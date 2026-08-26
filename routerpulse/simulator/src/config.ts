import { Connection, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import type { Routerpulse } from "../../target/types/routerpulse";
// Imported directly (not via anchor.BN) — see tests/routerpulse.ts for why.
import BN from "bn.js";

// load wallet from solana default keypair
export function loadWallet(): anchor.web3.Keypair {
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
    const idlPath = path.join(
        __dirname,
        "../../target/idl/routerpulse.json"
    );
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

export const RPC_URL   = "http://127.0.0.1:8899";
export const HEARTBEAT_INTERVAL_MS = 5_000;  // 5 seconds for simulation
