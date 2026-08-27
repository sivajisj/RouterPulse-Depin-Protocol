"use client";

import dynamic from "next/dynamic";
import { useSession } from "@/lib/useSession";
import { shortAddress } from "@/lib/api";

// The wallet button reads `window.solana` on mount, so server-rendering
// it produces markup that never matches the client. Loading it
// client-only avoids the hydration mismatch entirely.
const WalletMultiButton = dynamic(
    () => import("@solana/wallet-adapter-react-ui").then(m => m.WalletMultiButton),
    { ssr: false, loading: () => <div className="wallet-placeholder">Connect Wallet</div> }
);

export function WalletBar() {
    const { wallet, isAuthenticated, signIn, signOut, signingIn, error } = useSession();

    return (
        <div className="wallet-bar">
            {wallet && (
                isAuthenticated ? (
                    <div className="session-chip">
                        <span className="session-dot" />
                        <span>Signed in as {shortAddress(wallet)}</span>
                        <button onClick={signOut} className="link-btn">sign out</button>
                    </div>
                ) : (
                    <button onClick={signIn} disabled={signingIn} className="btn-primary">
                        {signingIn ? "Check your wallet…" : "Sign in with Solana"}
                    </button>
                )
            )}
            <WalletMultiButton />
            {error && <span className="wallet-error">{error}</span>}
        </div>
    );
}
