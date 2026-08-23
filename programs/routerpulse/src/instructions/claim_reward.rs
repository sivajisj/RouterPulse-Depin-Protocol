use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::RouterPulseError;
use crate::events::RewardClaimed;
use crate::state::{Epoch, Protocol, Reward, Router};

// V2 rewrite: the pre-Step-6 prototype paid SOL out of a system-owned
// `reward_vault` PDA, computed from Router-level elapsed time and
// `protocol.reward_rate`. That mechanism is gone from this instruction —
// rewards now come from a per-(router, epoch) Reward PDA that
// finalize_epoch already computed and created, paid out in RPULSE (SPL
// Token) from the Protocol-owned treasury ATA. Router.total_rewards /
// last_claim_time are the old V1 fields; this handler intentionally never
// writes them (same "kept but superseded" treatment uptime.rs's V1 scoring
// got — nothing reads them for reward purposes anymore).
pub fn handler(ctx: Context<ClaimReward>) -> Result<()> {
    require!(ctx.accounts.epoch.finalized, RouterPulseError::EpochNotFinalized);

    let reward = &mut ctx.accounts.reward;

    // SECURITY: check `claimed`, THEN set it to true, THEN transfer — not
    // transfer-then-mark. Solana has no JS-style mid-instruction
    // reentrancy (a callee can't call back into this program while this
    // instruction is still executing), so that classic reentrancy vector
    // doesn't apply here. Check-then-write is still the correct order,
    // for three separate reasons:
    //
    // 1. Cross-transaction races: Solana can process transactions
    //    touching the same writable account in any relative order the
    //    runtime picks, but never truly concurrently — each transaction
    //    execution sees the account state as of the last transaction
    //    that actually committed a write to it. If this handler
    //    transferred tokens first and only wrote `claimed = true`
    //    afterward, two claim_reward transactions racing for the same
    //    Reward PDA could BOTH execute their transfer (both reading
    //    claimed = false, since neither has committed yet) before either
    //    one's write to `claimed` lands — double-paying the operator.
    //    Writing `claimed = true` before the transfer CPI means the
    //    second transaction to actually commit sees `claimed = true`
    //    already and fails the require! below, regardless of how the
    //    runtime ordered/scheduled the two attempts.
    //
    // 2. Partial-failure safety: if the transfer CPI fails partway
    //    (insufficient treasury balance, a frozen token account, etc.),
    //    `claimed` must not already be durably set to true. We check
    //    the treasury balance BEFORE writing `claimed = true` (see the
    //    require! below), and a failed instruction rolls back every
    //    state change in the transaction — including the `claimed`
    //    write — so a failed transfer can never leave a Reward marked
    //    claimed with no tokens actually moved. Checking first keeps
    //    that guarantee explicit rather than relying solely on
    //    transaction atomicity to paper over the ordering.
    //
    // 3. Defensive against future changes: if a later edit adds another
    //    CPI before the reward payout (a fee transfer, an extra token
    //    move, a cross-program call), keeping the check-then-write ahead
    //    of ALL CPIs means that edit can't accidentally open a window
    //    where `claimed` is still false after tokens have already moved
    //    — the invariant holds regardless of what gets inserted after it.
    require!(!reward.claimed, RouterPulseError::RewardAlreadyClaimed);
    require_keys_eq!(
        reward.router,
        ctx.accounts.router.key(),
        RouterPulseError::Unauthorized
    );

    require!(
        ctx.accounts.treasury.amount >= reward.reward_amount,
        RouterPulseError::InsufficientTreasuryBalance
    );

    reward.claimed = true;
    let reward_amount = reward.reward_amount;
    let router_key = reward.router;
    let epoch_id = reward.epoch;

    let protocol_bump = ctx.accounts.protocol.bump;
    let protocol_seeds: &[&[u8]] = &[Protocol::SEED, &[protocol_bump]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.treasury.to_account_info(),
                to: ctx.accounts.operator_ata.to_account_info(),
                authority: ctx.accounts.protocol.to_account_info(),
            },
            &[protocol_seeds],
        ),
        reward_amount,
    )?;

    emit!(RewardClaimed {
        router: router_key,
        epoch_id,
        amount: reward_amount,
        timestamp: Clock::get()?.unix_timestamp,
    });

    msg!("Reward claimed: {} RPULSE for router {}", reward_amount, router_key);
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimReward<'info> {
    #[account(
        mut,
        seeds = [Reward::SEED, reward.router.as_ref(), &reward.epoch.to_le_bytes()],
        bump = reward.bump,
    )]
    pub reward: Account<'info, Reward>,

    #[account(
        seeds = [Epoch::SEED, &reward.epoch.to_le_bytes()],
        bump = epoch.bump,
    )]
    pub epoch: Account<'info, Epoch>,

    #[account(
        address = reward.router,
        has_one = owner,
    )]
    pub router: Account<'info, Router>,

    #[account(
        seeds = [Protocol::SEED],
        bump = protocol.bump,
    )]
    pub protocol: Account<'info, Protocol>,

    #[account(mut, address = protocol.treasury)]
    pub treasury: Account<'info, TokenAccount>,

    /// The operator's own RPULSE ATA. Pass 1 requires it to already exist
    /// (created via `spl-token create-account` or an ATA-creating wallet);
    /// auto-creating it here with `init_if_needed` is deferred to pass 2
    /// to avoid that pattern's re-init edge cases in a first pass.
    #[account(
        mut,
        associated_token::mint = protocol.token_mint,
        associated_token::authority = owner,
    )]
    pub operator_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub token_program: Program<'info, Token>,
}
