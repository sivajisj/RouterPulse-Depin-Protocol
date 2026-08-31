"use client";

import { TxState } from "@/lib/useTx";

const LABEL: Record<string, string> = {
    building:   "Building transaction…",
    signing:    "Waiting for your wallet — check for a popup",
    confirming: "Submitted, waiting for confirmation…",
    confirmed:  "Confirmed on-chain",
};

export function TxStatus({ state }: { state: TxState }) {
    if (state.phase === "idle") return null;

    if (state.phase === "error") {
        return <div className="tx-status tx-error">{state.error}</div>;
    }

    return (
        <div className={`tx-status ${state.phase === "confirmed" ? "tx-ok" : "tx-pending"}`}>
            <span>{LABEL[state.phase]}</span>
            {state.signature && (
                <span className="mono tx-sig">{state.signature.slice(0, 20)}…</span>
            )}
        </div>
    );
}
