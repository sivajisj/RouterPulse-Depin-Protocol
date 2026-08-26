use anchor_lang::prelude::*;

/// Per-router stake position. Collateral an operator must post before a
/// router can earn: it is what makes slashing meaningful, since a
/// router with nothing at risk can spam bad uptime for free.
///
/// The tokens themselves live in one shared protocol-owned stake vault;
/// this account is the per-router accounting record against it.
#[account]
#[derive(InitSpace)]
pub struct Stake {
    pub router: Pubkey,
    pub owner: Pubkey,
    /// Currently staked, net of anything already slashed.
    pub amount: u64,
    /// Lifetime total slashed away from this position.
    pub total_slashed: u64,
    /// Unstaking is blocked until this timestamp. Set forward on every
    /// new stake so collateral can't be posted to pass an activation
    /// check and then yanked out in the same epoch.
    pub locked_until: i64,
    pub created_at: i64,
    pub bump: u8,
}

impl Stake {
    pub const SEED: &'static [u8] = b"stake";
    /// PDA that holds every operator's staked tokens.
    pub const VAULT_SEED: &'static [u8] = b"stake_vault";
}
