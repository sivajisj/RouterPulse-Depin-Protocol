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
    /// SPL mint for the reward token. Mint authority is the protocol
    /// PDA itself, so issuance is only ever possible through this
    /// program's instructions — never by a human holding a key.
    pub reward_mint: Pubkey,
    /// Collateral a router must have staked before it may heartbeat or
    /// earn. This is what gives slashing teeth.
    pub min_stake: u64,
    /// How long staked collateral is locked after each `stake` call.
    pub stake_lock_duration: i64,
    /// Cliff/duration applied to every epoch reward entitlement.
    pub reward_cliff_duration: i64,
    pub reward_vesting_duration: i64,
    /// Per-epoch emission budget before decay, and the decay curve.
    pub initial_emission_per_epoch: u64,
    pub epochs_per_year: u64,
    pub emission_decay_bps: u16,
    /// Hard cap on the initial distribution. Rewards can only be minted
    /// by vesting, and staking requires already holding tokens — so
    /// without a genesis allocation no operator could ever bootstrap.
    /// Fixed at initialization and enforced on-chain, so the authority
    /// can distribute up to this much and then never mint again.
    pub genesis_allocation: u64,
    pub genesis_minted: u64,
    pub total_routers: u64,
    pub total_rewards_distributed: u64,
    pub total_staked: u64,
    pub total_slashed: u64,
    pub total_minted: u64,
    pub total_burned: u64,
    pub is_paused: bool,
    pub bump: u8,
    pub vault_bump: u8
}

impl Protocol{
    pub const SEED: &'static [u8] = b"protocol";
    /// Reward mint PDA — derived, so its authority can only ever be the
    /// protocol PDA.
    pub const MINT_SEED: &'static [u8] = b"reward_mint";
    /// Protocol-owned token account receiving slashed collateral.
    pub const TREASURY_SEED: &'static [u8] = b"treasury";
    pub const REWARD_DECIMALS: u8 = 9;

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
