use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;
pub mod uptime;

use instructions::*;

declare_id!("4nVLSAiwNCBiepWwHdiafKcGzKHtaKu8YSPk24REG6d4");

#[program]
pub mod routerpulse {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        reward_rate: u64,
        penalty_bps: u16,
        heartbeat_interval: i64,
        epoch_duration: i64,
    ) -> Result<()> {
        instructions::initialize_protocol::handler(
            ctx, reward_rate, penalty_bps, heartbeat_interval, epoch_duration,
        )
    }

    pub fn register_router(
        ctx: Context<RegisterRouter>,
        router_id: String,
        location_lat: i64,
        location_long: i64,
        device_pubkey: Pubkey,
    ) -> Result<()> {
        instructions::register_router::handler(
            ctx, router_id, location_lat, location_long, device_pubkey,
        )
    }

    pub fn heartbeat(ctx: Context<Heartbeat>, epoch_number: u64) -> Result<()> {
        instructions::heartbeat::handler(ctx, epoch_number)
    }

    pub fn finalize_router_epoch(ctx: Context<FinalizeRouterEpoch>, epoch_number: u64) -> Result<()> {
        instructions::finalize_router_epoch::handler(ctx, epoch_number)
    }

    pub fn claim_reward(ctx: Context<ClaimReward>, epoch_number: u64) -> Result<()> {
        instructions::claim_reward::handler(ctx, epoch_number)
    }

    pub fn rotate_device_key(ctx: Context<RotateDeviceKey>, new_device_pubkey: Pubkey) -> Result<()> {
        instructions::rotate_device_key::handler(ctx, new_device_pubkey)
    }

    pub fn apply_penalty(ctx: Context<ApplyPenalty>) -> Result<()> {
        instructions::apply_penalty::handler(ctx)
    }

    pub fn pause_protocol(ctx: Context<AdminProtocol>) -> Result<()> {
        instructions::admin::pause_protocol(ctx)
    }

    pub fn resume_protocol(ctx: Context<AdminProtocol>) -> Result<()> {
        instructions::admin::resume_protocol(ctx)
    }

    pub fn reinstate_router(ctx: Context<AdminRouter>) -> Result<()> {
        instructions::admin::reinstate_router(ctx)
    }

    pub fn decommission_router(ctx: Context<AdminRouter>) -> Result<()> {
        instructions::admin::decommission_router(ctx)
    }

    pub fn update_reward_rate(
        ctx: Context<AdminProtocol>,
        new_rate: u64,
    ) -> Result<()> {
        instructions::admin::update_reward_rate(ctx, new_rate)
    }
}
