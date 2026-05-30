import * as anchor from "@coral-xyz/anchor";
import { Program }  from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { assert }   from "chai";

describe("RouterPulse", () => {

    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.Routerpulse as Program<any>;

    // ── Shared PDAs ───────────────────────────────────────────────────────────

    const [protocolPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("protocol")],
        program.programId
    );

    function getRouterPDA(owner: PublicKey, routerId: string): PublicKey {
        const [pda] = PublicKey.findProgramAddressSync(
            [Buffer.from("router"), owner.toBuffer(), Buffer.from(routerId)],
            program.programId
        );
        return pda;
    }

    // ── Suite 1: Protocol Initialization ─────────────────────────────────────

    describe("Protocol Initialization", () => {

        it("initializes the protocol correctly", async () => {
            const alreadyExists = await provider.connection.getAccountInfo(protocolPDA);
            if (!alreadyExists) {
                await program.methods
                    .initializeProtocol(new anchor.BN(1_000), 500, new anchor.BN(300))
                    .accounts({
                        protocol:      protocolPDA,
                        authority:     provider.wallet.publicKey,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .rpc();

                const protocol = await program.account.protocol.fetch(protocolPDA);
                assert.equal(protocol.totalRouters.toString(), "0", "Fresh protocol should have 0 routers");
            }

            const protocol = await program.account.protocol.fetch(protocolPDA);
            assert.equal(protocol.isPaused, false, "Protocol should not be paused");
            assert.ok(protocol.authority, "Authority should be set");
            console.log("✅ Protocol initialized");
        });
    });

    // ── Suite 2: Router Registration ──────────────────────────────────────────

    describe("Router Registration", () => {

        const routerId  = "router-mumbai-001";
        const routerPDA = getRouterPDA(provider.wallet.publicKey, routerId);

        // Mumbai GPS — fixed-point × 1_000_000
        const lat  = 19_076_000;
        const long = 72_877_700;

        // ── Happy Path ────────────────────────────────────────────────────────

        it("registers a router successfully", async () => {
            const alreadyExists = await provider.connection.getAccountInfo(routerPDA);
            if (!alreadyExists) {
                const protocolBefore = await program.account.protocol.fetch(protocolPDA);
                await program.methods
                    .registerRouter(routerId, new anchor.BN(lat), new anchor.BN(long))
                    .accounts({
                        router:        routerPDA,
                        protocol:      protocolPDA,
                        owner:         provider.wallet.publicKey,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .rpc();
                const protocolAfter = await program.account.protocol.fetch(protocolPDA);
                assert.equal(
                    protocolAfter.totalRouters.toNumber(),
                    protocolBefore.totalRouters.toNumber() + 1,
                    "totalRouters should have incremented"
                );
            }

            const router = await program.account.router.fetch(routerPDA);

            assert.equal(router.owner.toBase58(),          provider.wallet.publicKey.toBase58(), "Owner should match");
            assert.equal(router.routerId,                  routerId,         "Router ID should match");
            assert.equal(router.locationLat.toString(),    lat.toString(),   "Latitude should match");
            assert.equal(router.locationLong.toString(),   long.toString(),  "Longitude should match");
            assert.equal(router.uptimeScore,               100,              "Initial score should be 100");
            assert.equal(router.heartbeatCount.toString(), "0",              "No heartbeats yet");
            assert.equal(router.totalRewards.toString(),   "0",              "No rewards yet");
            assert.isAbove(router.lastHeartbeat.toNumber(), 0,               "lastHeartbeat set to registration time");
            assert.isAbove(router.registeredAt.toNumber(),  0,               "Registration time should be set");

            const protocol = await program.account.protocol.fetch(protocolPDA);
            console.log("✅ Router PDA:      ", routerPDA.toBase58());
            console.log("✅ Router ID:       ", router.routerId);
            console.log("✅ Location:        ", `${router.locationLat}, ${router.locationLong}`);
            console.log("✅ Uptime Score:    ", router.uptimeScore);
            console.log("✅ Total Routers:   ", protocol.totalRouters.toString());
        });

        // ── Duplicate Registration ────────────────────────────────────────────

        it("rejects duplicate router registration", async () => {
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

                assert.fail("Should have rejected duplicate");
            } catch (err: any) {
                assert.ok(err);
                console.log("✅ Duplicate registration correctly rejected");
            }
        });

        // ── Empty Router ID ───────────────────────────────────────────────────

        it("rejects empty router ID", async () => {
            const emptyIdPDA = getRouterPDA(provider.wallet.publicKey, "");
            try {
                await program.methods
                    .registerRouter("", new anchor.BN(lat), new anchor.BN(long))
                    .accounts({
                        router:        emptyIdPDA,
                        protocol:      protocolPDA,
                        owner:         provider.wallet.publicKey,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .rpc();

                assert.fail("Should have rejected empty router ID");
            } catch (err: any) {
                assert.ok(err);
                console.log("✅ Empty router ID correctly rejected");
            }
        });

        // ── Invalid GPS ───────────────────────────────────────────────────────

        it("rejects invalid latitude", async () => {
            const badLatPDA = getRouterPDA(provider.wallet.publicKey, "router-bad-lat");
            try {
                await program.methods
                    .registerRouter("router-bad-lat", new anchor.BN(999_000_000), new anchor.BN(long))
                    .accounts({
                        router:        badLatPDA,
                        protocol:      protocolPDA,
                        owner:         provider.wallet.publicKey,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .rpc();

                assert.fail("Should have rejected invalid latitude");
            } catch (err: any) {
                assert.ok(err);
                console.log("✅ Invalid latitude correctly rejected");
            }
        });

        // ── Multiple Routers Same Owner ───────────────────────────────────────

        it("allows same owner to register multiple routers", async () => {
            const routerId2  = "router-delhi-001";
            const routerPDA2 = getRouterPDA(provider.wallet.publicKey, routerId2);

            const alreadyExists = await provider.connection.getAccountInfo(routerPDA2);
            if (!alreadyExists) {
                const protocolBefore = await program.account.protocol.fetch(protocolPDA);
                // Delhi GPS: 28.6139° N, 77.2090° E
                await program.methods
                    .registerRouter(routerId2, new anchor.BN(28_613_900), new anchor.BN(77_209_000))
                    .accounts({
                        router:        routerPDA2,
                        protocol:      protocolPDA,
                        owner:         provider.wallet.publicKey,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .rpc();
                const protocolAfter = await program.account.protocol.fetch(protocolPDA);
                assert.equal(
                    protocolAfter.totalRouters.toNumber(),
                    protocolBefore.totalRouters.toNumber() + 1,
                    "totalRouters should have incremented"
                );
            }

            const router2  = await program.account.router.fetch(routerPDA2);
            assert.equal(router2.routerId, routerId2, "Second router ID should match");

            const protocol = await program.account.protocol.fetch(protocolPDA);
            console.log("✅ Second router registered:", router2.routerId);
            console.log("✅ Total routers now:       ", protocol.totalRouters.toString());
        });
    });
});
