use anchor_lang::prelude::*;

/// Per-epoch emission budget — the hard cap on how many reward tokens
/// that epoch can ever mint.
///
/// Created lazily on the first `finalize_router_epoch` for an epoch and
/// debited by each router's reward as it finalizes. Without this, reward
/// issuance would be unbounded: `reward_rate * epoch_duration * routers`
/// grows with the router count, so a Sybil operator registering many
/// routers could inflate supply arbitrarily. Here, extra routers dilute
/// a fixed pool instead of expanding it.
#[account]
#[derive(InitSpace)]
pub struct EmissionSchedule {
    pub epoch_number: u64,
    /// Budget for this epoch, snapshotted at creation from the
    /// protocol's decaying emission curve.
    pub total_emission: u64,
    /// Sum of all rewards finalized against this epoch so far.
    pub allocated: u64,
    pub created_at: i64,
    pub bump: u8,
}

impl EmissionSchedule {
    pub const SEED: &'static [u8] = b"emission";

    pub fn remaining(&self) -> u64 {
        self.total_emission.saturating_sub(self.allocated)
    }
}
