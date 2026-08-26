use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use crate::state::{Protocol, Router, RewardVesting};
use crate::errors::RouterPulseError;
use crate::math;

/// Mints the portion of an epoch's reward that has vested since the
/// last call, straight to the beneficiary.
///
/// This is the only instruction in the program that increases token
/// supply. The mint authority is the protocol PDA, so issuance happens
/// exclusively through `invoke_signed` here — there is no human-held
/// mint key anywhere in the system.
pub fn handler(ctx: Context<ClaimVested>, _epoch_number: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    require!(!ctx.accounts.protocol.is_paused, RouterPulseError::ProtocolPaused);
    require!(
        ctx.accounts.vesting.router == ctx.accounts.router.key(),
        RouterPulseError::VestingRouterMismatch
    );

    let vesting = &ctx.accounts.vesting;
    let vested = math::vested_amount(
        vesting.total_amount,
        vesting.start_time,
        vesting.cliff_duration,
        vesting.vesting_duration,
        now,
    );

    // Only the newly-vested delta — `claimed_amount` is what stops this
    // from paying the same slice out twice.
    let releasable = vested.saturating_sub(vesting.claimed_amount);
    require!(releasable > 0, RouterPulseError::NothingVested);

    let protocol_bump = ctx.accounts.protocol.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[Protocol::SEED, &[protocol_bump]]];

    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            MintTo {
                mint:      ctx.accounts.reward_mint.to_account_info(),
                to:        ctx.accounts.beneficiary_token_account.to_account_info(),
                authority: ctx.accounts.protocol.to_account_info(),
            },
            signer_seeds,
        ),
        releasable,
    )?;

    let vesting = &mut ctx.accounts.vesting;
    vesting.claimed_amount = vesting.claimed_amount
        .checked_add(releasable)
        .ok_or(RouterPulseError::Overflow)?;

    ctx.accounts.protocol.total_minted = ctx.accounts.protocol.total_minted
        .checked_add(releasable)
        .ok_or(RouterPulseError::Overflow)?;

    emit!(VestedRewardClaimed {
        router:        vesting.router,
        beneficiary:   vesting.beneficiary,
        epoch_number:  vesting.epoch_number,
        amount:        releasable,
        total_claimed: vesting.claimed_amount,
        total_amount:  vesting.total_amount,
        timestamp:     now,
    });

    msg!(
        "Minted {} vested tokens for epoch {} ({} of {} claimed)",
        releasable,
        vesting.epoch_number,
        vesting.claimed_amount,
        vesting.total_amount,
    );

    Ok(())
}

#[derive(Accounts)]
#[instruction(epoch_number: u64)]
pub struct ClaimVested<'info> {
    #[account(
        seeds   = [Router::SEED, beneficiary.key().as_ref(), router.router_id.as_bytes()],
        bump    = router.bump,
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
        seeds      = [RewardVesting::SEED, router.key().as_ref(), &epoch_number.to_le_bytes()],
        bump       = vesting.bump,
        constraint = vesting.beneficiary == beneficiary.key() @ RouterPulseError::Unauthorized,
    )]
    pub vesting: Account<'info, RewardVesting>,

    #[account(
        mut,
        address = protocol.reward_mint @ RouterPulseError::InvalidRewardMint
    )]
    pub reward_mint: Account<'info, Mint>,

    #[account(
        mut,
        token::mint = reward_mint,
        token::authority = beneficiary,
    )]
    pub beneficiary_token_account: Account<'info, TokenAccount>,

    pub beneficiary: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[event]
pub struct VestedRewardClaimed {
    pub router:        Pubkey,
    pub beneficiary:   Pubkey,
    pub epoch_number:  u64,
    pub amount:        u64,
    pub total_claimed: u64,
    pub total_amount:  u64,
    pub timestamp:     i64,
}
