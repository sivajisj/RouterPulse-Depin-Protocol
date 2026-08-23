use anchor_lang::prelude::*;

// NOTE: every other event in this program is defined locally in its own
// instructions/*.rs file (e.g. ProtocolInitialized in
// initialize_protocol.rs) rather than here — this file was empty before
// this change. New V2 events are added here per Step 6's explicit
// instruction; matching the field-alignment style those events use.

#[event]
pub struct EpochOpened {
    pub epoch_id:      u64,
    pub reward_budget: u64,
    pub start_time:    i64,
    pub end_time:      i64,
    pub timestamp:     i64,
}

#[event]
pub struct EpochFinalized {
    pub epoch_id:              u64,
    pub total_distributed:     u64,
    pub total_eligible_weight: u64,
    pub proof_root:            [u8; 32],
    pub timestamp:             i64,
}

#[event]
pub struct RewardClaimed {
    pub router:    Pubkey,
    pub epoch_id:  u64,
    pub amount:    u64,
    pub timestamp: i64,
}
