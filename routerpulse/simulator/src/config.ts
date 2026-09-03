import { Connection, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import type { Routerpulse } from "../../target/types/routerpulse";
// Imported directly (not via anchor.BN) — see tests/routerpulse.ts for why.
import BN from "bn.js";

/// Loads the operator wallet.
///
/// Prefers `SOLANA_SECRET_KEY` so this can run somewhere with no home
/// directory — CI, a container — and falls back to the CLI's default
/// keypair for local use. Both encodings are accepted because the two
/// obvious things to paste into a secret are the contents of `id.json`
/// (a JSON byte array) and the base58 string a wallet exports; guessing
/// wrong otherwise fails with an unhelpful length error.
export function loadWallet(): anchor.web3.Keypair {
    const inline = process.env.SOLANA_SECRET_KEY?.trim();
    if (inline) {
        const bytes = inline.startsWith("[")
            ? Uint8Array.from(JSON.parse(inline))
            : anchor.utils.bytes.bs58.decode(inline);
        if (bytes.length !== 64) {
            throw new Error(
                `SOLANA_SECRET_KEY decoded to ${bytes.length} bytes, expected 64. ` +
                `A 32-byte value is a public key, not a secret key.`
            );
        }
        return anchor.web3.Keypair.fromSecretKey(bytes);
    }

    const keyPath = path.join(
        process.env.HOME || "",
        ".config/solana/id.json"
    );
    const raw = JSON.parse(fs.readFileSync(keyPath, "utf-8"));
    return anchor.web3.Keypair.fromSecretKey(Uint8Array.from(raw));
}

// load program from local IDL
export function loadProgram(
    wallet: anchor.web3.Keypair,
    connection: Connection
): anchor.Program<Routerpulse> {
    // anchor's build output first (freshest, and what a local dev has),
    // then the copy committed for the indexer. A checkout without a
    // build — CI, a container — only ever has the second.
    const candidates = [
        process.env.SIMULATOR_IDL_PATH,
        path.join(__dirname, "../../target/idl/routerpulse.json"),
        path.join(__dirname, "../../../indexer/idl/routerpulse.json"),
    ].filter(Boolean) as string[];

    const idlPath = candidates.find(p => fs.existsSync(p));
    if (!idlPath) {
        throw new Error(
            `No IDL found. Looked in:\n  ${candidates.join("\n  ")}\n` +
            `Run \`anchor build\` in routerpulse/, or set SIMULATOR_IDL_PATH.`
        );
    }
    const idl  = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    const programId = new PublicKey(idl.address);

    const provider = new anchor.AnchorProvider(
        connection,
        new anchor.Wallet(wallet),
        { commitment: "confirmed" }
    );

    return new anchor.Program(idl, provider);
}

// Mirrors Protocol::epoch_number_at on-chain. Client and program must
// always agree on which epoch is "current", since heartbeat() rejects
// any epoch_number that doesn't match the on-chain clock.
export function currentEpochNumber(protocol: any, nowSec: number): BN {
    const genesis  = protocol.genesisTime.toNumber();
    const duration = protocol.epochDuration.toNumber();
    if (nowSec <= genesis || duration <= 0) return new BN(0);
    return new BN(Math.floor((nowSec - genesis) / duration));
}

function seedPda(programId: PublicKey, seeds: (Buffer | Uint8Array)[]): PublicKey {
    return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

const epochSeed = (epochNumber: BN) => epochNumber.toArrayLike(Buffer, "le", 8);

export const getProtocolPDA   = (programId: PublicKey) => seedPda(programId, [Buffer.from("protocol")]);
export const getRewardMintPDA = (programId: PublicKey) => seedPda(programId, [Buffer.from("reward_mint")]);
export const getStakeVaultPDA = (programId: PublicKey) => seedPda(programId, [Buffer.from("stake_vault")]);
export const getTreasuryPDA   = (programId: PublicKey) => seedPda(programId, [Buffer.from("treasury")]);

export function getRouterPDA(programId: PublicKey, owner: PublicKey, routerId: string): PublicKey {
    return seedPda(programId, [Buffer.from("router"), owner.toBuffer(), Buffer.from(routerId)]);
}

export function getStakePDA(programId: PublicKey, routerPDA: PublicKey): PublicKey {
    return seedPda(programId, [Buffer.from("stake"), routerPDA.toBuffer()]);
}

export function getRouterEpochPDA(
    programId: PublicKey,
    routerPDA: PublicKey,
    epochNumber: BN
): PublicKey {
    return seedPda(programId, [Buffer.from("router_epoch"), routerPDA.toBuffer(), epochSeed(epochNumber)]);
}

export function getVestingPDA(programId: PublicKey, routerPDA: PublicKey, epochNumber: BN): PublicKey {
    return seedPda(programId, [Buffer.from("vesting"), routerPDA.toBuffer(), epochSeed(epochNumber)]);
}

export function getEmissionPDA(programId: PublicKey, epochNumber: BN): PublicKey {
    return seedPda(programId, [Buffer.from("emission"), epochSeed(epochNumber)]);
}

export const PROGRAM_ID = new PublicKey(
    "4nVLSAiwNCBiepWwHdiafKcGzKHtaKu8YSPk24REG6d4"
);

export const RPC_URL   = process.env.RPC_URL || "http://127.0.0.1:8899";
export const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 5_000);

/// When set, the simulator sends heartbeats for this long and then exits
/// cleanly instead of running until interrupted. Unset (the default) is
/// the interactive behaviour: run until Ctrl-C. A scheduled job needs
/// the bounded form — an unbounded one would be killed mid-transaction
/// when the runner times out.
export const RUN_DURATION_MS = Number(process.env.RUN_DURATION_MS || 0);
