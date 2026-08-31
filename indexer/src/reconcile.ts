import * as anchor from "@coral-xyz/anchor";
import { loadIdl, getConnection, getProgramId, getProtocolPDA, getDb, closeDb } from "./config";

/// Periodically re-fetches the real on-chain `Protocol` and every
/// `Router` account and overwrites the indexed projection with them.
///
/// This exists because MongoDB is never the source of truth — Solana
/// is — and the event-driven projection in `projections.ts` is built
/// from a best-effort replay of logs, which can miss a transaction (an
/// RPC hiccup during the live subscription, a gap before backfill last
/// ran) with no local signal that anything is wrong. Reconciliation is
/// what catches that: it doesn't trust its own history, it just asks
/// the chain "what is actually true right now" on a fixed interval and
/// makes the projection match. Drift between what reconciliation finds
/// and what the event projection already had is logged, which is
/// exactly the signal you'd page an operator on in production.
export async function reconcileOnce(): Promise<{ routers: number; drifted: number }> {
    const idl        = loadIdl();
    const connection  = getConnection();
    const programId   = getProgramId(idl);
    const db          = await getDb();

    // Read-only: this instance never sends a transaction, so a
    // throwaway keypair with zero balance is sufficient as the
    // provider's nominal wallet.
    const wallet   = new anchor.Wallet(anchor.web3.Keypair.generate());
    const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
    // Cast to `any`: this reads from the generic `anchor.Idl` type rather
    // than the codegen'd `Routerpulse` type (the indexer is a separate
    // package and deliberately doesn't depend on the program crate's
    // generated TS types), so Anchor can't statically know the account
    // namespace has `.protocol` / `.router` on it — it does, at runtime,
    // decoded straight from the same IDL used to build them.
    const program: any = new anchor.Program(idl as any, provider);

    const protocolPDA = getProtocolPDA(programId);
    let protocolAccount: any;
    try {
        protocolAccount = await program.account.protocol.fetch(protocolPDA);
    } catch {
        console.log("[reconcile] protocol not yet initialized on-chain — nothing to reconcile");
        return { routers: 0, drifted: 0 };
    }

    await db.collection("protocol").updateOne(
        { _id: "protocol" as any },
        { $set: {
            authority:               protocolAccount.authority.toBase58(),
            rewardMint:              protocolAccount.rewardMint.toBase58(),
            rewardRate:              protocolAccount.rewardRate.toString(),
            penaltyBps:              protocolAccount.penaltyBps,
            heartbeatInterval:       protocolAccount.heartbeatInterval.toString(),
            epochDuration:           protocolAccount.epochDuration.toString(),
            genesisTime:             protocolAccount.genesisTime.toString(),
            minStake:                protocolAccount.minStake.toString(),
            totalRouters:            protocolAccount.totalRouters.toString(),
            totalRewardsDistributed: protocolAccount.totalRewardsDistributed.toString(),
            totalStaked:             protocolAccount.totalStaked.toString(),
            totalSlashed:            protocolAccount.totalSlashed.toString(),
            totalMinted:             protocolAccount.totalMinted.toString(),
            totalBurned:             protocolAccount.totalBurned.toString(),
            genesisAllocation:       protocolAccount.genesisAllocation.toString(),
            genesisMinted:           protocolAccount.genesisMinted.toString(),
            isPaused:                protocolAccount.isPaused,
            reconciledAt:            new Date(),
        } },
        { upsert: true }
    );

    const allRouters = await program.account.router.all();
    let drifted = 0;

    for (const { publicKey, account } of allRouters as any[]) {
        const routerPda = publicKey.toBase58();
        const before = await db.collection("routers").findOne({ _id: routerPda as any });

        const onChainStatus = Object.keys(account.status)[0] as string; // {active:{}} -> "active"
        const update = {
            owner:            account.owner.toBase58(),
            routerId:         account.routerId,
            devicePubkey:     account.devicePubkey.toBase58(),
            deviceKeyVersion: account.deviceKeyVersion,
            status:           onChainStatus,
            uptimeScore:      account.uptimeScore,
            heartbeatCount:   Number(account.heartbeatCount.toString()),
            missedHeartbeats: Number(account.missedHeartbeats.toString()),
            totalRewards:     account.totalRewards.toString(),
            totalPenalties:   account.totalPenalties.toString(),
            stakedAmount:     account.stakedAmount.toString(),
            registeredAt:     Number(account.registeredAt.toString()),
            lastHeartbeat:    Number(account.lastHeartbeat.toString()),
            reconciledAt:     new Date(),
        };

        if (before && (before.status !== update.status || before.stakedAmount !== update.stakedAmount)) {
            drifted++;
            console.log(
                `[reconcile] drift on ${routerPda.slice(0, 8)}...: ` +
                `status ${before.status} -> ${update.status}, staked ${before.stakedAmount} -> ${update.stakedAmount}`
            );
        }

        await db.collection("routers").updateOne(
            { _id: routerPda as any }, { $set: update }, { upsert: true }
        );
    }

    // ── epochs ────────────────────────────────────────────────────────
    // Originally this function only reconciled `protocol` and `router`,
    // which left a real hole: if a RouterEpochFinalized event was ever
    // lost, nothing repaired it and the epoch stayed permanently wrong
    // in Mongo — reward and uptime missing while the chain had them.
    // That happened. Epoch records are the basis of every reward figure
    // the dashboard shows, so they get the same treatment as routers:
    // trust the chain, overwrite the projection.
    const allEpochs = await program.account.routerEpoch.all();
    let epochsDrifted = 0;

    for (const { account } of allEpochs as any[]) {
        const key = `${account.router.toBase58()}:${account.epochNumber.toString()}`;
        const before = await db.collection("epochs").findOne({ _id: key as any });

        const update = {
            router:             account.router.toBase58(),
            epochNumber:        account.epochNumber.toString(),
            heartbeats:         account.heartbeats,
            expectedHeartbeats: account.expectedHeartbeats,
            uptimeBps:          account.uptimeBps,
            rewardAmount:       account.rewardAmount.toString(),
            slashAmount:        account.slashAmount.toString(),
            finalized:          account.finalized,
            claimed:            account.claimed,
            slashed:            account.slashed,
            reconciledAt:       new Date(),
        };

        // Missing `finalized` on a chain-finalized epoch is the exact
        // signature of a dropped event, so it's worth naming loudly
        // rather than silently patching.
        if (!before || before.finalized !== update.finalized || before.rewardAmount !== update.rewardAmount) {
            epochsDrifted++;
            console.log(
                `[reconcile] epoch drift ${key}: ` +
                `finalized ${before?.finalized} -> ${update.finalized}, ` +
                `reward ${before?.rewardAmount} -> ${update.rewardAmount}`
            );
        }

        await db.collection("epochs").updateOne(
            { _id: key as any }, { $set: update }, { upsert: true }
        );
    }

    console.log(
        `[reconcile] protocol + ${allRouters.length} router(s) + ${allEpochs.length} epoch(s) reconciled` +
        (drifted || epochsDrifted
            ? ` (${drifted} router / ${epochsDrifted} epoch drifted from the event projection)`
            : "")
    );
    return { routers: allRouters.length, drifted: drifted + epochsDrifted };
}

/// Runs immediately, then on a fixed interval. Returns the timer so the
/// caller can `clearInterval` it during graceful shutdown.
export function startReconciliationLoop(intervalMs: number): NodeJS.Timeout {
    reconcileOnce().catch(err => console.error("[reconcile] error:", err));
    return setInterval(() => {
        reconcileOnce().catch(err => console.error("[reconcile] error:", err));
    }, intervalMs);
}

if (require.main === module) {
    reconcileOnce()
        .then(() => closeDb())
        .catch(err => { console.error("[reconcile] fatal:", err); process.exit(1); });
}
