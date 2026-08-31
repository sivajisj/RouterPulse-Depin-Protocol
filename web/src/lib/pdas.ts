import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import idl from "./idl/routerpulse.json";

/// PDA derivations, mirroring the on-chain seeds exactly.
///
/// Deliberately framework-free — no React, no wallet adapter — so this
/// is importable from a plain Node script. That matters: it means the
/// headless verification exercises *this* code rather than a parallel
/// re-implementation that could silently drift from what the UI does.
///
/// The IDL is vendored into this package rather than read from
/// ../routerpulse/target/, which is gitignored build output. Vendoring
/// lets the dashboard build in CI and Docker without the Anchor
/// toolchain; the tradeoff is it can drift from the deployed program,
/// which `npm run sync-idl` refreshes. A mismatch fails loudly — Anchor
/// rejects an instruction whose discriminator doesn't match.
export const PROGRAM_ID = new PublicKey((idl as any).address);

const enc = (s: string) => Buffer.from(s);
const u64 = (n: number | BN) => new BN(n).toArrayLike(Buffer, "le", 8);
const pda = (seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

export const protocolPda   = () => pda([enc("protocol")]);
export const rewardMintPda = () => pda([enc("reward_mint")]);
export const stakeVaultPda = () => pda([enc("stake_vault")]);
export const treasuryPda   = () => pda([enc("treasury")]);

export const routerPda = (owner: PublicKey, routerId: string) =>
    pda([enc("router"), owner.toBuffer(), enc(routerId)]);

export const stakePda = (router: PublicKey) =>
    pda([enc("stake"), router.toBuffer()]);

export const routerEpochPda = (router: PublicKey, epoch: number | BN) =>
    pda([enc("router_epoch"), router.toBuffer(), u64(epoch)]);

export const vestingPda = (router: PublicKey, epoch: number | BN) =>
    pda([enc("vesting"), router.toBuffer(), u64(epoch)]);

export const emissionPda = (epoch: number | BN) =>
    pda([enc("emission"), u64(epoch)]);
