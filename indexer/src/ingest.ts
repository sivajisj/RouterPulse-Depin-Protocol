import { Db } from "mongodb";
import { Connection, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { decodeTransactionEvents } from "./eventParser";
import { applyEventToProjections } from "./projections";
import { EventPublisher } from "./publisher";

/// Fetches, decodes, and applies every event in one transaction.
/// Shared by both backfill and the live subscription so there is
/// exactly one code path that can write to Mongo — no risk of the two
/// drifting apart in what they consider "processed."
///
/// Idempotency is enforced by atomically claiming the signature in
/// `transactions` first (a plain unique-key insert): if that insert
/// fails because the signature is already there, this returns 0 without
/// touching `events` or the projections at all. That "all or nothing per
/// signature" gate matters specifically because `HeartbeatReceived`
/// increments a counter with `$inc` — replaying it would silently
/// inflate `heartbeatCount`, unlike the `$set`-based updates elsewhere
/// which would merely be harmless no-ops on replay.
export async function processSignature(
    db: Db,
    programId: PublicKey,
    connection: Connection,
    parser: anchor.EventParser,
    signature: string,
    publisher?: EventPublisher,
): Promise<number> {
    const transactions = db.collection("transactions");

    const tx = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
    });

    if (!tx || tx.meta?.err) {
        await claimSignature(transactions, signature, tx?.slot ?? null, tx?.blockTime ?? null, true, 0);
        return 0;
    }

    const logMessages = tx.meta?.logMessages ?? [];
    const events = decodeTransactionEvents(parser, signature, tx.slot, tx.blockTime ?? null, logMessages);

    const claimed = await claimSignature(transactions, signature, tx.slot, tx.blockTime ?? null, false, events.length);
    if (!claimed) return 0; // already processed by an earlier run

    if (events.length > 0) {
        // The raw event log is written first and is never rolled back —
        // it's the append-only source of truth for everything else in
        // this function, including re-derivation later if a projection
        // bug like the one below is fixed after the fact.
        await db.collection("events").insertMany(
            events.map(ev => ({ ...ev, _id: ev.id as any })),
            { ordered: false }
        );
        // Once claimSignature() above succeeds, this signature will
        // never be retried by backfill or a future live replay — so a
        // throw here must not abort the loop. If it did, one bad event
        // would permanently leave every event after it in the same
        // transaction un-projected, with no way to notice short of
        // reading logs. Projection failures are therefore caught and
        // logged per-event; reconcile.ts's periodic full-account refresh
        // is the safety net that keeps `routers` correct even if a
        // projection update is silently lost here.
        for (const ev of events) {
            try {
                await applyEventToProjections(db, programId, ev);
            } catch (err: any) {
                console.error(`[ingest] projection failed for ${ev.id} (${ev.name}):`, err.message || err);
            }
            // Published after the durable write, so a client that reacts
            // to the notification by querying the API can't observe an
            // event that isn't in MongoDB yet.
            publisher?.publish(ev);
        }
    }
    return events.length;
}

/// Returns true if this call successfully claimed the signature (first
/// time seen), false if it was already claimed by a previous run.
async function claimSignature(
    transactions: ReturnType<Db["collection"]>,
    signature: string,
    slot: number | null,
    blockTime: number | null,
    failed: boolean,
    eventCount: number,
): Promise<boolean> {
    try {
        await transactions.insertOne({
            _id: signature as any,
            slot, blockTime, failed, eventCount,
            indexedAt: new Date(),
        });
        return true;
    } catch (err: any) {
        if (err.code === 11000) return false; // duplicate key = already processed
        throw err;
    }
}
