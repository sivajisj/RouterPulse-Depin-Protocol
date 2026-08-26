use anchor_lang::prelude::*;
use crate::state::Router;
use crate::errors::RouterPulseError;

/// Owner-signed recovery path: swaps the key that is authorized to
/// sign heartbeats for this router. Used when a physical device is
/// lost, replaced, or suspected compromised — the owner's main wallet
/// never needs to sit on the device itself.
pub fn handler(ctx: Context<RotateDeviceKey>, new_device_pubkey: Pubkey) -> Result<()> {
    let router = &mut ctx.accounts.router;

    require!(
        new_device_pubkey != router.device_pubkey,
        RouterPulseError::DeviceKeyUnchanged
    );

    let old_device_pubkey = router.device_pubkey;
    router.device_pubkey = new_device_pubkey;
    router.device_key_version = router.device_key_version
        .checked_add(1)
        .ok_or(RouterPulseError::Overflow)?;

    emit!(DeviceKeyRotated {
        router_id:          router.router_id.clone(),
        owner:              router.owner,
        old_device_pubkey,
        new_device_pubkey,
        device_key_version: router.device_key_version,
        timestamp:          Clock::get()?.unix_timestamp,
    });

    msg!(
        "Device key rotated for {}. version={}",
        router.router_id,
        router.device_key_version
    );

    Ok(())
}

#[derive(Accounts)]
pub struct RotateDeviceKey<'info> {
    #[account(
        mut,
        seeds   = [Router::SEED, owner.key().as_ref(), router.router_id.as_bytes()],
        bump    = router.bump,
        has_one = owner,
    )]
    pub router: Account<'info, Router>,

    pub owner: Signer<'info>,
}

#[event]
pub struct DeviceKeyRotated {
    pub router_id:          String,
    pub owner:               Pubkey,
    pub old_device_pubkey:   Pubkey,
    pub new_device_pubkey:   Pubkey,
    pub device_key_version:  u16,
    pub timestamp:           i64,
}
