use anchor_lang::prelude::*;


#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, InitSpace)]
pub enum RouterStatus {
    Active,       // Router is online and earning rewards
    Inactive,     // Router registered but not yet sending heartbeats
    Suspended,    // Router violated rules — penalized, blocked temporarily
    Decommissioned, // Router permanently removed from network
}

#[account]
#[derive(InitSpace)]
pub struct Router{
    //this owner is the owns and operates the router,
    //this responsible for paying penalties and getting rewards
    pub owner: Pubkey,
    //this is the unique identifier for the router, it can be any string that the owner wants to use to identify their router, it can be a name or a number or any combination of characters, it should be unique across all routers in the system
    #[max_len(32)]
    pub router_id: String,
    /// GPS coordinates stored as fixed-point integers
    /// Multiply actual coordinate by 1_000_000 to store as i64
    /// Example: latitude 19.0760 → stored as 19_076_000
    /// This avoids floating point (not allowed in Solana programs)
    pub location_lat: i64,              // 8 bytes
    pub location_long: i64,             // 8 bytes

    //Unix timestamp when it is registered
    pub registered_at: i64,            // 8 bytes   
    //Uinix timestamp when the recent heartbeat was received
    pub last_heartbeat: i64,               // 8 bytes

    //uptime score 0-100
    pub uptime_score: u8,              // 1 byte

    pub total_rewards: u64,             // 8 bytes
    pub total_penalties: u64,            // 8 bytes
    pub heartbeat_count: u64,            // 8 bytes 
    pub missed_heartbeats: u64,           // 8 bytes
    pub bump: u8,                       // 1 byte


}

impl Router{
    pub const SEED: &'static [u8] = b"router";

    //perfect uptime score is 100
    pub const MAX_SCORE: u8 = 100;

    ///Minimum score before router gets suspended
    pub const SUSPENSION_THRESHOLD: u8 = 20;
}