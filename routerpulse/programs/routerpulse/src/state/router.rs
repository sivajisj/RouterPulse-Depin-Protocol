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
    /// The wallet that owns and operates this router.
    /// Responsible for paying penalties and receiving rewards.
    /// This is NOT the key that signs heartbeats — see `device_pubkey`.
    pub owner: Pubkey,                  // 32 bytes

    /// The key that signs heartbeat transactions on behalf of the
    /// physical device. Separated from `owner` so the operator's main
    /// wallet is never exposed to an unattended router, and so a
    /// compromised device can be recovered via `rotate_device_key`
    /// without re-registering the router.
    pub device_pubkey: Pubkey,          // 32 bytes

    /// Incremented every time the device key is rotated. Lets an
    /// indexer / audit trail distinguish "old device, new device"
    /// heartbeats after a recovery event.
    pub device_key_version: u16,        // 2 bytes

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

    /// Real-time uptime score 0–100, used only for fast suspension
    /// response. This is a complementary signal to the per-epoch
    /// reward accounting in `RouterEpoch` — it reacts immediately to
    /// bad behaviour but is never itself used to compute a payout.
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
