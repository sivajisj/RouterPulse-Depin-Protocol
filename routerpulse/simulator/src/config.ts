import { Connection, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import type { Routerpulse } from "../../target/types/routerpulse";

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

export const PROGRAM_ID = new PublicKey(
    "BD41MBys55QSTYgsL3S5RmkSu19PVqtfTje3XhZgnbtD"
);

export const RPC_URL   = "http://127.0.0.1:8899";
export const HEARTBEAT_INTERVAL_MS = 5_000;  // 5 seconds for simulation
