import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import { Server } from "socket.io";
import Redis from "ioredis";
import { REDIS } from "../redis/redis.module";
import { config } from "../config";

export const EVENTS_CHANNEL = "routerpulse:events";

/// Fans out newly-indexed events to connected browser clients in real
/// time. Deliberately does NOT read from Mongo itself or run its own
/// Solana subscription — the indexer (Phase 3) is the only thing that
/// talks to the chain, and it publishes to `EVENTS_CHANNEL` on Redis
/// after it successfully indexes each event. This gateway just
/// subscribes to that channel and re-broadcasts over Socket.IO, which
/// is exactly the "Redis for WebSocket fanout" pattern from the
/// production plan: it's what lets this API be horizontally scaled to
/// several instances later without each one needing its own Solana
/// subscription, and without clients on instance A missing events
/// published because of activity instance B happened to observe.
@Injectable()
@WebSocketGateway({ cors: { origin: config.corsOrigins } })
export class RealtimeGateway implements OnModuleInit, OnModuleDestroy {
    @WebSocketServer()
    server!: Server;

    private subscriber: Redis;

    constructor(@Inject(REDIS) _redis: Redis) {
        // A dedicated connection: once a Redis client issues SUBSCRIBE it
        // can only run subscriber commands, so this can't share the
        // connection injected for auth's challenge storage.
        //
        // `enableReadyCheck: false` is load-bearing, not tidying: ioredis's
        // ready check issues INFO after connecting, and on any reconnect
        // that races against this connection already being in subscriber
        // mode it throws "Connection in subscriber mode, only subscriber
        // commands may be used" as an *unhandled* error event.
        this.subscriber = new Redis(config.redisUrl, { enableReadyCheck: false });
        this.subscriber.on("error", err => {
            // Live fanout is a convenience over the durable MongoDB
            // record — log and let ioredis retry rather than taking the
            // whole API process down over it.
            console.warn("[realtime] redis subscriber error:", err.message);
        });
    }

    async onModuleInit() {
        this.subscriber.on("message", (_channel, message) => {
            try {
                this.server?.emit("event", JSON.parse(message));
            } catch (err: any) {
                console.warn("[realtime] dropped malformed event payload:", err.message);
            }
        });
        await this.subscriber.subscribe(EVENTS_CHANNEL);
    }

    async onModuleDestroy() {
        await this.subscriber.quit();
    }
}
