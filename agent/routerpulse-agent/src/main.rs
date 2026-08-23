use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::Parser;
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use rand::Rng;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

/// Path to the persisted key file, resolved relative to this crate's
/// manifest dir so it's stable regardless of the invocation cwd.
fn key_file_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("device_key.json")
}

#[derive(Parser, Debug)]
#[command(name = "routerpulse-agent")]
struct Args {
    #[arg(long, default_value = "http://localhost:3001")]
    api_url: String,

    #[arg(long)]
    device_id: String,

    #[arg(long)]
    token: String,

    #[arg(long, default_value_t = 10)]
    interval_secs: u64,
}

#[derive(Serialize, Deserialize)]
struct KeyFile {
    /// hex-encoded 32-byte Ed25519 seed
    seed_hex: String,
    public_key_b58: String,
    /// device_id this key has completed enrollment for, if any
    enrolled_device_id: Option<String>,
}

fn load_or_create_keypair() -> Result<(SigningKey, KeyFile)> {
    let path = key_file_path();

    if path.exists() {
        let contents = std::fs::read_to_string(&path)
            .with_context(|| format!("reading key file {}", path.display()))?;
        let key_file: KeyFile = serde_json::from_str(&contents)
            .with_context(|| format!("parsing key file {}", path.display()))?;
        let seed_bytes = hex::decode(&key_file.seed_hex).context("decoding seed hex")?;
        let seed: [u8; 32] = seed_bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("seed in key file is not 32 bytes"))?;
        let signing_key = SigningKey::from_bytes(&seed);
        info!("loaded existing identity from {}", path.display());
        Ok((signing_key, key_file))
    } else {
        let mut csprng = rand::rngs::OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let verifying_key: VerifyingKey = signing_key.verifying_key();
        let key_file = KeyFile {
            seed_hex: hex::encode(signing_key.to_bytes()),
            public_key_b58: bs58::encode(verifying_key.to_bytes()).into_string(),
            enrolled_device_id: None,
        };
        save_key_file(&key_file)?;
        info!("generated new device identity, saved to {}", path.display());
        Ok((signing_key, key_file))
    }
}

fn save_key_file(key_file: &KeyFile) -> Result<()> {
    let path = key_file_path();
    let contents = serde_json::to_string_pretty(key_file)?;
    std::fs::write(&path, contents)
        .with_context(|| format!("writing key file {}", path.display()))?;
    Ok(())
}

#[derive(Deserialize)]
struct EnrollmentStartResponse {
    enrollment_id: uuid::Uuid,
    challenge: String,
}

#[derive(Serialize)]
struct EnrollmentCompleteRequest {
    enrollment_id: uuid::Uuid,
    device_pubkey: String,
    signature: String,
}

#[derive(Serialize)]
struct TelemetryPayload {
    device_id: String,
    sequence_num: i64,
    latency_ms: f32,
    packet_loss_pct: f32,
    download_mbps: f32,
    upload_mbps: f32,
    availability: bool,
    nonce: String,
    signature: String,
}

/// Must match services/api/src/handlers/telemetry.rs `canonical_message()`
/// exactly: colon-joined fields in this order, using Display formatting.
fn canonical_message(
    device_id: &str,
    sequence_num: i64,
    latency_ms: f32,
    packet_loss_pct: f32,
    download_mbps: f32,
    upload_mbps: f32,
    availability: bool,
    nonce: &str,
) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}:{}:{}",
        device_id,
        sequence_num,
        latency_ms,
        packet_loss_pct,
        download_mbps,
        upload_mbps,
        availability,
        nonce,
    )
}

fn random_nonce() -> String {
    let bytes: [u8; 16] = rand::thread_rng().gen();
    hex::encode(bytes)
}

async fn enroll(
    client: &Client,
    api_url: &str,
    token: &str,
    device_id: &str,
    signing_key: &SigningKey,
    key_file: &mut KeyFile,
) -> Result<()> {
    info!("starting enrollment for device {device_id}");

    let start_resp: EnrollmentStartResponse = client
        .post(format!("{api_url}/v1/devices/{device_id}/enrollment"))
        .bearer_auth(token)
        .send()
        .await
        .context("enrollment start request failed")?
        .error_for_status()
        .context("enrollment start returned error status")?
        .json()
        .await
        .context("parsing enrollment start response")?;

    info!(enrollment_id = %start_resp.enrollment_id, "got enrollment challenge");

    let signature = signing_key.sign(start_resp.challenge.as_bytes());
    let signature_b58 = bs58::encode(signature.to_bytes()).into_string();

    let complete_body = EnrollmentCompleteRequest {
        enrollment_id: start_resp.enrollment_id,
        device_pubkey: key_file.public_key_b58.clone(),
        signature: signature_b58,
    };

    let resp = client
        .post(format!("{api_url}/v1/devices/{device_id}/enrollment/complete"))
        .bearer_auth(token)
        .json(&complete_body)
        .send()
        .await
        .context("enrollment complete request failed")?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("enrollment complete failed: {status} - {body}");
    }

    key_file.enrolled_device_id = Some(device_id.to_string());
    save_key_file(key_file)?;

    info!("enrollment complete, device_pubkey bound: {}", key_file.public_key_b58);
    Ok(())
}

async fn send_heartbeat(
    client: &Client,
    api_url: &str,
    token: &str,
    device_id: &str,
    signing_key: &SigningKey,
    sequence_num: i64,
) -> Result<()> {
    let mut rng = rand::thread_rng();
    let latency_ms: f32 = rng.gen_range(15.0..60.0);
    let packet_loss_pct: f32 = rng.gen_range(0.0..2.0);
    let download_mbps: f32 = rng.gen_range(50.0..500.0);
    let upload_mbps: f32 = rng.gen_range(10.0..100.0);
    let availability = true;
    let nonce = random_nonce();

    let message = canonical_message(
        device_id,
        sequence_num,
        latency_ms,
        packet_loss_pct,
        download_mbps,
        upload_mbps,
        availability,
        &nonce,
    );
    let signature = signing_key.sign(message.as_bytes());
    let signature_b58 = bs58::encode(signature.to_bytes()).into_string();

    let payload = TelemetryPayload {
        device_id: device_id.to_string(),
        sequence_num,
        latency_ms,
        packet_loss_pct,
        download_mbps,
        upload_mbps,
        availability,
        nonce,
        signature: signature_b58,
    };

    let resp = client
        .post(format!("{api_url}/v1/telemetry/heartbeat"))
        .bearer_auth(token)
        .json(&payload)
        .send()
        .await
        .context("heartbeat request failed")?;

    let status = resp.status();
    if status.is_success() {
        info!(sequence_num, "heartbeat accepted");
        Ok(())
    } else {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("heartbeat rejected: {status} - {body}");
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let args = Args::parse();
    let client = Client::new();

    let (signing_key, mut key_file) = load_or_create_keypair()?;

    let already_enrolled = key_file.enrolled_device_id.as_deref() == Some(args.device_id.as_str());

    if already_enrolled {
        info!("device already enrolled for {}, skipping enrollment", args.device_id);
    } else {
        enroll(
            &client,
            &args.api_url,
            &args.token,
            &args.device_id,
            &signing_key,
            &mut key_file,
        )
        .await
        .context("enrollment failed")?;
    }

    info!(
        "starting telemetry loop, interval={}s, device_id={}",
        args.interval_secs, args.device_id
    );

    let mut sequence_num: i64 = 1;
    let mut ticker = tokio::time::interval(Duration::from_secs(args.interval_secs));

    loop {
        ticker.tick().await;
        match send_heartbeat(
            &client,
            &args.api_url,
            &args.token,
            &args.device_id,
            &signing_key,
            sequence_num,
        )
        .await
        {
            Ok(()) => {}
            Err(e) => warn!("heartbeat failed: {e:#}"),
        }
        sequence_num += 1;
    }
}
