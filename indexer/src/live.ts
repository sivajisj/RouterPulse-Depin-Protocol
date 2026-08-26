import { Connection, PublicKey } from "@solana/web3.js";
import { Db } from "mongodb";
import * as anchor from "@coral-xyz/anchor";
import { processSignature } from "./ingest";

/// Subscribes to every log notification for the program over the
/// cluster's websocket and indexes each one as it confirms. This is the
/// "real-time" half of the indexer; `backfill.ts` is the "catch up on
/// history" half, and they share `processSignature` so a transaction
/// observed by both never gets double-applied.
///
/// `onLogs` delivers `{signature, err, logs}`, but this deliberately
/// re-fetches the full transaction via `processSignature` rather than
/// decoding `logs` directly — that's the only way to also get `slot`
/// and `blockTime`, and it means live and backfill really do run
/// identical code, not two implementations that could quietly diverge.
export function startLiveSubscription(
    db: Db,
    programId: PublicKey,
    connection: Connection,
    parser: anchor.EventParser,
): number {
    console.log(`[live] subscribing to logs for ${programId.toBase58()} ...`);

    const subscriptionId = connection.onLogs(
        programId,
        (logsResult) => {
            if (logsResult.err) return; // failed instructions emit no events worth indexing
            processSignature(db, programId, connection, parser, logsResult.signature)
                .then(count => {
                    if (count > 0) {
                        console.log(`[live] ${logsResult.signature.slice(0, 12)}... -> ${count} event(s)`);
                    }
                })
                .catch(err => {
                    console.error(`[live] failed to process ${logsResult.signature}:`, err.stack || err);
                });
        },
        "confirmed"
    );

    return subscriptionId;
}
