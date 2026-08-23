use anchor_lang::prelude::*;
use crate::state::{Protocol, Router, RouterStatus};
use crate::errors::RouterPulseError;
use crate::uptime;

pub fn handler(ctx: Context<Heartbeat>) -> Result<()> {

    let now                = Clock::get()?.unix_timestamp;
    let heartbeat_interval = ctx.accounts.protocol.heartbeat_interval;
    let router             = &mut ctx.accounts.router;

    // block suspended and decommissioned routers
    require!(
        router.status != RouterStatus::Suspended,
        RouterPulseError::RouterSuspended
    );
    require!(
        router.status != RouterStatus::Decommissioned,
        RouterPulseError::RouterDecommissioned
    );

    if router.heartbeat_count == 0 {
        // first heartbeat — activate router, no penalty
        router.status         = RouterStatus::Active;
        router.last_heartbeat = now;
        router.heartbeat_count = router.heartbeat_count
            .checked_add(1)
            .ok_or(RouterPulseError::Overflow)?;

        emit!(HeartbeatReceived {
            router_id:    router.router_id.clone(),
            owner:        router.owner,
            timestamp:    now,
            uptime_score: router.uptime_score,
            was_on_time:  true,
            is_first:     true,
        });

        msg!("First heartbeat: {}. Now Active.", router.router_id);

    } else {
        let elapsed = now
            .checked_sub(router.last_heartbeat)
            .ok_or(RouterPulseError::InvalidTimestamp)?;

        // same block replay check
        require!(elapsed > 0, RouterPulseError::HeartbeatTooSoon);

        // delegate all score math to uptime module
        let result = uptime::calculate(
            router.uptime_score,
            elapsed,
            heartbeat_interval,
        );

        // apply result
        router.uptime_score = result.new_score;
        router.missed_heartbeats = router.missed_heartbeats
            .checked_add(result.missed_count)
            .ok_or(RouterPulseError::Overflow)?;

        // suspend if score too low
        if uptime::should_suspend(router.uptime_score) &&
           router.status == RouterStatus::Active {
            router.status = RouterStatus::Suspended;

            emit!(RouterSuspended {
                router_id:    router.router_id.clone(),
                owner:        router.owner,
                uptime_score: router.uptime_score,
                timestamp:    now,
            });

            msg!("Router {} suspended. Score: {}", router.router_id, router.uptime_score);
        }

        router.last_heartbeat  = now;
        router.heartbeat_count = router.heartbeat_count
            .checked_add(1)
            .ok_or(RouterPulseError::Overflow)?;

        emit!(HeartbeatReceived {
            router_id:    router.router_id.clone(),
            owner:        router.owner,
            timestamp:    now,
            uptime_score: router.uptime_score,
            was_on_time:  result.was_on_time,
            is_first:     false,
        });

        msg!(
            "Heartbeat: {}. on_time: {}. score: {}. elapsed: {}s",
            router.router_id,
            result.was_on_time,
            router.uptime_score,
            elapsed
        );
    }

    Ok(())
}

#[derive(Accounts)]
pub struct Heartbeat<'info> {
    #[account(
        mut,
        seeds = [
            Router::SEED,
            owner.key().as_ref(),
            router.router_id.as_bytes(),
        ],
        bump    = router.bump,
        has_one = owner,
    )]
    pub router: Account<'info, Router>,

    #[account(
        seeds = [Protocol::SEED],
        bump  = protocol.bump,
    )]
    pub protocol: Account<'info, Protocol>,

    pub owner: Signer<'info>,
}

#[event]
pub struct HeartbeatReceived {
    pub router_id:    String,
    pub owner:        Pubkey,
    pub timestamp:    i64,
    pub uptime_score: u8,
    pub was_on_time:  bool,
    pub is_first:     bool,
}

#[event]
pub struct RouterSuspended {
    pub router_id:    String,
    pub owner:        Pubkey,
    pub uptime_score: u8,
    pub timestamp:    i64,
}