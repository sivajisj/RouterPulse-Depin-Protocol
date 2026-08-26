use anchor_lang::prelude::*;
use crate::state::{Protocol, Router, RouterStatus, RouterEpoch};
use crate::errors::RouterPulseError;
use crate::uptime;

/// Records a heartbeat and does two independent things with it:
///
/// 1. Updates the router's live `uptime_score`, which drives immediate
///    auto-suspension of a misbehaving router. This is a safety valve,
///    not a reward input.
/// 2. Increments the `heartbeats` counter on the `RouterEpoch` for the
///    *current* epoch (created lazily here on first touch). This is
///    the only thing `claim_reward` ever reads — so a router cannot
///    accrue reward for an epoch it went silent in, no matter what its
///    lifetime counters say.
pub fn handler(ctx: Context<Heartbeat>, epoch_number: u64) -> Result<()> {

    let now = Clock::get()?.unix_timestamp;
    let protocol = &ctx.accounts.protocol;

    require!(!protocol.is_paused, RouterPulseError::ProtocolPaused);

    let expected_epoch = protocol.epoch_number_at(now);
    require!(epoch_number == expected_epoch, RouterPulseError::WrongEpochNumber);

    let heartbeat_interval        = protocol.heartbeat_interval;
    let epoch_duration            = protocol.epoch_duration;
    let (epoch_start, epoch_end)  = protocol.epoch_bounds(epoch_number);

    // ── live scoring — drives suspension, independent of reward accounting ──
    {
        let router = &mut ctx.accounts.router;

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
            router.status          = RouterStatus::Active;
            router.last_heartbeat  = now;
            router.heartbeat_count = router.heartbeat_count
                .checked_add(1)
                .ok_or(RouterPulseError::Overflow)?;

            emit!(HeartbeatReceived {
                router_id:    router.router_id.clone(),
                owner:        router.owner,
                epoch_number,
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
                epoch_number,
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
    }

    // ── epoch bookkeeping — the only input to reward accounting ──
    let router_key    = ctx.accounts.router.key();
    let router_epoch  = &mut ctx.accounts.router_epoch;

    if router_epoch.expected_heartbeats == 0 {
        // Freshly created by init_if_needed (all fields zeroed) — open it.
        router_epoch.router              = router_key;
        router_epoch.epoch_number        = epoch_number;
        router_epoch.start_time          = epoch_start;
        router_epoch.end_time            = epoch_end;
        router_epoch.expected_heartbeats = (epoch_duration / heartbeat_interval).max(1) as u32;
        router_epoch.bump                = ctx.bumps.router_epoch;
    }

    require!(!router_epoch.finalized, RouterPulseError::EpochAlreadyFinalized);

    router_epoch.heartbeats = router_epoch.heartbeats
        .checked_add(1)
        .ok_or(RouterPulseError::Overflow)?;

    Ok(())
}

#[derive(Accounts)]
#[instruction(epoch_number: u64)]
pub struct Heartbeat<'info> {
    #[account(
        mut,
        seeds = [
            Router::SEED,
            router.owner.as_ref(),
            router.router_id.as_bytes(),
        ],
        bump = router.bump,
    )]
    pub router: Account<'info, Router>,

    #[account(
        seeds = [Protocol::SEED],
        bump  = protocol.bump,
    )]
    pub protocol: Account<'info, Protocol>,

    /// The device key registered for this router — NOT the owner
    /// wallet. See `rotate_device_key` for recovery from a compromised
    /// device.
    #[account(
        mut,
        constraint = device.key() == router.device_pubkey @ RouterPulseError::InvalidDeviceSigner
    )]
    pub device: Signer<'info>,

    #[account(
        init_if_needed,
        payer = device,
        space = 8 + RouterEpoch::INIT_SPACE,
        seeds = [RouterEpoch::SEED, router.key().as_ref(), &epoch_number.to_le_bytes()],
        bump
    )]
    pub router_epoch: Account<'info, RouterEpoch>,

    pub system_program: Program<'info, System>,
}

#[event]
pub struct HeartbeatReceived {
    pub router_id:    String,
    pub owner:        Pubkey,
    pub epoch_number: u64,
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
