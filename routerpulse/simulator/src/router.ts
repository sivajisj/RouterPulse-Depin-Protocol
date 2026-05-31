import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

export interface RouterConfig {
    routerId: string;
    lat:      number;
    long:     number;
    failRate: number;
}

export class RouterSimulator {
    private program:     any;
    private wallet:      anchor.web3.Keypair;
    private config:      RouterConfig;
    private routerPDA:   PublicKey;
    private protocolPDA: PublicKey;
    private running:     boolean = false;
    private heartbeatCount: number = 0;
    private missedCount:    number = 0;

    constructor(
        program:     any,
        wallet:      anchor.web3.Keypair,
        config:      RouterConfig,
        protocolPDA: PublicKey
    ) {
        this.program     = program;
        this.wallet      = wallet;
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

    async register(): Promise<void> {
        const connection = (this.program.provider as anchor.AnchorProvider).connection;
        const existing   = await connection.getAccountInfo(this.routerPDA);

        if (existing) {
            console.log(`[${this.config.routerId}] already registered`);
            return;
        }

        await this.program.methods
            .registerRouter(
                this.config.routerId,
                new anchor.BN(this.config.lat),
                new anchor.BN(this.config.long)
            )
            .accountsPartial({
                router:        this.routerPDA,
                protocol:      this.protocolPDA,
                owner:         this.wallet.publicKey,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .signers([this.wallet])
            .rpc();

        console.log(`[${this.config.routerId}] registered ✅`);
    }

    async sendHeartbeat(): Promise<boolean> {
        if (Math.random() < this.config.failRate) {
            this.missedCount++;
            console.log(`[${this.config.routerId}] ❌ missed (total: ${this.missedCount})`);
            return false;
        }

        try {
            await this.program.methods
                .heartbeat()
                .accountsPartial({
                    router:   this.routerPDA,
                    protocol: this.protocolPDA,
                    owner:    this.wallet.publicKey,
                })
                .signers([this.wallet])
                .rpc();

            this.heartbeatCount++;

            const router = await this.program.account.router.fetch(this.routerPDA);
            console.log(
                `[${this.config.routerId}] ✅ #${this.heartbeatCount}` +
                ` | score: ${router.uptimeScore}` +
                ` | status: ${JSON.stringify(router.status)}`
            );
            return true;

        } catch (err: any) {
            if (err.message?.includes("RouterSuspended")) {
                console.log(`[${this.config.routerId}] 🔴 SUSPENDED — stopping`);
                this.running = false;
            } else if (err.message?.includes("HeartbeatTooSoon")) {
                console.log(`[${this.config.routerId}] ⏱ too soon — skipping`);
            } else {
                console.log(`[${this.config.routerId}] error: ${err.message}`);
            }
            return false;
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
