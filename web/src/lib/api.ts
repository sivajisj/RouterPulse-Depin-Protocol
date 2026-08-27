export const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

/// Solana RPC the wallet adapter connects to for signing and sending
/// transactions. Reads still come from the API's indexed projection —
/// this is only for the operator actions the API deliberately can't
/// perform on a user's behalf.
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "http://localhost:8899";

export interface RouterDoc {
    _id: string;
    owner: string;
    routerId: string;
    devicePubkey: string;
    deviceKeyVersion: number;
    status: string;
    uptimeScore: number;
    heartbeatCount: number;
    missedHeartbeats?: number;
    stakedAmount: string;
    totalRewards?: string;
    totalPenalties?: string;
    lastHeartbeat?: number;
    registeredAt?: number;
    locationLat?: number;
    locationLong?: number;
}

export interface EpochDoc {
    _id: string;
    router: string;
    epochNumber: string;
    heartbeats?: number;
    expectedHeartbeats?: number;
    uptimeBps?: number;
    rewardMultiplierBps?: number;
    rewardAmount?: string;
    slashAmount?: string;
    finalized?: boolean;
    claimed?: boolean;
    slashed?: boolean;
    vestedClaimed?: string;
    vestedTotal?: string;
}

export interface EventDoc {
    _id: string;
    signature: string;
    index: number;
    slot: number;
    blockTime: number | null;
    name: string;
    data: Record<string, any>;
}

export interface Page<T> {
    items: T[];
    nextCursor: string | null;
}

/// Server-side fetch helper. `cache: "no-store"` because every one of
/// these reads is live operational data that the indexer is actively
/// rewriting — a cached router list showing a stale "active" for a
/// router that just got suspended is worse than a slightly slower page.
async function get<T>(path: string): Promise<T> {
    const res = await fetch(`${API_URL}${path}`, { cache: "no-store" });
    if (!res.ok) {
        throw new Error(`API ${res.status} on ${path}`);
    }
    return res.json() as Promise<T>;
}

/// Same as `get`, but returns null instead of throwing when the API is
/// unreachable — used where a page should degrade to an "API offline"
/// notice rather than a Next.js error screen.
export async function tryGet<T>(path: string): Promise<T | null> {
    try {
        return await get<T>(path);
    } catch {
        return null;
    }
}

export const api = {
    protocol:      () => tryGet<any>("/api/v1/protocol"),
    currentEpoch:  () => tryGet<any>("/api/v1/protocol/epochs/current"),
    network:       () => tryGet<any>("/api/v1/analytics/network"),
    regions:       () => tryGet<any[]>("/api/v1/analytics/regions"),
    recentEpochs:  (limit = 10) => tryGet<EpochDoc[]>(`/api/v1/analytics/epochs?limit=${limit}`),
    routers:       (qs = "") => tryGet<Page<RouterDoc>>(`/api/v1/routers${qs}`),
    router:        (pda: string) => tryGet<RouterDoc>(`/api/v1/routers/${pda}`),
    routerEpochs:  (pda: string) => tryGet<Page<EpochDoc>>(`/api/v1/routers/${pda}/epochs`),
    events:        (limit = 25, name?: string) =>
        tryGet<Page<EventDoc>>(`/api/v1/events?limit=${limit}${name ? `&name=${name}` : ""}`),
};

/// Reward-token amounts come back as base-unit strings (9 decimals) and
/// must stay strings end to end — they routinely exceed
/// Number.MAX_SAFE_INTEGER, so parsing to a float to format it would
/// silently corrupt the value. Formatted here with BigInt only.
export function formatTokens(raw: string | undefined, decimals = 9, precision = 4): string {
    if (!raw) return "0";
    let value: bigint;
    try {
        value = BigInt(raw);
    } catch {
        return raw;
    }
    const base = BigInt(10) ** BigInt(decimals);
    const whole = value / base;
    const frac = value % base;
    if (frac === BigInt(0)) return whole.toLocaleString();
    const fracStr = frac.toString().padStart(decimals, "0").slice(0, precision).replace(/0+$/, "");
    return fracStr ? `${whole.toLocaleString()}.${fracStr}` : whole.toLocaleString();
}

export function formatBps(bps: number | undefined): string {
    if (bps == null) return "—";
    return `${(bps / 100).toFixed(2)}%`;
}

export function shortAddress(addr: string | undefined, chars = 4): string {
    if (!addr) return "—";
    return addr.length <= chars * 2 + 3 ? addr : `${addr.slice(0, chars)}…${addr.slice(-chars)}`;
}

export function timeAgo(unixSeconds: number | undefined | null): string {
    if (!unixSeconds) return "never";
    const diff = Math.floor(Date.now() / 1000) - unixSeconds;
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}
