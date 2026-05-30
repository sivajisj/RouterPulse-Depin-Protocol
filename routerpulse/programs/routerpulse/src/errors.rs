use anchor_lang::prelude::*;

#[error_code]
pub enum RouterPulseError {
    //  Protocol Errors 
    #[msg("Reward rate must be greater than zero")]
    InvalidRewardRate,

    #[msg("Penalty basis points must be between 0 and 10000")]
    InvalidPenaltyBps,

    #[msg("Heartbeat interval must be at least 60 seconds")]
    InvalidHeartbeatInterval,

    #[msg("Protocol is currently paused")]
    ProtocolPaused,

    #[msg("Unauthorized: only protocol authority can perform this action")]
    Unauthorized,

    //  Router Errors 
    #[msg("Router ID cannot be empty")]
    RouterIdEmpty,

    #[msg("Router ID cannot exceed 32 characters")]
    RouterIdTooLong,

    #[msg("Latitude must be between -90000000 and 90000000")]
    InvalidLatitude,

    #[msg("Longitude must be between -180000000 and 180000000")]
    InvalidLongitude,

    #[msg("Arithmetic overflow")]
    Overflow,
}