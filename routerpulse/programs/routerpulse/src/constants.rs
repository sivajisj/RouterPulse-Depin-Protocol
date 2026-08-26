/// Denominator used everywhere a ratio is expressed in basis points
/// (penalty_bps, uptime_bps). 1 bps = 0.01%.
pub const BASIS_POINTS_DIVISOR: u64 = 10_000;

/// Epoch duration must be at least this many heartbeat intervals so
/// `expected_heartbeats` is never zero and uptime_bps stays meaningful.
pub const MIN_HEARTBEATS_PER_EPOCH: i64 = 4;
