import { Controller, Get, Inject } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Db } from "mongodb";
import Redis from "ioredis";
import { MONGO_DB } from "./database/database.module";
import { REDIS } from "./redis/redis.module";

@ApiTags("health")
@Controller()
export class HealthController {
    constructor(
        @Inject(MONGO_DB) private readonly db: Db,
        @Inject(REDIS) private readonly redis: Redis,
    ) {}

    @Get("health")
    @ApiOperation({ summary: "Liveness + dependency check (MongoDB and Redis)" })
    async health() {
        const [mongo, redis] = await Promise.allSettled([
            this.db.command({ ping: 1 }),
            this.redis.ping(),
        ]);
        const ok = mongo.status === "fulfilled" && redis.status === "fulfilled";
        return {
            status: ok ? "ok" : "degraded",
            mongo: mongo.status === "fulfilled" ? "up" : "down",
            redis: redis.status === "fulfilled" ? "up" : "down",
        };
    }
}
