"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import { API_URL } from "./api";

const STORAGE_KEY = "routerpulse.session";

interface StoredSession {
    wallet: string;
    accessToken: string;
}

/// Drives the Sign-In-With-Solana handshake against the API:
/// request a nonce → sign it with the connected wallet → exchange the
/// signature for a session JWT.
///
/// The wallet signs a plain message, never a transaction — signing in
/// costs nothing, touches no funds, and cannot be replayed (the API
/// deletes the nonce on first use).
export function useSession() {
    const { publicKey, signMessage, disconnect } = useWallet();
    const [session, setSession] = useState<StoredSession | null>(null);
    const [signingIn, setSigningIn] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const wallet = publicKey?.toBase58() ?? null;

    // Restore a previous session, but only if it belongs to the wallet
    // that's currently connected — otherwise switching wallets would
    // leave you authenticated as the previous one.
    useEffect(() => {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const stored: StoredSession = JSON.parse(raw);
            if (wallet && stored.wallet === wallet) {
                setSession(stored);
            } else {
                localStorage.removeItem(STORAGE_KEY);
                setSession(null);
            }
        } catch {
            /* corrupt or unavailable storage — just start signed out */
        }
    }, [wallet]);

    const signIn = useCallback(async () => {
        if (!wallet || !signMessage) {
            setError("Connect a wallet that supports message signing first.");
            return;
        }
        setSigningIn(true);
        setError(null);
        try {
            const challengeRes = await fetch(`${API_URL}/api/v1/auth/challenge?wallet=${wallet}`);
            if (!challengeRes.ok) throw new Error(`Challenge failed (${challengeRes.status})`);
            const { message } = await challengeRes.json();

            const signature = await signMessage(new TextEncoder().encode(message));

            const verifyRes = await fetch(`${API_URL}/api/v1/auth/verify`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ wallet, signature: bs58.encode(signature) }),
            });
            if (!verifyRes.ok) throw new Error(`Verification rejected (${verifyRes.status})`);

            const { accessToken } = await verifyRes.json();
            const next = { wallet, accessToken };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
            setSession(next);
        } catch (err: any) {
            // A user rejecting the signature prompt in their wallet is a
            // normal outcome, not an error worth shouting about.
            setError(err?.message?.includes("User rejected") ? null : (err?.message ?? "Sign-in failed"));
        } finally {
            setSigningIn(false);
        }
    }, [wallet, signMessage]);

    const signOut = useCallback(() => {
        localStorage.removeItem(STORAGE_KEY);
        setSession(null);
    }, []);

    const signOutAndDisconnect = useCallback(async () => {
        signOut();
        await disconnect().catch(() => undefined);
    }, [signOut, disconnect]);

    return {
        wallet,
        session,
        isAuthenticated: !!session && session.wallet === wallet,
        signIn,
        signOut,
        signOutAndDisconnect,
        signingIn,
        error,
    };
}

/// Fetch helper that attaches the session token. Returns `status` so
/// callers can distinguish "not allowed" (403 — signed in, wrong wallet)
/// from "not signed in" (401), which matters for what to tell the user.
export async function authedFetch<T>(
    path: string,
    accessToken: string,
): Promise<{ ok: boolean; status: number; data: T | null }> {
    const res = await fetch(`${API_URL}${path}`, {
        headers: { authorization: `Bearer ${accessToken}` },
    });
    let data: T | null = null;
    try {
        data = await res.json();
    } catch {
        /* error responses aren't always JSON */
    }
    return { ok: res.ok, status: res.status, data };
}
