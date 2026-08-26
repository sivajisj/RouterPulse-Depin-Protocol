import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Db } from "mongodb";
import { MONGO_DB } from "../database/database.module";
import { Page, decodeCursor, encodeCursor, clampLimit } from "../common/pagination";

@Injectable()
export class ExplorerService {
    constructor(@Inject(MONGO_DB) private readonly db: Db) {}

    async getTransaction(signature: string): Promise<any> {
        const tx = await this.db.collection("transactions").findOne({ _id: signature as any });
        if (!tx) throw new NotFoundException(`No indexed transaction ${signature}`);
        const events = await this.db.collection("events")
            .find({ signature })
            .sort({ index: 1 })
            .toArray();
        return { ...tx, events };
    }

    async listEvents(query: { name?: string; cursor?: string; limit?: number }): Promise<Page<any>> {
        const limit = clampLimit(query.limit);
        const filter: Record<string, unknown> = {};
        if (query.name) filter.name = query.name;

        // Cursor on blockTime, not _id — _id is `signature:index`, and
        // signatures don't sort lexicographically by time, so an _id
        // cursor would silently produce a feed in the wrong order.
        const after = decodeCursor(query.cursor);
        if (after) filter.blockTime = { $lt: Number(after) };

        const items = await this.db.collection("events")
            .find(filter)
            .sort({ blockTime: -1, index: -1 })
            .limit(limit + 1)
            .toArray();

        const hasMore = items.length > limit;
        const page = hasMore ? items.slice(0, limit) : items;

        return {
            items: page,
            nextCursor: hasMore ? encodeCursor(page[page.length - 1].blockTime) : null,
        };
    }
}
