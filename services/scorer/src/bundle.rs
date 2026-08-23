//! Epoch proof bundle: the full scoring input/output for one scorer pass,
//! hashed and (if credentials are configured) pinned to IPFS via Pinata.

use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::scoring::Components;

#[derive(Debug, Serialize)]
pub struct BundleDeviceComponents {
    pub availability: i64,
    pub latency: i64,
    pub throughput: i64,
    pub packet_loss: i64,
    pub independent_verification: i64,
    pub protocol_compliance: i64,
}

impl From<Components> for BundleDeviceComponents {
    fn from(c: Components) -> Self {
        Self {
            availability: c.availability,
            latency: c.latency,
            throughput: c.throughput,
            packet_loss: c.packet_loss,
            independent_verification: c.independent_verification,
            protocol_compliance: c.protocol_compliance,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct BundleDevice {
    pub device_id: Uuid,
    pub router_id: String,
    pub sample_count: usize,
    pub components: BundleDeviceComponents,
    pub raw_score: i64,
    pub stored_score: i64,
    pub quality_tier: String,
    pub compliance_violation: bool,
}

#[derive(Debug, Serialize)]
pub struct Bundle {
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub devices: Vec<BundleDevice>,
}

/// Hashes the bundle's JSON serialization. Note: this hashes struct-field
/// order as emitted by serde_json (stable within this codebase, but NOT a
/// canonical-JSON hash in the RFC 8785 sense) — good enough for "detect
/// tampering / pin a snapshot" today, not yet suitable as a cross-language
/// canonical commitment. Revisit if bundles are ever hashed/verified
/// outside this exact serializer.
pub fn hash_bundle(bundle_json: &serde_json::Value) -> String {
    let bytes = serde_json::to_vec(bundle_json).expect("Value serialization cannot fail");
    let digest = Sha256::digest(&bytes);
    hex::encode(digest)
}

const PINATA_PIN_JSON_URL: &str = "https://api.pinata.cloud/pinning/pinJSONToIPFS";

/// Attempts to pin the bundle JSON to IPFS via Pinata's `pinJSONToIPFS`
/// endpoint. Reads the JWT from `IPFS_API_KEY`. Returns `Ok(None)` (not an
/// error) whenever upload didn't happen, always logging why — the caller
/// still stores the bundle + hash locally either way, so a missing/failing
/// IPFS integration never blocks scoring.
///
/// We picked Pinata over web3.storage: web3.storage's old bearer-token
/// upload API is deprecated in favor of `w3up`, which requires a
/// DID/UCAN-based agent and delegated proofs — too much ceremony for a
/// dev/demo setup. Pinata's `pinJSONToIPFS` is a single POST with a plain
/// JWT bearer token, which fits the "read a key from an env var" ask.
pub async fn upload_to_pinata(
    client: &reqwest::Client,
    bundle_json: &serde_json::Value,
    epoch_number: i64,
) -> Option<String> {
    let jwt = match std::env::var("IPFS_API_KEY") {
        Ok(v) if !v.trim().is_empty() => v,
        _ => {
            tracing::info!(
                "IPFS_API_KEY not set — skipping IPFS upload (bundle hash still computed and stored locally)"
            );
            return None;
        }
    };

    let body = serde_json::json!({
        "pinataContent": bundle_json,
        "pinataMetadata": { "name": format!("routerpulse-epoch-{epoch_number}") },
    });

    let resp = match client
        .post(PINATA_PIN_JSON_URL)
        .bearer_auth(&jwt)
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("IPFS upload request failed: {e} — storing bundle without a CID");
            return None;
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        tracing::warn!("IPFS upload rejected by Pinata: {status} - {text} — storing bundle without a CID");
        return None;
    }

    #[derive(serde::Deserialize)]
    struct PinataResponse {
        #[serde(rename = "IpfsHash")]
        ipfs_hash: String,
    }

    match resp.json::<PinataResponse>().await {
        Ok(parsed) => {
            tracing::info!("bundle pinned to IPFS: {}", parsed.ipfs_hash);
            Some(parsed.ipfs_hash)
        }
        Err(e) => {
            tracing::warn!("could not parse Pinata response: {e} — storing bundle without a CID");
            None
        }
    }
}
