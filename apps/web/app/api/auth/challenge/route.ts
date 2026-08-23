import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { buildChallengeMessage, createChallenge } from "@/lib/challengeStore";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const walletAddress = body?.walletAddress;

  if (typeof walletAddress !== "string") {
    return NextResponse.json({ error: "walletAddress required" }, { status: 400 });
  }

  // Reject malformed input before it ever reaches the challenge store —
  // never trust a client-supplied string to be a real base58 pubkey.
  try {
    new PublicKey(walletAddress);
  } catch {
    return NextResponse.json({ error: "invalid wallet address" }, { status: 400 });
  }

  const nonce = createChallenge(walletAddress);
  const message = buildChallengeMessage(walletAddress, nonce);

  return NextResponse.json({ nonce, message });
}
