use anchor_lang::prelude::*;
use crate::state::{Protocol, Router, RouterStatus};
use crate::errors::RouterPulseError;
use crate::uptime;

pub fn handler(ctx: Context<ClaimReward>) -> Result<()> {

    let now    = Clock::get()?.unix_timestamp;
    let router = &mut ctx.accounts.router;

    require!(
        router.status == RouterStatus::Active,
        RouterPulseError::RouterNotActive
    );

    require!(
        router.heartbeat_count > 0,
        RouterPulseError::NoHeartbeatYet
    );

    let claim_start = if router.last_claim_time == 0 {
        router.registered_at
    } else {
        router.last_claim_time
    };

    let elapsed = now
        .checked_sub(claim_start)
        .ok_or(RouterPulseError::InvalidTimestamp)?;

    require!(elapsed > 0, RouterPulseError::NothingToClaim);

    let uptime_pct = uptime::uptime_percentage(
        router.heartbeat_count,
        router.missed_heartbeats,
    );

    let base_reward = (elapsed as u64)
        .checked_mul(ctx.accounts.protocol.reward_rate)
        .ok_or(RouterPulseError::Overflow)?;

    let reward_amount = base_reward
        .checked_mul(uptime_pct)
        .ok_or(RouterPulseError::Overflow)?
        .checked_div(100)
        .ok_or(RouterPulseError::Overflow)?;

    require!(reward_amount > 0, RouterPulseError::NothingToClaim);

    let vault_balance = ctx.accounts.reward_vault.lamports();
    require!(
        vault_balance >= reward_amount,
        RouterPulseError::InsufficientVaultBalance
    );

    // Transfer SOL from vault PDA to owner via invoke_signed.
    // The vault is a system-owned PDA (no allocated data), so direct
    // lamport manipulation is not allowed — we must go through the
    // system program with the vault's PDA seeds as the signer.
    let protocol_key = ctx.accounts.protocol.key();
    let vault_seeds: &[&[u8]] = &[
        b"reward_vault",
        protocol_key.as_ref(),
        &[ctx.accounts.protocol.vault_bump],
    ];
    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.reward_vault.key(),
            &ctx.accounts.owner.key(),
            reward_amount,
        ),
        &[
            ctx.accounts.reward_vault.to_account_info(),
            ctx.accounts.owner.to_account_info(),
        ],
        &[vault_seeds],
    )?;

    // update router
    router.total_rewards = router.total_rewards
        .checked_add(reward_amount)
        .ok_or(RouterPulseError::Overflow)?;
    router.last_claim_time = now;

    // update protocol stats
    ctx.accounts.protocol.total_rewards_distributed =
        ctx.accounts.protocol.total_rewards_distributed
            .checked_add(reward_amount)
            .ok_or(RouterPulseError::Overflow)?;

    emit!(RewardClaimed {
        router_id:  router.router_id.clone(),
        owner:      router.owner,
        amount:     reward_amount,
        uptime_pct,
        elapsed:    elapsed as u64,
        timestamp:  now,
    });

    msg!(
        "Reward: {} lamports for {}. Uptime: {}%",
        reward_amount,
        router.router_id,
        uptime_pct
    );

    Ok(())
}

#[derive(Accounts)]
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

    /// CHECK: PDA vault holding SOL for rewards
    #[account(
        mut,
        seeds = [b"reward_vault", protocol.key().as_ref()],
        bump  = protocol.vault_bump,
    )]
    pub reward_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[event]
pub struct RewardClaimed {
    pub router_id:  String,
    pub owner:      Pubkey,
    pub amount:     u64,
    pub uptime_pct: u64,
    pub elapsed:    u64,
    pub timestamp:  i64,
}
