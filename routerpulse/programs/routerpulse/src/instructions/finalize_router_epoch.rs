use anchor_lang::prelude::*;
use crate::state::{Protocol, Router, RouterEpoch, EmissionSchedule, Stake};
use crate::errors::RouterPulseError;
use crate::constants::BASIS_POINTS_DIVISOR;
use crate::math;

/// Permissionless crank: closes a router's epoch record once its time
/// window has passed, locking in `uptime_bps`, `reward_amount` and
/// `slash_amount` from the heartbeats actually observed. Anyone can
/// call this (an indexer, a keeper bot, the operator) — it reads only
/// public on-chain state and writes a pure function of it, so it cannot
/// be manipulated by the caller and needs no authority.
pub fn handler(ctx: Context<FinalizeRouterEpoch>, epoch_number: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let protocol = &ctx.accounts.protocol;
    let reward_rate = protocol.reward_rate;

    // ── open the epoch's emission budget if this is the first router to finalize ──
    let emission = &mut ctx.accounts.emission;
    if emission.created_at == 0 {
        emission.epoch_number   = epoch_number;
        emission.total_emission = math::epoch_emission(
            protocol.initial_emission_per_epoch,
            epoch_number,
            protocol.epochs_per_year,
            protocol.emission_decay_bps,
        ).ok_or(RouterPulseError::Overflow)?;
        emission.allocated  = 0;
        emission.created_at = now;
        emission.bump       = ctx.bumps.emission;
    }

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
    let uptime_bps = uptime_bps as u16;

    let tier = math::performance_tier(uptime_bps);

    let epoch_duration = router_epoch.end_time
        .checked_sub(router_epoch.start_time)
        .ok_or(RouterPulseError::InvalidTimestamp)? as u64;

    let base_reward = epoch_duration
        .checked_mul(reward_rate)
        .ok_or(RouterPulseError::Overflow)?;

    // Uptime scales the reward, then the performance tier scales it
    // again — so a router at 90% uptime earns 0.90 * 0.75 of base, not
    // simply 0.75. Downtime is meant to compound against you.
    let uptime_scaled = math::apply_bps(base_reward, uptime_bps)
        .ok_or(RouterPulseError::Overflow)?;
    let tiered_reward = math::apply_bps(uptime_scaled, tier.reward_multiplier_bps)
        .ok_or(RouterPulseError::Overflow)?;

    // The epoch's emission budget is a hard ceiling. Routers finalizing
    // late in a crowded epoch get whatever is left rather than minting
    // fresh supply — extra routers dilute a fixed pool, they don't
    // expand it.
    let reward_amount = tiered_reward.min(emission.remaining());

    emission.allocated = emission.allocated
        .checked_add(reward_amount)
        .ok_or(RouterPulseError::Overflow)?;

    // Slash is a fraction of collateral currently at risk, and can
    // never exceed what is actually staked.
    let staked = ctx.accounts.stake.amount;
    let slash_amount = math::apply_bps(staked, tier.slash_bps)
        .ok_or(RouterPulseError::Overflow)?
        .min(staked);

    router_epoch.uptime_bps    = uptime_bps;
    router_epoch.reward_amount = reward_amount;
    router_epoch.slash_amount  = slash_amount;
    router_epoch.finalized     = true;

    emit!(RouterEpochFinalized {
        router:              router_epoch.router,
        epoch_number:        router_epoch.epoch_number,
        heartbeats:          router_epoch.heartbeats,
        expected_heartbeats: router_epoch.expected_heartbeats,
        uptime_bps:          router_epoch.uptime_bps,
        reward_multiplier_bps: tier.reward_multiplier_bps,
        reward_amount,
        slash_amount,
        emission_remaining:  emission.remaining(),
        timestamp:           now,
    });

    msg!(
        "Epoch {} finalized for {}. uptime_bps={} multiplier={} reward={} slash={}",
        router_epoch.epoch_number,
        router_epoch.router,
        router_epoch.uptime_bps,
        tier.reward_multiplier_bps,
        reward_amount,
        slash_amount,
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

    #[account(
        seeds   = [Stake::SEED, router.key().as_ref()],
        bump    = stake.bump,
        constraint = stake.router == router.key() @ RouterPulseError::StakeRouterMismatch,
    )]
    pub stake: Account<'info, Stake>,

    #[account(
        init_if_needed,
        payer = cranker,
        space = 8 + EmissionSchedule::INIT_SPACE,
        seeds = [EmissionSchedule::SEED, &epoch_number.to_le_bytes()],
        bump,
    )]
    pub emission: Account<'info, EmissionSchedule>,

    /// Whoever is turning the crank. Pays rent for the epoch's emission
    /// account if they happen to be the first to finalize it; otherwise
    /// only the transaction fee. Deliberately not required to be the
    /// operator or the authority.
    #[account(mut)]
    pub cranker: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[event]
pub struct RouterEpochFinalized {
    pub router:                Pubkey,
    pub epoch_number:          u64,
    pub heartbeats:            u32,
    pub expected_heartbeats:   u32,
    pub uptime_bps:            u16,
    pub reward_multiplier_bps: u16,
    pub reward_amount:         u64,
    pub slash_amount:          u64,
    pub emission_remaining:    u64,
    pub timestamp:             i64,
}
