use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::state::{Protocol, Router, RouterStatus, Stake};
use crate::errors::RouterPulseError;

/// Withdraws collateral back to the operator. The stake vault is owned
/// by the protocol PDA, so this transfer must be signed by the program
/// via `invoke_signed` — the operator's signature alone cannot move
/// tokens out of the vault.
pub fn handler(ctx: Context<Unstake>, amount: u64) -> Result<()> {
    require!(!ctx.accounts.protocol.is_paused, RouterPulseError::ProtocolPaused);
    require!(amount > 0, RouterPulseError::InvalidStakeAmount);

    let now = Clock::get()?.unix_timestamp;

    require!(
        ctx.accounts.stake.router == ctx.accounts.router.key(),
        RouterPulseError::StakeRouterMismatch
    );
    require!(
        amount <= ctx.accounts.stake.amount,
        RouterPulseError::UnstakeExceedsStake
    );
    require!(
        now >= ctx.accounts.stake.locked_until,
        RouterPulseError::StakeLocked
    );

    let remaining = ctx.accounts.stake.amount - amount;

    // An active router must stay collateralized. To withdraw below the
    // minimum the operator has to decommission the router first, which
    // stops it earning — you cannot keep earning with nothing at risk.
    if ctx.accounts.router.status == RouterStatus::Active {
        require!(
            remaining >= ctx.accounts.protocol.min_stake,
            RouterPulseError::UnstakeBelowMinimum
        );
    }

    let protocol_bump = ctx.accounts.protocol.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[Protocol::SEED, &[protocol_bump]]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from:      ctx.accounts.stake_vault.to_account_info(),
                to:        ctx.accounts.owner_token_account.to_account_info(),
                authority: ctx.accounts.protocol.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    ctx.accounts.stake.amount = remaining;
    ctx.accounts.router.staked_amount = remaining;

    ctx.accounts.protocol.total_staked = ctx.accounts.protocol.total_staked
        .saturating_sub(amount);

    emit!(CollateralUnstaked {
        router:       ctx.accounts.stake.router,
        owner:        ctx.accounts.stake.owner,
        amount,
        remaining,
        timestamp:    now,
    });

    msg!("Unstaked {}. Remaining: {}", amount, remaining);
    Ok(())
}

#[derive(Accounts)]
pub struct Unstake<'info> {
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
        seeds   = [Stake::SEED, router.key().as_ref()],
        bump    = stake.bump,
        has_one = owner,
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

    pub owner: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[event]
pub struct CollateralUnstaked {
    pub router:    Pubkey,
    pub owner:     Pubkey,
    pub amount:    u64,
    pub remaining: u64,
    pub timestamp: i64,
}
