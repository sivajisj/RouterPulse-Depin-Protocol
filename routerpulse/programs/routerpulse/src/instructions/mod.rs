// Anchor's `#[program]` macro expands to code that reaches for
// `crate::instructions::__client_accounts_*` modules, which the
// `#[derive(Accounts)]` macro generates inside each instruction module.
// Those are only reachable through a glob re-export, so the globs below
// are mandatory — replacing them with an explicit export list breaks the
// build with an unresolved-import error pointing at `#[program]`.
//
// The cost is that every instruction module also exports its own
// `pub fn handler`, making the bare name `instructions::handler`
// ambiguous. That's harmless here because nothing ever refers to it —
// `lib.rs` always calls the fully-qualified
// `instructions::<module>::handler(..)`. Scoped to this module so the
// rest of the crate still fails CI on real ambiguity.
#![allow(ambiguous_glob_reexports)]

pub mod initialize_protocol;
pub mod register_router;
pub mod heartbeat;
pub mod finalize_router_epoch;
pub mod claim_reward;
pub mod claim_vested;
pub mod stake;
pub mod unstake;
pub mod slash_router;
pub mod burn_treasury;
pub mod mint_genesis;
pub mod apply_penalty;
pub mod rotate_device_key;
pub mod admin;

pub use initialize_protocol::*;
pub use register_router::*;
pub use heartbeat::*;
pub use finalize_router_epoch::*;
pub use claim_reward::*;
pub use claim_vested::*;
pub use stake::*;
pub use unstake::*;
pub use slash_router::*;
pub use burn_treasury::*;
pub use mint_genesis::*;
pub use apply_penalty::*;
pub use rotate_device_key::*;
pub use admin::*;
