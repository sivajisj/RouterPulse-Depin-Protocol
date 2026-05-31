use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, InitSpace)]
pub enum RouterStatus {
    Active,           // Router is online and earning rewards
    Inactive,         // Router registered but not yet sending heartbeats
    Suspended,        // Router violated rules — penalized, blocked temporarily
    Decommissioned,   // Router permanently removed from network
}

#[account]
#[derive(InitSpace)]
pub struct Router {
    /// The wallet that owns and operates this router
    /// Responsible for paying penalties and receiving rewards
    pub owner: Pubkey,                  // 32 bytes

    /// Unique hardware identifier , max 32 characters
    /// Example: "router-mumbai-001" or device MAC hash
    #[max_len(32)]
    pub router_id: String,              // 4 + 32 bytes

    /// GPS coordinates as fixed-point integers
    /// Multiply actual coordinate by 1_000_000
    /// Example: 19.0760° → 19_076_000
    /// Avoids floating point (not supported in Solana BPF)
    pub location_lat: i64,              // 8 bytes
    pub location_long: i64,             // 8 bytes

    /// Unix timestamp when router was registered
    pub registered_at: i64,            // 8 bytes

    /// Unix timestamp of most recent heartbeat
    pub last_heartbeat: i64,           // 8 bytes

    /// Uptime score 0–100
    /// 100 = perfect, 0 = completely offline
    pub uptime_score: u8,              // 1 byte

    /// Lifetime earnings in token units
    pub total_rewards: u64,            // 8 bytes

    /// Lifetime penalties deducted
    pub total_penalties: u64,          // 8 bytes

    /// Total heartbeats received
    pub heartbeat_count: u64,          // 8 bytes

    /// Total heartbeats missed or late
    pub missed_heartbeats: u64,        // 8 bytes

    //track rewards were last claimed
    pub last_claim_time: i64,             // 8 bytes

    /// Current operational status of this router
    pub status: RouterStatus,          // 1 byte  

    /// Canonical PDA bump — stored during registration
    pub bump: u8,                      // 1 byte
}

impl Router {
    pub const SEED: &'static [u8] = b"router";
    pub const MAX_SCORE: u8 = 100;
    pub const SUSPENSION_THRESHOLD: u8 = 20;
}
