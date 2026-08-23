use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Reward {
    /// The Router PDA this reward belongs to (not the owner wallet).
    pub router: Pubkey,

    /// Mirrors the epoch_id seed component — same "store what's already in
    /// the seeds" pattern Router.router_id uses.
    pub epoch: u64,

    /// 0-10000 fixed-point, matches services/scorer/src/scoring.rs's SCALE.
    pub service_score: u16,

    pub reward_weight: u64,
    pub reward_amount: u64,

    /// Reserved for pass 2 — finalize_epoch's RewardInput doesn't carry a
    /// penalty component yet, so this is always 0 for now.
    pub penalty_amount: u64,

    pub claimed: bool,

    /// Pass 1: every reward in an epoch shares the same commitment as the
    /// epoch's own proof_root (no per-router Merkle proof yet — that's a
    /// pass 2 addition once Step 5's bundle format supports it).
    pub proof_commitment: [u8; 32],

    pub bump: u8,
}

impl Reward {
    pub const SEED: &'static [u8] = b"reward";
}
