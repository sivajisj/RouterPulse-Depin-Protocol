use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::state::{Protocol, Router, RouterEpoch, Stake};
use crate::errors::RouterPulseError;

/// Executes the slash that `finalize_router_epoch` already computed for
/// a given epoch, moving collateral from the stake vault to the
/// treasury.
///
/// Permissionless for the same reason finalization is: the amount was
/// fixed at finalization from public state, so the caller has no
/// discretion — they can only trigger a transfer whose size was already
/// determined. That means a keeper can enforce penalties without anyone
/// holding a privileged slashing key.
pub fn handler(ctx: Context<SlashRouter>, _epoch_number: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    require!(
        ctx.accounts.router_epoch.router == ctx.accounts.router.key(),
        RouterPulseError::EpochRouterMismatch
    );
    require!(
        ctx.accounts.stake.router == ctx.accounts.router.key(),
        RouterPulseError::StakeRouterMismatch
    );
    require!(ctx.accounts.router_epoch.finalized, RouterPulseError::EpochNotFinalized);
    require!(!ctx.accounts.router_epoch.slashed, RouterPulseError::EpochAlreadySlashed);

    // Collateral may have shrunk since finalization (an earlier epoch
    // slashed first), so re-clamp against what is actually left.
    let amount = ctx.accounts.router_epoch.slash_amount.min(ctx.accounts.stake.amount);
    require!(amount > 0, RouterPulseError::NothingToSlash);

    // Mark slashed before the CPI (checks-effects-interactions).
    ctx.accounts.router_epoch.slashed = true;

    let protocol_bump = ctx.accounts.protocol.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[Protocol::SEED, &[protocol_bump]]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from:      ctx.accounts.stake_vault.to_account_info(),
                to:        ctx.accounts.treasury.to_account_info(),
                authority: ctx.accounts.protocol.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    let stake = &mut ctx.accounts.stake;
    stake.amount = stake.amount.saturating_sub(amount);
    stake.total_slashed = stake.total_slashed
        .checked_add(amount)
        .ok_or(RouterPulseError::Overflow)?;

    ctx.accounts.router.staked_amount = stake.amount;
    ctx.accounts.router.total_penalties = ctx.accounts.router.total_penalties
        .checked_add(amount)
        .ok_or(RouterPulseError::Overflow)?;

    ctx.accounts.protocol.total_staked = ctx.accounts.protocol.total_staked.saturating_sub(amount);
    ctx.accounts.protocol.total_slashed = ctx.accounts.protocol.total_slashed
        .checked_add(amount)
        .ok_or(RouterPulseError::Overflow)?;

    emit!(RouterSlashed {
        router:          ctx.accounts.router.key(),
        owner:           ctx.accounts.router.owner,
        epoch_number:    ctx.accounts.router_epoch.epoch_number,
        uptime_bps:      ctx.accounts.router_epoch.uptime_bps,
        amount,
        remaining_stake: ctx.accounts.stake.amount,
        timestamp:       now,
    });

    msg!(
        "Slashed {} from router {} for epoch {}. Remaining stake: {}",
        amount,
        ctx.accounts.router.key(),
        ctx.accounts.router_epoch.epoch_number,
        ctx.accounts.stake.amount,
    );

    Ok(())
}

#[derive(Accounts)]
#[instruction(epoch_number: u64)]
pub struct SlashRouter<'info> {
    #[account(mut)]
    pub router: Account<'info, Router>,

    // Boxed: Protocol is by far the largest state struct in this program
    // (it grew a lot in Phase 2 — the mint/stake/emission/vesting config
    // all live on it), and this instruction already touches six other
    // accounts. Left unboxed, `try_accounts` exceeds the BPF VM's 4096
    // byte stack-frame limit — Anchor's own fix for that is to move the
    // large account off the stack and onto the heap.
    #[account(
        mut,
        seeds = [Protocol::SEED],
        bump  = protocol.bump,
    )]
    pub protocol: Box<Account<'info, Protocol>>,

    #[account(
        mut,
        seeds = [RouterEpoch::SEED, router.key().as_ref(), &epoch_number.to_le_bytes()],
        bump  = router_epoch.bump,
    )]
    pub router_epoch: Account<'info, RouterEpoch>,

    #[account(
        mut,
        seeds = [Stake::SEED, router.key().as_ref()],
        bump  = stake.bump,
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
        seeds = [Protocol::TREASURY_SEED],
        bump,
        token::mint = reward_mint,
        token::authority = protocol,
    )]
    pub treasury: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[event]
pub struct RouterSlashed {
    pub router:          Pubkey,
    pub owner:           Pubkey,
    pub epoch_number:    u64,
    pub uptime_bps:      u16,
    pub amount:          u64,
    pub remaining_stake: u64,
    pub timestamp:       i64,
}
