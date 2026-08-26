use anchor_lang::prelude::*;
use crate::state::{Protocol, Router, RouterStatus, RouterEpoch, RewardVesting};
use crate::errors::RouterPulseError;

/// Converts a finalized epoch's reward into a vesting entitlement.
///
/// Deliberately moves no tokens. It records the right to mint on a
/// cliff + linear schedule; `claim_vested` mints each slice as it
/// actually vests. Two consequences worth stating plainly:
///
/// - Total supply only ever grows in step with vested rewards, so
///   there is no pre-minted pool sitting somewhere waiting to be
///   drained, and no vault balance that can drift out of sync with the
///   accounting.
/// - Operators are paid over time rather than in a lump, which means
///   a router that earns well for one epoch and then vanishes still
///   forfeits the unvested remainder.
pub fn handler(ctx: Context<ClaimReward>, _epoch_number: u64) -> Result<()> {

    let now = Clock::get()?.unix_timestamp;

    require!(!ctx.accounts.protocol.is_paused, RouterPulseError::ProtocolPaused);
    require!(
        ctx.accounts.router.status != RouterStatus::Decommissioned,
        RouterPulseError::RouterDecommissioned
    );

    let reward_amount;
    let epoch_number;
    let uptime_bps;
    {
        let router_epoch = &mut ctx.accounts.router_epoch;

        require!(
            router_epoch.router == ctx.accounts.router.key(),
            RouterPulseError::EpochRouterMismatch
        );
        require!(router_epoch.finalized, RouterPulseError::EpochNotFinalized);
        require!(!router_epoch.claimed, RouterPulseError::EpochAlreadyClaimed);

        reward_amount = router_epoch.reward_amount;
        require!(reward_amount > 0, RouterPulseError::NothingToClaim);

        router_epoch.claimed = true;
        epoch_number = router_epoch.epoch_number;
        uptime_bps   = router_epoch.uptime_bps;
    }

    let vesting = &mut ctx.accounts.vesting;
    vesting.router           = ctx.accounts.router.key();
    vesting.beneficiary      = ctx.accounts.owner.key();
    vesting.epoch_number     = epoch_number;
    vesting.total_amount     = reward_amount;
    vesting.claimed_amount   = 0;
    vesting.start_time       = now;
    vesting.cliff_duration   = ctx.accounts.protocol.reward_cliff_duration;
    vesting.vesting_duration = ctx.accounts.protocol.reward_vesting_duration;
    vesting.bump             = ctx.bumps.vesting;

    ctx.accounts.router.total_rewards = ctx.accounts.router.total_rewards
        .checked_add(reward_amount)
        .ok_or(RouterPulseError::Overflow)?;
    ctx.accounts.router.last_claim_time = now;

    ctx.accounts.protocol.total_rewards_distributed =
        ctx.accounts.protocol.total_rewards_distributed
            .checked_add(reward_amount)
            .ok_or(RouterPulseError::Overflow)?;

    emit!(RewardClaimed {
        router_id:        ctx.accounts.router.router_id.clone(),
        owner:            ctx.accounts.router.owner,
        epoch_number,
        amount:           reward_amount,
        uptime_bps,
        cliff_duration:   vesting.cliff_duration,
        vesting_duration: vesting.vesting_duration,
        timestamp:        now,
    });

    msg!(
        "Reward {} granted to {} (epoch {}), vesting over {}s after a {}s cliff. Uptime: {} bps",
        reward_amount,
        ctx.accounts.router.router_id,
        epoch_number,
        vesting.vesting_duration,
        vesting.cliff_duration,
        uptime_bps
    );

    Ok(())
}

#[derive(Accounts)]
#[instruction(epoch_number: u64)]
pub struct ClaimReward<'info> {
    #[account(
        mut,
        seeds   = [Router::SEED, owner.key().as_ref(), router.router_id.as_bytes()],
        bump    = router.bump,
        has_one = owner,
    )]
    pub router: Account<'info, Router>,

    #[account(
        mut,
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

    /// `init` (not `init_if_needed`): one vesting record per epoch,
    /// ever. Combined with the `claimed` flag on the epoch, this makes
    /// double-claiming fail two independent ways.
    #[account(
        init,
        payer = owner,
        space = 8 + RewardVesting::INIT_SPACE,
        seeds = [RewardVesting::SEED, router.key().as_ref(), &epoch_number.to_le_bytes()],
        bump,
    )]
    pub vesting: Account<'info, RewardVesting>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[event]
pub struct RewardClaimed {
    pub router_id:        String,
    pub owner:            Pubkey,
    pub epoch_number:     u64,
    pub amount:           u64,
    pub uptime_bps:       u16,
    pub cliff_duration:   i64,
    pub vesting_duration: i64,
    pub timestamp:        i64,
}
