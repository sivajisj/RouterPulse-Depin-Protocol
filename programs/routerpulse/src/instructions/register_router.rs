use anchor_lang::prelude::*;

use crate::state::{Protocol, Router, RouterStatus};
use crate::errors::RouterPulseError;


pub fn handler(ctx: Context<RegisterRouter>, router_id: String, location_lat: i64, location_long: i64) -> Result<()> {

    //  Validation
    require!(
        router_id.is_empty() == false,
        RouterPulseError::RouterIdEmpty 
    );

    require!(
        router_id.len() <= 32,
        RouterPulseError::RouterIdTooLong
    );

    require!(
        location_lat >= -90000000 && location_lat <= 90000000,
        RouterPulseError::InvalidLatitude
    );

    require!(
        location_long >= -180000000 && location_long <= 180000000,
        RouterPulseError::InvalidLongitude
    );

    // checking whether the protocol is paused or not
    let protocol = &mut ctx.accounts.protocol;
    require!(
        protocol.is_paused == false,
        RouterPulseError::ProtocolPaused
    );
    let now = Clock::get()?.unix_timestamp;

    let router = &mut ctx.accounts.router;
    router.owner = ctx.accounts.owner.key();
    router.router_id = router_id.clone();
    router.location_lat = location_lat;
    router.location_long = location_long;
    router.registered_at = now;
    router.last_heartbeat = now;
    router.uptime_score = Router::MAX_SCORE; // Start with perfect score
    router.total_rewards = 0;
    router.total_penalties = 0;
    router.heartbeat_count = 0;
    router.missed_heartbeats = 0;
    router.bump = ctx.bumps.router;
    protocol.total_routers = protocol.total_routers.checked_add(1).ok_or(RouterPulseError::Overflow)?;
    emit!(RouterRegistered {    
        owner: router.owner,
        router_id: router.router_id.clone(),
        location_lat: router.location_lat,
        location_long: router.location_long,
        timestamp: now,
    });

    Ok(())
}


#[derive(Accounts)]
#[instruction(router_id: String)]
//this is rom instruction args  and needed to derive PDA
pub struct RegisterRouter<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + Router::INIT_SPACE, // 8 bytes for account discriminator + space for Router struct
        seeds = [Router::SEED, owner.key().as_ref(), router_id.as_bytes()],
        bump
    )]
    pub router: Account<'info, Router>,

    #[account(
        mut,
        seeds = [Protocol::SEED],
        bump = protocol.bump,
    )]
    pub protocol: Account<'info, Protocol>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct RouterRegistered{
    pub owner: Pubkey,
    pub router_id: String,
    pub location_lat: i64,
    pub location_long: i64,
    pub timestamp: i64,
}