/// End-to-end API tests against a real running stack: the actual
/// MongoDB the indexer wrote to, real Redis, and a real HTTP server —
/// no mocks. Run with `npm test` while MongoDB and Redis are up and the
/// indexer has populated at least one router.
///
/// Deliberately hand-rolled rather than Jest: this needs to boot the
/// whole Nest app once and assert against live data, and a tiny runner
/// keeps what's actually being verified obvious.

import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import * as nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { createApp } from "../src/main";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = "") {
    if (condition) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`);
        failures.push(name + (detail ? ` (${detail})` : ""));
        failed++;
    }
}

async function main() {
    const app: INestApplication = await createApp();
    await app.init();
    await app.listen(0); // ephemeral port so tests never collide with a running dev server
    const base = await app.getUrl();
    const get = async (path: string, headers: Record<string, string> = {}) => {
        const res = await fetch(base + path, { headers });
        const body = await res.text();
        let json: any = null;
        try { json = JSON.parse(body); } catch { /* non-JSON error page */ }
        return { status: res.status, json, body };
    };

    console.log("\nHealth & protocol");
    const health = await get("/health");
    check("GET /health returns ok with both dependencies up", health.json?.status === "ok",
        JSON.stringify(health.json));

    const protocol = await get("/api/v1/protocol");
    check("GET /api/v1/protocol returns the reconciled protocol account",
        protocol.status === 200 && typeof protocol.json?.rewardMint === "string",
        `status=${protocol.status}`);

    const epoch = await get("/api/v1/protocol/epochs/current");
    check("GET /api/v1/protocol/epochs/current derives a live epoch number",
        epoch.status === 200 && Number.isFinite(epoch.json?.epochNumber) && epoch.json.secondsRemaining >= 0,
        JSON.stringify(epoch.json));

    console.log("\nRouters");
    const routers = await get("/api/v1/routers?limit=2");
    check("GET /api/v1/routers returns a page of indexed routers",
        routers.status === 200 && Array.isArray(routers.json?.items) && routers.json.items.length > 0,
        `status=${routers.status} count=${routers.json?.items?.length}`);
    check("router list respects the limit", (routers.json?.items?.length ?? 99) <= 2);

    // Cursor pagination must actually advance, not repeat the first page —
    // the specific bug a naive skip/limit or a mis-encoded cursor causes.
    if (routers.json?.nextCursor) {
        const page2 = await get(`/api/v1/routers?limit=2&cursor=${encodeURIComponent(routers.json.nextCursor)}`);
        const firstIds = new Set(routers.json.items.map((r: any) => r._id));
        const overlap = (page2.json?.items ?? []).filter((r: any) => firstIds.has(r._id));
        check("cursor pagination advances without repeating rows", overlap.length === 0,
            `overlap=${overlap.length}`);
    } else {
        console.log("  ⏭  cursor pagination (only one page of routers indexed)");
    }

    const firstRouter = routers.json?.items?.[0];
    if (firstRouter) {
        const one = await get(`/api/v1/routers/${firstRouter._id}`);
        check("GET /api/v1/routers/:pda returns that specific router",
            one.status === 200 && one.json?._id === firstRouter._id);

        const epochs = await get(`/api/v1/routers/${firstRouter._id}/epochs`);
        check("GET /api/v1/routers/:pda/epochs returns a page", epochs.status === 200 && Array.isArray(epochs.json?.items));
    }

    const missing = await get("/api/v1/routers/NotARealRouterPdaAddress11111111111111");
    check("unknown router PDA returns 404, not an empty 200", missing.status === 404, `status=${missing.status}`);

    console.log("\nAnalytics & explorer");
    const network = await get("/api/v1/analytics/network");
    check("GET /api/v1/analytics/network aggregates router counts",
        network.status === 200 && typeof network.json?.totalRouters === "number" && network.json.totalRouters > 0,
        JSON.stringify(network.json));
    check("total staked is returned as a precise string, not a lossy float",
        typeof network.json?.totalStakedIndexed === "string");

    const events = await get("/api/v1/events?limit=3");
    check("GET /api/v1/events returns decoded events newest-first",
        events.status === 200 && Array.isArray(events.json?.items) && events.json.items.length > 0,
        `count=${events.json?.items?.length}`);

    const times = (events.json?.items ?? []).map((e: any) => e.blockTime).filter((t: any) => t != null);
    check("event feed is actually ordered newest-first",
        times.every((t: number, i: number) => i === 0 || times[i - 1] >= t),
        JSON.stringify(times));

    console.log("\nAuth (Sign-In-With-Solana) & RBAC");
    const unauth = await get("/api/v1/admin/audit");
    check("admin endpoint rejects an unauthenticated request", unauth.status === 401, `status=${unauth.status}`);

    // A wallet that is NOT the protocol authority must authenticate fine
    // but still be refused by the RBAC guard — 200 here would mean the
    // authority check isn't actually wired up.
    const stranger = Keypair.generate();
    const strangerWallet = stranger.publicKey.toBase58();
    const challenge = await get(`/api/v1/auth/challenge?wallet=${strangerWallet}`);
    check("GET /api/v1/auth/challenge issues a nonce message",
        challenge.status === 200 && typeof challenge.json?.message === "string");

    const signature = bs58.encode(
        nacl.sign.detached(Buffer.from(challenge.json.message, "utf-8"), stranger.secretKey)
    );
    const verifyRes = await fetch(base + "/api/v1/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: strangerWallet, signature }),
    });
    const verifyJson: any = await verifyRes.json();
    check("POST /api/v1/auth/verify accepts a valid signature and returns a JWT",
        verifyRes.status === 200 || verifyRes.status === 201, `status=${verifyRes.status}`);
    check("issued token is a JWT", typeof verifyJson?.accessToken === "string" && verifyJson.accessToken.split(".").length === 3);

    const asStranger = await get("/api/v1/admin/audit", { authorization: `Bearer ${verifyJson.accessToken}` });
    check("authenticated non-authority wallet is still refused by RBAC (403)",
        asStranger.status === 403, `status=${asStranger.status}`);

    // Replay: the challenge is single-use, so the same signature must not
    // mint a second session.
    const replay = await fetch(base + "/api/v1/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: strangerWallet, signature }),
    });
    check("replaying a consumed challenge is rejected", replay.status === 401, `status=${replay.status}`);

    // Wrong signature over a fresh challenge must not authenticate.
    const c2 = await get(`/api/v1/auth/challenge?wallet=${strangerWallet}`);
    const wrongSig = bs58.encode(nacl.sign.detached(Buffer.from("a different message", "utf-8"), stranger.secretKey));
    const bad = await fetch(base + "/api/v1/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: strangerWallet, signature: wrongSig }),
    });
    check("signature over the wrong message is rejected", bad.status === 401, `status=${bad.status} (challenge=${c2.status})`);

    const badToken = await get("/api/v1/admin/audit", { authorization: "Bearer not.a.real.token" });
    check("garbage bearer token is rejected", badToken.status === 401, `status=${badToken.status}`);

    await app.close();

    console.log(`\n${passed} passing, ${failed} failing`);
    if (failed > 0) {
        console.log("\nFailures:");
        for (const f of failures) console.log("  - " + f);
        process.exit(1);
    }
    process.exit(0);
}

main().catch(err => {
    console.error("Fatal:", err);
    process.exit(1);
});
