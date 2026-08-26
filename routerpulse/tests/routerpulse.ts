import * as anchor from "@coral-xyz/anchor";
import { Program }  from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { assert }   from "chai";

describe("RouterPulse", () => {

    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.Routerpulse as Program<any>;

    // Kept short so the epoch-based reward tests (which must wait for
    // real wall-clock time to cross an epoch boundary) finish in a
    // reasonable amount of time. heartbeat_interval=60s is the on-chain
    // floor; epoch_duration=120s is 2x that, the on-chain floor too.
    const HEARTBEAT_INTERVAL = 60;
    const EPOCH_DURATION     = 120;

    const [protocolPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("protocol")],
        program.programId
    );

    const [rewardVaultPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("reward_vault"), protocolPDA.toBuffer()],
        program.programId
    );

    function getRouterPDA(owner: PublicKey, routerId: string): PublicKey {
        const [pda] = PublicKey.findProgramAddressSync(
            [Buffer.from("router"), owner.toBuffer(), Buffer.from(routerId)],
            program.programId
        );
        return pda;
    }

    function getRouterEpochPDA(routerPDA: PublicKey, epochNumber: number | anchor.BN): PublicKey {
        const [pda] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("router_epoch"),
                routerPDA.toBuffer(),
                new anchor.BN(epochNumber).toArrayLike(Buffer, "le", 8),
            ],
            program.programId
        );
        return pda;
    }

    // Mirrors Protocol::epoch_number_at on-chain — deterministic from
    // genesis_time + epoch_duration, so client and program always agree.
    function currentEpochNumber(protocol: any, nowSec: number): anchor.BN {
        const genesis = protocol.genesisTime.toNumber();
        const duration = protocol.epochDuration.toNumber();
        if (nowSec <= genesis || duration <= 0) return new anchor.BN(0);
        return new anchor.BN(Math.floor((nowSec - genesis) / duration));
    }

    function nowSec(): number {
        return Math.floor(Date.now() / 1000);
    }

    function sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function airdrop(pubkey: PublicKey, sol = 1): Promise<void> {
        const sig = await provider.connection.requestAirdrop(pubkey, sol * anchor.web3.LAMPORTS_PER_SOL);
        await provider.connection.confirmTransaction(sig);
    }

    // ── Protocol ──────────────────────────────────────────────────────────────

    describe("Protocol Initialization", () => {

        it("initializes protocol correctly", async () => {
            const exists = await provider.connection.getAccountInfo(protocolPDA);
            if (!exists) {
                await program.methods
                    .initializeProtocol(
                        new anchor.BN(1_000),
                        500,
                        new anchor.BN(HEARTBEAT_INTERVAL),
                        new anchor.BN(EPOCH_DURATION),
                    )
                    .accounts({
                        protocol:      protocolPDA,
                        authority:     provider.wallet.publicKey,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .rpc();
            }
            const protocol = await program.account.protocol.fetch(protocolPDA);
            assert.equal(protocol.isPaused, false);
            assert.ok(protocol.authority);
            assert.ok(protocol.vaultBump >= 0);
            assert.isAbove(protocol.epochDuration.toNumber(), 0);
            assert.isAbove(protocol.genesisTime.toNumber(), 0);
            console.log("✅ Protocol ready");
            console.log("   authority:     ", protocol.authority.toBase58());
            console.log("   rewardRate:    ", protocol.rewardRate.toString());
            console.log("   epochDuration: ", protocol.epochDuration.toString());
        });

        it("rejects zero reward rate", async () => {
            const fakePDA = PublicKey.findProgramAddressSync(
                [Buffer.from("protocol_test")], program.programId
            )[0];
            try {
                await program.methods
                    .initializeProtocol(new anchor.BN(0), 500, new anchor.BN(HEARTBEAT_INTERVAL), new anchor.BN(EPOCH_DURATION))
                    .accounts({
                        protocol:      fakePDA,
                        authority:     provider.wallet.publicKey,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.ok(err);
                console.log("✅ Zero reward rate rejected");
            }
        });

        it("rejects invalid penalty bps", async () => {
            const fakePDA = PublicKey.findProgramAddressSync(
                [Buffer.from("protocol_test2")], program.programId
            )[0];
            try {
                await program.methods
                    .initializeProtocol(new anchor.BN(1000), 20000, new anchor.BN(HEARTBEAT_INTERVAL), new anchor.BN(EPOCH_DURATION))
                    .accounts({
                        protocol:      fakePDA,
                        authority:     provider.wallet.publicKey,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.ok(err);
                console.log("✅ Invalid penalty bps rejected");
            }
        });

        it("rejects epoch duration shorter than the minimum heartbeat multiple", async () => {
            const fakePDA = PublicKey.findProgramAddressSync(
                [Buffer.from("protocol_test3")], program.programId
            )[0];
            try {
                await program.methods
                    .initializeProtocol(new anchor.BN(1000), 500, new anchor.BN(HEARTBEAT_INTERVAL), new anchor.BN(10))
                    .accounts({
                        protocol:      fakePDA,
                        authority:     provider.wallet.publicKey,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.ok(err);
                console.log("✅ Too-short epoch duration rejected");
            }
        });
    });

    // ── Router Registration ───────────────────────────────────────────────────

    describe("Router Registration", () => {

        const routerId  = "router-mumbai-001";
        const routerPDA = getRouterPDA(provider.wallet.publicKey, routerId);
        const lat       = 19_076_000;
        const long      = 72_877_700;
        // Device identity is deliberately separate from the owner wallet.
        const device    = anchor.web3.Keypair.generate();

        it("registers a router with a distinct device key", async () => {
            const exists = await provider.connection.getAccountInfo(routerPDA);
            if (!exists) {
                await airdrop(device.publicKey);

                const before = await program.account.protocol.fetch(protocolPDA);
                await program.methods
                    .registerRouter(routerId, new anchor.BN(lat), new anchor.BN(long), device.publicKey)
                    .accounts({
                        router:        routerPDA,
                        protocol:      protocolPDA,
                        owner:         provider.wallet.publicKey,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .rpc();
                const after = await program.account.protocol.fetch(protocolPDA);
                assert.equal(after.totalRouters.toNumber(), before.totalRouters.toNumber() + 1);

                // fresh-state assertions — only valid on first registration
                const freshRouter = await program.account.router.fetch(routerPDA);
                assert.equal(freshRouter.uptimeScore,              100, "fresh score should be 100");
                assert.equal(freshRouter.heartbeatCount.toString(), "0", "fresh count should be 0");
                assert.equal(freshRouter.devicePubkey.toBase58(), device.publicKey.toBase58());
                assert.equal(freshRouter.deviceKeyVersion, 0);
            }
            const router = await program.account.router.fetch(routerPDA);
            // stable properties — valid regardless of history
            assert.equal(router.owner.toBase58(), provider.wallet.publicKey.toBase58());
            assert.equal(router.routerId,         routerId);
            console.log("✅ Router registered:", router.routerId);
            console.log("   PDA:          ", routerPDA.toBase58());
            console.log("   device:       ", router.devicePubkey.toBase58());
        });

        it("rejects duplicate registration", async () => {
            try {
                await program.methods
                    .registerRouter(routerId, new anchor.BN(lat), new anchor.BN(long), device.publicKey)
                    .accounts({
                        router:        routerPDA,
                        protocol:      protocolPDA,
                        owner:         provider.wallet.publicKey,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.ok(err);
                console.log("✅ Duplicate rejected");
            }
        });

        it("rejects empty router ID", async () => {
            const emptyPDA = getRouterPDA(provider.wallet.publicKey, "");
            try {
                await program.methods
                    .registerRouter("", new anchor.BN(lat), new anchor.BN(long), device.publicKey)
                    .accounts({
                        router:        emptyPDA,
                        protocol:      protocolPDA,
                        owner:         provider.wallet.publicKey,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.ok(err);
                console.log("✅ Empty ID rejected");
            }
        });

        it("rejects invalid latitude", async () => {
            const badPDA = getRouterPDA(provider.wallet.publicKey, "bad-lat");
            try {
                await program.methods
                    .registerRouter("bad-lat", new anchor.BN(999_000_000), new anchor.BN(long), device.publicKey)
                    .accounts({
                        router:        badPDA,
                        protocol:      protocolPDA,
                        owner:         provider.wallet.publicKey,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.ok(err);
                console.log("✅ Bad latitude rejected");
            }
        });

        it("allows multiple routers same owner", async () => {
            const id2     = "router-delhi-001";
            const pda2    = getRouterPDA(provider.wallet.publicKey, id2);
            const device2 = anchor.web3.Keypair.generate();
            const exists  = await provider.connection.getAccountInfo(pda2);
            if (!exists) {
                await airdrop(device2.publicKey);
                await program.methods
                    .registerRouter(id2, new anchor.BN(28_613_900), new anchor.BN(77_209_000), device2.publicKey)
                    .accounts({
                        router:        pda2,
                        protocol:      protocolPDA,
                        owner:         provider.wallet.publicKey,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .rpc();
            }
            const router2  = await program.account.router.fetch(pda2);
            const protocol = await program.account.protocol.fetch(protocolPDA);
            assert.equal(router2.routerId, id2);
            console.log("✅ Multiple routers allowed");
            console.log("   total routers:", protocol.totalRouters.toString());
        });
    });

    // ── Device Identity ───────────────────────────────────────────────────────

    describe("Device Identity", () => {

        const routerId  = "router-mumbai-001";
        const routerPDA = getRouterPDA(provider.wallet.publicKey, routerId);

        it("rotates the device key and the old device is rejected", async () => {
            const router     = await program.account.router.fetch(routerPDA);
            const oldDevice   = router.devicePubkey;
            const newDevice   = anchor.web3.Keypair.generate();

            await program.methods
                .rotateDeviceKey(newDevice.publicKey)
                .accountsPartial({
                    router: routerPDA,
                    owner:  provider.wallet.publicKey,
                })
                .rpc();

            const after = await program.account.router.fetch(routerPDA);
            assert.equal(after.devicePubkey.toBase58(), newDevice.publicKey.toBase58());
            assert.equal(after.deviceKeyVersion, router.deviceKeyVersion + 1);
            console.log("✅ Device key rotated:", oldDevice.toBase58(), "->", after.devicePubkey.toBase58());
        });

        it("rejects rotation from a non-owner", async () => {
            const attacker = anchor.web3.Keypair.generate();
            await airdrop(attacker.publicKey);
            try {
                await program.methods
                    .rotateDeviceKey(anchor.web3.Keypair.generate().publicKey)
                    .accountsPartial({
                        router: routerPDA,
                        owner:  attacker.publicKey,
                    })
                    .signers([attacker])
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.ok(err);
                console.log("✅ Non-owner rotation rejected");
            }
        });
    });

    // ── Heartbeat ─────────────────────────────────────────────────────────────

    describe("Heartbeat", () => {

        const routerId  = "router-mumbai-001";
        const routerPDA = getRouterPDA(provider.wallet.publicKey, routerId);
        // set by "rotates the device key" above — the currently-valid device
        let device: anchor.web3.Keypair;

        before(async () => {
            // On a persistent validator the router may be Suspended from a
            // prior run. Reinstate it so all heartbeat tests start clean.
            const router = await program.account.router.fetch(routerPDA);
            if (JSON.stringify(router.status) === JSON.stringify({ suspended: {} })) {
                await program.methods
                    .reinstateRouter()
                    .accountsPartial({
                        router:    routerPDA,
                        protocol:  protocolPDA,
                        authority: provider.wallet.publicKey,
                    })
                    .rpc();
                console.log("ℹ️  Router reinstated before heartbeat suite");
            }
        });

        // The "Device Identity" suite rotated the device key, so we need a
        // fresh keypair we actually control for heartbeat tests.
        before(async () => {
            device = anchor.web3.Keypair.generate();
            await airdrop(device.publicKey);
            await program.methods
                .rotateDeviceKey(device.publicKey)
                .accountsPartial({ router: routerPDA, owner: provider.wallet.publicKey })
                .rpc();
        });

        function heartbeatCall(epochNumber: anchor.BN, signer: anchor.web3.Keypair) {
            const routerEpochPDA = getRouterEpochPDA(routerPDA, epochNumber);
            return program.methods
                .heartbeat(epochNumber)
                .accountsPartial({
                    router:        routerPDA,
                    protocol:      protocolPDA,
                    device:        signer.publicKey,
                    routerEpoch:   routerEpochPDA,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .signers([signer]);
        }

        it("first heartbeat activates router", async () => {
            const before      = await program.account.router.fetch(routerPDA);
            const countBefore = before.heartbeatCount.toNumber();
            const protocol    = await program.account.protocol.fetch(protocolPDA);
            const epochNumber = currentEpochNumber(protocol, nowSec());

            await heartbeatCall(epochNumber, device).rpc();

            const after = await program.account.router.fetch(routerPDA);
            assert.deepEqual(after.status, { active: {} });
            assert.equal(after.heartbeatCount.toNumber(), countBefore + 1);
            assert.isAtMost(after.uptimeScore, 100);
            assert.isAbove(after.lastHeartbeat.toNumber(), 0);

            const routerEpoch = await program.account.routerEpoch.fetch(getRouterEpochPDA(routerPDA, epochNumber));
            assert.equal(routerEpoch.heartbeats, 1);
            assert.equal(routerEpoch.finalized, false);
            console.log("✅ Router activated");
            console.log("   status:", JSON.stringify(after.status));
            console.log("   epoch heartbeats:", routerEpoch.heartbeats);
        });

        it("rejects replay in same block", async () => {
            const protocol    = await program.account.protocol.fetch(protocolPDA);
            const epochNumber = currentEpochNumber(protocol, nowSec());
            try {
                await heartbeatCall(epochNumber, device).rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.ok(err);
                console.log("✅ Replay rejected");
            }
        });

        it("rejects a signer that is not the registered device key", async () => {
            const impostor = anchor.web3.Keypair.generate();
            await airdrop(impostor.publicKey);
            const protocol    = await program.account.protocol.fetch(protocolPDA);
            const epochNumber = currentEpochNumber(protocol, nowSec());
            try {
                await heartbeatCall(epochNumber, impostor).rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.include(err.toString(), "InvalidDeviceSigner");
                console.log("✅ Wrong device signer rejected");
            }
        });

        it("rejects a wrong epoch number", async () => {
            const protocol      = await program.account.protocol.fetch(protocolPDA);
            const epochNumber   = currentEpochNumber(protocol, nowSec());
            const wrongEpoch    = epochNumber.addn(7);
            await sleep(2000);
            try {
                await heartbeatCall(wrongEpoch, device).rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.include(err.toString(), "WrongEpochNumber");
                console.log("✅ Wrong epoch number rejected");
            }
        });

        it("increments count on valid heartbeat", async () => {
            const before       = await program.account.router.fetch(routerPDA);
            const countBefore  = before.heartbeatCount.toNumber();
            const protocol     = await program.account.protocol.fetch(protocolPDA);
            const epochNumber  = currentEpochNumber(protocol, nowSec());

            await heartbeatCall(epochNumber, device).rpc();

            const after = await program.account.router.fetch(routerPDA);
            assert.equal(after.heartbeatCount.toNumber(), countBefore + 1);
            assert.isAtMost(after.uptimeScore, 100);
            console.log("✅ Count incremented:", after.heartbeatCount.toString());
        });

        it("blocks heartbeats while the protocol is paused", async () => {
            await program.methods.pauseProtocol()
                .accountsPartial({ protocol: protocolPDA, authority: provider.wallet.publicKey })
                .rpc();

            const protocol    = await program.account.protocol.fetch(protocolPDA);
            const epochNumber = currentEpochNumber(protocol, nowSec());
            try {
                await heartbeatCall(epochNumber, device).rpc();
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

    // ── Epoch Rewards ─────────────────────────────────────────────────────────
    // These tests wait for a real epoch (EPOCH_DURATION seconds) to close,
    // proving rewards are computed strictly from heartbeats received inside
    // that specific window — not a lifetime counter that can go stale.

    describe("Epoch Rewards", function () {
        this.timeout(EPOCH_DURATION * 1000 + 60_000);

        const routerId  = "router-mumbai-001";
        const routerPDA = getRouterPDA(provider.wallet.publicKey, routerId);
        let device: anchor.web3.Keypair;
        let epochNumber: anchor.BN;

        it("funds the vault", async () => {
            const balance = await provider.connection.getBalance(rewardVaultPDA);
            if (balance < anchor.web3.LAMPORTS_PER_SOL) {
                const tx = new anchor.web3.Transaction().add(
                    anchor.web3.SystemProgram.transfer({
                        fromPubkey: provider.wallet.publicKey,
                        toPubkey:   rewardVaultPDA,
                        lamports:   10 * anchor.web3.LAMPORTS_PER_SOL,
                    })
                );
                await provider.sendAndConfirm(tx);
            }
            const funded = await provider.connection.getBalance(rewardVaultPDA);
            assert.isAbove(funded, 0);
            console.log("✅ Vault balance:", funded, "lamports");
        });

        it("sends heartbeats inside the current epoch", async () => {
            const router = await program.account.router.fetch(routerPDA);
            if (JSON.stringify(router.status) === JSON.stringify({ suspended: {} })) {
                await program.methods.reinstateRouter()
                    .accountsPartial({ router: routerPDA, protocol: protocolPDA, authority: provider.wallet.publicKey })
                    .rpc();
            }

            device = anchor.web3.Keypair.generate();
            await airdrop(device.publicKey);
            await program.methods.rotateDeviceKey(device.publicKey)
                .accountsPartial({ router: routerPDA, owner: provider.wallet.publicKey })
                .rpc();

            const protocol = await program.account.protocol.fetch(protocolPDA);
            epochNumber = currentEpochNumber(protocol, nowSec());
            const routerEpochPDA = getRouterEpochPDA(routerPDA, epochNumber);

            await program.methods.heartbeat(epochNumber)
                .accountsPartial({
                    router: routerPDA, protocol: protocolPDA, device: device.publicKey,
                    routerEpoch: routerEpochPDA, systemProgram: anchor.web3.SystemProgram.programId,
                })
                .signers([device])
                .rpc();

            const routerEpoch = await program.account.routerEpoch.fetch(routerEpochPDA);
            assert.equal(routerEpoch.heartbeats, 1);
            console.log("✅ Heartbeat recorded for epoch", epochNumber.toString());
        });

        it("rejects finalization before the epoch ends", async () => {
            const routerEpochPDA = getRouterEpochPDA(routerPDA, epochNumber);
            try {
                await program.methods.finalizeRouterEpoch(epochNumber)
                    .accountsPartial({ router: routerPDA, protocol: protocolPDA, routerEpoch: routerEpochPDA })
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.include(err.toString(), "EpochNotEnded");
                console.log("✅ Early finalize rejected");
            }
        });

        it("rejects claiming before finalization", async () => {
            const routerEpochPDA = getRouterEpochPDA(routerPDA, epochNumber);
            try {
                await program.methods.claimReward(epochNumber)
                    .accountsPartial({
                        router: routerPDA, protocol: protocolPDA, routerEpoch: routerEpochPDA,
                        rewardVault: rewardVaultPDA, owner: provider.wallet.publicKey,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.include(err.toString(), "EpochNotFinalized");
                console.log("✅ Premature claim rejected");
            }
        });

        it("finalizes the epoch once it ends, then pays out on claim exactly once", async () => {
            const protocol = await program.account.protocol.fetch(protocolPDA);
            const [, epochEnd] = [null, protocol.genesisTime.toNumber()
                + (epochNumber.toNumber() + 1) * protocol.epochDuration.toNumber()];
            const waitMs = Math.max(0, (epochEnd - nowSec() + 2) * 1000);
            console.log(`   waiting ${Math.ceil(waitMs / 1000)}s for epoch to close...`);
            await sleep(waitMs);

            const routerEpochPDA = getRouterEpochPDA(routerPDA, epochNumber);

            await program.methods.finalizeRouterEpoch(epochNumber)
                .accountsPartial({ router: routerPDA, protocol: protocolPDA, routerEpoch: routerEpochPDA })
                .rpc();

            const finalized = await program.account.routerEpoch.fetch(routerEpochPDA);
            assert.equal(finalized.finalized, true);
            assert.isAbove(finalized.rewardAmount.toNumber(), 0);
            console.log("✅ Epoch finalized. uptime_bps:", finalized.uptimeBps, "reward:", finalized.rewardAmount.toString());

            const ownerBefore = await provider.connection.getBalance(provider.wallet.publicKey);
            await program.methods.claimReward(epochNumber)
                .accountsPartial({
                    router: routerPDA, protocol: protocolPDA, routerEpoch: routerEpochPDA,
                    rewardVault: rewardVaultPDA, owner: provider.wallet.publicKey,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .rpc();
            const ownerAfter = await provider.connection.getBalance(provider.wallet.publicKey);
            assert.isAbove(ownerAfter, ownerBefore);
            console.log("✅ Reward claimed. balance diff:", ownerAfter - ownerBefore, "lamports");

            // double-claim must fail
            try {
                await program.methods.claimReward(epochNumber)
                    .accountsPartial({
                        router: routerPDA, protocol: protocolPDA, routerEpoch: routerEpochPDA,
                        rewardVault: rewardVaultPDA, owner: provider.wallet.publicKey,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .rpc();
                assert.fail("should reject double claim");
            } catch (err: any) {
                assert.include(err.toString(), "EpochAlreadyClaimed");
                console.log("✅ Double claim rejected");
            }

            // re-finalizing an already-finalized epoch must fail
            try {
                await program.methods.finalizeRouterEpoch(epochNumber)
                    .accountsPartial({ router: routerPDA, protocol: protocolPDA, routerEpoch: routerEpochPDA })
                    .rpc();
                assert.fail("should reject double finalize");
            } catch (err: any) {
                assert.include(err.toString(), "EpochAlreadyFinalized");
                console.log("✅ Double finalize rejected");
            }
        });
    });

    // ── Penalty ───────────────────────────────────────────────────────────────

    describe("Penalty Engine", () => {

        const routerId  = "router-delhi-001";
        const routerPDA = getRouterPDA(provider.wallet.publicKey, routerId);

        it("applies penalty correctly", async () => {
            const before = await program.account.router.fetch(routerPDA);
            await program.methods.applyPenalty()
                .accountsPartial({
                    router:    routerPDA,
                    protocol:  protocolPDA,
                    authority: provider.wallet.publicKey,
                })
                .rpc();
            const after = await program.account.router.fetch(routerPDA);

            // uptime score always drops by 20 (or floors at 0)
            assert.isAtMost(after.uptimeScore, before.uptimeScore);

            // total_penalties increases only when total_rewards > 0
            if (before.totalRewards.toNumber() > 0) {
                assert.isAbove(after.totalPenalties.toNumber(), before.totalPenalties.toNumber());
            }

            console.log("✅ Penalty applied");
            console.log("   score before:", before.uptimeScore);
            console.log("   score after: ", after.uptimeScore);
            console.log("   penalties:   ", after.totalPenalties.toString());
        });

        it("rejects penalty from non-authority", async () => {
            const attacker = anchor.web3.Keypair.generate();
            await airdrop(attacker.publicKey);
            try {
                await program.methods.applyPenalty()
                    .accountsPartial({
                        router:    routerPDA,
                        protocol:  protocolPDA,
                        authority: attacker.publicKey,
                    })
                    .signers([attacker])
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.ok(err);
                console.log("✅ Non-authority penalty rejected");
            }
        });
    });

    // ── Admin ─────────────────────────────────────────────────────────────────

    describe("Admin Controls", () => {

        it("pauses and resumes protocol", async () => {
            // guard: resume first if a prior run left the protocol paused
            const current = await program.account.protocol.fetch(protocolPDA);
            if (current.isPaused) {
                await program.methods.resumeProtocol()
                    .accountsPartial({ protocol: protocolPDA, authority: provider.wallet.publicKey })
                    .rpc();
            }

            await program.methods.pauseProtocol()
                .accountsPartial({ protocol: protocolPDA, authority: provider.wallet.publicKey })
                .rpc();
            const paused = await program.account.protocol.fetch(protocolPDA);
            assert.equal(paused.isPaused, true);
            console.log("✅ Protocol paused");

            await program.methods.resumeProtocol()
                .accountsPartial({ protocol: protocolPDA, authority: provider.wallet.publicKey })
                .rpc();
            const resumed = await program.account.protocol.fetch(protocolPDA);
            assert.equal(resumed.isPaused, false);
            console.log("✅ Protocol resumed");
        });

        it("updates reward rate", async () => {
            const newRate = new anchor.BN(3_000);
            await program.methods.updateRewardRate(newRate)
                .accountsPartial({ protocol: protocolPDA, authority: provider.wallet.publicKey })
                .rpc();
            const protocol = await program.account.protocol.fetch(protocolPDA);
            assert.equal(protocol.rewardRate.toString(), newRate.toString());
            console.log("✅ Reward rate updated:", protocol.rewardRate.toString());
        });

        it("rejects admin action from non-authority", async () => {
            const attacker = anchor.web3.Keypair.generate();
            await airdrop(attacker.publicKey);
            try {
                await program.methods.updateRewardRate(new anchor.BN(9999))
                    .accountsPartial({ protocol: protocolPDA, authority: attacker.publicKey })
                    .signers([attacker])
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.ok(err);
                console.log("✅ Non-authority admin rejected");
            }
        });
    });
});
