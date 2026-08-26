import { Global, Module } from "@nestjs/common";
import { MongoClient, Db } from "mongodb";
import { config } from "../config";

export const MONGO_DB = "MONGO_DB";

/// Provides a single shared `Db` handle over the *same* MongoDB the
/// indexer (Phase 3) writes to. This API is deliberately read-only
/// against it — nothing here ever calls insertOne/updateOne on the
/// indexer's collections, because the indexer's idempotency guarantees
/// (see indexer/src/ingest.ts) only hold if it's the only writer.
@Global()
@Module({
    providers: [
        {
            provide: MONGO_DB,
            useFactory: async (): Promise<Db> => {
                const client = new MongoClient(config.mongoUrl);
                await client.connect();
                return client.db(config.mongoDb);
            },
        },
    ],
    exports: [MONGO_DB],
})
export class DatabaseModule {}
