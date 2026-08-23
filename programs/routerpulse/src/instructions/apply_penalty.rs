use anchor_lang::prelude::*;
use crate::state::{Protocol, Router, RouterStatus};
use crate::errors::RouterPulseError;

pub fn handler(ctx: Context<ApplyPenalty>) -> Result<()> {

    let now    = Clock::get()?.unix_timestamp;
    let router = &mut ctx.accounts.router;

    // only authority can apply penalties
    require!(
        ctx.accounts.authority.key() == ctx.accounts.protocol.authority,
        RouterPulseError::Unauthorized
    );

    // can't penalize decommissioned router
    require!(
        router.status != RouterStatus::Decommissioned,
        RouterPulseError::RouterDecommissioned
    );

    let protocol      = &ctx.accounts.protocol;
    let penalty_bps   = protocol.penalty_bps as u64;

    // penalty = total_rewards * penalty_bps / 10000
    let penalty_amount = router.total_rewards
        .checked_mul(penalty_bps)
        .ok_or(RouterPulseError::Overflow)?
        .checked_div(10_000)
        .ok_or(RouterPulseError::Overflow)?;

    // deduct from total_rewards, floor at 0
    router.total_rewards = router.total_rewards
        .saturating_sub(penalty_amount);

    router.total_penalties = router.total_penalties
        .checked_add(penalty_amount)
        .ok_or(RouterPulseError::Overflow)?;

    // drop uptime score by 20 on manual penalty
    router.uptime_score = router.uptime_score.saturating_sub(20);

    // suspend if score too low
    if router.uptime_score <= Router::SUSPENSION_THRESHOLD
        && router.status == RouterStatus::Active
    {
        router.status = RouterStatus::Suspended;
    }

    emit!(PenaltyApplied {
        router_id:      router.router_id.clone(),
        owner:          router.owner,
        penalty_amount,
        uptime_score:   router.uptime_score,
        timestamp:      now,
    });

    msg!(
        "Penalty applied to {}. Amount: {}. Score: {}",
        router.router_id,
        penalty_amount,
        router.uptime_score
    );

    Ok(())
}

#[derive(Accounts)]
pub struct ApplyPenalty<'info> {
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

#[event]
pub struct PenaltyApplied {
    pub router_id:      String,
    pub owner:          Pubkey,
    pub penalty_amount: u64,
    pub uptime_score:   u8,
    pub timestamp:      i64,
}
