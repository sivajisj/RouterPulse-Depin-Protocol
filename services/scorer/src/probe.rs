//! Independent Verification component — PLACEHOLDER.
//!
//! ⚠️ HONESTY NOTE: this is NOT real independent verification. The
//! project's architecture doc calls for external probe nodes —
//! geographically distributed machines that independently ping/HTTP/DNS
//! -check each router's real IP and report back, so a device can't just
//! lie about its own uptime. There are no real routers to probe yet
//! (everything is simulated, with no reachable IP), so that system does
//! not exist here.
//!
//! What this module actually does instead: it cross-checks a device's own
//! self-reported `availability` flag against whether the device has sent
//! ANY telemetry at all in the last 2 minutes. A device claiming
//! `availability = true` while going quiet for 2+ minutes is marked
//! "unverifiable" and takes a penalty on this component. A device isn't
//! penalized just for reporting `availability = false` — it isn't lying
//! about being up.
//!
//! This catches "stopped talking to us" — it does NOT catch "is still
//! sending us heartbeats but is lying about them", because that requires
//! a real, independent, third-party observation, which this stand-in
//! cannot provide. Replace this module with real probe-node results
//! before this component score means anything for slashing/rewards.

use chrono::{DateTime, Duration, Utc};

use crate::scoring::{TelemetrySample, SCALE};

/// Score for a device that claims to be up but hasn't been heard from
/// recently — clearly less than full marks, but not zero, since we have
/// no positive evidence of dishonesty, only absence of evidence of honesty.
const UNVERIFIABLE_SCORE: i64 = 2000;

const FRESHNESS_WINDOW: Duration = Duration::minutes(2);

/// `samples` must be sorted most-recent-first. `now` is passed in (rather
/// than computed here) so scoring is deterministic and testable.
pub fn independent_verification_score(samples: &[TelemetrySample], now: DateTime<Utc>) -> i64 {
    let Some(latest) = samples.first() else {
        return 0;
    };

    if !latest.availability {
        return SCALE;
    }

    let has_recent_telemetry = now.signed_duration_since(latest.recorded_at) <= FRESHNESS_WINDOW;
    if has_recent_telemetry {
        SCALE
    } else {
        UNVERIFIABLE_SCORE
    }
}
