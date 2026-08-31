"use client";

import { useState } from "react";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
    TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
    createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { useWallet } from "@solana/wallet-adapter-react";
import {
    useProgram, protocolPda, rewardMintPda, stakeVaultPda,
    stakePda, routerEpochPda, vestingPda, BN,
} from "@/lib/useProgram";
import { useTx } from "@/lib/useTx";
import { TxStatus } from "./TxStatus";
import { RouterDoc, EpochDoc, formatTokens } from "@/lib/api";

const DECIMALS = 9;

/// Converts a human token amount ("1.5") to base units without going
/// through a float — 1.5e9 is fine, but larger amounts silently lose
/// precision as doubles, and these are balances.
function toBaseUnits(input: string): BN {
    const [whole, frac = ""] = input.trim().split(".");
    const padded = (frac + "0".repeat(DECIMALS)).slice(0, DECIMALS);
    return new BN(whole || "0").mul(new BN(10).pow(new BN(DECIMALS))).add(new BN(padded || "0"));
}

export function RouterActions({
    router, epochs, onDone,
}: {
    router: RouterDoc;
    epochs: EpochDoc[];
    onDone?: () => void;
}) {
    const { publicKey } = useWallet();
    const program = useProgram();
    const stakeTx = useTx();
    const claimTx = useTx();
    const vestTx  = useTx();
    const [amount, setAmount] = useState("10");

    if (!program || !publicKey) return null;
    const routerKey = new PublicKey(router._id);

    /// The operator's token account may not exist yet — on a fresh
    /// wallet it won't. Prepending the create instruction is idempotent
    /// in practice because we only add it when the account is missing.
    const ataIx = async (owner: PublicKey, mint: PublicKey) => {
        const ata = getAssociatedTokenAddressSync(mint, owner);
        const info = await program.provider.connection.getAccountInfo(ata);
        return {
            ata,
            ix: info ? null : createAssociatedTokenAccountInstruction(owner, ata, owner, mint),
        };
    };

    const doStake = async () => {
        const mint = rewardMintPda();
        const { ata, ix } = await ataIx(publicKey, mint);
        await stakeTx.run(
            () => {
                const b = program.methods
                    .stake(toBaseUnits(amount))
                    .accountsPartial({
                        router: routerKey,
                        protocol: protocolPda(),
                        stake: stakePda(routerKey),
                        rewardMint: mint,
                        stakeVault: stakeVaultPda(),
                        ownerTokenAccount: ata,
                        owner: publicKey,
                        tokenProgram: TOKEN_PROGRAM_ID,
                        systemProgram: SystemProgram.programId,
                    });
                return (ix ? b.preInstructions([ix]) : b).rpc();
            },
            onDone,
        );
    };

    const doClaim = async (epochNumber: number) => {
        await claimTx.run(
            () => program.methods
                .claimReward(new BN(epochNumber))
                .accountsPartial({
                    router: routerKey,
                    protocol: protocolPda(),
                    routerEpoch: routerEpochPda(routerKey, epochNumber),
                    vesting: vestingPda(routerKey, epochNumber),
                    owner: publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc(),
            onDone,
        );
    };

    const doVest = async (epochNumber: number) => {
        const mint = rewardMintPda();
        const { ata, ix } = await ataIx(publicKey, mint);
        await vestTx.run(
            () => {
                const b = program.methods
                    .claimVested(new BN(epochNumber))
                    .accountsPartial({
                        router: routerKey,
                        protocol: protocolPda(),
                        vesting: vestingPda(routerKey, epochNumber),
                        rewardMint: mint,
                        beneficiaryTokenAccount: ata,
                        beneficiary: publicKey,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    });
                return (ix ? b.preInstructions([ix]) : b).rpc();
            },
            onDone,
        );
    };

    const claimable = epochs.filter(e => e.finalized && !e.claimed && e.rewardAmount && e.rewardAmount !== "0");
    const vesting   = epochs.filter(e => e.claimed);

    return (
        <div className="card">
            <div className="card-title">Actions — {router.routerId}</div>

            <div className="action-block">
                <div className="action-label">
                    Stake collateral
                    <span className="action-hint">
                        A router can&apos;t activate until it holds the protocol minimum.
                    </span>
                </div>
                <div className="action-row">
                    <input value={amount} onChange={e => setAmount(e.target.value)} style={{ width: 120 }} />
                    <button className="btn-primary" disabled={stakeTx.busy} onClick={doStake}>
                        {stakeTx.busy ? "Working…" : "Stake"}
                    </button>
                    <span style={{ color: "var(--text-dim)", fontSize: 12.5 }}>
                        currently staked: <span className="mono">{formatTokens(router.stakedAmount)}</span>
                    </span>
                </div>
                <TxStatus state={stakeTx.state} />
            </div>

            <div className="action-block">
                <div className="action-label">
                    Claim finalized epochs
                    <span className="action-hint">
                        Claiming creates a vesting grant — it does not move tokens yet.
                    </span>
                </div>
                {claimable.length === 0 ? (
                    <div className="action-empty">Nothing to claim. Epochs appear here once finalized.</div>
                ) : claimable.map(e => (
                    <div className="action-row" key={e._id}>
                        <span>epoch <span className="mono">{e.epochNumber}</span></span>
                        <span className="mono">{formatTokens(e.rewardAmount)}</span>
                        <button className="btn-primary" disabled={claimTx.busy}
                                onClick={() => doClaim(Number(e.epochNumber))}>
                            Claim
                        </button>
                    </div>
                ))}
                <TxStatus state={claimTx.state} />
            </div>

            <div className="action-block">
                <div className="action-label">
                    Release vested tokens
                    <span className="action-hint">
                        Mints only the portion that has actually vested since last time.
                    </span>
                </div>
                {vesting.length === 0 ? (
                    <div className="action-empty">No vesting grants yet.</div>
                ) : vesting.map(e => (
                    <div className="action-row" key={e._id}>
                        <span>epoch <span className="mono">{e.epochNumber}</span></span>
                        <span className="mono" style={{ color: "var(--text-dim)" }}>
                            {formatTokens(e.vestedClaimed ?? "0")} / {formatTokens(e.vestedTotal ?? e.rewardAmount)}
                        </span>
                        <button className="btn-primary" disabled={vestTx.busy}
                                onClick={() => doVest(Number(e.epochNumber))}>
                            Release
                        </button>
                    </div>
                ))}
                <TxStatus state={vestTx.state} />
            </div>
        </div>
    );
}
