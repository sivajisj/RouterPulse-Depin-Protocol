use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::state::{Protocol, Router, Stake};
use crate::errors::RouterPulseError;

/// Posts collateral for a router. Tokens move from the operator's own
/// token account into the protocol-owned stake vault via a plain SPL
/// transfer — the operator signs, so no PDA signing is needed on the
/// way in (unlike `unstake`, where the vault must sign).
pub fn handler(ctx: Context<StakeCollateral>, amount: u64) -> Result<()> {
    require!(!ctx.accounts.protocol.is_paused, RouterPulseError::ProtocolPaused);
    require!(amount > 0, RouterPulseError::InvalidStakeAmount);

    let now = Clock::get()?.unix_timestamp;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from:      ctx.accounts.owner_token_account.to_account_info(),
                to:        ctx.accounts.stake_vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
    )?;

    let stake = &mut ctx.accounts.stake;
    if stake.created_at == 0 {
        stake.router     = ctx.accounts.router.key();
        stake.owner      = ctx.accounts.owner.key();
        stake.created_at = now;
        stake.bump       = ctx.bumps.stake;
    }

    stake.amount = stake.amount
        .checked_add(amount)
        .ok_or(RouterPulseError::Overflow)?;
    // Push the lock forward on every top-up, so collateral can't be
    // posted just long enough to pass an activation check and then
    // withdrawn within the same epoch.
    stake.locked_until = now
        .checked_add(ctx.accounts.protocol.stake_lock_duration)
        .ok_or(RouterPulseError::Overflow)?;

    ctx.accounts.router.staked_amount = stake.amount;

    ctx.accounts.protocol.total_staked = ctx.accounts.protocol.total_staked
        .checked_add(amount)
        .ok_or(RouterPulseError::Overflow)?;

    emit!(CollateralStaked {
        router:       stake.router,
        owner:        stake.owner,
        amount,
        total_staked: stake.amount,
        locked_until: stake.locked_until,
        timestamp:    now,
    });

    msg!("Staked {} for router {}. Total: {}", amount, stake.router, stake.amount);
    Ok(())
}

#[derive(Accounts)]
pub struct StakeCollateral<'info> {
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
        init_if_needed,
        payer = owner,
        space = 8 + Stake::INIT_SPACE,
        seeds = [Stake::SEED, router.key().as_ref()],
        bump,
    )]
    pub stake: Account<'info, Stake>,

    #[account(
        address = protocol.reward_mint @ RouterPulseError::InvalidRewardMint
    )]
    pub reward_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [Stake::VAULT_SEED],
        bump,
        token::mint = reward_mint,
        token::authority = protocol,
    )]
    pub stake_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = reward_mint,
        token::authority = owner,
    )]
    pub owner_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct CollateralStaked {
    pub router:       Pubkey,
    pub owner:        Pubkey,
    pub amount:       u64,
    pub total_staked: u64,
    pub locked_until: i64,
    pub timestamp:    i64,
}
