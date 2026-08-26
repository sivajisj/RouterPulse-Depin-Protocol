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

    // epoch
    #[msg("Epoch duration must span at least a handful of heartbeat intervals")]
    InvalidEpochDuration,

    #[msg("Supplied epoch number does not match the current on-chain clock")]
    WrongEpochNumber,

    #[msg("Epoch has not ended yet")]
    EpochNotEnded,

    #[msg("Epoch has already been finalized")]
    EpochAlreadyFinalized,

    #[msg("Epoch has not been finalized yet")]
    EpochNotFinalized,

    #[msg("Epoch reward has already been claimed")]
    EpochAlreadyClaimed,

    #[msg("This epoch record does not belong to the given router")]
    EpochRouterMismatch,

    // device identity
    #[msg("Signer is not the router's registered device key")]
    InvalidDeviceSigner,

    #[msg("New device key must differ from the current one")]
    DeviceKeyUnchanged,

    // staking
    #[msg("Stake amount must be greater than zero")]
    InvalidStakeAmount,

    #[msg("Router has not staked the protocol minimum")]
    InsufficientStake,

    #[msg("Staked collateral is still within its lock period")]
    StakeLocked,

    #[msg("Cannot unstake more than is currently staked")]
    UnstakeExceedsStake,

    #[msg("Unstaking would drop an active router below the minimum stake")]
    UnstakeBelowMinimum,

    #[msg("This epoch has already been slashed")]
    EpochAlreadySlashed,

    #[msg("This epoch's performance does not warrant a slash")]
    NothingToSlash,

    #[msg("Stake account does not belong to the given router")]
    StakeRouterMismatch,

    // emissions / vesting
    #[msg("Epoch emission budget is exhausted")]
    EmissionExhausted,

    #[msg("Emission decay must be between 1 and 10000 basis points")]
    InvalidEmissionDecay,

    #[msg("Vesting duration must be at least the cliff duration")]
    InvalidVestingSchedule,

    #[msg("No tokens have vested yet")]
    NothingVested,

    #[msg("Vesting record does not belong to the given router")]
    VestingRouterMismatch,

    // token
    #[msg("Token mint does not match the protocol reward mint")]
    InvalidRewardMint,

    #[msg("Burn amount must be greater than zero")]
    InvalidBurnAmount,

    #[msg("Genesis allocation is exhausted")]
    GenesisAllocationExhausted,
}
