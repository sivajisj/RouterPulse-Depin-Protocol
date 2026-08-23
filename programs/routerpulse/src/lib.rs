use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;
pub mod uptime;

use instructions::*;

declare_id!("BD41MBys55QSTYgsL3S5RmkSu19PVqtfTje3XhZgnbtD");

#[program]
pub mod routerpulse {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        reward_rate: u64,
        penalty_bps: u16,
        heartbeat_interval: i64,
    ) -> Result<()> {
        instructions::initialize_protocol::handler(
            ctx, reward_rate, penalty_bps, heartbeat_interval,
        )
    }

    pub fn register_router(
        ctx: Context<RegisterRouter>,
        router_id: String,
        location_lat: i64,
        location_long: i64,
    ) -> Result<()> {
        instructions::register_router::handler(
            ctx, router_id, location_lat, location_long,
        )
    }

    pub fn heartbeat(ctx: Context<Heartbeat>) -> Result<()> {
        instructions::heartbeat::handler(ctx)
    }

    pub fn claim_reward(ctx: Context<ClaimReward>) -> Result<()> {
        instructions::claim_reward::handler(ctx)
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

    pub fn open_epoch(
        ctx: Context<OpenEpoch>,
        epoch_id: u64,
        reward_budget: u64,
        start_time: i64,
        end_time: i64,
    ) -> Result<()> {
        instructions::open_epoch::handler(ctx, epoch_id, reward_budget, start_time, end_time)
    }

    pub fn finalize_epoch<'info>(
        ctx: Context<'info, FinalizeEpoch<'info>>,
        proof_root: [u8; 32],
        total_network_weight: u64,
        inputs: Vec<RewardInput>,
    ) -> Result<()> {
        instructions::finalize_epoch::handler(ctx, proof_root, total_network_weight, inputs)
    }
}
