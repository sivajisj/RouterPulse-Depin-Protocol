use anchor_lang::prelude::*;



#[account]
#[derive(InitSpace)]
pub struct Protocol{
    /// The admin who can update protocol settings
    pub authority: Pubkey,
    ///Reward tokens earned per second of uptime per router
    pub reward_rate : u64,
    pub penalty_bps: u16,
    pub heartbeat_interval: i64,
    pub total_routers: u64,
    pub total_rewards_distributed: u64,
    pub is_paused: bool,
    pub bump: u8,
    pub vault_bump: u8,

    // --- V2: SPL reward config (Step 6) ---
    /// The RPULSE mint (standard SPL Token, 9 decimals). Created externally
    /// — this program never holds mint authority.
    pub token_mint: Pubkey,
    /// Associated Token Account owned by this Protocol PDA. The program
    /// signs transfers out of it with its own PDA seeds; it never mints.
    pub treasury: Pubkey,
}

impl Protocol{
    pub const SEED: &'static [u8] = b"protocol";
}