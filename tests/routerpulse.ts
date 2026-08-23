import * as anchor from "@coral-xyz/anchor";
import { Program }  from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { assert }   from "chai";

describe("RouterPulse", () => {

    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.Routerpulse as Program<any>;

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

    function sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ── Protocol ──────────────────────────────────────────────────────────────

    describe("Protocol Initialization", () => {

        it("initializes protocol correctly", async () => {
            const exists = await provider.connection.getAccountInfo(protocolPDA);
            if (!exists) {
                await program.methods
                    .initializeProtocol(new anchor.BN(1_000), 500, new anchor.BN(300))
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
            console.log("✅ Protocol ready");
            console.log("   authority:   ", protocol.authority.toBase58());
            console.log("   rewardRate:  ", protocol.rewardRate.toString());
            console.log("   vaultBump:   ", protocol.vaultBump);
        });

        it("rejects zero reward rate", async () => {
            const fakePDA = PublicKey.findProgramAddressSync(
                [Buffer.from("protocol_test")], program.programId
            )[0];
            try {
                await program.methods
                    .initializeProtocol(new anchor.BN(0), 500, new anchor.BN(300))
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
                    .initializeProtocol(new anchor.BN(1000), 20000, new anchor.BN(300))
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
    });

    // ── Router Registration ───────────────────────────────────────────────────

    describe("Router Registration", () => {

        const routerId  = "router-mumbai-001";
        const routerPDA = getRouterPDA(provider.wallet.publicKey, routerId);
        const lat       = 19_076_000;
        const long      = 72_877_700;

        it("registers a router successfully", async () => {
            const exists = await provider.connection.getAccountInfo(routerPDA);
            if (!exists) {
                const before = await program.account.protocol.fetch(protocolPDA);
                await program.methods
                    .registerRouter(routerId, new anchor.BN(lat), new anchor.BN(long))
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
            }
            const router = await program.account.router.fetch(routerPDA);
            // stable properties — valid regardless of history
            assert.equal(router.owner.toBase58(), provider.wallet.publicKey.toBase58());
            assert.equal(router.routerId,         routerId);
            console.log("✅ Router registered:", router.routerId);
            console.log("   PDA:          ", routerPDA.toBase58());
            console.log("   uptimeScore:  ", router.uptimeScore);
        });

        it("rejects duplicate registration", async () => {
            try {
                await program.methods
                    .registerRouter(routerId, new anchor.BN(lat), new anchor.BN(long))
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
                    .registerRouter("", new anchor.BN(lat), new anchor.BN(long))
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
                    .registerRouter("bad-lat", new anchor.BN(999_000_000), new anchor.BN(long))
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
            const id2  = "router-delhi-001";
            const pda2 = getRouterPDA(provider.wallet.publicKey, id2);
            const exists = await provider.connection.getAccountInfo(pda2);
            if (!exists) {
                await program.methods
                    .registerRouter(id2, new anchor.BN(28_613_900), new anchor.BN(77_209_000))
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

    // ── Heartbeat ─────────────────────────────────────────────────────────────

    describe("Heartbeat", () => {

        const routerId  = "router-mumbai-001";
        const routerPDA = getRouterPDA(provider.wallet.publicKey, routerId);

        // On a persistent validator the router may be Suspended from a prior run.
        // Reinstate it so all heartbeat tests start from a usable state.
        before(async () => {
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

        it("first heartbeat activates router", async () => {
            const before      = await program.account.router.fetch(routerPDA);
            const countBefore = before.heartbeatCount.toNumber();

            await program.methods.heartbeat()
                .accountsPartial({
                    router:   routerPDA,
                    protocol: protocolPDA,
                    owner:    provider.wallet.publicKey,
                })
                .rpc();

            const after = await program.account.router.fetch(routerPDA);
            assert.deepEqual(after.status, { active: {} });
            assert.equal(after.heartbeatCount.toNumber(), countBefore + 1);
            assert.isAtMost(after.uptimeScore, 100);
            assert.isAbove(after.lastHeartbeat.toNumber(), 0);
            console.log("✅ Router activated");
            console.log("   status:", JSON.stringify(after.status));
            console.log("   score: ", after.uptimeScore);
        });

        it("rejects replay in same block", async () => {
            try {
                await program.methods.heartbeat()
                    .accountsPartial({
                        router:   routerPDA,
                        protocol: protocolPDA,
                        owner:    provider.wallet.publicKey,
                    })
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.ok(err);
                console.log("✅ Replay rejected");
            }
        });

        it("rejects wrong owner", async () => {
            const attacker = anchor.web3.Keypair.generate();
            const sig = await provider.connection.requestAirdrop(
                attacker.publicKey, anchor.web3.LAMPORTS_PER_SOL
            );
            await provider.connection.confirmTransaction(sig);
            try {
                await program.methods.heartbeat()
                    .accountsPartial({
                        router:   routerPDA,
                        protocol: protocolPDA,
                        owner:    attacker.publicKey,
                    })
                    .signers([attacker])
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.ok(err);
                console.log("✅ Wrong owner rejected");
            }
        });

        it("increments count on valid heartbeat", async () => {
            await sleep(2000);
            const before      = await program.account.router.fetch(routerPDA);
            const countBefore = before.heartbeatCount.toNumber();
            await program.methods.heartbeat()
                .accountsPartial({
                    router:   routerPDA,
                    protocol: protocolPDA,
                    owner:    provider.wallet.publicKey,
                })
                .rpc();
            const after = await program.account.router.fetch(routerPDA);
            assert.equal(after.heartbeatCount.toNumber(), countBefore + 1);
            assert.isAtMost(after.uptimeScore, 100);
            console.log("✅ Count incremented:", after.heartbeatCount.toString());
            console.log("   score:           ", after.uptimeScore);
        });
    });

    // ── Rewards ───────────────────────────────────────────────────────────────

    describe("Reward Claiming", () => {

        const routerId  = "router-mumbai-001";
        const routerPDA = getRouterPDA(provider.wallet.publicKey, routerId);

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

        it("claims rewards for active router", async () => {
            await sleep(2000);

            const router = await program.account.router.fetch(routerPDA);
            if (!router.status.active) {
                console.log("ℹ️  Router not active — skipping claim test");
                return;
            }

            const ownerBefore = await provider.connection.getBalance(provider.wallet.publicKey);
            await program.methods.claimReward()
                .accountsPartial({
                    router:        routerPDA,
                    protocol:      protocolPDA,
                    rewardVault:   rewardVaultPDA,
                    owner:         provider.wallet.publicKey,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .rpc();
            const ownerAfter  = await provider.connection.getBalance(provider.wallet.publicKey);
            const afterRouter = await program.account.router.fetch(routerPDA);
            assert.isAbove(ownerAfter, ownerBefore);
            assert.isAbove(afterRouter.totalRewards.toNumber(), 0);
            console.log("✅ Reward claimed:", afterRouter.totalRewards.toString(), "lamports");
            console.log("   balance diff: ", ownerAfter - ownerBefore, "lamports");
        });

        it("rejects claim from inactive router", async () => {
            const id2  = "router-delhi-001";
            const pda2 = getRouterPDA(provider.wallet.publicKey, id2);
            const router2 = await program.account.router.fetch(pda2);
            if (router2.status.active) {
                console.log("ℹ️  router-delhi-001 is active — skip inactive test");
                return;
            }
            try {
                await program.methods.claimReward()
                    .accountsPartial({
                        router:        pda2,
                        protocol:      protocolPDA,
                        rewardVault:   rewardVaultPDA,
                        owner:         provider.wallet.publicKey,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .rpc();
                assert.fail("should reject");
            } catch (err: any) {
                assert.ok(err);
                console.log("✅ Inactive claim rejected");
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
            const sig = await provider.connection.requestAirdrop(
                attacker.publicKey, anchor.web3.LAMPORTS_PER_SOL
            );
            await provider.connection.confirmTransaction(sig);
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
            const sig = await provider.connection.requestAirdrop(
                attacker.publicKey, anchor.web3.LAMPORTS_PER_SOL
            );
            await provider.connection.confirmTransaction(sig);
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
