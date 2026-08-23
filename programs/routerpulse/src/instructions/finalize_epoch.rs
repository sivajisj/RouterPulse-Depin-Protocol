use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;

use crate::errors::RouterPulseError;
use crate::events::EpochFinalized;
use crate::state::{Epoch, EpochStatus, Protocol, Reward};

/// One router's scoring output for this epoch, as computed off-chain by
/// services/scorer. `penalty_amount` isn't carried here yet — every Reward
/// this instruction creates starts at penalty_amount = 0; wiring
/// compliance-violation penalties through to an on-chain deduction is
/// deferred to pass 2.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RewardInput {
    pub router: Pubkey,
    /// 0-10000 fixed-point, matches services/scorer/src/scoring.rs's SCALE.
    pub service_score: u16,
    pub reward_weight: u64,
}

/// Creates one Reward PDA per entry in `inputs`, in the same order as
/// `ctx.remaining_accounts`. Anchor's `#[derive(Accounts)]` can't declare a
/// dynamic number of `init` accounts, so each Reward PDA is created here by
/// hand: a `system_instruction::create_account` CPI signed with the PDA's
/// own seeds, followed by `try_serialize` to write the Anchor discriminator
/// + borsh data in one call — the same manual invoke_signed pattern this
/// program already uses for the V1 reward vault (see the old claim_reward
/// vault transfer), just building an account instead of moving lamports
/// out of one.
pub fn handler<'info>(
    ctx: Context<'info, FinalizeEpoch<'info>>,
    proof_root: [u8; 32],
    total_network_weight: u64,
    inputs: Vec<RewardInput>,
) -> Result<()> {
    require!(
        ctx.accounts.authority.key() == ctx.accounts.protocol.authority,
        RouterPulseError::Unauthorized
    );
    require!(
        !ctx.accounts.epoch.finalized,
        RouterPulseError::EpochAlreadyFinalized
    );
    require!(total_network_weight > 0, RouterPulseError::TotalNetworkWeightZero);
    require!(
        inputs.len() == ctx.remaining_accounts.len(),
        RouterPulseError::RewardAccountMismatch
    );

    let epoch_id = ctx.accounts.epoch.epoch_id;
    let reward_budget = ctx.accounts.epoch.reward_budget;
    let epoch_id_bytes = epoch_id.to_le_bytes();

    let mut total_distributed: u64 = 0;
    let mut total_eligible_weight: u64 = 0;

    for (input, reward_account_info) in inputs.iter().zip(ctx.remaining_accounts.iter()) {
        // CHECKED fixed-point math: reward_amount = budget * weight / total_weight.
        // Widened to u128 for the multiply only — budget and weight are each
        // raw u64 token/weight units, and their product can exceed u64
        // before the divide brings it back down (a plain u64 checked_mul
        // would spuriously fail on realistic values well before an actual
        // overflow attack). Still fully checked, still zero floats — same
        // discipline as services/scorer/src/scoring.rs's fixed-point math,
        // just one integer width wider than that module needs, since that
        // module's operands are pre-bounded to a 0..=10000 scale and these
        // aren't.
        let reward_amount: u64 = (reward_budget as u128)
            .checked_mul(input.reward_weight as u128)
            .ok_or(RouterPulseError::Overflow)?
            .checked_div(total_network_weight as u128)
            .ok_or(RouterPulseError::Overflow)?
            .try_into()
            .map_err(|_| RouterPulseError::Overflow)?;

        total_distributed = total_distributed
            .checked_add(reward_amount)
            .ok_or(RouterPulseError::Overflow)?;
        total_eligible_weight = total_eligible_weight
            .checked_add(input.reward_weight)
            .ok_or(RouterPulseError::Overflow)?;

        let (expected_pda, reward_bump) = Pubkey::find_program_address(
            &[Reward::SEED, input.router.as_ref(), &epoch_id_bytes],
            ctx.program_id,
        );
        require_keys_eq!(
            reward_account_info.key(),
            expected_pda,
            RouterPulseError::RewardAccountMismatch
        );

        let space = 8 + Reward::INIT_SPACE;
        let lamports = Rent::get()?.minimum_balance(space);

        let reward_seeds: &[&[u8]] = &[
            Reward::SEED,
            input.router.as_ref(),
            &epoch_id_bytes,
            &[reward_bump],
        ];

        invoke_signed(
            &system_instruction::create_account(
                &ctx.accounts.authority.key(),
                &expected_pda,
                lamports,
                space as u64,
                ctx.program_id,
            ),
            &[
                ctx.accounts.authority.to_account_info(),
                reward_account_info.clone(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[reward_seeds],
        )?;

        let reward = Reward {
            router: input.router,
            epoch: epoch_id,
            service_score: input.service_score,
            reward_weight: input.reward_weight,
            reward_amount,
            penalty_amount: 0,
            claimed: false,
            proof_commitment: proof_root,
            bump: reward_bump,
        };

        let mut data = reward_account_info.try_borrow_mut_data()?;
        reward.try_serialize(&mut &mut data[..])?;
    }

    let epoch = &mut ctx.accounts.epoch;
    epoch.total_eligible_weight = total_eligible_weight;
    epoch.total_distributed = total_distributed;
    epoch.proof_root = proof_root;
    epoch.status = EpochStatus::Finalized;
    epoch.finalized = true;

    emit!(EpochFinalized {
        epoch_id,
        total_distributed,
        total_eligible_weight,
        proof_root,
        timestamp: Clock::get()?.unix_timestamp,
    });

    msg!(
        "Epoch {} finalized. Distributed: {} across {} router(s)",
        epoch_id,
        total_distributed,
        inputs.len()
    );

    Ok(())
}

#[derive(Accounts)]
pub struct FinalizeEpoch<'info> {
    #[account(
        mut,
        seeds = [Epoch::SEED, &epoch.epoch_id.to_le_bytes()],
        bump = epoch.bump,
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
    // remaining_accounts: one not-yet-created Reward PDA per `inputs`
    // entry, in the same order, at
    // seeds=[Reward::SEED, input.router, epoch_id.to_le_bytes()].
}
