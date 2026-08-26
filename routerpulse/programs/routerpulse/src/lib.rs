use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;
pub mod uptime;

use instructions::*;

declare_id!("4nVLSAiwNCBiepWwHdiafKcGzKHtaKu8YSPk24REG6d4");

#[program]
pub mod routerpulse {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        config: ProtocolConfig,
    ) -> Result<()> {
        instructions::initialize_protocol::handler(ctx, config)
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

    pub fn claim_vested(ctx: Context<ClaimVested>, epoch_number: u64) -> Result<()> {
        instructions::claim_vested::handler(ctx, epoch_number)
    }

    pub fn stake(ctx: Context<StakeCollateral>, amount: u64) -> Result<()> {
        instructions::stake::handler(ctx, amount)
    }

    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        instructions::unstake::handler(ctx, amount)
    }

    pub fn slash_router(ctx: Context<SlashRouter>, epoch_number: u64) -> Result<()> {
        instructions::slash_router::handler(ctx, epoch_number)
    }

    pub fn burn_treasury(ctx: Context<BurnTreasury>, amount: u64) -> Result<()> {
        instructions::burn_treasury::handler(ctx, amount)
    }

    pub fn mint_genesis(ctx: Context<MintGenesis>, amount: u64) -> Result<()> {
        instructions::mint_genesis::handler(ctx, amount)
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
