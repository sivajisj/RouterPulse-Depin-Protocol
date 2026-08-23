"use client";

import { useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import bs58 from "bs58";
import "@solana/wallet-adapter-react-ui/styles.css";

export default function ConnectWalletButton() {
  const { publicKey, signMessage, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<"idle" | "signing" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const handleSignIn = useCallback(async () => {
    setError(null);

    if (!connected || !publicKey) {
      setVisible(true);
      return;
    }

    if (!signMessage) {
      setError("Your wallet does not support message signing.");
      return;
    }

    try {
      const walletAddress = publicKey.toBase58();

      setStatus("signing");
      const challengeRes = await fetch("/api/auth/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress }),
      });
      if (!challengeRes.ok) throw new Error("Could not start sign-in.");
      const { nonce, message } = await challengeRes.json();

      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = await signMessage(messageBytes);
      const signature = bs58.encode(signatureBytes);

      const verifyRes = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress, nonce, signature }),
      });
      if (!verifyRes.ok) throw new Error("Signature verification failed.");

      const redirectTo = searchParams.get("redirectTo") || "/dashboard";
      router.push(redirectTo);
      router.refresh();
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Sign-in failed.");
      return;
    }
    setStatus("idle");
  }, [connected, publicKey, signMessage, setVisible, router, searchParams]);

  let label = "Sign in with wallet";
  if (connected && publicKey) {
    label = status === "signing" ? "Waiting for signature…" : "Sign challenge";
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <button
        onClick={handleSignIn}
        disabled={status === "signing"}
        className="rounded-md border border-border bg-panel px-5 py-2.5 text-sm font-medium text-white hover:bg-white/5 disabled:opacity-50"
      >
        {label}
      </button>
      {connected && publicKey && (
        <p className="text-xs text-gray-500">
          {publicKey.toBase58().slice(0, 4)}…{publicKey.toBase58().slice(-4)}
        </p>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
