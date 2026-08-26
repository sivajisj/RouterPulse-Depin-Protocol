/// Opaque cursor pagination over a single monotonic sort field (never
/// skip/limit — skip gets slower and, worse, silently drifts if
/// documents are inserted between pages, which they constantly are
/// here since the indexer is writing concurrently with API reads).
///
/// The cursor is just the sort field's value from the last row of the
/// previous page, base64-encoded so it's an opaque string to API
/// consumers rather than a value they might be tempted to construct
/// themselves.
export interface Page<T> {
    items: T[];
    nextCursor: string | null;
}

export function encodeCursor(value: string | number): string {
    return Buffer.from(String(value), "utf-8").toString("base64url");
}

export function decodeCursor(cursor?: string): string | undefined {
    if (!cursor) return undefined;
    try {
        return Buffer.from(cursor, "base64url").toString("utf-8");
    } catch {
        return undefined;
    }
}

export function clampLimit(limit: unknown, fallback = 20, max = 100): number {
    const n = Number(limit);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.floor(n), max);
}
