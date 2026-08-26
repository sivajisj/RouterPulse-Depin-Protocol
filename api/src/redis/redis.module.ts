import { Global, Module } from "@nestjs/common";
import Redis from "ioredis";
import { config } from "../config";

export const REDIS = "REDIS";

@Global()
@Module({
    providers: [
        {
            provide: REDIS,
            useFactory: (): Redis => new Redis(config.redisUrl, { lazyConnect: false }),
        },
    ],
    exports: [REDIS],
})
export class RedisModule {}
