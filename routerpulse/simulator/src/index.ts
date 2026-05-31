import { Connection } from "@solana/web3.js";
import * as anchor    from "@coral-xyz/anchor";
import { loadWallet, loadProgram, RPC_URL, HEARTBEAT_INTERVAL_MS } from "./config";
import { RouterSimulator, RouterConfig } from "./router";
import { PublicKey } from "@solana/web3.js";

async function main() {

    console.log("🚀 RouterPulse Simulator Starting...\n");

    const connection = new Connection(RPC_URL, "confirmed");
    const wallet     = loadWallet();
    const program    = loadProgram(wallet, connection);

    // derive protocol PDA
    const [protocolPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("protocol")],
        program.programId
    );

    // check protocol exists
    const protocol = await program.account.protocol.fetch(protocolPDA);
    console.log("✅ Protocol found");
    console.log("   Reward rate:    ", protocol.rewardRate.toString());
    console.log("   Total routers:  ", protocol.totalRouters.toString());
    console.log("   Is paused:      ", protocol.isPaused);
    console.log("");

    // define multiple routers with different failure rates
    const routerConfigs: RouterConfig[] = [
        {
            routerId: "router-mumbai-001",
            lat:      19_076_000,   // Mumbai
            long:     72_877_700,
            failRate: 0.05,         // 5% failure — reliable router
        },
        {
            routerId: "router-delhi-001",
            lat:      28_613_900,   // Delhi
            long:     77_209_000,
            failRate: 0.30,         // 30% failure — unstable router
        },
        {
            routerId: "router-bangalore-001",
            lat:      12_971_600,   // Bangalore
            long:     77_594_600,
            failRate: 0.60,         // 60% failure — bad router (will get suspended)
        },
    ];

    // create simulator instances
    const simulators = routerConfigs.map(config =>
        new RouterSimulator(program, wallet, config, protocolPDA)
    );

    // register all routers
    console.log("📋 Registering routers...\n");
    for (const sim of simulators) {
        await sim.register();
        await sleep(500);
    }
    console.log("");

    // start all routers in parallel
    console.log("💓 Starting heartbeats...\n");
    await Promise.all(
        simulators.map(sim => sim.start(HEARTBEAT_INTERVAL_MS))
    );

    // print final stats
    console.log("\n📊 Final Stats:");
    for (const sim of simulators) {
        const stats = sim.getStats();
        console.log(`  ${stats.routerId}: sent=${stats.sent} missed=${stats.missed}`);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// handle ctrl+c gracefully
process.on("SIGINT", () => {
    console.log("\n\n🛑 Simulator stopped by user");
    process.exit(0);
});

main().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});
