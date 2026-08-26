import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

export interface DecodedEvent {
    /// `${signature}:${index}` — stable and unique even when a single
    /// transaction emits several events of the same or different kinds,
    /// which is what makes every downstream upsert idempotent.
    id:        string;
    signature: string;
    index:     number;
    slot:      number;
    blockTime: number | null;
    name:      string;
    data:      Record<string, unknown>;
}

/// Recursively converts Anchor's decoded event fields into
/// Mongo-storable primitives: BN -> decimal string (never a JS number —
/// reward/stake amounts routinely exceed Number.MAX_SAFE_INTEGER),
/// PublicKey -> base58 string, enum variants (`{ active: {} }`) -> their
/// variant name as a plain string.
export function serializeEventData(value: unknown): unknown {
    if (value instanceof BN) return value.toString();
    if (value instanceof PublicKey) return value.toBase58();
    if (Array.isArray(value)) return value.map(serializeEventData);

    if (value && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>);
        // Anchor decodes a Rust enum-without-data variant as { variantName: {} }.
        if (entries.length === 1 && isEmptyObject(entries[0][1])) {
            return entries[0][0];
        }
        const out: Record<string, unknown> = {};
        for (const [k, v] of entries) out[k] = serializeEventData(v);
        return out;
    }
    return value;
}

function isEmptyObject(v: unknown): boolean {
    return typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0;
}

export function buildEventParser(programId: PublicKey, idl: anchor.Idl): anchor.EventParser {
    const coder = new anchor.BorshCoder(idl as any);
    return new anchor.EventParser(programId, coder);
}

/// Decodes every event emitted within one transaction's logs, in the
/// order they were emitted. A transaction with no program-emitted
/// events (e.g. a failed instruction, or one that never calls `emit!`)
/// simply yields nothing.
export function decodeTransactionEvents(
    parser: anchor.EventParser,
    signature: string,
    slot: number,
    blockTime: number | null,
    logMessages: string[],
): DecodedEvent[] {
    const decoded: DecodedEvent[] = [];
    let index = 0;
    for (const event of parser.parseLogs(logMessages)) {
        decoded.push({
            id: `${signature}:${index}`,
            signature,
            index,
            slot,
            blockTime,
            name: event.name,
            data: serializeEventData(event.data) as Record<string, unknown>,
        });
        index++;
    }
    return decoded;
}
