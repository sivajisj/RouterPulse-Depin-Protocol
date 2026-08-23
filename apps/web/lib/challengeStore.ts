import { randomBytes } from "crypto";

// TEMP: in-memory Map. This is fine for one Next.js server process in dev,
// but breaks the moment you run more than one instance (each instance has
// its own memory — a challenge issued by instance A won't be found by
// instance B). Step 2 moves this to Redis with a TTL (`SETEX`), which is
// exactly the "Redis for short-lived sessions" role from the architecture
// doc. Don't ship this Map to production.
const challenges = new Map<string, { nonce: string; expiresAt: number }>();

const CHALLENGE_TTL_MS = 2 * 60 * 1000; // 2 minutes — short window on purpose

export function createChallenge(walletAddress: string): string {
  const nonce = randomBytes(32).toString("hex");
  challenges.set(walletAddress, {
    nonce,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  });
  return nonce;
}

export function buildChallengeMessage(walletAddress: string, nonce: string): string {
  // Human-readable on purpose — Phantom shows this text to the user before
  // they sign, so it must never look like a blank-check transaction.
  return [
    "RouterPulse wants you to sign in.",
    `Wallet: ${walletAddress}`,
    `Nonce: ${nonce}`,
    "This request will not trigger a blockchain transaction or cost any fees.",
  ].join("\n");
}

/**
 * Consumes the challenge for a wallet — verifying a nonce that has already
 * been used returns false. This single-use property is the entire defense
 * against replaying a captured signature.
 */
export function consumeChallenge(walletAddress: string, nonce: string): boolean {
  const entry = challenges.get(walletAddress);
  if (!entry) return false;

  challenges.delete(walletAddress); // single-use: gone whether it matched or not

  if (Date.now() > entry.expiresAt) return false;
  return entry.nonce === nonce;
}
