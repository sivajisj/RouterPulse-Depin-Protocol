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
    /// Length of one reward epoch, in seconds. Rewards are only ever
    /// paid out for a *closed* epoch, computed from heartbeats actually
    /// received inside that epoch's time window — never from a lifetime
    /// counter that can go stale while a router is silently offline.
    pub epoch_duration: i64,
    /// Unix timestamp the protocol was initialized. Epoch numbers are
    /// derived deterministically from this, so no cross-router cranking
    /// is ever required to "advance" the epoch clock.
    pub genesis_time: i64,
    pub total_routers: u64,
    pub total_rewards_distributed: u64,
    pub is_paused: bool,
    pub bump: u8,
    pub vault_bump: u8
}

impl Protocol{
    pub const SEED: &'static [u8] = b"protocol";

    /// Deterministic epoch number for a given timestamp. Anyone can
    /// recompute this off-chain, which is what lets `heartbeat` and
    /// `finalize_router_epoch` agree on which epoch is "current"
    /// without any stateful global counter.
    pub fn epoch_number_at(&self, ts: i64) -> u64 {
        if ts <= self.genesis_time || self.epoch_duration <= 0 {
            return 0;
        }
        ((ts - self.genesis_time) / self.epoch_duration) as u64
    }

    /// [start, end) unix-timestamp bounds of a given epoch number.
    pub fn epoch_bounds(&self, epoch_number: u64) -> (i64, i64) {
        let start = self.genesis_time + (epoch_number as i64) * self.epoch_duration;
        let end = start + self.epoch_duration;
        (start, end)
    }
}
