import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { DatabaseModule } from "./database/database.module";
import { RedisModule } from "./redis/redis.module";
import { RoutersModule } from "./routers/routers.module";
import { ProtocolModule } from "./protocol/protocol.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { ExplorerModule } from "./explorer/explorer.module";
import { AuthModule } from "./auth/auth.module";
import { AdminModule } from "./admin/admin.module";
import { RealtimeModule } from "./realtime/realtime.module";
import { HealthController } from "./health.controller";
import { config } from "./config";

@Module({
    imports: [
        ThrottlerModule.forRoot([{ ttl: config.rateLimitTtlMs, limit: config.rateLimitMax }]),
        DatabaseModule,
        RedisModule,
        AuthModule,
        RoutersModule,
        ProtocolModule,
        AnalyticsModule,
        ExplorerModule,
        AdminModule,
        RealtimeModule,
    ],
    controllers: [HealthController],
    providers: [
        // Rate limiting applied globally rather than per-controller, so
        // a new endpoint is protected by default instead of by remembering.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
    ],
})
export class AppModule {}
