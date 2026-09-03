/**
 * Seeds a router with a finalized, UNCLAIMED epoch — so the dashboard's
 * "Claim finalized epochs" panel has a real button to press on camera.
 *
 * Why this exists: both `npm run lifecycle` and `npm run verify:operator`
 * claim as part of their run, which is correct for a test but leaves the
 * operator UI with nothing to demonstrate — the claim panel renders
 * "Nothing to claim", because every finalized epoch is already claimed
 * and has moved on to vesting. This script deliberately stops one step
 * earlier.
 *
 * It also can't reuse a router registered through the dashboard: that
 * flow generates the device key in the browser and shows it once, so
 * nothing here can sign heartbeats for it. Hence a dedicated router with
 * a device key this script controls.
 *
 *   solana-test-validator --reset     # in another terminal
 *   cd routerpulse && anchor deploy
 *   npm run seed:claimable
 *
 * Budget ~2.5 minutes: it waits out a real epoch boundary rather than
 * mocking the clock, for the same reason the lifecycle script does.
 */
import * as anchor from "@coral-xyz/anchor";
import {
    Connection, Keypair, PublicKey, SystemProgram,
    LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
    TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
    createAssociatedTokenAccountInstruction, getAccount,
} from "@solana/spl-token";
import BN from "bn.js";
import * as fs from "fs";
import * as path from "path";

const RPC = process.env.RPC_URL || "http://127.0.0.1:8899";
const DECIMALS = 9;

/// Suffixed so repeat runs don't collide with an existing router PDA —
/// re-registering the same id would fail on an account that already exists.
const ROUTER_ID = process.env.ROUTER_ID || `demo-claim-${Date.now() % 100000}`;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const toBase = (v: string): BN => {
    const [w, f = ""] = v.trim().split(".");
    return new BN(w || "0").mul(new BN(10).pow(new BN(DECIMALS)))
        .add(new BN((f + "0".repeat(DECIMALS)).slice(0, DECIMALS) || "0"));
};
const fmt = (v: BN | bigint | string) => {
    const s = BigInt(v.toString());
    const whole = s / BigInt(10 ** DECIMALS);
    const frac = (s % BigInt(10 ** DECIMALS)).toString().padStart(DECIMALS, "0").slice(0, 3);
    return `${whole}.${frac}`;
};
const step = (n: number, m: string) => console.log(`\n\x1b[36m▸ ${n}. ${m}\x1b[0m`);

async function main() {
    const idl = JSON.parse(fs.readFileSync(
        path.resolve(__dirname, "../target/idl/routerpulse.json"), "utf-8"));
    const owner = Keypair.fromSecretKey(Uint8Array.from(
        JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf-8"))));
    const connection = new Connection(RPC, "confirmed");
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(owner), { commitment: "confirmed" });
    const program: any = new anchor.Program(idl, provider);
    const PID: PublicKey = program.programId;

    const seed = (s: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(s, PID)[0];
    const u64  = (n: number | BN) => new BN(n).toArrayLike(Buffer, "le", 8);
    const protocolPda = seed([Buffer.from("protocol")]);
    const rewardMint  = seed([Buffer.from("reward_mint")]);
    const stakeVault  = seed([Buffer.from("stake_vault")]);
    const routerPda   = (o: PublicKey, id: string) => seed([Buffer.from("router"), o.toBuffer(), Buffer.from(id)]);
    const stakePda    = (r: PublicKey) => seed([Buffer.from("stake"), r.toBuffer()]);
    const epochPda    = (r: PublicKey, e: number | BN) => seed([Buffer.from("router_epoch"), r.toBuffer(), u64(e)]);
    const emissionPda = (e: number | BN) => seed([Buffer.from("emission"), u64(e)]);
    const ownerAta    = getAssociatedTokenAddressSync(rewardMint, owner.publicKey);

    console.log(`\n\x1b[1mSeeding a claimable epoch\x1b[0m`);
    console.log(`   cluster ${RPC}`);
    console.log(`   router  ${ROUTER_ID}`);

    const p: any = await program.account.protocol.fetch(protocolPda);
    const EPOCH_DURATION = p.epochDuration.toNumber();
    const HEARTBEAT_INTERVAL = p.heartbeatInterval.toNumber();
    const epNow = () => Math.floor((Math.floor(Date.now() / 1000) - p.genesisTime.toNumber()) / EPOCH_DURATION);

    // ── 1. Make sure the operator can afford the stake ───────────────
    step(1, "Operator balance");
    try { await getAccount(connection, ownerAta); }
    catch {
        await sendAndConfirmTransaction(connection, new Transaction().add(
            createAssociatedTokenAccountInstruction(owner.publicKey, ownerAta, owner.publicKey, rewardMint)
        ), [owner]);
    }
    let bal = (await getAccount(connection, ownerAta)).amount;
    const need = BigInt(p.minStake.toString());
    if (bal < need) {
        // Only the authority can mint genesis, and only within the cap —
        // which is exactly the bootstrap path the protocol is designed for.
        const short = new BN((need - bal).toString());
        await program.methods.mintGenesis(short).accountsPartial({
            protocol: protocolPda, rewardMint, recipientTokenAccount: ownerAta,
            authority: owner.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
        }).rpc();
        bal = (await getAccount(connection, ownerAta)).amount;
    }
    console.log(`   balance ${fmt(bal)} RTP · min stake ${fmt(p.minStake)} RTP`);

    // ── 2. Register with a device key we control ─────────────────────
    step(2, "Register router");
    const device = Keypair.generate();
    const router = routerPda(owner.publicKey, ROUTER_ID);

    if (await connection.getAccountInfo(router)) {
        throw new Error(`router ${ROUTER_ID} already exists — rerun without ROUTER_ID to get a fresh one`);
    }
    await program.methods
        .registerRouter(ROUTER_ID, new BN(19_076_000), new BN(72_877_700), device.publicKey)
        .accountsPartial({
            router, protocol: protocolPda, owner: owner.publicKey,
            systemProgram: SystemProgram.programId,
        }).rpc();
    console.log(`   router  ${router.toBase58()}`);
    console.log(`   device  ${device.publicKey.toBase58()} (owner ≠ device)`);

    // The device pays its own heartbeat fees and the epoch-account rent.
    await sendAndConfirmTransaction(connection, new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: owner.publicKey, toPubkey: device.publicKey,
            lamports: LAMPORTS_PER_SOL / 20,
        })
    ), [owner]);

    // ── 3. Stake, or heartbeat is refused outright ───────────────────
    step(3, "Stake collateral");
    await program.methods.stake(new BN(p.minStake.toString())).accountsPartial({
        router, protocol: protocolPda, stake: stakePda(router), rewardMint, stakeVault,
        ownerTokenAccount: ownerAta, owner: owner.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).rpc();
    console.log(`   staked  ${fmt(p.minStake)} RTP`);

    // ── 4. Full uptime, so the reward is non-zero ────────────────────
    // A zero-reward epoch is filtered out of the claim panel, so a
    // partially-performing router would seed nothing visible.
    const epoch = epNow();
    const expected = Math.max(1, Math.floor(EPOCH_DURATION / HEARTBEAT_INTERVAL));
    step(4, `Heartbeats — ${expected}/${expected} for epoch ${epoch} (full uptime)`);
    for (let i = 0; i < expected; i++) {
        if (i) await sleep(1500);
        await program.methods.heartbeat(new BN(epoch)).accountsPartial({
            router, protocol: protocolPda, device: device.publicKey,
            routerEpoch: epochPda(router, epoch), systemProgram: SystemProgram.programId,
        }).signers([device]).rpc();
        console.log(`   beat ${i + 1}/${expected}`);
    }

    // ── 5. Wait out the real epoch boundary ──────────────────────────
    const endsAt = p.genesisTime.toNumber() + (epoch + 1) * EPOCH_DURATION;
    const waitMs = Math.max(0, (endsAt - Math.floor(Date.now() / 1000) + 3) * 1000);
    step(5, `Waiting ${Math.ceil(waitMs / 1000)}s for epoch ${epoch} to close`);
    await sleep(waitMs);

    // ── 6. Finalize — and stop here ──────────────────────────────────
    step(6, "Finalize (NOT claiming — that's the demo)");
    await program.methods.finalizeRouterEpoch(new BN(epoch)).accountsPartial({
        router, protocol: protocolPda, routerEpoch: epochPda(router, epoch),
        stake: stakePda(router), emission: emissionPda(epoch),
        cranker: owner.publicKey, systemProgram: SystemProgram.programId,
    }).rpc();

    const e: any = await program.account.routerEpoch.fetch(epochPda(router, epoch));
    console.log(`   uptime  ${e.uptimeBps} bps`);
    console.log(`   reward  ${fmt(e.rewardAmount)} RTP`);
    console.log(`   claimed ${e.claimed}`);

    if (e.rewardAmount.isZero()) {
        console.log(`\n\x1b[31m✗ reward is 0 — the claim panel filters these out.\x1b[0m`);
        process.exit(1);
    }

    console.log(`\n\x1b[32m✅ Ready.\x1b[0m`);
    console.log(`   1. cd indexer && node dist/reconcile.js`);
    console.log(`   2. open localhost:3000/operator`);
    console.log(`   3. find "${ROUTER_ID}" → click \x1b[1mmanage\x1b[0m`);
    console.log(`   4. "Claim finalized epochs" now shows epoch ${epoch} · ${fmt(e.rewardAmount)} RTP\n`);
}

main().catch(err => { console.error("\nfailed:", err?.message ?? err); process.exit(1); });
