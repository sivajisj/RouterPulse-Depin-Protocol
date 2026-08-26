import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { Db } from "mongodb";
import { MONGO_DB } from "../database/database.module";

@Injectable()
export class ProtocolService {
    constructor(@Inject(MONGO_DB) private readonly db: Db) {}

    async get(): Promise<any> {
        const doc = await this.db.collection("protocol").findOne({ _id: "protocol" as any });
        if (!doc) {
            throw new ServiceUnavailableException(
                "Protocol not yet reconciled — the indexer's reconcile.ts hasn't completed a pass yet."
            );
        }
        return doc;
    }

    /// Epoch number "now", derived the same way the on-chain program
    /// does (Protocol::epoch_number_at). Exposed here so a client never
    /// has to re-implement that formula itself.
    async currentEpoch(): Promise<{ epochNumber: number; epochStart: number; epochEnd: number; secondsRemaining: number }> {
        const protocol = await this.get();
        const genesis  = Number(protocol.genesisTime);
        const duration = Number(protocol.epochDuration);
        const now = Math.floor(Date.now() / 1000);

        const epochNumber = now <= genesis || duration <= 0 ? 0 : Math.floor((now - genesis) / duration);
        const epochStart = genesis + epochNumber * duration;
        const epochEnd = epochStart + duration;

        return { epochNumber, epochStart, epochEnd, secondsRemaining: Math.max(0, epochEnd - now) };
    }
}
