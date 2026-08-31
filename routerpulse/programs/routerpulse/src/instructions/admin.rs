use anchor_lang::prelude::*;
use crate::state::{Protocol, Router, RouterStatus};
use crate::errors::RouterPulseError;

// Governance actions.
//
// Every instruction here emits an event as well as a `msg!`. The log
// line is for a human tailing the validator; the event is what makes the
// action *indexable* — without it there is no queryable record of who
// paused the protocol, when a router was decommissioned, or how the
// reward rate has changed over time. Reconciliation can observe the
// resulting state, but not the transition or its actor, which is
// precisely what an audit trail needs.

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

    emit!(ProtocolPaused {
        authority: ctx.accounts.authority.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });
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

    emit!(ProtocolResumed {
        authority: ctx.accounts.authority.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });
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

    emit!(RouterReinstated {
        router:       ctx.accounts.router.key(),
        router_id:    ctx.accounts.router.router_id.clone(),
        owner:        ctx.accounts.router.owner,
        authority:    ctx.accounts.authority.key(),
        uptime_score: ctx.accounts.router.uptime_score,
        timestamp:    Clock::get()?.unix_timestamp,
    });
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

    emit!(RouterDecommissioned {
        router:    ctx.accounts.router.key(),
        router_id: ctx.accounts.router.router_id.clone(),
        owner:     ctx.accounts.router.owner,
        authority: ctx.accounts.authority.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });
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

    let previous_rate = ctx.accounts.protocol.reward_rate;
    ctx.accounts.protocol.reward_rate = new_rate;

    emit!(RewardRateUpdated {
        authority: ctx.accounts.authority.key(),
        previous_rate,
        new_rate,
        timestamp: Clock::get()?.unix_timestamp,
    });
    msg!("Reward rate updated {} -> {}", previous_rate, new_rate);
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

// ── governance events ─────────────────────────────────────────────────
// `previous_rate` is carried on RewardRateUpdated deliberately: an
// indexer that missed an earlier update can still reconstruct the change
// rather than only knowing where the rate landed.

#[event]
pub struct ProtocolPaused {
    pub authority: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct ProtocolResumed {
    pub authority: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct RouterReinstated {
    pub router:       Pubkey,
    pub router_id:    String,
    pub owner:        Pubkey,
    pub authority:    Pubkey,
    pub uptime_score: u8,
    pub timestamp:    i64,
}

#[event]
pub struct RouterDecommissioned {
    pub router:    Pubkey,
    pub router_id: String,
    pub owner:     Pubkey,
    pub authority: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct RewardRateUpdated {
    pub authority:     Pubkey,
    pub previous_rate: u64,
    pub new_rate:      u64,
    pub timestamp:     i64,
}
