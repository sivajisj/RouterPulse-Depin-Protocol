import { Connection, PublicKey } from "@solana/web3.js";
import * as anchor    from "@coral-xyz/anchor";
import { getOrCreateAssociatedTokenAccount, getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import {
    loadWallet, loadProgram, RPC_URL, HEARTBEAT_INTERVAL_MS,
    getProtocolPDA, getRewardMintPDA, getStakeVaultPDA,
} from "./config";
import { RouterSimulator, RouterConfig } from "./router";

async function main() {

    console.log("🚀 RouterPulse Simulator Starting...\n");

    const connection = new Connection(RPC_URL, "confirmed");
    const wallet     = loadWallet();
    const program    = loadProgram(wallet, connection);

    const protocolPDA   = getProtocolPDA(program.programId);
    const rewardMintPDA = getRewardMintPDA(program.programId);
    const stakeVaultPDA = getStakeVaultPDA(program.programId);

    // check protocol exists
    const protocol = await program.account.protocol.fetch(protocolPDA);
    console.log("✅ Protocol found");
    console.log("   Reward rate:    ", protocol.rewardRate.toString());
    console.log("   Total routers:  ", protocol.totalRouters.toString());
    console.log("   Is paused:      ", protocol.isPaused);
    console.log("   Epoch duration: ", protocol.epochDuration.toString(), "s");
    console.log("   Min stake:      ", protocol.minStake.toString());
    console.log("   Reward mint:    ", rewardMintPDA.toBase58());
    console.log("   Genesis time:   ", new Date(protocol.genesisTime.toNumber() * 1000).toISOString());
    console.log("");
    console.log("   Each router below signs heartbeats with its own throwaway");
    console.log("   device key (never the operator wallet), must be collateralized");
    console.log("   before it can go active, and rewards are only ever paid out —");
    console.log("   as a vesting entitlement, not a lump sum — for an epoch that");
    console.log("   has actually closed on-chain.");
    console.log("");

    // the operator's own token account for the reward mint — used both
    // as the source when staking and the destination when vested
    // rewards are minted
    const ownerAta = (await getOrCreateAssociatedTokenAccount(
        connection, wallet, rewardMintPDA, wallet.publicKey
    )).address;

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
            failRate: 0.60,         // 60% failure — bad router (will get suspended and slashed)
        },
    ];

    // Every router below stakes from the same operator wallet, so make
    // sure it holds enough to cover all of them. If the wallet is also
    // the protocol authority (true for a freshly-initialized local
    // validator), top it up from the fixed genesis allocation — that is
    // the only mint path that doesn't require already having tokens.
    const required = protocol.minStake.mul(new BN(routerConfigs.length + 1));
    const balance  = (await getAccount(connection, ownerAta)).amount;
    if (BigInt(required.toString()) > balance) {
        const shortfall = required.sub(new BN(balance.toString()));
        if (wallet.publicKey.equals(protocol.authority)) {
            console.log(`💧 Topping up ${shortfall.toString()} reward tokens from the genesis allocation...`);
            await program.methods.mintGenesis(shortfall)
                .accountsPartial({
                    protocol: protocolPDA, rewardMint: rewardMintPDA,
                    recipientTokenAccount: ownerAta, authority: wallet.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();
            console.log("");
        } else {
            console.log(
                "⚠️  Wallet balance is below what's needed to stake every router " +
                "below, and this wallet is not the protocol authority (no genesis " +
                "mint available). Staking calls may fail — acquire reward tokens " +
                "first.\n"
            );
        }
    }

    // create simulator instances
    const simulators = routerConfigs.map(config =>
        new RouterSimulator(program, wallet, config, protocolPDA, rewardMintPDA, stakeVaultPDA, ownerAta)
    );

    // register + stake every router
    console.log("📋 Registering & staking routers...\n");
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
