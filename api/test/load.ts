/**
 * Load test for the read API.
 *
 * Not a benchmark to brag about — the useful output is the shape of the
 * latency distribution and whether anything *breaks* under concurrency:
 * connection-pool exhaustion, unindexed collection scans, or the rate
 * limiter firing when it shouldn't.
 *
 * p50 is close to useless on its own here. A p50 of 8ms with a p99 of
 * 900ms means one request in a hundred feels broken, and that is the
 * number a user actually notices.
 *
 *   npx ts-node -r tsconfig-paths/register test/load.ts
 *   API_URL=https://... CONCURRENCY=50 DURATION_S=20 npx ts-node ... test/load.ts
 */
const API = process.env.API_URL || "http://127.0.0.1:3001";
const CONCURRENCY = Number(process.env.CONCURRENCY || 25);
const DURATION_S = Number(process.env.DURATION_S || 15);

interface Result { path: string; ms: number; status: number }

const ENDPOINTS = [
    "/health",
    "/api/v1/protocol",
    "/api/v1/protocol/epochs/current",
    "/api/v1/routers?limit=20",
    "/api/v1/analytics/network",
    "/api/v1/analytics/epochs?limit=20",
    "/api/v1/events?limit=20",
];

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[i];
}

async function worker(deadline: number, out: Result[]): Promise<void> {
    while (Date.now() < deadline) {
        const path = ENDPOINTS[Math.floor(Math.random() * ENDPOINTS.length)];
        const started = Date.now();
        try {
            const res = await fetch(`${API}${path}`);
            // Body must be consumed or sockets are held open and the
            // pool starves — which would look like the server slowing
            // down when it's really the client leaking connections.
            await res.arrayBuffer();
            out.push({ path, ms: Date.now() - started, status: res.status });
        } catch {
            out.push({ path, ms: Date.now() - started, status: 0 });
        }
    }
}

async function main() {
    console.log(`load: ${CONCURRENCY} concurrent workers for ${DURATION_S}s against ${API}\n`);

    // Fail fast rather than reporting a wall of zeros.
    try {
        const probe = await fetch(`${API}/health`);
        if (!probe.ok) throw new Error(`health returned ${probe.status}`);
    } catch (err: any) {
        console.error(`API unreachable at ${API}: ${err.message}`);
        process.exit(1);
    }

    const results: Result[] = [];
    const deadline = Date.now() + DURATION_S * 1000;
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(deadline, results)));

    const ok = results.filter(r => r.status === 200);
    const rateLimited = results.filter(r => r.status === 429);
    const failed = results.filter(r => r.status !== 200 && r.status !== 429);
    const all = ok.map(r => r.ms).sort((a, b) => a - b);

    console.log(`requests     ${results.length}  (${(results.length / DURATION_S).toFixed(0)}/s)`);
    console.log(`  ok         ${ok.length}`);
    console.log(`  rate-limited ${rateLimited.length}`);
    console.log(`  failed     ${failed.length}`);
    console.log(`\nlatency (ok only)`);
    console.log(`  p50        ${percentile(all, 50)}ms`);
    console.log(`  p95        ${percentile(all, 95)}ms`);
    console.log(`  p99        ${percentile(all, 99)}ms`);
    console.log(`  max        ${all[all.length - 1] ?? 0}ms`);

    console.log(`\nper endpoint (p95)`);
    for (const path of ENDPOINTS) {
        const times = ok.filter(r => r.path === path).map(r => r.ms).sort((a, b) => a - b);
        if (times.length) {
            console.log(`  ${percentile(times, 95).toString().padStart(5)}ms  ${path}`);
        }
    }

    // Rate limiting firing is the API defending itself, not a fault —
    // but silent non-429 failures mean something actually broke.
    if (failed.length) {
        const codes = [...new Set(failed.map(f => f.status))].join(", ");
        console.log(`\n❌ ${failed.length} request(s) failed with status: ${codes}`);
        process.exit(1);
    }
    console.log(`\n✅ no failures under ${CONCURRENCY}-way concurrency`);
}

main();
