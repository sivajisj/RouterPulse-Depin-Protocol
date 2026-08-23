import "@solana/wallet-adapter-react-ui/styles.css";
import "./globals.css";
import WalletProviders from "@/components/WalletProviders";

export const metadata = {
  title: "RouterPulse",
  description: "DePIN Proof-of-Service network for community Wi-Fi",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletProviders>{children}</WalletProviders>
      </body>
    </html>
  );
}
