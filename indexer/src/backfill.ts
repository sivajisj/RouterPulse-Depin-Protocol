import { ConfirmedSignatureInfo } from "@solana/web3.js";
import { loadIdl, getConnection, getProgramId, getDb, closeDb, BACKFILL_PAGE_SIZE } from "./config";
import { buildEventParser } from "./eventParser";
import { processSignature } from "./ingest";
import { withRetry } from "./retry";

/// Walks every historical signature that has ever touched the program,
/// oldest first, decoding and applying each one. Safe to run repeatedly
/// — already-processed signatures are skipped via the same idempotency
/// guard the live subscription uses — so this doubles as a "catch up
/// after downtime" tool, not just a one-time seed step.
export async function runBackfill(): Promise<{ signatures: number; events: number }> {
    const idl        = loadIdl();
    const programId   = getProgramId(idl);
    const connection  = getConnection();
    const db          = await getDb();
    const parser      = buildEventParser(programId, idl);

    console.log(`[backfill] scanning history for ${programId.toBase58()} ...`);

    // getSignaturesForAddress returns newest-first; page backward with
    // `before` until exhausted, then reverse so events get applied in
    // causal order (a router must be registered before its heartbeats
    // can update the same projection document).
    const allSignatures: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;
    for (;;) {
        const page = await withRetry(
            () => connection.getSignaturesForAddress(
                programId, { before, limit: BACKFILL_PAGE_SIZE }, "confirmed"
            ),
            { label: "getSignaturesForAddress" },
        );
        if (page.length === 0) break;
        allSignatures.push(...page);
        before = page[page.length - 1].signature;
        if (page.length < BACKFILL_PAGE_SIZE) break;
    }
    allSignatures.reverse();

    console.log(`[backfill] found ${allSignatures.length} signature(s); indexing...`);

    let eventsIndexed = 0;
    let processed = 0;
    for (const info of allSignatures) {
        const n = await processSignature(db, programId, connection, parser, info.signature);
        eventsIndexed += n;
        processed++;
        if (processed % 50 === 0) {
            console.log(`[backfill] ${processed}/${allSignatures.length} signatures (${eventsIndexed} events so far)`);
        }
    }

    await db.collection("sync_cursors").updateOne(
        { _id: "backfill" as any },
        { $set: {
            lastRunAt: new Date(),
            signaturesSeen: allSignatures.length,
            eventsIndexed,
        } },
        { upsert: true }
    );

    console.log(`[backfill] done: ${allSignatures.length} signature(s), ${eventsIndexed} event(s) applied.`);
    return { signatures: allSignatures.length, events: eventsIndexed };
}

if (require.main === module) {
    runBackfill()
        .then(() => closeDb())
        .catch(err => { console.error("[backfill] fatal:", err); process.exit(1); });
}
