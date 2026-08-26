use anchor_lang::prelude::*;
use crate::state::{Protocol, Router, RouterEpoch};
use crate::errors::RouterPulseError;
use crate::constants::BASIS_POINTS_DIVISOR;

/// Permissionless crank: closes a router's epoch record once its time
/// window has passed, locking in `uptime_bps` and `reward_amount` from
/// the heartbeats actually observed. Anyone can call this (an indexer,
/// a keeper bot, the operator itself) — it reads only public on-chain
/// state and cannot be front-run or manipulated by the caller, so no
/// signer is required.
pub fn handler(ctx: Context<FinalizeRouterEpoch>, _epoch_number: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let reward_rate = ctx.accounts.protocol.reward_rate;

    let router_epoch = &mut ctx.accounts.router_epoch;

    require!(
        router_epoch.router == ctx.accounts.router.key(),
        RouterPulseError::EpochRouterMismatch
    );
    require!(!router_epoch.finalized, RouterPulseError::EpochAlreadyFinalized);
    require!(now >= router_epoch.end_time, RouterPulseError::EpochNotEnded);

    // Clamp in case of a pathological expected/received mismatch —
    // uptime can never exceed 100%.
    let heartbeats = router_epoch.heartbeats.min(router_epoch.expected_heartbeats) as u64;
    let expected   = router_epoch.expected_heartbeats as u64;

    let uptime_bps: u64 = if expected == 0 {
        0
    } else {
        heartbeats
            .checked_mul(BASIS_POINTS_DIVISOR)
            .ok_or(RouterPulseError::Overflow)?
            .checked_div(expected)
            .ok_or(RouterPulseError::Overflow)?
    };

    let epoch_duration = router_epoch.end_time
        .checked_sub(router_epoch.start_time)
        .ok_or(RouterPulseError::InvalidTimestamp)? as u64;

    let base_reward = epoch_duration
        .checked_mul(reward_rate)
        .ok_or(RouterPulseError::Overflow)?;

    let reward_amount = base_reward
        .checked_mul(uptime_bps)
        .ok_or(RouterPulseError::Overflow)?
        .checked_div(BASIS_POINTS_DIVISOR)
        .ok_or(RouterPulseError::Overflow)?;

    router_epoch.uptime_bps    = uptime_bps as u16;
    router_epoch.reward_amount = reward_amount;
    router_epoch.finalized     = true;

    emit!(RouterEpochFinalized {
        router:              router_epoch.router,
        epoch_number:        router_epoch.epoch_number,
        heartbeats:          router_epoch.heartbeats,
        expected_heartbeats: router_epoch.expected_heartbeats,
        uptime_bps:          router_epoch.uptime_bps,
        reward_amount,
        timestamp:           now,
    });

    msg!(
        "Epoch {} finalized for {}. uptime_bps={} reward={}",
        router_epoch.epoch_number,
        router_epoch.router,
        router_epoch.uptime_bps,
        reward_amount
    );

    Ok(())
}

#[derive(Accounts)]
#[instruction(epoch_number: u64)]
pub struct FinalizeRouterEpoch<'info> {
    pub router: Account<'info, Router>,

    #[account(
        seeds = [Protocol::SEED],
        bump  = protocol.bump,
    )]
    pub protocol: Account<'info, Protocol>,

    #[account(
        mut,
        seeds = [RouterEpoch::SEED, router.key().as_ref(), &epoch_number.to_le_bytes()],
        bump  = router_epoch.bump,
    )]
    pub router_epoch: Account<'info, RouterEpoch>,
}

#[event]
pub struct RouterEpochFinalized {
    pub router:              Pubkey,
    pub epoch_number:        u64,
    pub heartbeats:          u32,
    pub expected_heartbeats: u32,
    pub uptime_bps:          u16,
    pub reward_amount:       u64,
    pub timestamp:           i64,
}
