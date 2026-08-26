import {
    loadIdl, getConnection, getProgramId, getDb, closeDb, RECONCILE_INTERVAL_MS, REDIS_URL,
} from "./config";
import { buildEventParser } from "./eventParser";
import { ensureIndexes } from "./db";
import { runBackfill } from "./backfill";
import { startLiveSubscription } from "./live";
import { startReconciliationLoop } from "./reconcile";
import { EventPublisher } from "./publisher";

async function main() {
    console.log("🔎 RouterPulse Indexer starting...\n");

    const idl       = loadIdl();
    const programId  = getProgramId(idl);
    const connection = getConnection();
    const db         = await getDb();
    const parser     = buildEventParser(programId, idl);

    const publisher = new EventPublisher(REDIS_URL);

    console.log(`   Program:  ${programId.toBase58()}`);
    console.log(`   RPC:      ${connection.rpcEndpoint}`);
    console.log(`   Mongo DB: ${db.databaseName}`);
    console.log(`   Redis:    ${REDIS_URL ?? "(not configured — no live fanout)"}\n`);

    await ensureIndexes(db);

    // 1. Catch up on everything that happened before this process
    //    started (or while it was down).
    await runBackfill();

    // 2. Start reconciliation immediately and on a fixed interval — it
    //    also serves as the first read of `protocol`, which the event
    //    projection never populates on its own (see projections.ts).
    const reconcileTimer = startReconciliationLoop(RECONCILE_INTERVAL_MS);

    // 3. Subscribe for everything from now on.
    const subscriptionId = startLiveSubscription(db, programId, connection, parser, publisher);

    console.log("\n✅ Indexer running. Ctrl+C to stop.\n");

    const shutdown = async () => {
        console.log("\n🛑 Shutting down...");
        clearInterval(reconcileTimer);
        try { await connection.removeOnLogsListener(subscriptionId); } catch { /* already gone */ }
        await publisher.close();
        await closeDb();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});
