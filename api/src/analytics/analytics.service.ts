import { Inject, Injectable } from "@nestjs/common";
import { Db } from "mongodb";
import { MONGO_DB } from "../database/database.module";

@Injectable()
export class AnalyticsService {
    constructor(@Inject(MONGO_DB) private readonly db: Db) {}

    /// Network-wide snapshot for a dashboard landing page. Token amounts
    /// are summed via `$toDecimal` (Decimal128), not a plain `$sum` on
    /// the string field — Mongo would silently coerce that to a double
    /// and lose precision on the very amounts this whole project treats
    /// as its money.
    async network(): Promise<any> {
        const routers = this.db.collection("routers");

        const [statusCounts, uptimeAgg, stakeAgg] = await Promise.all([
            routers.aggregate([
                { $group: { _id: "$status", count: { $sum: 1 } } },
            ]).toArray(),
            routers.aggregate([
                { $group: { _id: null, avgUptimeScore: { $avg: "$uptimeScore" }, totalHeartbeats: { $sum: "$heartbeatCount" } } },
            ]).toArray(),
            routers.aggregate([
                { $group: { _id: null, totalStaked: { $sum: { $toDecimal: "$stakedAmount" } } } },
            ]).toArray(),
        ]);

        const byStatus: Record<string, number> = {};
        for (const row of statusCounts) byStatus[row._id ?? "unknown"] = row.count;

        return {
            totalRouters: statusCounts.reduce((sum, r) => sum + r.count, 0),
            byStatus,
            averageUptimeScore: uptimeAgg[0]?.avgUptimeScore ?? 0,
            totalHeartbeatsRecorded: uptimeAgg[0]?.totalHeartbeats ?? 0,
            totalStakedIndexed: stakeAgg[0]?.totalStaked?.toString() ?? "0",
            generatedAt: new Date().toISOString(),
        };
    }

    /// Per-region-ish breakdown using rounded lat/long as a cheap proxy
    /// for "region" — good enough for a demo map, not meant to replace
    /// real geocoding.
    async byRegion(): Promise<any[]> {
        return this.db.collection("routers").aggregate([
            {
                $group: {
                    _id: {
                        lat: { $round: [{ $divide: ["$locationLat", 1_000_000] }, 0] },
                        long: { $round: [{ $divide: ["$locationLong", 1_000_000] }, 0] },
                    },
                    routerCount: { $sum: 1 },
                    avgUptimeScore: { $avg: "$uptimeScore" },
                },
            },
            { $sort: { routerCount: -1 } },
        ]).toArray();
    }

    async epochPerformance(limit = 20): Promise<any[]> {
        return this.db.collection("epochs")
            .find({ finalized: true })
            .sort({ finalizedAt: -1 })
            .limit(Math.min(limit, 200))
            .toArray();
    }
}
