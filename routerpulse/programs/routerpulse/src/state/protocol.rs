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
    pub bump: u8
}

impl Protocol{
    pub const SEED: &'static [u8] = b"protocol";
}