//! Fixed-point Proof-of-Service scoring.
//!
//! Everything here is INTEGER arithmetic, scaled by `SCALE` (10000). Raw
//! telemetry values are converted to fixed-point "centi" units (value * 100,
//! rounded) exactly once, at the DB boundary (see `TelemetrySample::from_row`
//! in main.rs) — every computation downstream of that conversion is integer
//! math only. This is deliberate: the same weighting/threshold logic here
//! needs to be reproducible bit-for-bit inside an Anchor program later,
//! and floats are not deterministic across platforms/compilers in that
//! context.

use chrono::{DateTime, Utc};

/// Score scale: components and the final score both live in [0, SCALE].
pub const SCALE: i64 = 10000;

// Weights, expressed in the same fixed-point scale, must sum to SCALE.
pub const WEIGHT_AVAILABILITY: i64 = 3500; // 35%
pub const WEIGHT_LATENCY: i64 = 2000; // 20%
pub const WEIGHT_THROUGHPUT: i64 = 2000; // 20%
pub const WEIGHT_PACKET_LOSS: i64 = 1000; // 10%
pub const WEIGHT_INDEPENDENT_VERIFICATION: i64 = 1000; // 10%
pub const WEIGHT_PROTOCOL_COMPLIANCE: i64 = 500; // 5%

const _WEIGHT_SUM_CHECK: () = assert!(
    WEIGHT_AVAILABILITY
        + WEIGHT_LATENCY
        + WEIGHT_THROUGHPUT
        + WEIGHT_PACKET_LOSS
        + WEIGHT_INDEPENDENT_VERIFICATION
        + WEIGHT_PROTOCOL_COMPLIANCE
        == SCALE
);

// Tier thresholds (inclusive lower bounds), on the same 0-SCALE scale.
pub const TIER_PLATINUM_MIN: i64 = 9500;
pub const TIER_GOLD_MIN: i64 = 8500;
pub const TIER_SILVER_MIN: i64 = 7000;
pub const TIER_BRONZE_MIN: i64 = 5000;

/// Top of the Bronze bracket — used to cap a device's *stored* score (not
/// just its tier label) when a compliance violation is flagged, so a
/// "bronze" device never shows a score that would otherwise read as
/// Silver/Gold/Platinum. This is a deliberate implementation choice beyond
/// the literal spec (which only said "cap the tier") — see summary.
pub const TIER_BRONZE_MAX: i64 = TIER_SILVER_MIN - 1;

/// Physically-impossible-telemetry bounds for a residential router, in
/// fixed-point centi units. Any sample outside these bounds is a protocol
/// compliance violation.
const MIN_LATENCY_CENTI_MS: i64 = 100; // 1.00 ms
const MAX_THROUGHPUT_CENTI_MBPS: i64 = 100_000; // 1000.00 Mbps

/// One telemetry sample, already converted to fixed-point centi units.
#[derive(Debug, Clone, Copy)]
pub struct TelemetrySample {
    pub latency_centi_ms: i64,
    pub packet_loss_centi_pct: i64,
    pub download_centi_mbps: i64,
    pub upload_centi_mbps: i64,
    pub availability: bool,
    pub recorded_at: DateTime<Utc>,
}

/// Convert a raw f32 telemetry field (as stored in Postgres) into a
/// fixed-point centi-unit integer. This is the ONLY place floats touch the
/// scoring pipeline — everything after this point is i64 arithmetic.
pub fn to_centi(value: Option<f32>) -> i64 {
    ((value.unwrap_or(0.0) as f64) * 100.0).round() as i64
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Components {
    pub availability: i64,
    pub latency: i64,
    pub throughput: i64,
    pub packet_loss: i64,
    pub independent_verification: i64,
    pub protocol_compliance: i64,
}

pub fn availability_score(samples: &[TelemetrySample]) -> i64 {
    if samples.is_empty() {
        return 0;
    }
    let true_count = samples.iter().filter(|s| s.availability).count() as i64;
    (true_count * SCALE) / samples.len() as i64
}

fn avg_centi(samples: &[TelemetrySample], f: impl Fn(&TelemetrySample) -> i64) -> i64 {
    if samples.is_empty() {
        return 0;
    }
    let sum: i64 = samples.iter().map(f).sum();
    sum / samples.len() as i64
}

/// Full score at <=20ms average latency, zero at >=300ms, linear between.
pub fn latency_score(samples: &[TelemetrySample]) -> i64 {
    const GOOD_CENTI: i64 = 2000; // 20.00ms
    const BAD_CENTI: i64 = 30000; // 300.00ms
    let avg = avg_centi(samples, |s| s.latency_centi_ms);
    if avg <= GOOD_CENTI {
        SCALE
    } else if avg >= BAD_CENTI {
        0
    } else {
        SCALE - (avg - GOOD_CENTI) * SCALE / (BAD_CENTI - GOOD_CENTI)
    }
}

/// packet_loss_pct is already 0-100, so centi units land exactly in
/// [0, SCALE] — 0% loss -> SCALE, 100% loss -> 0, linear between.
pub fn packet_loss_score(samples: &[TelemetrySample]) -> i64 {
    let avg = avg_centi(samples, |s| s.packet_loss_centi_pct).clamp(0, SCALE);
    SCALE - avg
}

/// Average of a download-Mbps score (full at >=100Mbps) and an upload-Mbps
/// score (full at >=20Mbps) — generous caps for a residential router.
pub fn throughput_score(samples: &[TelemetrySample]) -> i64 {
    const DOWNLOAD_CAP_CENTI: i64 = 10_000; // 100.00 Mbps
    const UPLOAD_CAP_CENTI: i64 = 2_000; // 20.00 Mbps
    let avg_down = avg_centi(samples, |s| s.download_centi_mbps).clamp(0, DOWNLOAD_CAP_CENTI);
    let avg_up = avg_centi(samples, |s| s.upload_centi_mbps).clamp(0, UPLOAD_CAP_CENTI);
    let d = avg_down * SCALE / DOWNLOAD_CAP_CENTI;
    let u = avg_up * SCALE / UPLOAD_CAP_CENTI;
    (d + u) / 2
}

/// True if ANY sample in the window is physically impossible for a
/// residential router. This is what catches the simulator's "spoofed"
/// behavior (0.1ms latency, 10,000 Mbps).
pub fn has_compliance_violation(samples: &[TelemetrySample]) -> bool {
    samples.iter().any(|s| {
        s.latency_centi_ms < MIN_LATENCY_CENTI_MS
            || s.packet_loss_centi_pct < 0
            || s.download_centi_mbps > MAX_THROUGHPUT_CENTI_MBPS
            || s.upload_centi_mbps > MAX_THROUGHPUT_CENTI_MBPS
    })
}

pub fn weighted_final_score(c: &Components) -> i64 {
    (c.availability * WEIGHT_AVAILABILITY
        + c.latency * WEIGHT_LATENCY
        + c.throughput * WEIGHT_THROUGHPUT
        + c.packet_loss * WEIGHT_PACKET_LOSS
        + c.independent_verification * WEIGHT_INDEPENDENT_VERIFICATION
        + c.protocol_compliance * WEIGHT_PROTOCOL_COMPLIANCE)
        / SCALE
}

pub fn tier_for_score(score: i64) -> &'static str {
    if score >= TIER_PLATINUM_MIN {
        "platinum"
    } else if score >= TIER_GOLD_MIN {
        "gold"
    } else if score >= TIER_SILVER_MIN {
        "silver"
    } else if score >= TIER_BRONZE_MIN {
        "bronze"
    } else {
        "suspended"
    }
}
