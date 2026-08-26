import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { currentEpochNumber, getRouterEpochPDA } from "./config";
// Imported directly (not via anchor.BN) — see tests/routerpulse.ts for why.
import BN from "bn.js";

export interface RouterConfig {
    routerId: string;
    lat:      number;
    long:     number;
    failRate: number;
}

/// Simulates one physical router. Owns two identities, on purpose:
/// - `wallet`  — the operator's wallet. Registers the router and later
///               claims rewards. Never touches the heartbeat path.
/// - `device`  — a throwaway keypair standing in for the physical
///               device's onboard key. Only this key can sign
///               heartbeats, so a compromised device can never drain
///               the operator's wallet, and losing device access is
///               recoverable via rotateDeviceKey without re-registering.
export class RouterSimulator {
    private program:     any;
    private wallet:      anchor.web3.Keypair;
    private device:      anchor.web3.Keypair;
    private config:      RouterConfig;
    private routerPDA:   PublicKey;
    private protocolPDA: PublicKey;
    private protocol:    any;
    private running:     boolean = false;
    private heartbeatCount: number = 0;
    private missedCount:    number = 0;
    private lastFinalizedEpoch: BN | null = null;

    constructor(
        program:     any,
        wallet:      anchor.web3.Keypair,
        config:      RouterConfig,
        protocolPDA: PublicKey
    ) {
        this.program     = program;
        this.wallet      = wallet;
        this.device      = anchor.web3.Keypair.generate();
        this.config      = config;
        this.protocolPDA = protocolPDA;

        const [pda] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("router"),
                wallet.publicKey.toBuffer(),
                Buffer.from(config.routerId),
            ],
            program.programId
        );
        this.routerPDA = pda;
    }

    private async fundDevice(): Promise<void> {
        const connection = (this.program.provider as anchor.AnchorProvider).connection;
        const sig = await connection.requestAirdrop(this.device.publicKey, anchor.web3.LAMPORTS_PER_SOL);
        await connection.confirmTransaction(sig);
    }

    async register(): Promise<void> {
        const connection = (this.program.provider as anchor.AnchorProvider).connection;
        const existing   = await connection.getAccountInfo(this.routerPDA);

        await this.fundDevice();

        if (existing) {
            // Router already registered from a prior run — rotate onto
            // this session's fresh device key so heartbeats succeed.
            await this.program.methods
                .rotateDeviceKey(this.device.publicKey)
                .accountsPartial({ router: this.routerPDA, owner: this.wallet.publicKey })
                .rpc();
            console.log(`[${this.config.routerId}] already registered — rotated device key`);
            return;
        }

        await this.program.methods
            .registerRouter(
                this.config.routerId,
                new BN(this.config.lat),
                new BN(this.config.long),
                this.device.publicKey
            )
            .accountsPartial({
                router:        this.routerPDA,
                protocol:      this.protocolPDA,
                owner:         this.wallet.publicKey,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .signers([this.wallet])
            .rpc();

        console.log(`[${this.config.routerId}] registered ✅ (device: ${this.device.publicKey.toBase58().slice(0, 8)}...)`);
    }

    async sendHeartbeat(): Promise<boolean> {
        if (Math.random() < this.config.failRate) {
            this.missedCount++;
            console.log(`[${this.config.routerId}] ❌ missed (total: ${this.missedCount})`);
            return false;
        }

        try {
            this.protocol = await this.program.account.protocol.fetch(this.protocolPDA);
            const epochNumber   = currentEpochNumber(this.protocol, Math.floor(Date.now() / 1000));
            const routerEpochPDA = getRouterEpochPDA(this.program.programId, this.routerPDA, epochNumber);

            await this.program.methods
                .heartbeat(epochNumber)
                .accountsPartial({
                    router:        this.routerPDA,
                    protocol:      this.protocolPDA,
                    device:        this.device.publicKey,
                    routerEpoch:   routerEpochPDA,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .signers([this.device])
                .rpc();

            this.heartbeatCount++;

            const router = await this.program.account.router.fetch(this.routerPDA);
            console.log(
                `[${this.config.routerId}] ✅ #${this.heartbeatCount}` +
                ` | score: ${router.uptimeScore}` +
                ` | status: ${JSON.stringify(router.status)}` +
                ` | epoch: ${epochNumber.toString()}`
            );

            await this.maybeSettlePreviousEpoch(epochNumber);
            return true;

        } catch (err: any) {
            if (err.message?.includes("RouterSuspended")) {
                console.log(`[${this.config.routerId}] 🔴 SUSPENDED — stopping`);
                this.running = false;
            } else if (err.message?.includes("HeartbeatTooSoon")) {
                console.log(`[${this.config.routerId}] ⏱ too soon — skipping`);
            } else if (err.message?.includes("ProtocolPaused")) {
                console.log(`[${this.config.routerId}] ⏸ protocol paused — skipping`);
            } else {
                console.log(`[${this.config.routerId}] error: ${err.message}`);
            }
            return false;
        }
    }

    /// Best-effort crank: once the clock has moved into a new epoch,
    /// finalize + claim the previous one so the demo shows the full
    /// heartbeat -> epoch close -> reward lifecycle without a separate
    /// operator step. Safe to call repeatedly — every failure mode here
    /// (not ended, already finalized/claimed, no record) is expected
    /// and just skipped.
    private async maybeSettlePreviousEpoch(currentEpoch: BN): Promise<void> {
        const previousEpoch = currentEpoch.subn(1);
        if (previousEpoch.isNeg()) return;
        if (this.lastFinalizedEpoch && this.lastFinalizedEpoch.eq(previousEpoch)) return;

        const routerEpochPDA = getRouterEpochPDA(this.program.programId, this.routerPDA, previousEpoch);
        const connection = (this.program.provider as anchor.AnchorProvider).connection;
        const exists = await connection.getAccountInfo(routerEpochPDA);
        if (!exists) return; // no heartbeats were sent during that epoch

        try {
            const routerEpoch = await this.program.account.routerEpoch.fetch(routerEpochPDA);
            if (!routerEpoch.finalized) {
                await this.program.methods
                    .finalizeRouterEpoch(previousEpoch)
                    .accountsPartial({ router: this.routerPDA, protocol: this.protocolPDA, routerEpoch: routerEpochPDA })
                    .rpc();
                console.log(`[${this.config.routerId}] 🔒 epoch ${previousEpoch.toString()} finalized`);
            }
            const settled = await this.program.account.routerEpoch.fetch(routerEpochPDA);
            if (settled.finalized && !settled.claimed && settled.rewardAmount.gtn(0)) {
                const [rewardVaultPDA] = PublicKey.findProgramAddressSync(
                    [Buffer.from("reward_vault"), this.protocolPDA.toBuffer()],
                    this.program.programId
                );
                await this.program.methods
                    .claimReward(previousEpoch)
                    .accountsPartial({
                        router: this.routerPDA, protocol: this.protocolPDA, routerEpoch: routerEpochPDA,
                        rewardVault: rewardVaultPDA, owner: this.wallet.publicKey,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .signers([this.wallet])
                    .rpc();
                console.log(`[${this.config.routerId}] 💰 claimed epoch ${previousEpoch.toString()}: ${settled.rewardAmount.toString()} lamports`);
            }
            this.lastFinalizedEpoch = previousEpoch;
        } catch (err: any) {
            console.log(`[${this.config.routerId}] (epoch settlement skipped: ${err.message?.split("\n")[0]})`);
        }
    }

    async start(intervalMs: number): Promise<void> {
        this.running = true;
        console.log(`[${this.config.routerId}] starting — fail rate: ${this.config.failRate * 100}%`);

        while (this.running) {
            await this.sendHeartbeat();
            await this.sleep(intervalMs);
        }

        this.printStats();
    }

    stop(): void {
        this.running = false;
    }

    printStats(): void {
        console.log(
            `\n[${this.config.routerId}] done:` +
            ` sent=${this.heartbeatCount}` +
            ` missed=${this.missedCount}`
        );
    }

    getStats() {
        return {
            routerId: this.config.routerId,
            sent:     this.heartbeatCount,
            missed:   this.missedCount,
            pda:      this.routerPDA.toBase58(),
        };
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
