/**
 * Headless verification of the operator transactions the dashboard sends.
 *
 * A browser wallet extension can't be driven from CI, but the risky part
 * of those components isn't the click — it's whether the account lists,
 * PDA derivations and ATA handling are correct. This exercises exactly
 * that, importing the *same* `src/lib/pdas` module the UI uses, so a
 * drift between this and the dashboard is impossible by construction.
 *
 * What this does NOT cover: wallet-adapter UI behaviour, and the
 * `useTx` phase transitions. Those still need one human pass.
 *
 * Run against a local validator with the program deployed:
 *   npx ts-node --project scripts/tsconfig.json scripts/verify-operator-flow.ts
 */
import {
    Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL,
    Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { AnchorProvider, Program, BN, Wallet } from "@coral-xyz/anchor";
import {
    TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
    createAssociatedTokenAccountInstruction, getAccount, getMint,
} from "@solana/spl-token";
import * as fs from "fs";
import idl from "../src/lib/idl/routerpulse.json";
import {
    protocolPda, rewardMintPda, stakeVaultPda, treasuryPda,
    routerPda, stakePda, routerEpochPda, vestingPda, emissionPda,
} from "../src/lib/pdas";

const RPC = process.env.RPC_URL || "http://127.0.0.1:8899";
const DECIMALS = 9;

let passed = 0, failed = 0;
const ok   = (m: string) => { passed++; console.log(`  ✅ ${m}`); };
const bad  = (m: string, e?: any) => { failed++; console.log(`  ❌ ${m}${e ? `\n       ${String(e).split("\n")[0]}` : ""}`); };
const step = (m: string) => console.log(`\n▸ ${m}`);

/// Mirrors RouterActions.toBaseUnits — deliberately avoids floats, since
/// these are balances and 1e9-scaled amounts lose precision as doubles.
function toBaseUnits(input: string): BN {
    const [whole, frac = ""] = input.trim().split(".");
    const padded = (frac + "0".repeat(DECIMALS)).slice(0, DECIMALS);
    return new BN(whole || "0").mul(new BN(10).pow(new BN(DECIMALS))).add(new BN(padded || "0"));
}

async function main() {
    const secret = JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf-8"));
    const owner = Keypair.fromSecretKey(Uint8Array.from(secret));
    const connection = new Connection(RPC, "confirmed");
    const provider = new AnchorProvider(connection, new Wallet(owner), { commitment: "confirmed" });
    const program = new Program(idl as any, provider);

    console.log(`RPC     ${RPC}`);
    console.log(`wallet  ${owner.publicKey.toBase58()}`);
    console.log(`program ${(idl as any).address}`);

    const protocol   = protocolPda();
    const rewardMint = rewardMintPda();
    const stakeVault = stakeVaultPda();
    const treasury   = treasuryPda();
    const ownerAta   = getAssociatedTokenAddressSync(rewardMint, owner.publicKey);

    // ── setup: protocol + genesis tokens ──────────────────────────────
    step("Setup — protocol and genesis allocation");

    // Short epoch so the finalize/claim path is reachable in one run.
    // 120s is the on-chain floor (heartbeat_interval * MIN_HEARTBEATS_PER_EPOCH).
    const HEARTBEAT_INTERVAL = 60, EPOCH_DURATION = 120;

    if (!await connection.getAccountInfo(protocol)) {
        try {
            // Single ProtocolConfig struct, not positional args — field
            // names are snake_case in the IDL and Anchor's client maps
            // them to camelCase here.
            await program.methods.initializeProtocol({
                rewardRate:              new BN(2_000_000),
                penaltyBps:              500,
                heartbeatInterval:       new BN(HEARTBEAT_INTERVAL),
                epochDuration:           new BN(EPOCH_DURATION),
                minStake:                new BN("1000000000"),        // 1 token
                stakeLockDuration:       new BN(0),                   // no lock, so unstake is testable
                rewardCliffDuration:     new BN(5),
                rewardVestingDuration:   new BN(60),
                initialEmissionPerEpoch: new BN("120000000000"),
                epochsPerYear:           new BN(262_800),
                emissionDecayBps:        1_000,
                genesisAllocation:       new BN("100000000000000"),
            }).accountsPartial({
                protocol, rewardMint, stakeVault, treasury,
                authority: owner.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
            }).rpc();
            ok("protocol initialized");
        } catch (e) { bad("initialize_protocol", e); return; }
    } else ok("protocol already initialized");

    // Operator needs tokens before it can stake — the bootstrap path.
    const ataInfo = await connection.getAccountInfo(ownerAta);
    const pre = ataInfo
        ? [] : [createAssociatedTokenAccountInstruction(owner.publicKey, ownerAta, owner.publicKey, rewardMint)];
    try {
        const b = program.methods.mintGenesis(toBaseUnits("500"))
            .accountsPartial({
                protocol, rewardMint, recipientTokenAccount: ownerAta,
                authority: owner.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
            });
        await (pre.length ? b.preInstructions(pre) : b).rpc();
        ok(`genesis minted — balance ${(await getAccount(connection, ownerAta)).amount}`);
    } catch (e) { bad("mint_genesis", e); return; }

    // ── 1. register_router (mirrors RegisterRouter.tsx) ───────────────
    step("1. register_router — with a generated device identity");
    const routerId = `dash-verify-${Date.now() % 100000}`;
    const device = Keypair.generate();
    const router = routerPda(owner.publicKey, routerId);

    try {
        await program.methods
            .registerRouter(routerId, new BN(19_076_000), new BN(72_877_700), device.publicKey)
            .accountsPartial({
                router, protocol, owner: owner.publicKey,
                systemProgram: SystemProgram.programId,
            })
            .rpc();
        const acct: any = await (program.account as any).router.fetch(router);
        if (acct.devicePubkey.toBase58() !== device.publicKey.toBase58()) {
            bad("device key mismatch — owner/device split is broken");
        } else if (acct.owner.toBase58() !== owner.publicKey.toBase58()) {
            bad("owner mismatch");
        } else {
            ok(`registered ${routerId}, device ${device.publicKey.toBase58().slice(0, 8)}… ≠ owner`);
        }
    } catch (e) { bad("register_router", e); return; }

    // ── 2. stake (mirrors RouterActions.doStake) ──────────────────────
    step("2. stake — collateral moves into the protocol vault");
    const vaultBefore = (await getAccount(connection, stakeVault)).amount;
    try {
        await program.methods.stake(toBaseUnits("10"))
            .accountsPartial({
                router, protocol, stake: stakePda(router),
                rewardMint, stakeVault, ownerTokenAccount: ownerAta,
                owner: owner.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            }).rpc();
        const delta = (await getAccount(connection, stakeVault)).amount - vaultBefore;
        delta === BigInt(toBaseUnits("10").toString())
            ? ok(`vault credited exactly ${delta}`)
            : bad(`vault delta ${delta}, expected ${toBaseUnits("10")}`);
    } catch (e) { bad("stake", e); return; }

    // ── 3. heartbeat, so the epoch has something to score ─────────────
    step("3. heartbeat — signed by the device key, not the owner");
    const p: any = await (program.account as any).protocol.fetch(protocol);
    const epochOf = (t: number) => Math.floor((t - p.genesisTime.toNumber()) / p.epochDuration.toNumber());
    const epoch = epochOf(Math.floor(Date.now() / 1000));

    // The device needs lamports of its own: it signs the heartbeat and
    // pays rent for the epoch account on the first heartbeat of each
    // epoch. Fund it by transfer from the owner rather than an airdrop —
    // airdrops only exist on test clusters, and devnet's faucet refuses
    // most requests anyway. A transfer works identically on localnet,
    // devnet and mainnet, which is what an operator would really do.
    {
        const fund = new Transaction().add(SystemProgram.transfer({
            fromPubkey: owner.publicKey,
            toPubkey: device.publicKey,
            lamports: LAMPORTS_PER_SOL / 20,   // 0.05 SOL: fees + epoch-account rent
        }));
        await sendAndConfirmTransaction(connection, fund, [owner]);
    }

    // expected_heartbeats = epoch_duration / heartbeat_interval. Send at
    // least that many, or uptime lands in a tier that pays zero and
    // slashes — which is correct protocol behaviour, but leaves the
    // claim/vest steps below with nothing to exercise.
    const expected = Math.max(1, Math.floor(EPOCH_DURATION / HEARTBEAT_INTERVAL));
    try {
        for (let i = 0; i < expected; i++) {
            // Consecutive heartbeats must land in different blocks —
            // the program rejects a same-timestamp replay.
            if (i > 0) await new Promise(r => setTimeout(r, 1500));
            await program.methods.heartbeat(new BN(epoch))
                .accountsPartial({
                    router, protocol, device: device.publicKey,
                    routerEpoch: routerEpochPda(router, epoch),
                    systemProgram: SystemProgram.programId,
                })
                .signers([device])
                .rpc();
        }
        ok(`${expected} heartbeats recorded in epoch ${epoch} (full uptime)`);
    } catch (e) { bad("heartbeat", e); return; }

    // ── 4. wait out the epoch, then finalize ──────────────────────────
    const epochEnd = p.genesisTime.toNumber() + (epoch + 1) * p.epochDuration.toNumber();
    const waitMs = Math.max(0, (epochEnd - Math.floor(Date.now() / 1000) + 3) * 1000);
    step(`4. finalize_router_epoch — waiting ${Math.ceil(waitMs / 1000)}s for epoch ${epoch} to close`);
    await new Promise(r => setTimeout(r, waitMs));

    try {
        await program.methods.finalizeRouterEpoch(new BN(epoch))
            .accountsPartial({
                router, protocol, routerEpoch: routerEpochPda(router, epoch),
                stake: stakePda(router), emission: emissionPda(epoch),
                cranker: owner.publicKey,
                systemProgram: SystemProgram.programId,
            }).rpc();
        const re: any = await (program.account as any).routerEpoch.fetch(routerEpochPda(router, epoch));
        ok(`finalized — uptime ${re.uptimeBps}bps, reward ${re.rewardAmount}, slash ${re.slashAmount}`);
        if (re.rewardAmount.isZero()) bad("reward is zero — nothing to claim, later steps are meaningless");
    } catch (e) { bad("finalize_router_epoch", e); return; }

    // ── 5. claim_reward (mirrors RouterActions.doClaim) ───────────────
    step("5. claim_reward — creates a vesting grant, moves no tokens");
    const supplyBefore = (await getMint(connection, rewardMint)).supply;
    try {
        await program.methods.claimReward(new BN(epoch))
            .accountsPartial({
                router, protocol, routerEpoch: routerEpochPda(router, epoch),
                vesting: vestingPda(router, epoch), owner: owner.publicKey,
                systemProgram: SystemProgram.programId,
            }).rpc();
        const supplyAfter = (await getMint(connection, rewardMint)).supply;
        supplyAfter === supplyBefore
            ? ok("vesting grant created and supply unchanged — claiming really doesn't mint")
            : bad(`supply moved on claim: ${supplyBefore} -> ${supplyAfter}`);
    } catch (e) { bad("claim_reward", e); return; }

    // ── 6. claim_vested (mirrors RouterActions.doVest) ────────────────
    step("6. claim_vested — mints only what has actually vested");
    await new Promise(r => setTimeout(r, 8000)); // past the 5s cliff
    const balBefore = (await getAccount(connection, ownerAta)).amount;
    try {
        await program.methods.claimVested(new BN(epoch))
            .accountsPartial({
                router, protocol, vesting: vestingPda(router, epoch),
                rewardMint, beneficiaryTokenAccount: ownerAta,
                beneficiary: owner.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
            }).rpc();
        const gained = (await getAccount(connection, ownerAta)).amount - balBefore;
        const v: any = await (program.account as any).rewardVesting.fetch(vestingPda(router, epoch));
        gained > 0n && gained < BigInt(v.totalAmount.toString())
            ? ok(`released ${gained} of ${v.totalAmount} — a partial slice, as a linear schedule should`)
            : bad(`released ${gained} of total ${v.totalAmount} — expected a partial amount`);
    } catch (e) { bad("claim_vested", e); }

    console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed\n`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error("fatal:", e); process.exit(1); });
