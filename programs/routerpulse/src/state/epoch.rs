use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum EpochStatus {
    Open,
    Closing,
    Finalizing,
    Finalized,
}

#[account]
#[derive(InitSpace)]
pub struct Epoch {
    pub epoch_id: u64,
    pub start_time: i64,
    pub end_time: i64,
    pub reward_budget: u64,
    pub total_eligible_weight: u64,
    pub total_distributed: u64,

    /// Hash commitment for the off-chain scoring bundle this epoch was
    /// settled from (the epoch_proof_bundles row + IPFS CID from Step 5).
    /// Pass 1 just stores whatever the caller passes in — nothing here
    /// verifies the bundle contents on-chain yet.
    pub proof_root: [u8; 32],

    /// Lifecycle status. Pass 1's instructions (open_epoch, finalize_epoch)
    /// only ever set Open and Finalized — Closing/Finalizing are reserved
    /// for pass 2, when a close_epoch instruction stops accepting new
    /// telemetry and an intermediate Finalizing state covers the window
    /// while the off-chain scorer is computing final numbers.
    pub status: EpochStatus,

    /// Authoritative re-finalization guard, checked directly rather than
    /// via `status == Finalized` so the check reads the same regardless of
    /// how the status enum evolves in later passes.
    pub finalized: bool,

    pub bump: u8,
}

impl Epoch {
    pub const SEED: &'static [u8] = b"epoch";
}
