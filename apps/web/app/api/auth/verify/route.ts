import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { consumeChallenge, buildChallengeMessage } from "@/lib/challengeStore";
import { issueSessionToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/session";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const { walletAddress, nonce, signature } = body ?? {};

  if (
    typeof walletAddress !== "string" ||
    typeof nonce !== "string" ||
    typeof signature !== "string"
  ) {
    return NextResponse.json({ error: "malformed request" }, { status: 400 });
  }

  // Step 1: nonce must exist and not have been used before. This call
  // deletes the entry regardless of outcome — that's what makes it single-use.
  const nonceValid = consumeChallenge(walletAddress, nonce);
  if (!nonceValid) {
    return NextResponse.json({ error: "challenge expired or already used" }, { status: 401 });
  }

  // Step 2: rebuild the EXACT message server-side. Never trust a
  // client-supplied "message" field — if you did, an attacker could ask you
  // to verify a signature against a message you never issued.
  const expectedMessage = buildChallengeMessage(walletAddress, nonce);

  // Step 3: verify the Ed25519 signature. This is the entire proof of key
  // ownership — no password, no secret ever left the wallet.
  let signatureValid = false;
  try {
    const messageBytes = new TextEncoder().encode(expectedMessage);
    const signatureBytes = bs58.decode(signature);
    const publicKeyBytes = new PublicKey(walletAddress).toBytes();
    signatureValid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
  } catch {
    signatureValid = false;
  }

  if (!signatureValid) {
    return NextResponse.json({ error: "signature verification failed" }, { status: 401 });
  }

  // Step 4: only after both checks pass do we mint a session.
  const token = await issueSessionToken({ walletAddress });

  const res = NextResponse.json({ ok: true, walletAddress });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true, // JS on the page can never read this — mitigates XSS token theft
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
  });
  return res;
}
