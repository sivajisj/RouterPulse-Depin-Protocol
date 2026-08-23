use anchor_lang::prelude::*;
use crate::state::{Protocol, Router, RouterStatus};
use crate::errors::RouterPulseError;

// pause the entire protocol , blocks heartbeats and claims
pub fn pause_protocol(ctx: Context<AdminProtocol>) -> Result<()> {
    require!(
        ctx.accounts.authority.key() == ctx.accounts.protocol.authority,
        RouterPulseError::Unauthorized
    );
    require!(
        !ctx.accounts.protocol.is_paused,
        RouterPulseError::AlreadyPaused
    );

    ctx.accounts.protocol.is_paused = true;

    msg!("Protocol paused by {}", ctx.accounts.authority.key());
    Ok(())
}

// resume a paused protocol
pub fn resume_protocol(ctx: Context<AdminProtocol>) -> Result<()> {
    require!(
        ctx.accounts.authority.key() == ctx.accounts.protocol.authority,
        RouterPulseError::Unauthorized
    );
    require!(
        ctx.accounts.protocol.is_paused,
        RouterPulseError::NotPaused
    );

    ctx.accounts.protocol.is_paused = false;

    msg!("Protocol resumed by {}", ctx.accounts.authority.key());
    Ok(())
}

// reinstate a suspended router back to active
pub fn reinstate_router(ctx: Context<AdminRouter>) -> Result<()> {
    require!(
        ctx.accounts.authority.key() == ctx.accounts.protocol.authority,
        RouterPulseError::Unauthorized
    );
    require!(
        ctx.accounts.router.status == RouterStatus::Suspended,
        RouterPulseError::RouterNotSuspended
    );

    ctx.accounts.router.status      = RouterStatus::Active;
    ctx.accounts.router.uptime_score = 50; // reinstated with partial score

    msg!("Router {} reinstated", ctx.accounts.router.router_id);
    Ok(())
}

// permanently decommission a router
pub fn decommission_router(ctx: Context<AdminRouter>) -> Result<()> {
    require!(
        ctx.accounts.authority.key() == ctx.accounts.protocol.authority,
        RouterPulseError::Unauthorized
    );
    require!(
        ctx.accounts.router.status != RouterStatus::Decommissioned,
        RouterPulseError::RouterDecommissioned
    );

    ctx.accounts.router.status = RouterStatus::Decommissioned;

    msg!("Router {} decommissioned", ctx.accounts.router.router_id);
    Ok(())
}

// update protocol reward rate
pub fn update_reward_rate(
    ctx: Context<AdminProtocol>,
    new_rate: u64,
) -> Result<()> {
    require!(
        ctx.accounts.authority.key() == ctx.accounts.protocol.authority,
        RouterPulseError::Unauthorized
    );
    require!(new_rate > 0, RouterPulseError::InvalidRewardRate);

    ctx.accounts.protocol.reward_rate = new_rate;

    msg!("Reward rate updated to {}", new_rate);
    Ok(())
}

#[derive(Accounts)]
pub struct AdminProtocol<'info> {
    #[account(
        mut,
        seeds = [Protocol::SEED],
        bump  = protocol.bump,
    )]
    pub protocol: Account<'info, Protocol>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AdminRouter<'info> {
    #[account(
        mut,
        seeds = [Router::SEED, router.owner.as_ref(), router.router_id.as_bytes()],
        bump  = router.bump,
    )]
    pub router: Account<'info, Router>,

    #[account(
        seeds = [Protocol::SEED],
        bump  = protocol.bump,
    )]
    pub protocol: Account<'info, Protocol>,

    pub authority: Signer<'info>,
}
