import { Db } from "mongodb";

/// Indexes that make the collections actually usable at scale, not just
/// correct. `events._id` and `transactions._id` are already unique by
/// being Mongo's `_id`; everything below is for the query patterns a
/// dashboard or API would actually run.
export async function ensureIndexes(db: Db): Promise<void> {
    await db.collection("events").createIndex({ name: 1, blockTime: -1 });
    await db.collection("events").createIndex({ signature: 1 });

    await db.collection("routers").createIndex({ owner: 1 });
    await db.collection("routers").createIndex({ status: 1 });
    await db.collection("routers").createIndex({ routerId: 1 });

    await db.collection("epochs").createIndex({ router: 1, epochNumber: -1 });
    await db.collection("epochs").createIndex({ finalized: 1, claimed: 1 });
}
