import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import Redis from "ioredis";
import bs58 from "bs58";
import nacl from "tweetnacl";
import * as crypto from "crypto";
import { REDIS } from "../redis/redis.module";

const CHALLENGE_TTL_SECONDS = 5 * 60;
const CHALLENGE_PREFIX = "siws:challenge:";

/// Sign-In-With-Solana: prove control of a wallet by signing a
/// server-issued, single-use, short-lived nonce with it — no password,
/// no custody of any key, ever. This is the standard non-custodial auth
/// pattern for Solana dApps, and it's what makes the RBAC on the
/// admin-only protocol endpoint meaningful: the JWT it produces is
/// bound to a wallet that provably signed for itself moments earlier.
@Injectable()
export class AuthService {
    constructor(
        @Inject(REDIS) private readonly redis: Redis,
        private readonly jwt: JwtService,
    ) {}

    async issueChallenge(wallet: string): Promise<{ wallet: string; message: string; expiresInSeconds: number }> {
        const nonce = crypto.randomBytes(16).toString("hex");
        const message = `RouterPulse wants you to sign in.\n\nWallet: ${wallet}\nNonce: ${nonce}\nIssued: ${new Date().toISOString()}`;
        await this.redis.set(CHALLENGE_PREFIX + wallet, message, "EX", CHALLENGE_TTL_SECONDS);
        return { wallet, message, expiresInSeconds: CHALLENGE_TTL_SECONDS };
    }

    async verify(wallet: string, signatureBase58: string): Promise<{ accessToken: string; wallet: string }> {
        const key = CHALLENGE_PREFIX + wallet;
        const message = await this.redis.get(key);
        if (!message) {
            throw new UnauthorizedException("No pending challenge for this wallet — request one first, and use it within 5 minutes.");
        }

        let verified: boolean;
        try {
            verified = nacl.sign.detached.verify(
                Buffer.from(message, "utf-8"),
                bs58.decode(signatureBase58),
                bs58.decode(wallet),
            );
        } catch {
            verified = false;
        }

        if (!verified) throw new UnauthorizedException("Signature does not match the issued challenge for this wallet.");

        // Single-use: burn the nonce immediately so the same signature
        // can never authenticate a second session.
        await this.redis.del(key);

        const accessToken = await this.jwt.signAsync({ sub: wallet, wallet });
        return { accessToken, wallet };
    }
}
