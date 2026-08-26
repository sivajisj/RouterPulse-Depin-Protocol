use anchor_lang::prelude::*;

/// One epoch's reward entitlement, released on a cliff + linear
/// schedule.
///
/// No tokens are moved when this is created — it records only the
/// right to mint. `claim_vested` mints the newly-vested slice straight
/// to the operator, so supply grows exactly in step with what has
/// actually vested and there is no vault balance to drift out of sync
/// or be drained.
#[account]
#[derive(InitSpace)]
pub struct RewardVesting {
    pub router: Pubkey,
    pub beneficiary: Pubkey,
    pub epoch_number: u64,
    /// Full entitlement for the epoch. `claimed` can never exceed it.
    pub total_amount: u64,
    pub claimed_amount: u64,
    pub start_time: i64,
    /// Nothing vests before `start_time + cliff_duration`.
    pub cliff_duration: i64,
    /// Fully vested at `start_time + vesting_duration`.
    pub vesting_duration: i64,
    pub bump: u8,
}

impl RewardVesting {
    pub const SEED: &'static [u8] = b"vesting";
}
