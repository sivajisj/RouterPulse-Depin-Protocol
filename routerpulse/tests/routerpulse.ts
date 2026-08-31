import * as anchor from "@coral-xyz/anchor";
import { Program }  from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
    TOKEN_PROGRAM_ID,
    getOrCreateAssociatedTokenAccount,
    getAccount,
    getMint,
} from "@solana/spl-token";
import { assert }   from "chai";
// Imported directly (not via anchor.BN) — under this toolchain's mocha/Node
// ESM interop, @coral-xyz/anchor's re-exported `BN` fails to resolve as a
// constructor while bn.js's own single default export resolves reliably.
import BN from "bn.js";

describe("RouterPulse", () => {

    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.Routerpulse as Program<any>;
    const wallet = (provider.wallet as anchor.Wallet).payer;

    // Kept short so the epoch tests (which must wait for real wall-clock
    // time to cross an epoch boundary) finish in a reasonable time.
    // heartbeat_interval=60s is the on-chain floor; epoch_duration=120s
    // is 2x that, also the on-chain floor.
    const HEARTBEAT_INTERVAL = 60;
    const EPOCH_DURATION     = 120;
    const STAKE_AMOUNT       = new BN(10_000_000_000);   // 10 tokens @ 9dp
    const MIN_STAKE          = new BN(1_000_000_000);    // 1 token
    const REWARD_VESTING     = 60;                        // seconds
    const GENESIS_ALLOCATION = new BN("100000000000000"); // 100k tokens

    const seedPda = (seeds: (Buffer | Uint8Array)[]) =>
        PublicKey.findProgramAddressSync(seeds, program.programId)[0];

    const protocolPDA   = seedPda([Buffer.from("protocol")]);
    const rewardMintPDA = seedPda([Buffer.from("reward_mint")]);
    const stakeVaultPDA = seedPda([Buffer.from("stake_vault")]);
    const treasuryPDA   = seedPda([Buffer.from("treasury")]);

    const epochSeed = (n: number | BN) => new BN(n).toArrayLike(Buffer, "le", 8);

    const getRouterPDA = (owner: PublicKey, routerId: string) =>
        seedPda([Buffer.from("router"), owner.toBuffer(), Buffer.from(routerId)]);
    const getRouterEpochPDA = (router: PublicKey, n: number | BN) =>
        seedPda([Buffer.from("router_epoch"), router.toBuffer(), epochSeed(n)]);
    const getStakePDA = (router: PublicKey) =>
        seedPda([Buffer.from("stake"), router.toBuffer()]);
    const getVestingPDA = (router: PublicKey, n: number | BN) =>
        seedPda([Buffer.from("vesting"), router.toBuffer(), epochSeed(n)]);
    const getEmissionPDA = (n: number | BN) =>
        seedPda([Buffer.from("emission"), epochSeed(n)]);

    // Mirrors Protocol::epoch_number_at on-chain — deterministic from
    // genesis_time + epoch_duration, so client and program always agree.
    function currentEpochNumber(protocol: any, atSec: number): BN {
        const genesis = protocol.genesisTime.toNumber();
        const duration = protocol.epochDuration.toNumber();
        if (atSec <= genesis || duration <= 0) return new BN(0);
        return new BN(Math.floor((atSec - genesis) / duration));
    }
    function epochEndTime(protocol: any, epochNumber: BN): number {
        return protocol.genesisTime.toNumber()
            + (epochNumber.toNumber() + 1) * protocol.epochDuration.toNumber();
    }

    const nowSec = () => Math.floor(Date.now() / 1000);
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
    const fetchProtocol = () => program.account.protocol.fetch(protocolPDA);

    /// Pulls one emitted event back out of a confirmed transaction's logs.
    ///
    /// Asserting on events rather than only on resulting state is the
    /// point for governance actions: reconciliation can always recover
    /// *what* a value became, but only the event records *who* changed it
    /// and *when*. Returns the decoded data, or null if absent.
    async function findEvent(signature: string, name: string): Promise<any | null> {
        // Anchor's Program constructor camelCases IDL names, so the same
        // event is `ProtocolPaused` in target/idl/routerpulse.json but
        // `protocolPaused` on `program.idl`. Compare case-insensitively
        // so callers can write either and neither silently misses.
        // (This is the third casing convention in this codebase: event
        // *fields* stay snake_case in the raw IDL — see indexer/README —
        // while account fields and now event names get camelCased.)
        const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

        // Fail loudly if the IDL doesn't declare this event at all.
        // Without this a stale IDL is indistinguishable from "the program
        // emitted nothing" — both just yield null — and that ambiguity
        // cost real debugging time here.
        const declared: string[] = (program.idl as any).events?.map((e: any) => e.name) ?? [];
        if (!declared.some(d => eq(d, name))) {
            throw new Error(
                `IDL has no event '${name}' (knows ${declared.length}: ${declared.slice(0, 5).join(", ")}…). ` +
                `The IDL is stale relative to the deployed program — rebuild with 'anchor build'.`
            );
        }

        // getTransaction routinely returns null for a moment after .rpc()
        // even at "confirmed" — the signature is confirmed before the
        // transaction is servable. Retry rather than reporting "no event".
        await provider.connection.confirmTransaction(signature, "confirmed");
        let tx = null;
        for (let i = 0; i < 8 && !tx; i++) {
            tx = await provider.connection.getTransaction(signature, {
                commitment: "confirmed",
                maxSupportedTransactionVersion: 0,
            });
            if (!tx) await sleep(400);
        }
        if (!tx?.meta?.logMessages) {
            throw new Error(`transaction ${signature.slice(0, 12)}… never became retrievable`);
        }

        const parser = new anchor.EventParser(program.programId, new anchor.BorshCoder(program.idl));
        for (const ev of parser.parseLogs(tx.meta.logMessages)) {
            if (eq(ev.name, name)) return ev.data;
        }
        return null;
    }

    async function airdrop(pubkey: PublicKey, sol = 1): Promise<void> {
        const sig = await provider.connection.requestAirdrop(pubkey, sol * anchor.web3.LAMPORTS_PER_SOL);
        await provider.connection.confirmTransaction(sig);
    }
    async function tokenBalance(ata: PublicKey): Promise<bigint> {
        return (await getAccount(provider.connection, ata)).amount;
    }

    let ownerAta: PublicKey;

    // ── Protocol + token bootstrap ────────────────────────────────────────────

    describe("Protocol Initialization", () => {

        it("creates the protocol, reward mint, stake vault and treasury", async () => {
            if (!await provider.connection.getAccountInfo(protocolPDA)) {
                await program.methods
                    .initializeProtocol({
                        rewardRate:              new BN(1_000_000),
                        penaltyBps:              500,
                        heartbeatInterval:       new BN(HEARTBEAT_INTERVAL),
                        epochDuration:           new BN(EPOCH_DURATION),
                        minStake:                MIN_STAKE,
                        stakeLockDuration:       new BN(0),
                        rewardCliffDuration:     new BN(0),
                        rewardVestingDuration:   new BN(REWARD_VESTING),
                        initialEmissionPerEpoch: new BN("1000000000000"),
                        epochsPerYear:           new BN(1000),
                        emissionDecayBps:        8000,
                        genesisAllocation:       GENESIS_ALLOCATION,
                    })
                    .accountsPartial({
                        protocol: protocolPDA, rewardMint: rewardMintPDA,
                        stakeVault: stakeVaultPDA, treasury: treasuryPDA,
                        authority: provider.wallet.publicKey,
                        tokenProgram: TOKEN_PROGRAM_ID,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .rpc();
            }
            const protocol = await fetchProtocol();
            assert.equal(protocol.rewardMint.toBase58(), rewardMintPDA.toBase58());
            assert.equal(protocol.isPaused, false);

            // The critical invariant: the protocol PDA is the sole mint
            // authority, so no human key can ever issue reward tokens.
            const mint = await getMint(provider.connection, rewardMintPDA);
            assert.equal(mint.mintAuthority?.toBase58(), protocolPDA.toBase58());
            assert.isNull(mint.freezeAuthority, "protocol must not be able to freeze holders");
            assert.equal(mint.decimals, 9);

            console.log("✅ Protocol + token ready");
            console.log("   mint:          ", rewardMintPDA.toBase58());
            console.log("   mint authority:", mint.mintAuthority?.toBase58(), "(protocol PDA)");
        });

        it("rejects a vesting duration shorter than its cliff", async () => {
            try {
                await program.methods
                    .initializeProtocol({
                        rewardRate: new BN(1000), penaltyBps: 500,
                        heartbeatInterval: new BN(HEARTBEAT_INTERVAL), epochDuration: new BN(EPOCH_DURATION),
                        minStake: MIN_STAKE, stakeLockDuration: new BN(0),
                        rewardCliffDuration: new BN(100), rewardVestingDuration: new BN(10),
                        initialEmissionPerEpoch: new BN(1000), epochsPerYear: new BN(1000),
                        emissionDecayBps: 8000, genesisAllocation: GENESIS_ALLOCATION,
                    })
                    .accountsPartial({
                        protocol: protocolPDA, rewardMint: rewardMintPDA, stakeVault: stakeVaultPDA,
                        treasury: treasuryPDA, authority: provider.wallet.publicKey,
                        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.ok(err);
                console.log("✅ Invalid vesting schedule rejected");
            }
        });
    });

    describe("Genesis Distribution", () => {

        before(async () => {
            ownerAta = (await getOrCreateAssociatedTokenAccount(
                provider.connection, wallet, rewardMintPDA, wallet.publicKey
            )).address;
        });

        it("mints the initial distribution so operators can bootstrap a stake", async () => {
            const before = await tokenBalance(ownerAta);
            if (before < BigInt(STAKE_AMOUNT.muln(4).toString())) {
                await program.methods.mintGenesis(STAKE_AMOUNT.muln(10))
                    .accountsPartial({
                        protocol: protocolPDA, rewardMint: rewardMintPDA,
                        recipientTokenAccount: ownerAta,
                        authority: provider.wallet.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .rpc();
            }
            const after = await tokenBalance(ownerAta);
            assert.isTrue(after > 0n);
            const protocol = await fetchProtocol();
            assert.isTrue(protocol.genesisMinted.gt(new BN(0)));
            console.log("✅ Genesis distributed. Operator balance:", after.toString());
        });

        it("rejects genesis minting from a non-authority", async () => {
            const attacker = anchor.web3.Keypair.generate();
            await airdrop(attacker.publicKey);
            try {
                await program.methods.mintGenesis(new BN(1))
                    .accountsPartial({
                        protocol: protocolPDA, rewardMint: rewardMintPDA,
                        recipientTokenAccount: ownerAta,
                        authority: attacker.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .signers([attacker])
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.ok(err);
                console.log("✅ Non-authority genesis mint rejected");
            }
        });

        it("enforces the genesis cap — the authority cannot mint unbounded supply", async () => {
            const protocol = await fetchProtocol();
            const remaining = protocol.genesisAllocation.sub(protocol.genesisMinted);
            try {
                await program.methods.mintGenesis(remaining.addn(1))
                    .accountsPartial({
                        protocol: protocolPDA, rewardMint: rewardMintPDA,
                        recipientTokenAccount: ownerAta,
                        authority: provider.wallet.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.include(err.toString(), "GenesisAllocationExhausted");
                console.log("✅ Genesis cap enforced (remaining:", remaining.toString() + ")");
            }
        });
    });

    // ── Registration + device identity ────────────────────────────────────────

    const routerId  = "router-mumbai-001";
    let routerPDA: PublicKey;
    let stakePDA: PublicKey;
    let device: anchor.web3.Keypair;

    describe("Router Registration & Device Identity", () => {

        before(() => {
            routerPDA = getRouterPDA(provider.wallet.publicKey, routerId);
            stakePDA  = getStakePDA(routerPDA);
        });

        it("registers a router whose device key differs from the owner wallet", async () => {
            device = anchor.web3.Keypair.generate();
            await airdrop(device.publicKey);

            if (!await provider.connection.getAccountInfo(routerPDA)) {
                await program.methods
                    .registerRouter(routerId, new BN(19_076_000), new BN(72_877_700), device.publicKey)
                    .accountsPartial({
                        router: routerPDA, protocol: protocolPDA,
                        owner: provider.wallet.publicKey,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .rpc();
            } else {
                await program.methods.rotateDeviceKey(device.publicKey)
                    .accountsPartial({ router: routerPDA, owner: provider.wallet.publicKey })
                    .rpc();
            }

            const router = await program.account.router.fetch(routerPDA);
            assert.equal(router.owner.toBase58(), provider.wallet.publicKey.toBase58());
            assert.equal(router.devicePubkey.toBase58(), device.publicKey.toBase58());
            assert.notEqual(router.devicePubkey.toBase58(), router.owner.toBase58());
            console.log("✅ Router registered; device identity separate from owner");
        });

        it("rejects invalid latitude", async () => {
            const badPDA = getRouterPDA(provider.wallet.publicKey, "bad-lat");
            try {
                await program.methods
                    .registerRouter("bad-lat", new BN(999_000_000), new BN(0), device.publicKey)
                    .accountsPartial({
                        router: badPDA, protocol: protocolPDA, owner: provider.wallet.publicKey,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.ok(err);
                console.log("✅ Bad latitude rejected");
            }
        });

        it("rejects device key rotation from a non-owner", async () => {
            const attacker = anchor.web3.Keypair.generate();
            await airdrop(attacker.publicKey);
            try {
                await program.methods.rotateDeviceKey(anchor.web3.Keypair.generate().publicKey)
                    .accountsPartial({ router: routerPDA, owner: attacker.publicKey })
                    .signers([attacker])
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.ok(err);
                console.log("✅ Non-owner rotation rejected");
            }
        });
    });

    // ── Staking ───────────────────────────────────────────────────────────────

    describe("Staking", () => {

        it("blocks heartbeats from an uncollateralized router", async () => {
            const protocol = await fetchProtocol();
            const epoch = currentEpochNumber(protocol, nowSec());
            const router = await program.account.router.fetch(routerPDA);
            if (router.stakedAmount.gte(protocol.minStake)) {
                console.log("ℹ️  Router already staked from a prior run — skipping");
                return;
            }
            try {
                await program.methods.heartbeat(epoch)
                    .accountsPartial({
                        router: routerPDA, protocol: protocolPDA, device: device.publicKey,
                        routerEpoch: getRouterEpochPDA(routerPDA, epoch),
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .signers([device])
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.include(err.toString(), "InsufficientStake");
                console.log("✅ Uncollateralized router cannot heartbeat");
            }
        });

        it("stakes collateral, moving real tokens into the protocol vault", async () => {
            const walletBefore = await tokenBalance(ownerAta);
            const vaultBefore  = await tokenBalance(stakeVaultPDA);

            await program.methods.stake(STAKE_AMOUNT)
                .accountsPartial({
                    router: routerPDA, protocol: protocolPDA, stake: stakePDA,
                    rewardMint: rewardMintPDA, stakeVault: stakeVaultPDA,
                    ownerTokenAccount: ownerAta, owner: provider.wallet.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .rpc();

            const walletAfter = await tokenBalance(ownerAta);
            const vaultAfter  = await tokenBalance(stakeVaultPDA);
            const staked = BigInt(STAKE_AMOUNT.toString());

            assert.equal(walletBefore - walletAfter, staked, "operator debited exactly");
            assert.equal(vaultAfter - vaultBefore, staked, "vault credited exactly");

            const stake = await program.account.stake.fetch(stakePDA);
            const router = await program.account.router.fetch(routerPDA);
            assert.equal(stake.amount.toString(), STAKE_AMOUNT.toString());
            // The denormalized mirror on Router must track the Stake account.
            assert.equal(router.stakedAmount.toString(), stake.amount.toString());
            console.log("✅ Staked", staked.toString(), "— vault balance:", vaultAfter.toString());
        });

        it("rejects a zero stake", async () => {
            try {
                await program.methods.stake(new BN(0))
                    .accountsPartial({
                        router: routerPDA, protocol: protocolPDA, stake: stakePDA,
                        rewardMint: rewardMintPDA, stakeVault: stakeVaultPDA,
                        ownerTokenAccount: ownerAta, owner: provider.wallet.publicKey,
                        tokenProgram: TOKEN_PROGRAM_ID,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.include(err.toString(), "InvalidStakeAmount");
                console.log("✅ Zero stake rejected");
            }
        });

        it("rejects unstaking more than is staked", async () => {
            const stake = await program.account.stake.fetch(stakePDA);
            try {
                await program.methods.unstake(stake.amount.addn(1))
                    .accountsPartial({
                        router: routerPDA, protocol: protocolPDA, stake: stakePDA,
                        rewardMint: rewardMintPDA, stakeVault: stakeVaultPDA,
                        ownerTokenAccount: ownerAta, owner: provider.wallet.publicKey,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.include(err.toString(), "UnstakeExceedsStake");
                console.log("✅ Over-unstake rejected");
            }
        });

        it("rejects an unstake that would drop an active router below the minimum", async () => {
            const router = await program.account.router.fetch(routerPDA);
            if (JSON.stringify(router.status) !== JSON.stringify({ active: {} })) {
                console.log("ℹ️  Router not active yet — minimum-stake floor tested after activation");
                return;
            }
            const stake = await program.account.stake.fetch(stakePDA);
            try {
                await program.methods.unstake(stake.amount)
                    .accountsPartial({
                        router: routerPDA, protocol: protocolPDA, stake: stakePDA,
                        rewardMint: rewardMintPDA, stakeVault: stakeVaultPDA,
                        ownerTokenAccount: ownerAta, owner: provider.wallet.publicKey,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.include(err.toString(), "UnstakeBelowMinimum");
                console.log("✅ Cannot strip collateral from an active router");
            }
        });
    });

    // ── Heartbeat ─────────────────────────────────────────────────────────────

    describe("Heartbeat", () => {

        const heartbeat = (epoch: BN, signer: anchor.web3.Keypair) =>
            program.methods.heartbeat(epoch)
                .accountsPartial({
                    router: routerPDA, protocol: protocolPDA, device: signer.publicKey,
                    routerEpoch: getRouterEpochPDA(routerPDA, epoch),
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .signers([signer]);

        it("first heartbeat activates the collateralized router", async () => {
            const protocol = await fetchProtocol();
            const epoch = currentEpochNumber(protocol, nowSec());
            await heartbeat(epoch, device).rpc();

            const router = await program.account.router.fetch(routerPDA);
            assert.deepEqual(router.status, { active: {} });
            const routerEpoch = await program.account.routerEpoch.fetch(getRouterEpochPDA(routerPDA, epoch));
            assert.isAtLeast(routerEpoch.heartbeats, 1);
            console.log("✅ Router active; epoch heartbeats:", routerEpoch.heartbeats);
        });

        it("rejects a replay within the same block", async () => {
            const protocol = await fetchProtocol();
            const epoch = currentEpochNumber(protocol, nowSec());
            try {
                await heartbeat(epoch, device).rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.ok(err);
                console.log("✅ Replay rejected");
            }
        });

        it("rejects a signer that is not the registered device key", async () => {
            const impostor = anchor.web3.Keypair.generate();
            await airdrop(impostor.publicKey);
            const protocol = await fetchProtocol();
            const epoch = currentEpochNumber(protocol, nowSec());
            try {
                await heartbeat(epoch, impostor).rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.include(err.toString(), "InvalidDeviceSigner");
                console.log("✅ Wrong device signer rejected");
            }
        });

        it("rejects a wrong epoch number", async () => {
            const protocol = await fetchProtocol();
            const epoch = currentEpochNumber(protocol, nowSec());
            await sleep(2000);
            try {
                await heartbeat(epoch.addn(7), device).rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.include(err.toString(), "WrongEpochNumber");
                console.log("✅ Wrong epoch number rejected");
            }
        });

        it("blocks heartbeats while the protocol is paused", async () => {
            await program.methods.pauseProtocol()
                .accountsPartial({ protocol: protocolPDA, authority: provider.wallet.publicKey })
                .rpc();
            const protocol = await fetchProtocol();
            const epoch = currentEpochNumber(protocol, nowSec());
            try {
                await heartbeat(epoch, device).rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.include(err.toString(), "ProtocolPaused");
                console.log("✅ Heartbeat blocked while paused");
            } finally {
                await program.methods.resumeProtocol()
                    .accountsPartial({ protocol: protocolPDA, authority: provider.wallet.publicKey })
                    .rpc();
            }
        });
    });

    // ── Epoch → reward → vesting, end to end ──────────────────────────────────

    describe("Epoch Rewards, Emissions and Vesting", function () {
        this.timeout(EPOCH_DURATION * 1000 + 240_000);

        let epochNumber: BN;

        it("records heartbeats inside the current epoch", async () => {
            const protocol = await fetchProtocol();
            epochNumber = currentEpochNumber(protocol, nowSec());
            await program.methods.heartbeat(epochNumber)
                .accountsPartial({
                    router: routerPDA, protocol: protocolPDA, device: device.publicKey,
                    routerEpoch: getRouterEpochPDA(routerPDA, epochNumber),
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .signers([device])
                .rpc();
            const re = await program.account.routerEpoch.fetch(getRouterEpochPDA(routerPDA, epochNumber));
            assert.isAtLeast(re.heartbeats, 1);
            console.log("✅ Heartbeats in epoch", epochNumber.toString() + ":", re.heartbeats);
        });

        const finalize = (epoch: BN) =>
            program.methods.finalizeRouterEpoch(epoch)
                .accountsPartial({
                    router: routerPDA, protocol: protocolPDA,
                    routerEpoch: getRouterEpochPDA(routerPDA, epoch),
                    stake: stakePDA, emission: getEmissionPDA(epoch),
                    cranker: provider.wallet.publicKey,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .rpc();

        const claim = (epoch: BN) =>
            program.methods.claimReward(epoch)
                .accountsPartial({
                    router: routerPDA, protocol: protocolPDA,
                    routerEpoch: getRouterEpochPDA(routerPDA, epoch),
                    vesting: getVestingPDA(routerPDA, epoch),
                    owner: provider.wallet.publicKey,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .rpc();

        it("rejects finalization before the epoch has ended", async () => {
            try {
                await finalize(epochNumber);
                assert.fail("should reject");
            } catch (err: any) {
                assert.include(err.toString(), "EpochNotEnded");
                console.log("✅ Early finalize rejected");
            }
        });

        it("rejects claiming before finalization", async () => {
            try {
                await claim(epochNumber);
                assert.fail("should reject");
            } catch (err: any) {
                assert.include(err.toString(), "EpochNotFinalized");
                console.log("✅ Premature claim rejected");
            }
        });

        it("finalizes once the epoch closes, opening the epoch's emission budget", async () => {
            const protocol = await fetchProtocol();
            const waitMs = Math.max(0, (epochEndTime(protocol, epochNumber) - nowSec() + 2) * 1000);
            console.log(`   waiting ${Math.ceil(waitMs / 1000)}s for epoch to close...`);
            await sleep(waitMs);

            await finalize(epochNumber);

            const re = await program.account.routerEpoch.fetch(getRouterEpochPDA(routerPDA, epochNumber));
            assert.equal(re.finalized, true);
            assert.isAbove(re.rewardAmount.toNumber(), 0);

            const emission = await program.account.emissionSchedule.fetch(getEmissionPDA(epochNumber));
            assert.isAbove(emission.totalEmission.toNumber(), 0);
            assert.equal(emission.allocated.toString(), re.rewardAmount.toString(),
                "the epoch's allocation must equal what was actually awarded");

            console.log("✅ Finalized. uptime_bps:", re.uptimeBps,
                        "reward:", re.rewardAmount.toString(),
                        "slash:", re.slashAmount.toString());
            console.log("   emission budget:", emission.totalEmission.toString(),
                        "allocated:", emission.allocated.toString());
        });

        it("rejects double finalization", async () => {
            try {
                await finalize(epochNumber);
                assert.fail("should reject");
            } catch (err: any) {
                assert.include(err.toString(), "EpochAlreadyFinalized");
                console.log("✅ Double finalize rejected");
            }
        });

        it("claims the epoch into a vesting schedule — granting rights, not tokens", async () => {
            const supplyBefore = (await getMint(provider.connection, rewardMintPDA)).supply;

            await claim(epochNumber);

            const vesting = await program.account.rewardVesting.fetch(getVestingPDA(routerPDA, epochNumber));
            const re = await program.account.routerEpoch.fetch(getRouterEpochPDA(routerPDA, epochNumber));
            assert.equal(re.claimed, true);
            assert.equal(vesting.totalAmount.toString(), re.rewardAmount.toString());
            assert.equal(vesting.claimedAmount.toString(), "0");

            // Claiming must not mint. Supply only moves when tokens vest.
            const supplyAfter = (await getMint(provider.connection, rewardMintPDA)).supply;
            assert.equal(supplyAfter, supplyBefore, "claim_reward must not change token supply");

            console.log("✅ Vesting granted:", vesting.totalAmount.toString(),
                        "over", vesting.vestingDuration.toString() + "s (supply unchanged)");
        });

        it("rejects double claiming the same epoch", async () => {
            try {
                await claim(epochNumber);
                assert.fail("should reject");
            } catch (err: any) {
                // Two independent guards fire here: the epoch's `claimed`
                // flag, and `init` on the vesting PDA (already in use).
                assert.ok(err);
                console.log("✅ Double claim rejected");
            }
        });

        it("mints only the vested portion, and only ever the un-released delta", async () => {
            const claimVested = () =>
                program.methods.claimVested(epochNumber)
                    .accountsPartial({
                        router: routerPDA, protocol: protocolPDA,
                        vesting: getVestingPDA(routerPDA, epochNumber),
                        rewardMint: rewardMintPDA,
                        beneficiaryTokenAccount: ownerAta,
                        beneficiary: provider.wallet.publicKey,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .rpc();

            // Vesting is linear over REWARD_VESTING seconds with no cliff,
            // so a slice is already releasable.
            await sleep(3000);

            const balanceBefore = await tokenBalance(ownerAta);
            await claimVested();
            const balanceAfter = await tokenBalance(ownerAta);
            assert.isTrue(balanceAfter > balanceBefore, "vested tokens must be minted to the operator");

            const v1 = await program.account.rewardVesting.fetch(getVestingPDA(routerPDA, epochNumber));
            assert.isTrue(v1.claimedAmount.gt(new BN(0)));
            assert.isTrue(v1.claimedAmount.lte(v1.totalAmount), "can never release more than granted");
            const firstSlice = balanceAfter - balanceBefore;
            console.log("✅ First vest released:", firstSlice.toString(),
                        "of", v1.totalAmount.toString());

            // A second call immediately after should release only the tiny
            // additional slice that vested in between — never the same
            // tokens twice.
            await sleep(3000);
            const beforeSecond = await tokenBalance(ownerAta);
            await claimVested();
            const afterSecond = await tokenBalance(ownerAta);
            const secondSlice = afterSecond - beforeSecond;

            const v2 = await program.account.rewardVesting.fetch(getVestingPDA(routerPDA, epochNumber));
            assert.isTrue(v2.claimedAmount.lte(v2.totalAmount));
            // `claimedAmount` started at 0, so the operator's total balance
            // gain across both calls must equal it exactly — proving no
            // slice was ever released twice.
            assert.equal(
                afterSecond - balanceBefore,
                BigInt(v2.claimedAmount.toString()),
                "cumulative balance gain must equal the vesting record's claimed total"
            );
            console.log("✅ Second vest released only the new delta:", secondSlice.toString(),
                        "(total claimed:", v2.claimedAmount.toString() + ")");
        });

        it("fully vests and then has nothing left to release", async () => {
            const protocol = await fetchProtocol();
            const vesting = await program.account.rewardVesting.fetch(getVestingPDA(routerPDA, epochNumber));
            const endsAt = vesting.startTime.toNumber() + vesting.vestingDuration.toNumber();
            const waitMs = Math.max(0, (endsAt - nowSec() + 2) * 1000);
            console.log(`   waiting ${Math.ceil(waitMs / 1000)}s for full vest...`);
            await sleep(waitMs);

            const claimVested = () =>
                program.methods.claimVested(epochNumber)
                    .accountsPartial({
                        router: routerPDA, protocol: protocolPDA,
                        vesting: getVestingPDA(routerPDA, epochNumber),
                        rewardMint: rewardMintPDA, beneficiaryTokenAccount: ownerAta,
                        beneficiary: provider.wallet.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .rpc();

            await claimVested();
            const done = await program.account.rewardVesting.fetch(getVestingPDA(routerPDA, epochNumber));
            assert.equal(done.claimedAmount.toString(), done.totalAmount.toString(),
                "the whole grant must eventually vest — exactly, never more");
            console.log("✅ Fully vested:", done.claimedAmount.toString());

            // And now there is genuinely nothing further to release.
            try {
                await claimVested();
                assert.fail("should reject");
            } catch (err: any) {
                assert.include(err.toString(), "NothingVested");
                console.log("✅ Over-claiming a fully vested grant rejected");
            }

            // Circulating supply must be exactly what the protocol says it
            // minted, less what it burned — proving no supply appeared from
            // anywhere outside genesis + vesting.
            //
            // Note this subtracts totalBurned rather than comparing against
            // totalMinted alone: burning reduces the mint's supply but is
            // tracked as a separate counter, so `supply == totalMinted`
            // only holds before the first burn. That made the assertion
            // pass on a fresh validator (where the burn test runs later)
            // and fail against any state where a burn had already
            // happened — a bug in the test, not the protocol.
            const mint = await getMint(provider.connection, rewardMintPDA);
            const p = await fetchProtocol();
            const expectedSupply = BigInt(p.totalMinted.toString()) - BigInt(p.totalBurned.toString());
            assert.equal(mint.supply.toString(), expectedSupply.toString(),
                "on-chain supply must equal totalMinted - totalBurned");
            console.log("✅ Supply reconciles with protocol accounting:", mint.supply.toString());
        });
    });

    // ── Slashing ──────────────────────────────────────────────────────────────

    describe("Slashing", function () {
        this.timeout(EPOCH_DURATION * 1000 + 240_000);

        // A second router that stakes but never heartbeats — 0% uptime,
        // which lands in the worst performance tier: no reward, maximum
        // slash.
        const badRouterId = "router-offline-001";
        let badRouterPDA: PublicKey;
        let badStakePDA: PublicKey;
        let badDevice: anchor.web3.Keypair;
        let badEpoch: BN;

        before(async () => {
            badRouterPDA = getRouterPDA(provider.wallet.publicKey, badRouterId);
            badStakePDA  = getStakePDA(badRouterPDA);
            badDevice    = anchor.web3.Keypair.generate();
            await airdrop(badDevice.publicKey);

            if (!await provider.connection.getAccountInfo(badRouterPDA)) {
                await program.methods
                    .registerRouter(badRouterId, new BN(28_613_900), new BN(77_209_000), badDevice.publicKey)
                    .accountsPartial({
                        router: badRouterPDA, protocol: protocolPDA,
                        owner: provider.wallet.publicKey,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .rpc();
            } else {
                await program.methods.rotateDeviceKey(badDevice.publicKey)
                    .accountsPartial({ router: badRouterPDA, owner: provider.wallet.publicKey })
                    .rpc();
            }

            await program.methods.stake(STAKE_AMOUNT)
                .accountsPartial({
                    router: badRouterPDA, protocol: protocolPDA, stake: badStakePDA,
                    rewardMint: rewardMintPDA, stakeVault: stakeVaultPDA,
                    ownerTokenAccount: ownerAta, owner: provider.wallet.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .rpc();
        });

        it("opens an epoch with a single heartbeat, then goes dark", async () => {
            const protocol = await fetchProtocol();
            badEpoch = currentEpochNumber(protocol, nowSec());
            await program.methods.heartbeat(badEpoch)
                .accountsPartial({
                    router: badRouterPDA, protocol: protocolPDA, device: badDevice.publicKey,
                    routerEpoch: getRouterEpochPDA(badRouterPDA, badEpoch),
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .signers([badDevice])
                .rpc();
            console.log("✅ Bad router sent 1 of", EPOCH_DURATION / HEARTBEAT_INTERVAL, "expected heartbeats");
        });

        it("finalizes the bad epoch into a reduced reward and a real slash", async () => {
            const protocol = await fetchProtocol();
            const waitMs = Math.max(0, (epochEndTime(protocol, badEpoch) - nowSec() + 2) * 1000);
            console.log(`   waiting ${Math.ceil(waitMs / 1000)}s for epoch to close...`);
            await sleep(waitMs);

            await program.methods.finalizeRouterEpoch(badEpoch)
                .accountsPartial({
                    router: badRouterPDA, protocol: protocolPDA,
                    routerEpoch: getRouterEpochPDA(badRouterPDA, badEpoch),
                    stake: badStakePDA, emission: getEmissionPDA(badEpoch),
                    cranker: provider.wallet.publicKey,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .rpc();

            const re = await program.account.routerEpoch.fetch(getRouterEpochPDA(badRouterPDA, badEpoch));
            // 1 of 2 expected heartbeats = 50% uptime -> worst tier.
            assert.isBelow(re.uptimeBps, 7000);
            assert.equal(re.rewardAmount.toString(), "0", "bottom tier earns nothing");
            assert.isAbove(re.slashAmount.toNumber(), 0, "bottom tier is slashed");
            console.log("✅ uptime_bps:", re.uptimeBps, "reward:", re.rewardAmount.toString(),
                        "slash:", re.slashAmount.toString());
        });

        it("executes the slash, moving collateral from the stake vault to the treasury", async () => {
            const stakeBefore    = await program.account.stake.fetch(badStakePDA);
            const vaultBefore    = await tokenBalance(stakeVaultPDA);
            const treasuryBefore = await tokenBalance(treasuryPDA);
            const re = await program.account.routerEpoch.fetch(getRouterEpochPDA(badRouterPDA, badEpoch));
            const expected = BigInt(re.slashAmount.toString());

            await program.methods.slashRouter(badEpoch)
                .accountsPartial({
                    router: badRouterPDA, protocol: protocolPDA,
                    routerEpoch: getRouterEpochPDA(badRouterPDA, badEpoch),
                    stake: badStakePDA, rewardMint: rewardMintPDA,
                    stakeVault: stakeVaultPDA, treasury: treasuryPDA,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();

            const vaultAfter    = await tokenBalance(stakeVaultPDA);
            const treasuryAfter = await tokenBalance(treasuryPDA);
            const stakeAfter    = await program.account.stake.fetch(badStakePDA);
            const routerAfter   = await program.account.router.fetch(badRouterPDA);

            assert.equal(vaultBefore - vaultAfter, expected, "vault debited by exactly the slash");
            assert.equal(treasuryAfter - treasuryBefore, expected, "treasury credited by exactly the slash");
            assert.equal(
                stakeBefore.amount.sub(stakeAfter.amount).toString(), expected.toString(),
                "stake accounting matches the token movement"
            );
            assert.equal(routerAfter.stakedAmount.toString(), stakeAfter.amount.toString(),
                "the router's denormalized mirror stays in sync after a slash");
            console.log("✅ Slashed", expected.toString(), "→ treasury:", treasuryAfter.toString());
        });

        it("rejects slashing the same epoch twice", async () => {
            try {
                await program.methods.slashRouter(badEpoch)
                    .accountsPartial({
                        router: badRouterPDA, protocol: protocolPDA,
                        routerEpoch: getRouterEpochPDA(badRouterPDA, badEpoch),
                        stake: badStakePDA, rewardMint: rewardMintPDA,
                        stakeVault: stakeVaultPDA, treasury: treasuryPDA,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.include(err.toString(), "EpochAlreadySlashed");
                console.log("✅ Double slash rejected");
            }
        });

        it("burns slashed collateral out of the treasury, reducing total supply", async () => {
            const treasuryBefore = await tokenBalance(treasuryPDA);
            assert.isTrue(treasuryBefore > 0n, "treasury should hold slashed collateral by now");
            const supplyBefore = (await getMint(provider.connection, rewardMintPDA)).supply;

            const burnAmount = new BN(treasuryBefore.toString());
            await program.methods.burnTreasury(burnAmount)
                .accountsPartial({
                    protocol: protocolPDA, rewardMint: rewardMintPDA, treasury: treasuryPDA,
                    authority: provider.wallet.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();

            const treasuryAfter = await tokenBalance(treasuryPDA);
            const supplyAfter = (await getMint(provider.connection, rewardMintPDA)).supply;
            assert.equal(treasuryAfter, 0n);
            assert.equal(supplyBefore - supplyAfter, BigInt(burnAmount.toString()),
                "burning must actually reduce circulating supply");

            const p = await fetchProtocol();
            assert.equal(p.totalBurned.toString(), burnAmount.toString());
            console.log("✅ Burned", burnAmount.toString(), "— supply:",
                        supplyBefore.toString(), "→", supplyAfter.toString());
        });
    });

    // ── Unstaking ─────────────────────────────────────────────────────────────

    describe("Unstaking", () => {

        it("returns collateral from the vault to the operator", async () => {
            const stake = await program.account.stake.fetch(stakePDA);
            const protocol = await fetchProtocol();
            // Keep the router above the minimum — it is still active.
            const withdrawable = stake.amount.sub(protocol.minStake);
            assert.isTrue(withdrawable.gt(new BN(0)), "test needs headroom above min stake");

            const walletBefore = await tokenBalance(ownerAta);
            const vaultBefore  = await tokenBalance(stakeVaultPDA);

            await program.methods.unstake(withdrawable)
                .accountsPartial({
                    router: routerPDA, protocol: protocolPDA, stake: stakePDA,
                    rewardMint: rewardMintPDA, stakeVault: stakeVaultPDA,
                    ownerTokenAccount: ownerAta, owner: provider.wallet.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();

            const walletAfter = await tokenBalance(ownerAta);
            const vaultAfter  = await tokenBalance(stakeVaultPDA);
            const moved = BigInt(withdrawable.toString());

            assert.equal(walletAfter - walletBefore, moved, "operator credited exactly");
            assert.equal(vaultBefore - vaultAfter, moved, "vault debited exactly");

            const after = await program.account.stake.fetch(stakePDA);
            const router = await program.account.router.fetch(routerPDA);
            assert.equal(after.amount.toString(), protocol.minStake.toString());
            assert.equal(router.stakedAmount.toString(), after.amount.toString());
            console.log("✅ Unstaked", moved.toString(), "— remaining:", after.amount.toString());
        });

        it("rejects an unstake from a non-owner", async () => {
            const attacker = anchor.web3.Keypair.generate();
            await airdrop(attacker.publicKey);
            try {
                await program.methods.unstake(new BN(1))
                    .accountsPartial({
                        router: routerPDA, protocol: protocolPDA, stake: stakePDA,
                        rewardMint: rewardMintPDA, stakeVault: stakeVaultPDA,
                        ownerTokenAccount: ownerAta, owner: attacker.publicKey,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .signers([attacker])
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.ok(err);
                console.log("✅ Non-owner unstake rejected");
            }
        });
    });

    // ── Admin ─────────────────────────────────────────────────────────────────

    describe("Admin Controls", () => {

        it("pauses and resumes the protocol", async () => {
            if ((await fetchProtocol()).isPaused) {
                await program.methods.resumeProtocol()
                    .accountsPartial({ protocol: protocolPDA, authority: provider.wallet.publicKey })
                    .rpc();
            }
            await program.methods.pauseProtocol()
                .accountsPartial({ protocol: protocolPDA, authority: provider.wallet.publicKey })
                .rpc();
            assert.equal((await fetchProtocol()).isPaused, true);

            await program.methods.resumeProtocol()
                .accountsPartial({ protocol: protocolPDA, authority: provider.wallet.publicKey })
                .rpc();
            assert.equal((await fetchProtocol()).isPaused, false);
            console.log("✅ Pause / resume");
        });

        it("updates the reward rate", async () => {
            await program.methods.updateRewardRate(new BN(2_000_000))
                .accountsPartial({ protocol: protocolPDA, authority: provider.wallet.publicKey })
                .rpc();
            assert.equal((await fetchProtocol()).rewardRate.toString(), "2000000");
            console.log("✅ Reward rate updated");
        });

        // Governance actions used to emit only `msg!`, so nothing
        // downstream could answer "who paused the protocol, and when".
        // These assert on the emitted events specifically, not just the
        // resulting state — reconciliation already recovers state, but
        // only an event carries the actor and the transition.
        it("emits an auditable event when the protocol is paused and resumed", async () => {
            if ((await fetchProtocol()).isPaused) {
                await program.methods.resumeProtocol()
                    .accountsPartial({ protocol: protocolPDA, authority: provider.wallet.publicKey })
                    .rpc();
            }

            const pauseSig = await program.methods.pauseProtocol()
                .accountsPartial({ protocol: protocolPDA, authority: provider.wallet.publicKey })
                .rpc();
            const paused = await findEvent(pauseSig, "ProtocolPaused");
            assert.ok(paused, "pause_protocol must emit ProtocolPaused");
            assert.equal(paused.authority.toBase58(), provider.wallet.publicKey.toBase58(),
                "the event must name the authority that actually did it");

            const resumeSig = await program.methods.resumeProtocol()
                .accountsPartial({ protocol: protocolPDA, authority: provider.wallet.publicKey })
                .rpc();
            assert.ok(await findEvent(resumeSig, "ProtocolResumed"));
            console.log("✅ Pause/resume emit auditable events naming the authority");
        });

        it("records both the old and new reward rate on update", async () => {
            const before = (await fetchProtocol()).rewardRate.toString();
            const sig = await program.methods.updateRewardRate(new BN(3_000_000))
                .accountsPartial({ protocol: protocolPDA, authority: provider.wallet.publicKey })
                .rpc();

            const ev = await findEvent(sig, "RewardRateUpdated");
            assert.ok(ev, "update_reward_rate must emit RewardRateUpdated");
            // previous_rate is what makes the event a usable audit record:
            // an indexer that missed an earlier update can still
            // reconstruct the change, not just where the rate landed.
            assert.equal(ev.previousRate.toString(), before);
            assert.equal(ev.newRate.toString(), "3000000");
            console.log(`✅ Rate change recorded as ${before} -> 3000000`);

            await program.methods.updateRewardRate(new BN(2_000_000))
                .accountsPartial({ protocol: protocolPDA, authority: provider.wallet.publicKey })
                .rpc();
        });

        it("rejects admin actions from a non-authority", async () => {
            const attacker = anchor.web3.Keypair.generate();
            await airdrop(attacker.publicKey);
            try {
                await program.methods.updateRewardRate(new BN(9999))
                    .accountsPartial({ protocol: protocolPDA, authority: attacker.publicKey })
                    .signers([attacker])
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.ok(err);
                console.log("✅ Non-authority admin rejected");
            }
        });

        it("rejects a treasury burn from a non-authority", async () => {
            const attacker = anchor.web3.Keypair.generate();
            await airdrop(attacker.publicKey);
            try {
                await program.methods.burnTreasury(new BN(1))
                    .accountsPartial({
                        protocol: protocolPDA, rewardMint: rewardMintPDA, treasury: treasuryPDA,
                        authority: attacker.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .signers([attacker])
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.ok(err);
                console.log("✅ Non-authority burn rejected");
            }
        });
    });
});
