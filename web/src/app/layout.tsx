import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";

export const metadata: Metadata = {
    title: "RouterPulse",
    description: "Solana DePIN network for verifiable Wi-Fi router uptime",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
            <body>
                <div className="layout">
                    <aside className="sidebar">
                        <div className="brand">
                            <span className="brand-dot" />
                            RouterPulse
                        </div>
                        <Nav />
                    </aside>
                    <main className="main">{children}</main>
                </div>
            </body>
        </html>
    );
}
