import { config } from "./config.js";
import { ApiClient } from "./api.js";
import { SimulatedRouter, RouterBehavior } from "./router.js";
import { Stats } from "./stats.js";

// You need a valid dev token. Generate with:
// cd services/api && cargo run --bin dev_token
const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error("Set TOKEN env var first: export TOKEN=<your_dev_token>");
  process.exit(1);
}

const api = new ApiClient({ baseUrl: config.apiUrl, token: TOKEN });
const stats = new Stats();

async function main() {
  console.log(`\nRouterPulse Simulator 2.0`);
  console.log(`Routers: ${config.routers} | Rounds: ${config.rounds} | Attacks: ${config.attacks}`);
  console.log(`API: ${config.apiUrl}\n`);

  // --- Phase 1: Create routers with assigned behaviors ---
  const routers = createRouters();
  console.log(`Registering ${routers.length} devices...`);

  await runInBatches(routers, config.concurrency, async (router) => {
    const { status, data } = await api.createDevice(
      router.routerId,
      `Sim ${router.routerId}`,
      router.region
    );
    stats.recordRegistration(status);

    if (status === 200 || status === 201) {
      router.deviceUuid = data.id;
    }
  });

  // Filter to only routers that registered successfully
  const active = routers.filter((r) => r.deviceUuid);
  console.log(`Registered: ${active.length}/${routers.length}`);

  if (active.length === 0) {
    console.log("No devices registered. Check if the API is running.");
    return;
  }

  // --- Phase 2: Send telemetry rounds ---
  for (let round = 1; round <= config.rounds; round++) {
    const sending = active.filter((r) => r.behavior !== "offline");
    console.log(`\nRound ${round}/${config.rounds} — sending ${sending.length} heartbeats...`);

    await runInBatches(sending, config.concurrency, async (router) => {
      const packet = router.generateTelemetry();
      const { status, data } = await api.submitTelemetry(packet);
      stats.recordTelemetry(status, data?.error);
    });

    // Small delay between rounds to simulate real timing
    if (round < config.rounds) {
      await sleep(config.delayMs);
    }
  }

  // --- Phase 3: Sybil attack (if enabled) ---
  if (config.attacks) {
    console.log("\nRunning Sybil attack: registering 50 extra devices rapidly...");
    for (let i = 0; i < 50; i++) {
      const { status } = await api.createDevice(
        `sybil-device-${i}`,
        `Sybil ${i}`,
        "unknown"
      );
      stats.recordRegistration(status);
    }
  }

  stats.print();
}

function createRouters(): SimulatedRouter[] {
  const routers: SimulatedRouter[] = [];

  for (let i = 0; i < config.routers; i++) {
    let behavior: RouterBehavior = "healthy";

    if (config.attacks) {
      // When attacks are enabled, assign a mix of behaviors:
      // 60% healthy, 15% degraded, 5% offline, 10% replay, 10% spoofed
      const roll = Math.random();
      if (roll < 0.60) behavior = "healthy";
      else if (roll < 0.75) behavior = "degraded";
      else if (roll < 0.80) behavior = "offline";
      else if (roll < 0.90) behavior = "replay";
      else behavior = "spoofed";
    }

    routers.push(new SimulatedRouter(i, behavior));
  }

  if (config.attacks) {
    const counts: Record<string, number> = {};
    routers.forEach((r) => {
      counts[r.behavior] = (counts[r.behavior] || 0) + 1;
    });
    console.log("Behavior distribution:", counts);
  }

  return routers;
}

/** Run async tasks in batches to avoid overwhelming the server. */
async function runInBatches<T>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<void>
) {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map(fn));
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch(console.error);
