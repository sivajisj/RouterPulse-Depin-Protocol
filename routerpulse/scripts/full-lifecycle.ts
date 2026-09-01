/**
 * RouterPulse — complete protocol lifecycle, end to end.
 *
 * Runs the entire economic story against a real cluster and asserts on
 * every step: two routers are onboarded, one behaves and one doesn't,
 * and the protocol pays the first, slashes the second, burns the
 * proceeds, and lets the good operator withdraw. Governance and the
 * device-recovery path are exercised too.
 *
 * This doubles as the demo script — it narrates as it goes, so it can be
 * run in front of someone rather than only in CI.
 *
 * It deliberately waits out real epoch boundaries instead of mocking the
 * clock. Epoch closure is the mechanism the whole reward design rests
 * on; faking it would test the wrong thing. Budget ~6 minutes.
 *
 *   # local
 *   solana-test-validator --reset      # in another terminal
 *   anchor deploy
 *   npm run lifecycle
 *
 *   # devnet
 *   RPC_URL=https://api.devnet.solana.com npm run lifecycle
 *
 * The compiler options matter: this package's tsconfig targets es6/es2015,
 * which has no BigInt literals and no `console` type. Hence the override
 * baked into the npm script rather than left for the caller to rediscover.
 */
import * as anchor from "@coral-xyz/anchor";
import {
    Connection, Keypair, PublicKey, SystemProgram,
    LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
    TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
    createAssociatedTokenAccountInstruction, getAccount, getMint,
} from "@solana/spl-token";
import BN from "bn.js";
import * as fs from "fs";
import * as path from "path";

const RPC = process.env.RPC_URL || "http://127.0.0.1:8899";
const DECIMALS = 9;

// Short enough to run in one sitting; both are the on-chain floors.
const HEARTBEAT_INTERVAL = 60;
const EPOCH_DURATION = 120;

let passed = 0, failed = 0;
const ok   = (m: string) => { passed++; console.log(`   ✅ ${m}`); };
const fail = (m: string, e?: any) => {
    failed++;
    console.log(`   ❌ ${m}${e ? `\n      ${String(e?.message ?? e).split("\n")[0].slice(0, 160)}` : ""}`);
};
const act  = (n: number, m: string) => console.log(`\n\x1b[36m▸ ${n}. ${m}\x1b[0m`);
const note = (m: string) => console.log(`      ${m}`);
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
    const protocolPda   = seed([Buffer.from("protocol")]);
    const rewardMint    = seed([Buffer.from("reward_mint")]);
    const stakeVault    = seed([Buffer.from("stake_vault")]);
    const treasury      = seed([Buffer.from("treasury")]);
    const routerPda     = (o: PublicKey, id: string) => seed([Buffer.from("router"), o.toBuffer(), Buffer.from(id)]);
    const stakePda      = (r: PublicKey) => seed([Buffer.from("stake"), r.toBuffer()]);
    const epochPda      = (r: PublicKey, e: number | BN) => seed([Buffer.from("router_epoch"), r.toBuffer(), u64(e)]);
    const vestPda       = (r: PublicKey, e: number | BN) => seed([Buffer.from("vesting"), r.toBuffer(), u64(e)]);
    const emissionPda   = (e: number | BN) => seed([Buffer.from("emission"), u64(e)]);
    const ownerAta      = getAssociatedTokenAddressSync(rewardMint, owner.publicKey);

    console.log(`\n\x1b[1mRouterPulse — full lifecycle\x1b[0m`);
    console.log(`   cluster ${RPC}`);
    console.log(`   program ${PID.toBase58()}`);
    console.log(`   wallet  ${owner.publicKey.toBase58()}`);

    // ── 1. Bootstrap ──────────────────────────────────────────────────
    act(1, "Bootstrap — protocol, reward mint, stake vault, treasury");
    if (!await connection.getAccountInfo(protocolPda)) {
        await program.methods.initializeProtocol({
            rewardRate: new BN(2_000_000), penaltyBps: 500,
            heartbeatInterval: new BN(HEARTBEAT_INTERVAL),
            epochDuration: new BN(EPOCH_DURATION),
            minStake: toBase("1"), stakeLockDuration: new BN(0),
            rewardCliffDuration: new BN(5), rewardVestingDuration: new BN(60),
            initialEmissionPerEpoch: toBase("120"), epochsPerYear: new BN(262_800),
            emissionDecayBps: 1_000, genesisAllocation: toBase("100000"),
        }).accountsPartial({
            protocol: protocolPda, rewardMint, stakeVault, treasury,
            authority: owner.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
        }).rpc();
        ok("protocol initialized — mint authority is the protocol PDA, supply starts at 0");
    } else ok("protocol already initialized");

    const mint0 = await getMint(connection, rewardMint);
    note(`mint authority: ${mint0.mintAuthority?.toBase58().slice(0, 12)}… (the PDA, not a human key)`);
    note(`freeze authority: ${mint0.freezeAuthority ?? "none — nobody can freeze balances"}`);

    // ── 2. Genesis ────────────────────────────────────────────────────
    act(2, "Genesis — the bootstrap problem");
    note("staking needs tokens; the only other mint path is vesting, which");
    note("needs staking. Without a bounded genesis nobody gets the first token.");
    const ataInfo = await connection.getAccountInfo(ownerAta);
    const pre = ataInfo ? [] : [createAssociatedTokenAccountInstruction(owner.publicKey, ownerAta, owner.publicKey, rewardMint)];
    const g = program.methods.mintGenesis(toBase("1000")).accountsPartial({
        protocol: protocolPda, rewardMint, recipientTokenAccount: ownerAta,
        authority: owner.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
    });
    await (pre.length ? g.preInstructions(pre) : g).rpc();
    ok(`operator funded — balance ${fmt((await getAccount(connection, ownerAta)).amount)} RTP`);

    const p: any = await program.account.protocol.fetch(protocolPda);
    note(`genesis is hard-capped: ${fmt(p.genesisMinted)} of ${fmt(p.genesisAllocation)} used`);

    // ── 3. Two routers, two fates ─────────────────────────────────────
    act(3, "Onboarding — a good router and one that will fail");
    const stamp = Date.now() % 100000;
    const goodId = `lc-good-${stamp}`, badId = `lc-bad-${stamp}`;
    const goodDev = Keypair.generate(), badDev = Keypair.generate();
    const good = routerPda(owner.publicKey, goodId), bad = routerPda(owner.publicKey, badId);

    for (const [id, dev, pda] of [[goodId, goodDev, good], [badId, badDev, bad]] as const) {
        await program.methods.registerRouter(id, new BN(19_076_000), new BN(72_877_700), dev.publicKey)
            .accountsPartial({ router: pda, protocol: protocolPda, owner: owner.publicKey, systemProgram: SystemProgram.programId })
            .rpc();
    }
    const gAcct: any = await program.account.router.fetch(good);
    gAcct.devicePubkey.toBase58() !== owner.publicKey.toBase58()
        ? ok("both registered; device key ≠ owner wallet — a stolen router cannot move funds")
        : fail("device key equals the owner wallet");

    // Fund devices by transfer, not airdrop: airdrops only exist on test
    // clusters, and this is what a real operator would do anyway.
    const fund = new Transaction();
    for (const d of [goodDev, badDev]) {
        fund.add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: d.publicKey, lamports: LAMPORTS_PER_SOL / 20 }));
    }
    await sendAndConfirmTransaction(connection, fund, [owner]);

    // ── 4. Collateral gate ────────────────────────────────────────────
    act(4, "Collateral — staking is a structural gate, not a policy");
    const epNow = () => Math.floor((Math.floor(Date.now() / 1000) - p.genesisTime.toNumber()) / p.epochDuration.toNumber());
    try {
        const e = epNow();
        await program.methods.heartbeat(new BN(e)).accountsPartial({
            router: good, protocol: protocolPda, device: goodDev.publicKey,
            routerEpoch: epochPda(good, e), systemProgram: SystemProgram.programId,
        }).signers([goodDev]).rpc();
        fail("an uncollateralized router was allowed to activate");
    } catch {
        ok("uncollateralized router refused — heartbeat requires min_stake");
    }

    const vaultBefore = (await getAccount(connection, stakeVault)).amount;
    for (const r of [good, bad]) {
        await program.methods.stake(toBase("10")).accountsPartial({
            router: r, protocol: protocolPda, stake: stakePda(r), rewardMint, stakeVault,
            ownerTokenAccount: ownerAta, owner: owner.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        }).rpc();
    }
    const staked = (await getAccount(connection, stakeVault)).amount - vaultBefore;
    staked === BigInt(toBase("20").toString())
        ? ok(`vault credited exactly ${fmt(staked)} RTP across both routers`)
        : fail(`vault moved ${fmt(staked)}, expected 20`);

    // ── 5. Divergent behaviour ────────────────────────────────────────
    act(5, "Uptime — the good router performs, the bad one goes dark");
    const epoch = epNow();
    const expected = Math.max(1, Math.floor(EPOCH_DURATION / HEARTBEAT_INTERVAL));
    const beat = async (r: PublicKey, d: Keypair) =>
        program.methods.heartbeat(new BN(epoch)).accountsPartial({
            router: r, protocol: protocolPda, device: d.publicKey,
            routerEpoch: epochPda(r, epoch), systemProgram: SystemProgram.programId,
        }).signers([d]).rpc();

    for (let i = 0; i < expected; i++) { if (i) await sleep(1500); await beat(good, goodDev); }
    await beat(bad, badDev);  // one of two — 50% uptime, the bottom tier
    ok(`good router: ${expected}/${expected} heartbeats · bad router: 1/${expected}`);

    // Wrong signer must be refused.
    try {
        await beat(good, badDev);
        fail("a foreign device key was able to heartbeat for another router");
    } catch { ok("heartbeat from the wrong device key rejected"); }

    // ── 6. Epoch closes ───────────────────────────────────────────────
    const endsAt = p.genesisTime.toNumber() + (epoch + 1) * p.epochDuration.toNumber();
    const waitMs = Math.max(0, (endsAt - Math.floor(Date.now() / 1000) + 3) * 1000);
    act(6, `Finalization — waiting ${Math.ceil(waitMs / 1000)}s for epoch ${epoch} to close`);
    note("not mocked: epoch closure is the mechanism the reward design rests on");
    await sleep(waitMs);

    for (const r of [good, bad]) {
        await program.methods.finalizeRouterEpoch(new BN(epoch)).accountsPartial({
            router: r, protocol: protocolPda, routerEpoch: epochPda(r, epoch),
            stake: stakePda(r), emission: emissionPda(epoch),
            cranker: owner.publicKey, systemProgram: SystemProgram.programId,
        }).rpc();
    }
    const gE: any = await program.account.routerEpoch.fetch(epochPda(good, epoch));
    const bE: any = await program.account.routerEpoch.fetch(epochPda(bad, epoch));
    console.log(`      good: ${gE.uptimeBps}bps → reward ${fmt(gE.rewardAmount)}, slash ${fmt(gE.slashAmount)}`);
    console.log(`      bad : ${bE.uptimeBps}bps → reward ${fmt(bE.rewardAmount)}, slash ${fmt(bE.slashAmount)}`);
    gE.rewardAmount.gtn(0) && gE.slashAmount.isZero()
        ? ok("good uptime earns full reward, no slash")
        : fail("good router was not rewarded correctly");
    bE.rewardAmount.isZero() && bE.slashAmount.gtn(0)
        ? ok("sub-70% uptime earns nothing AND is slashed — same tier table drives both")
        : fail("bad router was not penalised correctly");

    // ── 7. Claim mints nothing ────────────────────────────────────────
    act(7, "Claim — creates an entitlement, moves no tokens");
    const supplyBefore = (await getMint(connection, rewardMint)).supply;
    await program.methods.claimReward(new BN(epoch)).accountsPartial({
        router: good, protocol: protocolPda, routerEpoch: epochPda(good, epoch),
        vesting: vestPda(good, epoch), owner: owner.publicKey, systemProgram: SystemProgram.programId,
    }).rpc();
    (await getMint(connection, rewardMint)).supply === supplyBefore
        ? ok("supply unchanged — claiming grants rights, it does not mint")
        : fail("supply moved during claim");

    try {
        await program.methods.claimReward(new BN(epoch)).accountsPartial({
            router: good, protocol: protocolPda, routerEpoch: epochPda(good, epoch),
            vesting: vestPda(good, epoch), owner: owner.publicKey, systemProgram: SystemProgram.programId,
        }).rpc();
        fail("the same epoch was claimed twice");
    } catch { ok("double-claim rejected"); }

    // ── 8. Vesting is the only mint path ──────────────────────────────
    act(8, "Vesting — the only instruction that increases supply");
    await sleep(9000);   // past the 5s cliff
    const balBefore = (await getAccount(connection, ownerAta)).amount;
    await program.methods.claimVested(new BN(epoch)).accountsPartial({
        router: good, protocol: protocolPda, vesting: vestPda(good, epoch),
        rewardMint, beneficiaryTokenAccount: ownerAta,
        beneficiary: owner.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc();
    const gained = (await getAccount(connection, ownerAta)).amount - balBefore;
    const v: any = await program.account.rewardVesting.fetch(vestPda(good, epoch));
    gained > 0n && gained < BigInt(v.totalAmount.toString())
        ? ok(`released ${fmt(gained)} of ${fmt(v.totalAmount)} — a partial slice, as linear vesting should`)
        : fail(`released ${fmt(gained)} of ${fmt(v.totalAmount)} — expected a partial amount`);

    // ── 9. Slash and burn ─────────────────────────────────────────────
    act(9, "Slashing — collateral actually moves, then is destroyed");
    const treasuryBefore = (await getAccount(connection, treasury)).amount;
    await program.methods.slashRouter(new BN(epoch)).accountsPartial({
        router: bad, protocol: protocolPda, routerEpoch: epochPda(bad, epoch),
        stake: stakePda(bad), rewardMint, stakeVault, treasury, tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc();
    const moved = (await getAccount(connection, treasury)).amount - treasuryBefore;
    moved === BigInt(bE.slashAmount.toString())
        ? ok(`${fmt(moved)} RTP moved from stake vault to treasury`)
        : fail(`treasury gained ${fmt(moved)}, expected ${fmt(bE.slashAmount)}`);

    try {
        await program.methods.slashRouter(new BN(epoch)).accountsPartial({
            router: bad, protocol: protocolPda, routerEpoch: epochPda(bad, epoch),
            stake: stakePda(bad), rewardMint, stakeVault, treasury, tokenProgram: TOKEN_PROGRAM_ID,
        }).rpc();
        fail("the same epoch was slashed twice");
    } catch { ok("double-slash rejected"); }

    const supplyPreBurn = (await getMint(connection, rewardMint)).supply;
    await program.methods.burnTreasury(new BN(moved.toString())).accountsPartial({
        protocol: protocolPda, rewardMint, treasury,
        authority: owner.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc();
    const supplyPostBurn = (await getMint(connection, rewardMint)).supply;
    supplyPostBurn === supplyPreBurn - moved
        ? ok(`burned ${fmt(moved)} — the penalty is deflationary, not a transfer to the treasury operator`)
        : fail("burn did not reduce supply correctly");

    // ── 10. Device recovery ───────────────────────────────────────────
    act(10, "Device recovery — rotate a compromised key");
    const replacement = Keypair.generate();
    await program.methods.rotateDeviceKey(replacement.publicKey)
        .accountsPartial({ router: good, owner: owner.publicKey }).rpc();
    const rotated: any = await program.account.router.fetch(good);
    rotated.devicePubkey.toBase58() === replacement.publicKey.toBase58() && rotated.deviceKeyVersion >= 1
        ? ok(`rotated to a new device, version ${rotated.deviceKeyVersion} — stake and history intact`)
        : fail("rotation did not take effect");

    try {
        await beat(good, goodDev);
        fail("the retired device key still works — rotation does not contain a compromise");
    } catch { ok("the old device key is dead"); }

    // ── 11. Governance ────────────────────────────────────────────────
    act(11, "Governance — pause is enforced, and auditable");
    await program.methods.pauseProtocol()
        .accountsPartial({ protocol: protocolPda, authority: owner.publicKey }).rpc();
    try {
        await beat(good, replacement);
        fail("heartbeats still accepted while the protocol was paused");
    } catch { ok("pause actually blocks heartbeats"); }
    await program.methods.resumeProtocol()
        .accountsPartial({ protocol: protocolPda, authority: owner.publicKey }).rpc();

    const rateSig = await program.methods.updateRewardRate(new BN(3_000_000))
        .accountsPartial({ protocol: protocolPda, authority: owner.publicKey }).rpc();
    await connection.confirmTransaction(rateSig, "confirmed");
    let rtx = null;
    for (let i = 0; i < 8 && !rtx; i++) {
        rtx = await connection.getTransaction(rateSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        if (!rtx) await sleep(400);
    }
    const parser = new anchor.EventParser(PID, new anchor.BorshCoder(program.idl));
    let sawRate = false;
    for (const ev of parser.parseLogs(rtx!.meta!.logMessages!)) {
        if (ev.name.toLowerCase() === "rewardrateupdated") {
            sawRate = true;
            note(`event records ${(ev.data as any).previousRate} → ${(ev.data as any).newRate}, and the acting authority`);
        }
    }
    sawRate ? ok("governance actions emit an auditable event, not just a log line")
            : fail("no RewardRateUpdated event emitted");
    await program.methods.updateRewardRate(new BN(2_000_000))
        .accountsPartial({ protocol: protocolPda, authority: owner.publicKey }).rpc();

    // ── 12. Exit ──────────────────────────────────────────────────────
    act(12, "Exit — withdraw collateral above the minimum");
    const vb = (await getAccount(connection, stakeVault)).amount;
    await program.methods.unstake(toBase("5")).accountsPartial({
        router: good, protocol: protocolPda, stake: stakePda(good),
        rewardMint, stakeVault, ownerTokenAccount: ownerAta,
        owner: owner.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc();
    const out = vb - (await getAccount(connection, stakeVault)).amount;
    out === BigInt(toBase("5").toString())
        ? ok(`withdrew exactly ${fmt(out)} RTP`)
        : fail(`vault moved ${fmt(out)}, expected 5`);

    // ── 13. Supply reconciles ─────────────────────────────────────────
    act(13, "Reconciliation — does the money add up?");
    const finalMint = await getMint(connection, rewardMint);
    const fp: any = await program.account.protocol.fetch(protocolPda);
    const expectedSupply = BigInt(fp.totalMinted.toString()) - BigInt(fp.totalBurned.toString());
    finalMint.supply === expectedSupply
        ? ok(`on-chain supply ${fmt(finalMint.supply)} == totalMinted − totalBurned`)
        : fail(`supply ${fmt(finalMint.supply)} != minted−burned ${fmt(expectedSupply)}`);
    note(`staked ${fmt(fp.totalStaked)} · slashed ${fmt(fp.totalSlashed)} · burned ${fmt(fp.totalBurned)}`);

    console.log(`\n${failed === 0 ? "\x1b[32m✅" : "\x1b[31m❌"} ${passed} passed, ${failed} failed\x1b[0m\n`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error("\nfatal:", e); process.exit(1); });
