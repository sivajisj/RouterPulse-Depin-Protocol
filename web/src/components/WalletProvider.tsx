"use client";

import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { RPC_URL } from "@/lib/api";

import "@solana/wallet-adapter-react-ui/styles.css";

/// Wraps the app in the Solana wallet context.
///
/// Note this is the *only* place a Solana connection exists in the
/// dashboard — every read still goes through the API's indexed
/// projection. The connection here is used purely to build, sign and
/// send transactions from the user's own wallet, which is the one thing
/// the API deliberately cannot do on their behalf (it holds no keypair).
export function SolanaWalletProvider({ children }: { children: React.ReactNode }) {
    // Adapters are stable for the lifetime of the app; re-creating them
    // on every render would tear down and re-establish wallet listeners.
    const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);

    return (
        <ConnectionProvider endpoint={RPC_URL}>
            <WalletProvider wallets={wallets} autoConnect>
                <WalletModalProvider>{children}</WalletModalProvider>
            </WalletProvider>
        </ConnectionProvider>
    );
}
