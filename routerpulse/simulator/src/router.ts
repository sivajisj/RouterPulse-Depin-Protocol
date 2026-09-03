import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createHash } from "crypto";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
    currentEpochNumber, getRouterEpochPDA, getStakePDA, getVestingPDA, getEmissionPDA,
} from "./config";
// Imported directly (not via anchor.BN) — see tests/routerpulse.ts for why.
import BN from "bn.js";

/// A heartbeat costs ~5000 lamports, so this funds thousands of them.
/// The old code airdropped a full 1 SOL per device, which the devnet
/// faucet will not sustain and which nothing here needs.
const DEVICE_FUND_LAMPORTS = 0.02 * LAMPORTS_PER_SOL;
const DEVICE_MIN_LAMPORTS  = 0.005 * LAMPORTS_PER_SOL;

/// Device keys are throwaway by design — a real router holds its own, and
/// losing one is recovered with `rotate_device_key` rather than by
/// re-registering. For an interactive demo a fresh key each run is the
/// honest simulation, and shows rotation working.
///
/// A *scheduled* run can't afford that: every new key is an unfunded
/// account needing SOL it will never give back. With DEVICE_KEY_SEED set,
/// keys are derived from (seed, routerId) instead, so repeat runs reuse
/// the same devices and fund them once.
function deriveDevice(routerId: string): anchor.web3.Keypair {
    const seed = process.env.DEVICE_KEY_SEED;
    if (!seed) return anchor.web3.Keypair.generate();
    const digest = createHash("sha256").update(`${seed}:${routerId}`).digest();
    return anchor.web3.Keypair.fromSeed(Uint8Array.from(digest.subarray(0, 32)));
}

export interface RouterConfig {
    routerId: string;
    lat:      number;
    long:     number;
    failRate: number;
}

/// Simulates one physical router. Owns two identities, on purpose:
/// - `wallet`  — the operator's wallet. Registers the router, stakes
///               collateral, and later claims/vests rewards. Never
///               touches the heartbeat path.
/// - `device`  — a throwaway keypair standing in for the physical
///               device's onboard key. Only this key can sign
///               heartbeats, so a compromised device can never drain
///               the operator's wallet, and losing device access is
///               recoverable via rotateDeviceKey without re-registering.
export class RouterSimulator {
    private program:      any;
    private wallet:       anchor.web3.Keypair;
    private device:       anchor.web3.Keypair;
    private config:       RouterConfig;
    private routerPDA:    PublicKey;
    private stakePDA:     PublicKey;
    private protocolPDA:  PublicKey;
    private rewardMintPDA: PublicKey;
    private stakeVaultPDA: PublicKey;
    private ownerAta:      PublicKey;
    private protocol:     any;
    private running:      boolean = false;
    private heartbeatCount: number = 0;
    private missedCount:    number = 0;
    private lastFinalizedEpoch: BN | null = null;

    constructor(
        program:      any,
        wallet:       anchor.web3.Keypair,
        config:       RouterConfig,
        protocolPDA:  PublicKey,
        rewardMintPDA: PublicKey,
        stakeVaultPDA: PublicKey,
        ownerAta:      PublicKey,
    ) {
        this.program       = program;
        this.wallet        = wallet;
        this.device        = deriveDevice(config.routerId);
        this.config        = config;
        this.protocolPDA   = protocolPDA;
        this.rewardMintPDA = rewardMintPDA;
        this.stakeVaultPDA = stakeVaultPDA;
        this.ownerAta      = ownerAta;

        this.routerPDA = PublicKey.findProgramAddressSync(
            [Buffer.from("router"), wallet.publicKey.toBuffer(), Buffer.from(config.routerId)],
            program.programId
        )[0];
        this.stakePDA = getStakePDA(program.programId, this.routerPDA);
    }

    /// Gives the device key enough SOL to pay for its own heartbeat fees.
    ///
    /// Funded by transfer from the operator, not `requestAirdrop`. The
    /// devnet faucet is aggressively rate-limited and returns a bare
    /// "Internal error" once you cross the line, which makes any repeated
    /// or scheduled run fail on the second attempt. The operator already
    /// holds SOL, so a transfer is both reliable and far cheaper than the
    /// 1 SOL the airdrop used to request.
    ///
    /// Skipped entirely when the device is already funded, so re-running
    /// against persistent device keys costs nothing after the first pass.
    private async fundDevice(): Promise<void> {
        const provider   = this.program.provider as anchor.AnchorProvider;
        const connection = provider.connection;

        const balance = await connection.getBalance(this.device.publicKey);
        if (balance >= DEVICE_MIN_LAMPORTS) return;

        const topUp = DEVICE_FUND_LAMPORTS - balance;
        const tx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: this.wallet.publicKey,
                toPubkey:   this.device.publicKey,
                lamports:   topUp,
            })
        );
        await provider.sendAndConfirm(tx, []);
        console.log(`[${this.config.routerId}] funded device with ${(topUp / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    }

    /// Registers (or re-attaches to) the router, then posts collateral
    /// up to the protocol minimum. Staking is a real, structural gate —
    /// heartbeat() rejects an uncollateralized router with
    /// InsufficientStake — so this has to happen before the router can
    /// ever go active.
    async register(): Promise<void> {
        const connection = (this.program.provider as anchor.AnchorProvider).connection;
        const existing    = await connection.getAccountInfo(this.routerPDA);

        await this.fundDevice();

        if (existing) {
            // Only rotate when the key actually differs. rotate_device_key
            // rejects a no-op rotation with DeviceKeyUnchanged, which is
            // correct — rotation is a recovery action, and silently
            // accepting a rotation to the current key would let an
            // operator believe a compromised device had been replaced.
            const router = await this.program.account.router.fetch(this.routerPDA);
            // `device_pubkey` on-chain; anchor camelCases account fields on
            // deserialize. Checked explicitly because a renamed field would
            // otherwise surface as "Cannot read properties of undefined"
            // three frames deep, naming neither the field nor the account.
            if (!router.devicePubkey) {
                throw new Error(
                    `Router account has no devicePubkey — the vendored IDL is probably ` +
                    `stale. Re-run \`anchor build\` and \`npm run sync-idl\`.`
                );
            }
            if (router.devicePubkey.equals(this.device.publicKey)) {
                console.log(`[${this.config.routerId}] already registered — same device key, nothing to rotate`);
            } else {
                await this.program.methods
                    .rotateDeviceKey(this.device.publicKey)
                    .accountsPartial({ router: this.routerPDA, owner: this.wallet.publicKey })
                    .rpc();
                console.log(`[${this.config.routerId}] already registered — rotated device key`);
            }
        } else {
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

        await this.ensureStaked();
    }

    private async ensureStaked(): Promise<void> {
        this.protocol = await this.program.account.protocol.fetch(this.protocolPDA);
        const router  = await this.program.account.router.fetch(this.routerPDA);

        const shortfall: anchor.BN = this.protocol.minStake.sub(router.stakedAmount);
        if (shortfall.lten(0)) {
            console.log(`[${this.config.routerId}] already collateralized (${router.stakedAmount.toString()} staked)`);
            return;
        }

        await this.program.methods
            .stake(shortfall)
            .accountsPartial({
                router: this.routerPDA, protocol: this.protocolPDA, stake: this.stakePDA,
                rewardMint: this.rewardMintPDA, stakeVault: this.stakeVaultPDA,
                ownerTokenAccount: this.ownerAta, owner: this.wallet.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .signers([this.wallet])
            .rpc();
        console.log(`[${this.config.routerId}] staked ${shortfall.toString()} — now at protocol minimum`);
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
                ` | epoch: ${epochNumber.toString()}` +
                ` | staked: ${router.stakedAmount.toString()}`
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
            } else if (err.message?.includes("InsufficientStake")) {
                console.log(`[${this.config.routerId}] 🪙 insufficient stake — topping up`);
                await this.ensureStaked();
            } else {
                console.log(`[${this.config.routerId}] error: ${err.message}`);
            }
            return false;
        }
    }

    /// Best-effort crank: once the clock has moved into a new epoch,
    /// finalize the previous one (locking in reward + slash together),
    /// execute the slash if there is one, convert the reward into a
    /// vesting entitlement, and mint whatever of it has already vested.
    /// So running the simulator demonstrates the full on-chain lifecycle
    /// live: heartbeat -> epoch close -> finalize -> [slash] -> claim ->
    /// vest, with no separate operator step. Every failure mode here
    /// (not ended yet, already finalized/claimed, nothing vested, no
    /// record at all) is expected and just skipped.
    private async maybeSettlePreviousEpoch(currentEpoch: BN): Promise<void> {
        const previousEpoch = currentEpoch.subn(1);
        if (previousEpoch.isNeg()) return;
        if (this.lastFinalizedEpoch && this.lastFinalizedEpoch.eq(previousEpoch)) return;

        const routerEpochPDA = getRouterEpochPDA(this.program.programId, this.routerPDA, previousEpoch);
        const connection = (this.program.provider as anchor.AnchorProvider).connection;
        const exists = await connection.getAccountInfo(routerEpochPDA);
        if (!exists) return; // no heartbeats were sent during that epoch

        try {
            let routerEpoch = await this.program.account.routerEpoch.fetch(routerEpochPDA);

            if (!routerEpoch.finalized) {
                await this.program.methods
                    .finalizeRouterEpoch(previousEpoch)
                    .accountsPartial({
                        router: this.routerPDA, protocol: this.protocolPDA, routerEpoch: routerEpochPDA,
                        stake: this.stakePDA, emission: getEmissionPDA(this.program.programId, previousEpoch),
                        cranker: this.wallet.publicKey,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .signers([this.wallet])
                    .rpc();
                routerEpoch = await this.program.account.routerEpoch.fetch(routerEpochPDA);
                console.log(
                    `[${this.config.routerId}] 🔒 epoch ${previousEpoch.toString()} finalized` +
                    ` | uptime_bps: ${routerEpoch.uptimeBps}` +
                    ` | reward: ${routerEpoch.rewardAmount.toString()}` +
                    ` | slash: ${routerEpoch.slashAmount.toString()}`
                );
            }

            if (routerEpoch.slashAmount.gtn(0) && !routerEpoch.slashed) {
                const [treasuryPDA] = PublicKey.findProgramAddressSync(
                    [Buffer.from("treasury")], this.program.programId
                );
                await this.program.methods
                    .slashRouter(previousEpoch)
                    .accountsPartial({
                        router: this.routerPDA, protocol: this.protocolPDA, routerEpoch: routerEpochPDA,
                        stake: this.stakePDA, rewardMint: this.rewardMintPDA,
                        stakeVault: this.stakeVaultPDA, treasury: treasuryPDA,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .rpc();
                console.log(`[${this.config.routerId}] ⚔️  slashed ${routerEpoch.slashAmount.toString()} for epoch ${previousEpoch.toString()}`);
            }

            const vestingPDA = getVestingPDA(this.program.programId, this.routerPDA, previousEpoch);
            if (routerEpoch.rewardAmount.gtn(0) && !routerEpoch.claimed) {
                await this.program.methods
                    .claimReward(previousEpoch)
                    .accountsPartial({
                        router: this.routerPDA, protocol: this.protocolPDA, routerEpoch: routerEpochPDA,
                        vesting: vestingPDA, owner: this.wallet.publicKey,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .signers([this.wallet])
                    .rpc();
                console.log(`[${this.config.routerId}] 🎟️  epoch ${previousEpoch.toString()} reward granted to vesting`);
            }

            if (await connection.getAccountInfo(vestingPDA)) {
                try {
                    await this.program.methods
                        .claimVested(previousEpoch)
                        .accountsPartial({
                            router: this.routerPDA, protocol: this.protocolPDA, vesting: vestingPDA,
                            rewardMint: this.rewardMintPDA, beneficiaryTokenAccount: this.ownerAta,
                            beneficiary: this.wallet.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
                        })
                        .signers([this.wallet])
                        .rpc();
                    console.log(`[${this.config.routerId}] 💰 vested tokens minted for epoch ${previousEpoch.toString()}`);
                } catch (vestErr: any) {
                    if (!vestErr.message?.includes("NothingVested")) throw vestErr;
                }
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
            // A router that can't reach the network is a *missed* heartbeat,
            // not a crashed simulator. Letting this throw would reject the
            // Promise.all in main() and take every other router down with
            // it — so a throttled RPC on one device would end the whole run.
            try {
                await this.sendHeartbeat();
            } catch (err: any) {
                this.missedCount++;
                const why = /429|Too Many Requests/.test(String(err?.message))
                    ? "RPC rate-limited"
                    : (err?.message ?? "unknown error");
                console.log(`[${this.config.routerId}] ⚠️  heartbeat failed (${why}) — counted as missed`);
            }
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
