

use anchor_lang::prelude::*;
use crate::state::Protocol;
use crate::errors::RouterPulseError;

//  Instruction Handler 
pub fn handler(
    ctx: Context<InitializeProtocol>,
    reward_rate: u64,
    penalty_bps: u16,
    heartbeat_interval: i64,
) -> Result<()> {

    //  Validation 

    // reward_rate must be non-zero, zero means no one ever earns anything
    require!(
        reward_rate > 0,
        RouterPulseError::InvalidRewardRate
    );

    // penalty_bps must be between 0 and 10000 (0% to 100%)
    // Anything above 10000 is mathematically invalid
    require!(
        penalty_bps <= 10_000,
        RouterPulseError::InvalidPenaltyBps
    );

    // Heartbeat interval must be positive
    // Minimum 60 seconds , unrealistic to heartbeat faster in production
    require!(
        heartbeat_interval >= 60,
        RouterPulseError::InvalidHeartbeatInterval
    );

    //  Set Protocol State 

    let protocol = &mut ctx.accounts.protocol;

  
    protocol.authority              = ctx.accounts.authority.key();
    protocol.reward_rate            = reward_rate;
    protocol.penalty_bps            = penalty_bps;
    protocol.heartbeat_interval     = heartbeat_interval;
    protocol.total_routers          = 0;
    protocol.total_rewards_distributed = 0;
    protocol.is_paused              = false;

    
    protocol.bump                   = ctx.bumps.protocol;

    //  Emit Event 
    // Events are indexed by RPC nodes
    emit!(ProtocolInitialized {
        authority:          protocol.authority,
        reward_rate:        protocol.reward_rate,
        penalty_bps:        protocol.penalty_bps,
        heartbeat_interval: protocol.heartbeat_interval,
        timestamp:          Clock::get()?.unix_timestamp,
    });

    msg!(
        "RouterPulse protocol initialized. Authority: {}, Reward rate: {}",
        protocol.authority,
        protocol.reward_rate
    );

    Ok(())
}

//  Account Validation Struct 

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

//  Event Definition 

#[event]
pub struct ProtocolInitialized {
    pub authority:          Pubkey,
    pub reward_rate:        u64,
    pub penalty_bps:        u16,
    pub heartbeat_interval: i64,
    pub timestamp:          i64,
}