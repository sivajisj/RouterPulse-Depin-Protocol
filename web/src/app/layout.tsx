import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { SolanaWalletProvider } from "@/components/WalletProvider";
import { WalletBar } from "@/components/WalletBar";

export const metadata: Metadata = {
    title: "RouterPulse",
    description: "Solana DePIN network for verifiable Wi-Fi router uptime",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
            <body>
                {/* The wallet context has to wrap everything that might read
                    it, but note the pages themselves stay Server Components —
                    only the components that actually call wallet hooks are
                    client-side. */}
                <SolanaWalletProvider>
                    <div className="layout">
                        <aside className="sidebar">
                            <div className="brand">
                                <span className="brand-dot" />
                                RouterPulse
                            </div>
                            <Nav />
                        </aside>
                        <div className="content">
                            <header className="topbar">
                                <WalletBar />
                            </header>
                            <main className="main">{children}</main>
                        </div>
                    </div>
                </SolanaWalletProvider>
            </body>
        </html>
    );
}
