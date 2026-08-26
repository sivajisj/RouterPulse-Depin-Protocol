use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::state::{Protocol, Stake};
use crate::errors::RouterPulseError;
use crate::constants::MIN_HEARTBEATS_PER_EPOCH;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProtocolConfig {
    pub reward_rate: u64,
    pub penalty_bps: u16,
    pub heartbeat_interval: i64,
    pub epoch_duration: i64,
    pub min_stake: u64,
    pub stake_lock_duration: i64,
    pub reward_cliff_duration: i64,
    pub reward_vesting_duration: i64,
    pub initial_emission_per_epoch: u64,
    pub epochs_per_year: u64,
    pub emission_decay_bps: u16,
    pub genesis_allocation: u64,
}

pub fn handler(ctx: Context<InitializeProtocol>, config: ProtocolConfig) -> Result<()> {

    require!(config.reward_rate > 0,          RouterPulseError::InvalidRewardRate);
    require!(config.penalty_bps <= 10_000,    RouterPulseError::InvalidPenaltyBps);
    require!(config.heartbeat_interval >= 60, RouterPulseError::InvalidHeartbeatInterval);
    require!(
        config.epoch_duration >= config.heartbeat_interval.saturating_mul(MIN_HEARTBEATS_PER_EPOCH),
        RouterPulseError::InvalidEpochDuration
    );
    require!(
        config.emission_decay_bps > 0 && config.emission_decay_bps <= 10_000,
        RouterPulseError::InvalidEmissionDecay
    );
    require!(
        config.reward_vesting_duration >= config.reward_cliff_duration
            && config.reward_cliff_duration >= 0,
        RouterPulseError::InvalidVestingSchedule
    );

    // compute vault bump without creating the account
    // vault is funded separately via direct SOL transfer
    let (_, vault_bump) = Pubkey::find_program_address(
        &[b"reward_vault", ctx.accounts.protocol.key().as_ref()],
        ctx.program_id,
    );

    let now = Clock::get()?.unix_timestamp;
    let protocol = &mut ctx.accounts.protocol;

    protocol.authority                 = ctx.accounts.authority.key();
    protocol.reward_rate               = config.reward_rate;
    protocol.penalty_bps               = config.penalty_bps;
    protocol.heartbeat_interval        = config.heartbeat_interval;
    protocol.epoch_duration            = config.epoch_duration;
    protocol.genesis_time              = now;
    protocol.reward_mint               = ctx.accounts.reward_mint.key();
    protocol.min_stake                 = config.min_stake;
    protocol.stake_lock_duration       = config.stake_lock_duration;
    protocol.reward_cliff_duration     = config.reward_cliff_duration;
    protocol.reward_vesting_duration   = config.reward_vesting_duration;
    protocol.initial_emission_per_epoch = config.initial_emission_per_epoch;
    protocol.epochs_per_year           = config.epochs_per_year;
    protocol.emission_decay_bps        = config.emission_decay_bps;
    protocol.genesis_allocation        = config.genesis_allocation;
    protocol.genesis_minted            = 0;
    protocol.total_routers             = 0;
    protocol.total_rewards_distributed = 0;
    protocol.total_staked              = 0;
    protocol.total_slashed             = 0;
    protocol.total_minted              = 0;
    protocol.total_burned              = 0;
    protocol.is_paused                 = false;
    protocol.bump                      = ctx.bumps.protocol;
    protocol.vault_bump                = vault_bump;

    emit!(ProtocolInitialized {
        authority:          protocol.authority,
        reward_mint:        protocol.reward_mint,
        reward_rate:        protocol.reward_rate,
        penalty_bps:        protocol.penalty_bps,
        heartbeat_interval: protocol.heartbeat_interval,
        epoch_duration:     protocol.epoch_duration,
        min_stake:          protocol.min_stake,
        genesis_time:       protocol.genesis_time,
        timestamp:          now,
    });

    msg!(
        "RouterPulse initialized. Authority: {}, Mint: {}, Epoch: {}s, Min stake: {}",
        protocol.authority,
        protocol.reward_mint,
        protocol.epoch_duration,
        protocol.min_stake,
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

    /// Reward mint, created here as a PDA with the protocol PDA as its
    /// sole mint authority. No freeze authority is set: the protocol
    /// can issue and slash, but must not be able to freeze a holder's
    /// tokens.
    #[account(
        init,
        payer = authority,
        seeds = [Protocol::MINT_SEED],
        bump,
        mint::decimals = Protocol::REWARD_DECIMALS,
        mint::authority = protocol,
    )]
    pub reward_mint: Account<'info, Mint>,

    /// Holds every operator's staked collateral.
    #[account(
        init,
        payer = authority,
        seeds = [Stake::VAULT_SEED],
        bump,
        token::mint = reward_mint,
        token::authority = protocol,
    )]
    pub stake_vault: Account<'info, TokenAccount>,

    /// Receives slashed collateral.
    #[account(
        init,
        payer = authority,
        seeds = [Protocol::TREASURY_SEED],
        bump,
        token::mint = reward_mint,
        token::authority = protocol,
    )]
    pub treasury: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[event]
pub struct ProtocolInitialized {
    pub authority:          Pubkey,
    pub reward_mint:        Pubkey,
    pub reward_rate:        u64,
    pub penalty_bps:        u16,
    pub heartbeat_interval: i64,
    pub epoch_duration:     i64,
    pub min_stake:          u64,
    pub genesis_time:       i64,
    pub timestamp:          i64,
}
