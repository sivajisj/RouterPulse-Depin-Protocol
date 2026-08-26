#!/usr/bin/env node
/**
 * Seeds MongoDB with the same document shapes the indexer writes, so the
 * API's end-to-end suite can run in CI where there's no Solana validator.
 *
 * This deliberately mirrors indexer/src/projections.ts and
 * indexer/src/reconcile.ts rather than inventing a convenient shape — if
 * those change and this doesn't, the API tests should start failing,
 * which is the point. In particular: token amounts are strings (they
 * exceed Number.MAX_SAFE_INTEGER), `_id`s are base58-style strings not
 * ObjectIds, and event data uses snake_case field names exactly as the
 * Anchor IDL emits them.
 */

const { MongoClient } = require("mongodb");

const MONGO_URL = process.env.MONGO_URL || "mongodb://127.0.0.1:27017";
const MONGO_DB = process.env.MONGO_DB || "routerpulse";

const AUTHORITY = "DYFPsP14ZyMMg4qAoQmEvSNNNVxYdTkJExy8QYZkTGTD";
const ROUTERS = [
    { _id: "J1YDrPBbf4sxwYt7jHvGJPSjeGqJ2mfvTKi8SRRNsDLY", routerId: "router-mumbai-001",    status: "active",    uptimeScore: 95, lat: 19_076_000, long: 72_877_700 },
    { _id: "7Br91tsD6y7wzxJ7VcU2xWsCkgnt9eVd4hLqHhLhLJBr", routerId: "router-delhi-001",     status: "active",    uptimeScore: 88, lat: 28_613_900, long: 77_209_000 },
    { _id: "Abt1HbgMwnc3SZukPbA8r2j8mNJVGqGepGWUiQqqs4e9", routerId: "router-bangalore-001", status: "suspended", uptimeScore: 18, lat: 12_971_600, long: 77_594_600 },
];

async function main() {
    const client = new MongoClient(MONGO_URL);
    await client.connect();
    const db = client.db(MONGO_DB);

    await Promise.all(
        ["protocol", "routers", "epochs", "events", "transactions"].map(c =>
            db.collection(c).deleteMany({})
        )
    );

    await db.collection("protocol").insertOne({
        _id: "protocol",
        authority: AUTHORITY,
        rewardMint: "5XMivScQnghSLw2oLeG71Qr11wHkLwfuNtTTd28G4bQr",
        rewardRate: "1000000",
        penaltyBps: 500,
        heartbeatInterval: "60",
        epochDuration: "120",
        genesisTime: String(Math.floor(Date.now() / 1000) - 3600),
        minStake: "1000000000",
        totalRouters: String(ROUTERS.length),
        totalRewardsDistributed: "120000000",
        totalStaked: "3000000000",
        totalSlashed: "1000000000",
        totalMinted: "100120000000",
        totalBurned: "1000000000",
        genesisAllocation: "100000000000000",
        genesisMinted: "100000000000",
        isPaused: false,
        reconciledAt: new Date(),
    });

    const now = Math.floor(Date.now() / 1000);

    await db.collection("routers").insertMany(
        ROUTERS.map((r, i) => ({
            _id: r._id,
            owner: AUTHORITY,
            routerId: r.routerId,
            devicePubkey: `Device${i}1111111111111111111111111111111111111`,
            deviceKeyVersion: i,
            status: r.status,
            uptimeScore: r.uptimeScore,
            heartbeatCount: 10 + i,
            missedHeartbeats: i,
            totalRewards: "40000000",
            totalPenalties: i === 2 ? "1000000000" : "0",
            stakedAmount: "1000000000",
            locationLat: r.lat,
            locationLong: r.long,
            registeredAt: now - 7200,
            lastHeartbeat: now - 60 * i,
            reconciledAt: new Date(),
        }))
    );

    await db.collection("epochs").insertMany(
        ROUTERS.map((r, i) => ({
            _id: `${r._id}:1`,
            router: r._id,
            epochNumber: "1",
            heartbeats: 2 - i,
            expectedHeartbeats: 2,
            uptimeBps: i === 2 ? 5000 : 10000,
            rewardMultiplierBps: i === 2 ? 0 : 10000,
            rewardAmount: i === 2 ? "0" : "120000000",
            slashAmount: i === 2 ? "1000000000" : "0",
            finalized: true,
            claimed: i !== 2,
            finalizedAt: now - 600,
        }))
    );

    // Descending blockTime so the API's "newest first" ordering assertion
    // has something real to verify against.
    await db.collection("events").insertMany(
        ROUTERS.flatMap((r, i) => [
            {
                _id: `Sig${i}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0`,
                signature: `Sig${i}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
                index: 0,
                slot: 1000 + i,
                blockTime: now - i * 60,
                name: "HeartbeatReceived",
                data: {
                    router_id: r.routerId,
                    owner: AUTHORITY,
                    epoch_number: "1",
                    timestamp: String(now - i * 60),
                    uptime_score: r.uptimeScore,
                    was_on_time: true,
                    is_first: false,
                },
            },
            {
                _id: `Sig${i}bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:0`,
                signature: `Sig${i}bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
                index: 0,
                slot: 900 + i,
                blockTime: now - 600 - i * 60,
                name: "RouterRegistered",
                data: {
                    owner: AUTHORITY,
                    device_pubkey: `Device${i}1111111111111111111111111111111111111`,
                    router_id: r.routerId,
                    location_lat: r.lat,
                    location_long: r.long,
                    timestamp: String(now - 7200),
                },
            },
        ])
    );

    await db.collection("transactions").insertMany(
        ROUTERS.map((r, i) => ({
            _id: `Sig${i}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
            slot: 1000 + i,
            blockTime: now - i * 60,
            failed: false,
            eventCount: 1,
            indexedAt: new Date(),
        }))
    );

    const counts = {
        protocol: await db.collection("protocol").countDocuments(),
        routers: await db.collection("routers").countDocuments(),
        epochs: await db.collection("epochs").countDocuments(),
        events: await db.collection("events").countDocuments(),
    };
    console.log("Seeded:", JSON.stringify(counts));

    await client.close();
}

main().catch(err => {
    console.error("Seed failed:", err);
    process.exit(1);
});
