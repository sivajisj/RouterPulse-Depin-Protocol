use anchor_lang::prelude::*;
use crate::state::Protocol;
use crate::errors::RouterPulseError;

pub fn handler(
    ctx: Context<InitializeProtocol>,
    reward_rate: u64,
    penalty_bps: u16,
    heartbeat_interval: i64,
) -> Result<()> {

    require!(reward_rate > 0,          RouterPulseError::InvalidRewardRate);
    require!(penalty_bps <= 10_000,    RouterPulseError::InvalidPenaltyBps);
    require!(heartbeat_interval >= 60, RouterPulseError::InvalidHeartbeatInterval);

    // compute vault bump without creating the account
    // vault is funded separately via direct SOL transfer
    let (_, vault_bump) = Pubkey::find_program_address(
        &[b"reward_vault", ctx.accounts.protocol.key().as_ref()],
        ctx.program_id,
    );

    let protocol = &mut ctx.accounts.protocol;

    protocol.authority                 = ctx.accounts.authority.key();
    protocol.reward_rate               = reward_rate;
    protocol.penalty_bps               = penalty_bps;
    protocol.heartbeat_interval        = heartbeat_interval;
    protocol.total_routers             = 0;
    protocol.total_rewards_distributed = 0;
    protocol.is_paused                 = false;
    protocol.bump                      = ctx.bumps.protocol;
    protocol.vault_bump                = vault_bump;

    emit!(ProtocolInitialized {
        authority:          protocol.authority,
        reward_rate:        protocol.reward_rate,
        penalty_bps:        protocol.penalty_bps,
        heartbeat_interval: protocol.heartbeat_interval,
        timestamp:          Clock::get()?.unix_timestamp,
    });

    msg!(
        "RouterPulse initialized. Authority: {}, Reward rate: {}",
        protocol.authority,
        protocol.reward_rate
    );

    Ok(())
}

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Protocol::INIT_SPACE,
        seeds = [Protocol::SEED],
        bump,
    )]
    pub protocol: Account<'info, Protocol>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[event]
pub struct ProtocolInitialized {
    pub authority:          Pubkey,
    pub reward_rate:        u64,
    pub penalty_bps:        u16,
    pub heartbeat_interval: i64,
    pub timestamp:          i64,
}
