import { Db } from "mongodb";
import { PublicKey } from "@solana/web3.js";
import { DecodedEvent } from "./eventParser";
import { getRouterPDA } from "./config";

/// Applies one decoded event to the derived, query-friendly collections
/// (`routers`, `epochs`). These are *projections*, not the source of
/// truth — `events` (the raw decoded log, written by the caller before
/// this runs) is the append-only record; this is what makes it cheap to
/// ask "what does this router look like right now" without replaying
/// history. Exact cumulative token amounts (staked/rewards/penalties)
/// are deliberately taken verbatim from event fields that already carry
/// the post-transaction total (e.g. `CollateralStaked.total_staked`)
/// rather than accumulated here — and `reconcile.ts` periodically
/// overwrites this projection from the real on-chain account anyway, so
/// this module only ever has to be "probably right, fast," not
/// authoritative.
///
/// Field names below are `snake_case`, matching the event data exactly
/// as this Anchor/anchor-lang version's IDL emits it (see
/// `docs/indexer.md` — event data does NOT go through the same
/// camelCase conversion the account/instruction client layer applies,
/// which is a real trap: it type-checks fine either way since decoded
/// event data is untyped `Record<string, unknown>`, and only fails at
/// runtime on first access).
export async function applyEventToProjections(
    db: Db,
    programId: PublicKey,
    event: DecodedEvent,
): Promise<void> {
    // `_id`s here are base58 pubkeys / composite strings, not ObjectIds —
    // typed `any` so the driver's default ObjectId-typed `_id` doesn't
    // fight every filter/update below.
    const routers = db.collection<any>("routers");
    const epochs  = db.collection<any>("epochs");
    const d = event.data as Record<string, any>;

    const routerPdaFromOwnerRouterId = (owner: string, routerId: string) =>
        getRouterPDA(programId, new PublicKey(owner), routerId).toBase58();

    switch (event.name) {

        case "RouterRegistered": {
            const routerPda = routerPdaFromOwnerRouterId(d.owner, d.router_id);
            await routers.updateOne(
                { _id: routerPda },
                {
                    $set: {
                        owner: d.owner, routerId: d.router_id, devicePubkey: d.device_pubkey,
                        deviceKeyVersion: 0, locationLat: d.location_lat, locationLong: d.location_long,
                        registeredAt: Number(d.timestamp), status: "inactive",
                        uptimeScore: 100, heartbeatCount: 0, stakedAmount: "0",
                        updatedAt: new Date(),
                    },
                    $setOnInsert: { firstIndexedAt: new Date() },
                },
                { upsert: true }
            );
            break;
        }

        case "DeviceKeyRotated": {
            const routerPda = routerPdaFromOwnerRouterId(d.owner, d.router_id);
            await routers.updateOne(
                { _id: routerPda },
                { $set: {
                    devicePubkey: d.new_device_pubkey,
                    deviceKeyVersion: Number(d.device_key_version),
                    updatedAt: new Date(),
                } },
                { upsert: true }
            );
            break;
        }

        case "HeartbeatReceived": {
            const routerPda = routerPdaFromOwnerRouterId(d.owner, d.router_id);
            await routers.updateOne(
                { _id: routerPda },
                {
                    $set: {
                        lastHeartbeat: Number(d.timestamp),
                        uptimeScore:   Number(d.uptime_score),
                        status:        "active",
                        updatedAt:     new Date(),
                    },
                    $inc: { heartbeatCount: 1 },
                },
                { upsert: true }
            );
            break;
        }

        case "RouterSuspended": {
            const routerPda = routerPdaFromOwnerRouterId(d.owner, d.router_id);
            await routers.updateOne(
                { _id: routerPda },
                { $set: { status: "suspended", uptimeScore: Number(d.uptime_score), updatedAt: new Date() } },
                { upsert: true }
            );
            break;
        }

        case "PenaltyApplied": {
            const routerPda = routerPdaFromOwnerRouterId(d.owner, d.router_id);
            await routers.updateOne(
                { _id: routerPda },
                { $set: { uptimeScore: Number(d.uptime_score), updatedAt: new Date() } },
                { upsert: true }
            );
            break;
        }

        case "CollateralStaked": {
            await routers.updateOne(
                { _id: d.router },
                { $set: { stakedAmount: d.total_staked, updatedAt: new Date() } },
                { upsert: true }
            );
            break;
        }

        case "CollateralUnstaked": {
            await routers.updateOne(
                { _id: d.router },
                { $set: { stakedAmount: d.remaining, updatedAt: new Date() } },
                { upsert: true }
            );
            break;
        }

        case "RouterSlashed": {
            await routers.updateOne(
                { _id: d.router },
                { $set: { stakedAmount: d.remaining_stake, updatedAt: new Date() } },
                { upsert: true }
            );
            await epochs.updateOne(
                { _id: `${d.router}:${d.epoch_number}` },
                { $set: {
                    router: d.router, epochNumber: d.epoch_number,
                    slashed: true, slashedAmount: d.amount, slashedAt: Number(d.timestamp),
                } },
                { upsert: true }
            );
            break;
        }

        case "RouterEpochFinalized": {
            await epochs.updateOne(
                { _id: `${d.router}:${d.epoch_number}` },
                { $set: {
                    router: d.router, epochNumber: d.epoch_number,
                    heartbeats: Number(d.heartbeats), expectedHeartbeats: Number(d.expected_heartbeats),
                    uptimeBps: Number(d.uptime_bps), rewardMultiplierBps: Number(d.reward_multiplier_bps),
                    rewardAmount: d.reward_amount, slashAmount: d.slash_amount,
                    finalized: true, finalizedAt: Number(d.timestamp),
                } },
                { upsert: true }
            );
            break;
        }

        case "RewardClaimed": {
            const routerPda = routerPdaFromOwnerRouterId(d.owner, d.router_id);
            await epochs.updateOne(
                { _id: `${routerPda}:${d.epoch_number}` },
                { $set: {
                    router: routerPda, epochNumber: d.epoch_number,
                    claimed: true, claimedAt: Number(d.timestamp),
                } },
                { upsert: true }
            );
            break;
        }

        case "VestedRewardClaimed": {
            await epochs.updateOne(
                { _id: `${d.router}:${d.epoch_number}` },
                { $set: {
                    router: d.router, epochNumber: d.epoch_number,
                    lastVestedAt: Number(d.timestamp),
                    vestedClaimed: d.total_claimed, vestedTotal: d.total_amount,
                } },
                { upsert: true }
            );
            break;
        }

        // ProtocolInitialized, TreasuryBurned, GenesisMinted are
        // protocol-singleton concerns. They're still written verbatim
        // to `events` by the caller; the `protocol` collection itself is
        // kept correct by reconcile.ts fetching the real account instead
        // of replaying deltas, since it holds cumulative counters
        // (total_minted, total_burned, ...) that are cheap to just re-read.
        // ── governance ────────────────────────────────────────────
        // These previously emitted nothing at all, so an admin action
        // was invisible to the index: reconciliation would eventually
        // show a router had become Decommissioned, but never that an
        // authority did it, or when.
        case "RouterReinstated": {
            await routers.updateOne(
                { _id: d.router },
                { $set: { status: "active", uptimeScore: Number(d.uptime_score), updatedAt: new Date() } },
                { upsert: true }
            );
            break;
        }

        case "RouterDecommissioned": {
            await routers.updateOne(
                { _id: d.router },
                { $set: { status: "decommissioned", updatedAt: new Date() } },
                { upsert: true }
            );
            break;
        }

        case "ProtocolPaused":
        case "ProtocolResumed": {
            await db.collection<any>("protocol").updateOne(
                { _id: "protocol" },
                { $set: { isPaused: event.name === "ProtocolPaused", updatedAt: new Date() } },
                { upsert: true }
            );
            break;
        }

        // RewardRateUpdated carries previous_rate as well as new_rate, so
        // the raw event in `events` is already a complete audit record —
        // reconcile.ts owns the current value on `protocol`.
        default:
            break;
    }
}
