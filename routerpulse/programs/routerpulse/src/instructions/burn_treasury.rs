use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount};
use crate::state::Protocol;
use crate::errors::RouterPulseError;

/// Burns slashed collateral out of the treasury, permanently reducing
/// supply.
///
/// This is what closes the economic loop: slashing moves tokens from a
/// bad operator to the treasury, and burning them makes that penalty
/// deflationary for every remaining holder rather than a transfer of
/// value to whoever controls the treasury. Authority-gated because it
/// is a governance decision (burn now vs. redeploy the treasury), not
/// a mechanical one.
pub fn handler(ctx: Context<BurnTreasury>, amount: u64) -> Result<()> {
    require!(
        ctx.accounts.authority.key() == ctx.accounts.protocol.authority,
        RouterPulseError::Unauthorized
    );
    require!(amount > 0, RouterPulseError::InvalidBurnAmount);
    require!(
        ctx.accounts.treasury.amount >= amount,
        RouterPulseError::InsufficientVaultBalance
    );

    let protocol_bump = ctx.accounts.protocol.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[Protocol::SEED, &[protocol_bump]]];

    token::burn(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Burn {
                mint:      ctx.accounts.reward_mint.to_account_info(),
                from:      ctx.accounts.treasury.to_account_info(),
                authority: ctx.accounts.protocol.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    ctx.accounts.protocol.total_burned = ctx.accounts.protocol.total_burned
        .checked_add(amount)
        .ok_or(RouterPulseError::Overflow)?;

    emit!(TreasuryBurned {
        amount,
        total_burned: ctx.accounts.protocol.total_burned,
        timestamp:    Clock::get()?.unix_timestamp,
    });

    msg!("Burned {} from treasury. Lifetime burned: {}", amount, ctx.accounts.protocol.total_burned);
    Ok(())
}

#[derive(Accounts)]
pub struct BurnTreasury<'info> {
    #[account(
        mut,
        seeds = [Protocol::SEED],
        bump  = protocol.bump,
    )]
    pub protocol: Account<'info, Protocol>,

    #[account(
        mut,
        address = protocol.reward_mint @ RouterPulseError::InvalidRewardMint
    )]
    pub reward_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [Protocol::TREASURY_SEED],
        bump,
        token::mint = reward_mint,
        token::authority = protocol,
    )]
    pub treasury: Account<'info, TokenAccount>,

    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[event]
pub struct TreasuryBurned {
    pub amount:       u64,
    pub total_burned: u64,
    pub timestamp:    i64,
}
