/// Retry with exponential backoff, specifically for RPC calls.
///
/// Public Solana RPC endpoints rate-limit aggressively, and this indexer
/// makes one `getTransaction` per signature during backfill — which is
/// exactly the shape of traffic that trips a 429. Without this, a single
/// throttled response killed the whole process mid-backfill and the
/// service simply stopped indexing.
///
/// Only transient failures are retried. A malformed request or a genuine
/// program error will fail identically on the tenth attempt as the
/// first, so retrying those just delays a real error and hides it behind
/// a long pause.
export interface RetryOptions {
    attempts?: number;
    baseDelayMs?: number;
    label?: string;
}

const TRANSIENT = [
    "429", "too many requests", "rate limit",
    "503", "502", "504", "service unavailable", "bad gateway", "gateway timeout",
    "timeout", "timed out", "econnreset", "socket hang up", "etimedout",
    "fetch failed", "network error",
];

export function isTransient(err: unknown): boolean {
    const msg = String((err as any)?.message ?? err).toLowerCase();
    return TRANSIENT.some(t => msg.includes(t));
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
    const attempts = opts.attempts ?? 6;
    const base = opts.baseDelayMs ?? 500;

    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (!isTransient(err) || i === attempts - 1) throw err;

            // Exponential backoff with jitter. The jitter matters when
            // several calls get throttled at once: without it they all
            // wake at the same instant and trip the limit again together.
            const delay = base * 2 ** i + Math.random() * base;
            console.warn(
                `[retry] ${opts.label ?? "rpc"} attempt ${i + 1}/${attempts} failed ` +
                `(${String((err as any)?.message ?? err).slice(0, 80)}) — retrying in ${Math.round(delay)}ms`
            );
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastErr;
}
