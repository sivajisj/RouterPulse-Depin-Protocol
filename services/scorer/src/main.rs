mod bundle;
mod probe;
mod scoring;

use std::time::Duration as StdDuration;

use chrono::Utc;
use clap::Parser;
use scoring::{Components, TelemetrySample};
use sqlx::postgres::PgPoolOptions;
use sqlx::Row;
use uuid::Uuid;

use bundle::{Bundle, BundleDevice};

#[derive(Parser, Debug)]
#[command(name = "scorer")]
struct Args {
    /// Run one scoring pass and exit, instead of looping on a timer.
    #[arg(long)]
    once: bool,

    #[arg(long, default_value_t = 30)]
    interval_secs: u64,
}

struct DeviceRow {
    id: Uuid,
    router_id: String,
}

async fn fetch_active_devices(pool: &sqlx::PgPool) -> anyhow::Result<Vec<DeviceRow>> {
    let rows = sqlx::query("SELECT id, router_id FROM devices WHERE status = 'active'")
        .fetch_all(pool)
        .await?;

    Ok(rows
        .into_iter()
        .map(|r| DeviceRow {
            id: r.get("id"),
            router_id: r.get("router_id"),
        })
        .collect())
}

/// Last N=20 samples within the last 5 minutes, most recent first.
async fn fetch_recent_samples(
    pool: &sqlx::PgPool,
    device_id: Uuid,
) -> anyhow::Result<Vec<TelemetrySample>> {
    let rows = sqlx::query(
        "SELECT latency_ms, packet_loss_pct, download_mbps, upload_mbps, availability, recorded_at
         FROM telemetry
         WHERE device_id = $1 AND recorded_at > now() - interval '5 minutes'
         ORDER BY recorded_at DESC
         LIMIT 20",
    )
    .bind(device_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| TelemetrySample {
            latency_centi_ms: scoring::to_centi(r.get("latency_ms")),
            packet_loss_centi_pct: scoring::to_centi(r.get("packet_loss_pct")),
            download_centi_mbps: scoring::to_centi(r.get("download_mbps")),
            upload_centi_mbps: scoring::to_centi(r.get("upload_mbps")),
            availability: r.get("availability"),
            recorded_at: r.get("recorded_at"),
        })
        .collect())
}

async fn update_device_score(
    pool: &sqlx::PgPool,
    device_id: Uuid,
    stored_score: i64,
    tier: &str,
) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE devices SET service_score = $1, quality_tier = $2, updated_at = now() WHERE id = $3",
    )
    .bind(stored_score as f32)
    .bind(tier)
    .bind(device_id)
    .execute(pool)
    .await?;
    Ok(())
}

async fn run_scoring_pass(pool: &sqlx::PgPool, http: &reqwest::Client) -> anyhow::Result<()> {
    let devices = fetch_active_devices(pool).await?;
    tracing::info!("scoring pass starting: {} active device(s)", devices.len());

    let mut bundle_devices = Vec::new();

    for device in devices {
        let samples = fetch_recent_samples(pool, device.id).await?;

        if samples.is_empty() {
            tracing::info!(
                device_id = %device.id,
                router_id = %device.router_id,
                "no telemetry in last 5 minutes — skipping (score/tier unchanged)"
            );
            continue;
        }

        let violation = scoring::has_compliance_violation(&samples);

        let components = Components {
            availability: scoring::availability_score(&samples),
            latency: scoring::latency_score(&samples),
            throughput: scoring::throughput_score(&samples),
            packet_loss: scoring::packet_loss_score(&samples),
            independent_verification: probe::independent_verification_score(&samples, Utc::now()),
            protocol_compliance: if violation { 0 } else { scoring::SCALE },
        };

        let raw_score = scoring::weighted_final_score(&components);
        let stored_score = if violation {
            raw_score.min(scoring::TIER_BRONZE_MAX)
        } else {
            raw_score
        };
        let tier = scoring::tier_for_score(stored_score);

        tracing::info!(
            device_id = %device.id,
            router_id = %device.router_id,
            samples = samples.len(),
            availability = components.availability,
            latency = components.latency,
            throughput = components.throughput,
            packet_loss = components.packet_loss,
            independent_verification = components.independent_verification,
            protocol_compliance = components.protocol_compliance,
            raw_score,
            stored_score,
            tier,
            compliance_violation = violation,
            "device scored{}",
            if violation { " — COMPLIANCE VIOLATION, capped at Bronze" } else { "" }
        );

        update_device_score(pool, device.id, stored_score, tier).await?;

        bundle_devices.push(BundleDevice {
            device_id: device.id,
            router_id: device.router_id,
            sample_count: samples.len(),
            components: components.into(),
            raw_score,
            stored_score,
            quality_tier: tier.to_string(),
            compliance_violation: violation,
        });
    }

    let bundle = Bundle {
        timestamp: Utc::now(),
        devices: bundle_devices,
    };
    let bundle_json = serde_json::to_value(&bundle)?;
    let bundle_hash = bundle::hash_bundle(&bundle_json);

    // epoch_number is a BIGSERIAL — we don't know its value until after
    // insert, but Pinata's metadata name is cosmetic, so probe with a
    // placeholder-free approach: insert first, then upload, then patch the
    // ipfs_cid in. This also means the bundle is durably stored even if
    // the IPFS call hangs or fails.
    let inserted = sqlx::query(
        "INSERT INTO epoch_proof_bundles (bundle_json, bundle_hash)
         VALUES ($1, $2)
         RETURNING id, epoch_number",
    )
    .bind(&bundle_json)
    .bind(&bundle_hash)
    .fetch_one(pool)
    .await?;

    let bundle_id: Uuid = inserted.get("id");
    let epoch_number: i64 = inserted.get("epoch_number");

    let ipfs_cid = bundle::upload_to_pinata(http, &bundle_json, epoch_number).await;

    if let Some(ref cid) = ipfs_cid {
        sqlx::query("UPDATE epoch_proof_bundles SET ipfs_cid = $1 WHERE id = $2")
            .bind(cid)
            .bind(bundle_id)
            .execute(pool)
            .await?;
    }

    tracing::info!(
        epoch_number,
        bundle_id = %bundle_id,
        bundle_hash = %bundle_hash,
        ipfs_cid = %ipfs_cid.as_deref().unwrap_or("null"),
        "epoch proof bundle stored"
    );

    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let args = Args::parse();

    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await?;
    tracing::info!("scorer connected to postgres");

    let http = reqwest::Client::new();

    if args.once {
        run_scoring_pass(&pool, &http).await?;
        return Ok(());
    }

    tracing::info!("scorer running on a {}s timer", args.interval_secs);
    let mut ticker = tokio::time::interval(StdDuration::from_secs(args.interval_secs));
    loop {
        ticker.tick().await;
        if let Err(e) = run_scoring_pass(&pool, &http).await {
            tracing::error!("scoring pass failed: {e:#}");
        }
    }
}
