import { SignJWT, jwtVerify } from "jose";

// TEMP: in Step 1 the dashboard is its own backend. Step 2 replaces this
// whole file with calls to the real Axum service (POST /v1/auth/verify
// returns a session token from the Rust backend instead). Keeping the
// contract (cookie name, payload shape) identical now means swapping the
// implementation later doesn't touch any page or component code.

const SESSION_COOKIE = "routerpulse_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "SESSION_SECRET is not set. Add it to .env.local (32+ random bytes)."
    );
  }
  return new TextEncoder().encode(secret);
}

export interface SessionPayload {
  walletAddress: string;
  [key: string]: unknown;
}

export async function issueSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSecret());
}

export async function verifySessionToken(
  token: string
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return payload as SessionPayload;
  } catch {
    // Expired, tampered, or malformed — always treat as "not authenticated",
    // never leak which failure mode it was.
    return null;
  }
}

export { SESSION_COOKIE, SESSION_TTL_SECONDS };
