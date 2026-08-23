use anchor_lang::prelude::*;

#[error_code]
pub enum RouterPulseError {
    // protocol
    #[msg("Reward rate must be greater than zero")]
    InvalidRewardRate,

    #[msg("Penalty basis points must be between 0 and 10000")]
    InvalidPenaltyBps,

    #[msg("Heartbeat interval must be at least 60 seconds")]
    InvalidHeartbeatInterval,

    #[msg("Protocol is currently paused")]
    ProtocolPaused,

    #[msg("Protocol is already paused")]
    AlreadyPaused,

    #[msg("Protocol is not paused")]
    NotPaused,

    #[msg("Unauthorized")]
    Unauthorized,

    // router
    #[msg("Router ID cannot be empty")]
    RouterIdEmpty,

    #[msg("Router ID cannot exceed 32 characters")]
    RouterIdTooLong,

    #[msg("Invalid latitude")]
    InvalidLatitude,

    #[msg("Invalid longitude")]
    InvalidLongitude,

    #[msg("Arithmetic overflow")]
    Overflow,

    #[msg("Router is not suspended")]
    RouterNotSuspended,

    // heartbeat
    #[msg("Router is suspended")]
    RouterSuspended,

    #[msg("Router is decommissioned")]
    RouterDecommissioned,

    #[msg("Heartbeat too soon")]
    HeartbeatTooSoon,

    #[msg("Invalid timestamp")]
    InvalidTimestamp,

    // reward
    #[msg("Router must be Active to claim rewards")]
    RouterNotActive,

    #[msg("No heartbeat sent yet")]
    NoHeartbeatYet,

    #[msg("No rewards to claim")]
    NothingToClaim,

    #[msg("Vault has insufficient balance")]
    InsufficientVaultBalance,

    // epoch / reward v2
    #[msg("Epoch start time must be before end time")]
    InvalidEpochWindow,

    #[msg("Reward budget must be greater than zero")]
    InvalidRewardBudget,

    #[msg("Epoch has already been finalized")]
    EpochAlreadyFinalized,

    #[msg("Epoch has not been finalized yet")]
    EpochNotFinalized,

    #[msg("Total network weight must be greater than zero")]
    TotalNetworkWeightZero,

    #[msg("Reward input list length does not match the accounts provided")]
    RewardAccountMismatch,

    #[msg("Reward has already been claimed")]
    RewardAlreadyClaimed,

    #[msg("Treasury has insufficient balance to pay this reward")]
    InsufficientTreasuryBalance,
}
