use anchor_lang::prelude::*;

use crate::errors::RouterPulseError;
use crate::events::EpochOpened;
use crate::state::{Epoch, EpochStatus, Protocol};

pub fn handler(
    ctx: Context<OpenEpoch>,
    epoch_id: u64,
    reward_budget: u64,
    start_time: i64,
    end_time: i64,
) -> Result<()> {
    require!(
        ctx.accounts.authority.key() == ctx.accounts.protocol.authority,
        RouterPulseError::Unauthorized
    );
    require!(end_time > start_time, RouterPulseError::InvalidEpochWindow);
    require!(reward_budget > 0, RouterPulseError::InvalidRewardBudget);

    let epoch = &mut ctx.accounts.epoch;
    epoch.epoch_id = epoch_id;
    epoch.start_time = start_time;
    epoch.end_time = end_time;
    epoch.reward_budget = reward_budget;
    epoch.total_eligible_weight = 0;
    epoch.total_distributed = 0;
    // Set for real by finalize_epoch once the off-chain scoring bundle for
    // this epoch exists — nothing to commit to yet at open time.
    epoch.proof_root = [0u8; 32];
    epoch.status = EpochStatus::Open;
    epoch.finalized = false;
    epoch.bump = ctx.bumps.epoch;

    emit!(EpochOpened {
        epoch_id,
        reward_budget,
        start_time,
        end_time,
        timestamp: Clock::get()?.unix_timestamp,
    });

    msg!("Epoch {} opened. Budget: {}", epoch_id, reward_budget);
    Ok(())
}

#[derive(Accounts)]
#[instruction(epoch_id: u64)]
pub struct OpenEpoch<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Epoch::INIT_SPACE,
        seeds = [Epoch::SEED, &epoch_id.to_le_bytes()],
        bump,
    )]
    pub epoch: Account<'info, Epoch>,

    #[account(
        seeds = [Protocol::SEED],
        bump = protocol.bump,
    )]
    pub protocol: Account<'info, Protocol>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}
