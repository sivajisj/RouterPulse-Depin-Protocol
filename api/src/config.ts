import * as dotenv from "dotenv";
dotenv.config();

function num(name: string, fallback: number): number {
    const v = process.env[name];
    return v ? Number(v) : fallback;
}

export const config = {
    port: num("PORT", 3001),
    mongoUrl: process.env.MONGO_URL || "mongodb://127.0.0.1:27017",
    mongoDb: process.env.MONGO_DB || "routerpulse",
    redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
    jwtSecret: process.env.JWT_SECRET || "dev-only-change-me",
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || "1h",
    corsOrigins: (process.env.CORS_ORIGINS || "http://localhost:3000").split(",").map(s => s.trim()),
    rateLimitTtlMs: num("RATE_LIMIT_TTL_MS", 60_000),
    rateLimitMax: num("RATE_LIMIT_MAX", 120),
};
