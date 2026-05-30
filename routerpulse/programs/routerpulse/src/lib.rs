use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

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
            ctx,
            reward_rate,
            penalty_bps,
            heartbeat_interval,
        )
    }

    pub fn register_router(
        ctx: Context<RegisterRouter>,
        router_id: String,
        location_lat: i64,
        location_long: i64,
    ) -> Result<()> {
        instructions::register_router::handler(
            ctx,
            router_id,
            location_lat,
            location_long,
        )
    }                       
}
