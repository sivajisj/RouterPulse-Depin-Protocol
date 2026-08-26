use anchor_lang::prelude::*;
use crate::state::{Protocol, Router, RouterStatus, RouterEpoch};
use crate::errors::RouterPulseError;

/// Pays out the reward locked in by `finalize_router_epoch` for one
/// specific, already-closed epoch. Reward comes exclusively from
/// `router_epoch.reward_amount` — never recomputed from lifetime
/// counters — and `router_epoch.claimed` makes double-claiming the
/// same epoch impossible.
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

        // Mark claimed before the CPI transfer (checks-effects-interactions).
        router_epoch.claimed = true;
        epoch_number = router_epoch.epoch_number;
        uptime_bps    = router_epoch.uptime_bps;
    }

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
    ctx.accounts.router.total_rewards = ctx.accounts.router.total_rewards
        .checked_add(reward_amount)
        .ok_or(RouterPulseError::Overflow)?;
    ctx.accounts.router.last_claim_time = now;

    // update protocol stats
    ctx.accounts.protocol.total_rewards_distributed =
        ctx.accounts.protocol.total_rewards_distributed
            .checked_add(reward_amount)
            .ok_or(RouterPulseError::Overflow)?;

    emit!(RewardClaimed {
        router_id:    ctx.accounts.router.router_id.clone(),
        owner:        ctx.accounts.router.owner,
        epoch_number,
        amount:       reward_amount,
        uptime_bps,
        timestamp:    now,
    });

    msg!(
        "Reward: {} lamports for {} (epoch {}). Uptime: {} bps",
        reward_amount,
        ctx.accounts.router.router_id,
        epoch_number,
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
    pub router_id:    String,
    pub owner:        Pubkey,
    pub epoch_number: u64,
    pub amount:       u64,
    pub uptime_bps:   u16,
    pub timestamp:    i64,
}
