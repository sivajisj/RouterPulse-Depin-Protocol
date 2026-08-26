import Redis from "ioredis";
import { DecodedEvent } from "./eventParser";

export const EVENTS_CHANNEL = "routerpulse:events";

/// Publishes newly-indexed events to Redis so the API's WebSocket
/// gateway can fan them out to browsers without running its own Solana
/// subscription.
///
/// Deliberately fire-and-forget and non-fatal: Redis being down must
/// never stop the indexer from indexing. The durable record is MongoDB;
/// this pub/sub channel is a live notification convenience on top of it,
/// so a dropped publish costs a client a real-time update, not data.
export class EventPublisher {
    private redis: Redis | null = null;

    constructor(redisUrl?: string) {
        if (!redisUrl) return;
        this.redis = new Redis(redisUrl, {
            lazyConnect: false,
            maxRetriesPerRequest: 1,
            // Don't let a Redis outage stall the ingest loop behind a
            // growing queue of retried publishes.
            enableOfflineQueue: false,
        });
        this.redis.on("error", err => {
            console.warn("[publisher] redis error (continuing without live fanout):", err.message);
        });
    }

    publish(event: DecodedEvent): void {
        if (!this.redis) return;
        this.redis.publish(EVENTS_CHANNEL, JSON.stringify(event)).catch(() => {
            /* already logged by the error handler; never propagate */
        });
    }

    async close(): Promise<void> {
        if (this.redis) await this.redis.quit().catch(() => undefined);
    }
}
