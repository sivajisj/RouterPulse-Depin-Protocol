use anchor_lang::prelude::*;

/// Per-router, per-epoch performance record. Created lazily on a
/// router's first heartbeat inside a given epoch, closed by
/// `finalize_router_epoch` once the epoch's time window has elapsed,
/// and consumed exactly once by `claim_reward`.
///
/// This account — not the lifetime counters on `Router` — is the
/// source of truth for rewards. A router that goes silent simply never
/// accumulates a `RouterEpoch` for the epochs it missed, so it cannot
/// coast on a stale historical uptime percentage the way a
/// claim-from-lifetime-average design would allow.
#[account]
#[derive(InitSpace)]
pub struct RouterEpoch {
    pub router: Pubkey,
    pub epoch_number: u64,
    pub start_time: i64,
    pub end_time: i64,
    /// Heartbeats actually received inside [start_time, end_time).
    pub heartbeats: u32,
    /// ceil(epoch_duration / heartbeat_interval) at the time this
    /// epoch record was opened — the denominator for uptime_bps.
    pub expected_heartbeats: u32,
    /// Set once by `finalize_router_epoch`, after which `heartbeats`
    /// is frozen and a reward amount is locked in.
    pub finalized: bool,
    /// Set once by `claim_reward`. Prevents double-claiming the same
    /// epoch.
    pub claimed: bool,
    /// Uptime for this epoch in basis points (0-10_000), fixed at
    /// finalization time.
    pub uptime_bps: u16,
    /// Reward amount (lamports) locked in at finalization, paid out
    /// verbatim on claim.
    pub reward_amount: u64,
    pub bump: u8,
}

impl RouterEpoch {
    pub const SEED: &'static [u8] = b"router_epoch";
}
