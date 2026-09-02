import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { Connection, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { MongoClient, Db } from "mongodb";

dotenv.config();

export const RPC_URL   = process.env.RPC_URL   || "http://127.0.0.1:8899";
// solana-test-validator serves its pubsub websocket on RPC port + 1
// (8900 alongside the default 8899 RPC port), not on the RPC URL with
// just the scheme swapped — which is what Connection's auto-derivation
// assumes, and does correctly for devnet/mainnet RPC providers. Set this
// explicitly for local validators; leave unset elsewhere.
export const WS_URL: string | undefined = process.env.WS_URL;
export const MONGO_URL = process.env.MONGO_URL || "mongodb://127.0.0.1:27017";
export const MONGO_DB  = process.env.MONGO_DB  || "routerpulse";
// Resolves to `indexer/<IDL_PATH>` from both `src/` (ts-node) and `dist/`
// (compiled), so the same default works in dev and in a container. The
// default is the *vendored* copy rather than anchor's build output:
// deployments only check out this repo, and `routerpulse/target/` is
// gitignored build artifact that would not be there. Run `npm run
// sync-idl` after changing the program.
export const IDL_PATH  = path.resolve(__dirname, "..", process.env.IDL_PATH || "idl/routerpulse.json");
export const RECONCILE_INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS || 30_000);
// Optional: when set, newly-indexed events are published here for the
// API's WebSocket gateway to fan out. Indexing works fine without it.
export const REDIS_URL: string | undefined = process.env.REDIS_URL;
export const BACKFILL_PAGE_SIZE    = Number(process.env.BACKFILL_PAGE_SIZE || 1_000);

export function loadIdl(): anchor.Idl {
    if (!fs.existsSync(IDL_PATH)) {
        throw new Error(
            `IDL not found at ${IDL_PATH}. Run "anchor build" in ../routerpulse first, ` +
            `or point IDL_PATH at the generated target/idl/routerpulse.json.`
        );
    }
    return JSON.parse(fs.readFileSync(IDL_PATH, "utf-8"));
}

export function getConnection(): Connection {
    return new Connection(RPC_URL, { commitment: "confirmed", wsEndpoint: WS_URL });
}

export function getProgramId(idl: anchor.Idl): PublicKey {
    return new PublicKey((idl as any).address);
}

let mongoClient: MongoClient | null = null;

/// Single shared client for the process — the driver already pools
/// connections internally, so every module just calls this rather than
/// each opening its own client.
export async function getDb(): Promise<Db> {
    if (!mongoClient) {
        mongoClient = new MongoClient(MONGO_URL);
        await mongoClient.connect();
    }
    return mongoClient.db(MONGO_DB);
}

export async function closeDb(): Promise<void> {
    if (mongoClient) {
        await mongoClient.close();
        mongoClient = null;
    }
}

export function seedPda(programId: PublicKey, seeds: (Buffer | Uint8Array)[]): PublicKey {
    return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

export function getRouterPDA(programId: PublicKey, owner: PublicKey, routerId: string): PublicKey {
    return seedPda(programId, [Buffer.from("router"), owner.toBuffer(), Buffer.from(routerId)]);
}

export function getProtocolPDA(programId: PublicKey): PublicKey {
    return seedPda(programId, [Buffer.from("protocol")]);
}
