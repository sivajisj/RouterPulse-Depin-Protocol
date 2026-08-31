import { Db } from "mongodb";

/// Indexes that make the collections usable at scale, not just correct.
/// `events._id` and `transactions._id` are already unique by being
/// Mongo's `_id`; everything below serves the query patterns a dashboard
/// or API actually runs.
///
/// Every index is given an explicit `rp_` name. Mongo auto-generates
/// names like `routerId_1` from the key spec, which collides with any
/// index of the same shape already in the database — including one left
/// behind by a *different* schema. Naming them ours makes that
/// impossible, and makes it obvious in Atlas which indexes belong to
/// this service.
const INDEXES: Array<[string, Record<string, 1 | -1>, string]> = [
    ["events",   { name: 1, blockTime: -1 },        "rp_events_name_time"],
    ["events",   { signature: 1 },                  "rp_events_signature"],
    ["routers",  { owner: 1 },                      "rp_routers_owner"],
    ["routers",  { status: 1 },                     "rp_routers_status"],
    ["routers",  { routerId: 1 },                   "rp_routers_routerId"],
    ["epochs",   { router: 1, epochNumber: -1 },    "rp_epochs_router_epoch"],
    ["epochs",   { finalized: 1, claimed: 1 },      "rp_epochs_state"],
];

export async function ensureIndexes(db: Db): Promise<void> {
    for (const [collection, keys, name] of INDEXES) {
        try {
            await db.collection(collection).createIndex(keys as any, { name });
        } catch (err: any) {
            // Index creation is a startup optimisation, not a
            // correctness requirement — the service reads and writes
            // fine without it, just slower. Killing the process here
            // means no indexing happens at all, which is strictly worse
            // than running unindexed. Log it and carry on.
            console.warn(
                `[db] could not create index ${name} on ${collection}: ${err?.message ?? err}\n` +
                `     continuing without it — queries will be slower, nothing is incorrect.`
            );
        }
    }
}

/// Warns about indexes this service didn't create that could actively
/// break it. Specifically: a unique index on `routerId` is wrong here,
/// because a router's identity is the PDA derived from
/// (owner, router_id) — two different operators can each legitimately
/// register "router-mumbai-001", and a unique constraint would silently
/// reject the second one.
export async function warnOnHostileIndexes(db: Db): Promise<void> {
    try {
        const existing = await db.collection("routers").indexes();
        const uniqueRouterId = existing.find(
            (i: any) => i.unique && i.key && Object.keys(i.key).join() === "routerId"
        );
        if (uniqueRouterId) {
            console.warn(
                `[db] WARNING: 'routers' has a UNIQUE index on routerId (${uniqueRouterId.name}).\n` +
                `     That is incompatible with this schema — router identity is the PDA of\n` +
                `     (owner, router_id), so two operators may share a router_id. Writes for the\n` +
                `     second one will fail. Drop it:  db.routers.dropIndex("${uniqueRouterId.name}")`
            );
        }
    } catch {
        /* collection may not exist yet — nothing to warn about */
    }
}
