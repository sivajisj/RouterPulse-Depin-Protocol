use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use crate::state::Protocol;
use crate::errors::RouterPulseError;

/// Distributes part of the fixed genesis allocation to a recipient.
///
/// This exists to solve a real bootstrap problem: reward tokens are only
/// ever minted by vesting, and vesting requires having earned rewards,
/// which requires having staked collateral — in the reward token. With
/// no initial distribution the system could never start, because nobody
/// could obtain the first token.
///
/// The mitigation for handing the authority a mint path is that the cap
/// is set once at initialization and enforced here: `genesis_minted` can
/// never exceed `genesis_allocation`, so the authority's total issuing
/// power is bounded and publicly auditable from day one. Once the
/// allocation is exhausted this instruction can never mint again, and
/// vesting becomes the only remaining source of supply.
pub fn handler(ctx: Context<MintGenesis>, amount: u64) -> Result<()> {
    require!(
        ctx.accounts.authority.key() == ctx.accounts.protocol.authority,
        RouterPulseError::Unauthorized
    );
    require!(amount > 0, RouterPulseError::InvalidStakeAmount);

    let protocol = &ctx.accounts.protocol;
    let remaining = protocol.genesis_allocation.saturating_sub(protocol.genesis_minted);
    require!(amount <= remaining, RouterPulseError::GenesisAllocationExhausted);

    let protocol_bump = protocol.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[Protocol::SEED, &[protocol_bump]]];

    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            MintTo {
                mint:      ctx.accounts.reward_mint.to_account_info(),
                to:        ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.protocol.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    let protocol = &mut ctx.accounts.protocol;
    protocol.genesis_minted = protocol.genesis_minted
        .checked_add(amount)
        .ok_or(RouterPulseError::Overflow)?;
    protocol.total_minted = protocol.total_minted
        .checked_add(amount)
        .ok_or(RouterPulseError::Overflow)?;

    emit!(GenesisMinted {
        recipient:        ctx.accounts.recipient_token_account.key(),
        amount,
        genesis_minted:   protocol.genesis_minted,
        genesis_remaining: protocol.genesis_allocation.saturating_sub(protocol.genesis_minted),
        timestamp:        Clock::get()?.unix_timestamp,
    });

    msg!(
        "Genesis minted {} ({} of {} allocated)",
        amount,
        protocol.genesis_minted,
        protocol.genesis_allocation,
    );
    Ok(())
}

#[derive(Accounts)]
pub struct MintGenesis<'info> {
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
        token::mint = reward_mint,
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[event]
pub struct GenesisMinted {
    pub recipient:         Pubkey,
    pub amount:            u64,
    pub genesis_minted:    u64,
    pub genesis_remaining: u64,
    pub timestamp:         i64,
}
