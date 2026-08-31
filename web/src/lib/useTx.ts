"use client";

import { useCallback, useState } from "react";

export type TxPhase = "idle" | "building" | "signing" | "confirming" | "confirmed" | "error";

export interface TxState {
    phase: TxPhase;
    signature: string | null;
    error: string | null;
}

const IDLE: TxState = { phase: "idle", signature: null, error: null };

/// Wraps a transaction-sending call so the UI can show *which* step is
/// in progress rather than a single opaque spinner. The distinction that
/// matters most to a user is "signing" — that's the moment their wallet
/// pops up and is waiting on them, and it's the only step they can act
/// on. Lumping it in with network latency is what makes dApps feel
/// broken when a wallet window opens behind the browser.
export function useTx() {
    const [state, setState] = useState<TxState>(IDLE);

    const run = useCallback(async (
        send: () => Promise<string>,
        onDone?: () => void | Promise<void>,
    ) => {
        setState({ phase: "building", signature: null, error: null });
        try {
            // Anchor's .rpc() builds, prompts the wallet, and confirms in
            // one call, so "signing" is set optimistically just before —
            // it's the phase the user spends real time in.
            setState({ phase: "signing", signature: null, error: null });
            const signature = await send();

            setState({ phase: "confirming", signature, error: null });
            await onDone?.();

            setState({ phase: "confirmed", signature, error: null });
            return signature;
        } catch (err: any) {
            const raw = err?.message ?? String(err);
            setState({ phase: "error", signature: null, error: humanize(raw) });
            return null;
        }
    }, []);

    const reset = useCallback(() => setState(IDLE), []);
    const busy = state.phase === "building" || state.phase === "signing" || state.phase === "confirming";

    return { state, run, reset, busy };
}

/// Anchor surfaces program errors as long multi-line logs. Pull out the
/// custom error name when it's there, since that's the part that tells
/// an operator what to actually do differently.
function humanize(raw: string): string {
    if (/User rejected|rejected the request/i.test(raw)) return "You rejected the request in your wallet.";

    const known: Record<string, string> = {
        InsufficientStake:        "This router needs collateral before it can activate.",
        StakeLocked:              "Collateral is still inside its lock period.",
        UnstakeBelowMinimum:      "An active router must stay above the minimum stake — decommission it first.",
        EpochNotFinalized:        "That epoch hasn't been finalized yet.",
        EpochAlreadyClaimed:      "That epoch's reward has already been claimed.",
        NothingVested:            "Nothing new has vested yet — wait for the cliff or for more time to pass.",
        ProtocolPaused:           "The protocol is paused.",
        RouterIdTooLong:          "Router ID must be 32 characters or fewer.",
        RouterIdEmpty:            "Router ID can't be empty.",
        InvalidLatitude:          "Latitude must be between -90 and 90.",
        InvalidLongitude:         "Longitude must be between -180 and 180.",
        GenesisAllocationExhausted: "The genesis allocation is used up.",
    };
    for (const [code, message] of Object.entries(known)) {
        if (raw.includes(code)) return message;
    }

    if (/already in use/i.test(raw)) return "That router ID is already registered to this wallet.";
    if (/insufficient lamports|Attempt to debit/i.test(raw)) return "Not enough SOL to cover the transaction fee.";

    return raw.split("\n")[0].slice(0, 200);
}
