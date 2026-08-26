import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Db } from "mongodb";
import { MONGO_DB } from "../database/database.module";
import { Page, decodeCursor, encodeCursor, clampLimit } from "../common/pagination";

export interface RouterListQuery {
    status?: string;
    owner?: string;
    cursor?: string;
    limit?: number;
}

@Injectable()
export class RoutersService {
    constructor(@Inject(MONGO_DB) private readonly db: Db) {}

    async list(query: RouterListQuery): Promise<Page<any>> {
        const limit = clampLimit(query.limit);
        const filter: Record<string, unknown> = {};
        if (query.status) filter.status = query.status;
        if (query.owner) filter.owner = query.owner;

        const after = decodeCursor(query.cursor);
        if (after) filter._id = { $gt: after };

        // collection<any>: these `_id`s are base58 pubkey strings written
        // by the indexer, not ObjectIds, so the driver's default typing
        // would reject both the filter above and the cursor below.
        const items = await this.db.collection<any>("routers")
            .find(filter)
            .sort({ _id: 1 })
            .limit(limit + 1)
            .toArray();

        const hasMore = items.length > limit;
        const page = hasMore ? items.slice(0, limit) : items;

        return {
            items: page,
            nextCursor: hasMore ? encodeCursor(page[page.length - 1]._id) : null,
        };
    }

    async getOne(routerPda: string): Promise<any> {
        const doc = await this.db.collection("routers").findOne({ _id: routerPda as any });
        if (!doc) throw new NotFoundException(`No router indexed at ${routerPda}`);
        return doc;
    }

    async epochs(routerPda: string, query: { cursor?: string; limit?: number }): Promise<Page<any>> {
        const limit = clampLimit(query.limit);
        const filter: Record<string, unknown> = { router: routerPda };

        const after = decodeCursor(query.cursor);
        if (after) filter.epochNumber = { $lt: Number(after) }; // newest epoch first

        const items = await this.db.collection("epochs")
            .find(filter)
            .sort({ epochNumber: -1 })
            .limit(limit + 1)
            .toArray();

        const hasMore = items.length > limit;
        const page = hasMore ? items.slice(0, limit) : items;

        return {
            items: page,
            nextCursor: hasMore ? encodeCursor(page[page.length - 1].epochNumber) : null,
        };
    }

    async recentHeartbeats(routerPda: string, limit = 20): Promise<any[]> {
        return this.db.collection("events")
            .find({ name: "HeartbeatReceived", "data.router_id": (await this.getOne(routerPda)).routerId })
            .sort({ blockTime: -1 })
            .limit(clampLimit(limit))
            .toArray();
    }
}
