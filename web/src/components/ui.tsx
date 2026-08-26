import { RouterDoc } from "@/lib/api";

export function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
    return (
        <div className="card">
            <div className="stat-label">{label}</div>
            <div className="stat-value">{value}</div>
            {sub && <div className="stat-sub">{sub}</div>}
        </div>
    );
}

export function StatusBadge({ status }: { status: string }) {
    const known = ["active", "suspended", "inactive", "decommissioned"];
    const cls = known.includes(status) ? `badge-${status}` : "badge-inactive";
    return <span className={`badge ${cls}`}>{status}</span>;
}

/// Uptime score as a bar. Colour thresholds mirror the on-chain
/// performance tiers (see programs/routerpulse/src/math.rs): green while
/// a router is earning a full multiplier, amber where rewards start
/// getting cut, red once it's in slashing territory.
export function ScoreMeter({ score }: { score: number }) {
    const color = score >= 90 ? "var(--ok)" : score >= 70 ? "var(--warn)" : "var(--danger)";
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div className="meter">
                <div className="meter-fill" style={{ width: `${Math.min(100, Math.max(0, score))}%`, background: color }} />
            </div>
            <span style={{ color, fontWeight: 600, fontSize: 12.5, minWidth: 26 }}>{score}</span>
        </div>
    );
}

export function ApiOffline() {
    return (
        <div className="notice">
            Can&apos;t reach the RouterPulse API. Start it with <code>npm start</code> in <code>api/</code>,
            and make sure the indexer has run at least once so there&apos;s data to show.
        </div>
    );
}

/// Plots routers on a simple equirectangular projection. Deliberately
/// hand-rolled rather than pulling in MapLibre + a tile provider: it has
/// no external dependency, no API key, and no network call, which keeps
/// the dashboard fully functional offline. A production build would swap
/// this for real tiles.
export function RouterMap({ routers }: { routers: RouterDoc[] }) {
    const located = routers.filter(r => r.locationLat != null && r.locationLong != null);
    return (
        <div className="card">
            <div className="card-title">Router Locations</div>
            <div className="map">
                {located.length === 0 && <div className="empty">No location data indexed.</div>}
                {located.map(r => {
                    // Fixed-point degrees (×1e6) → percentage of the map box.
                    const lat = (r.locationLat as number) / 1_000_000;
                    const long = (r.locationLong as number) / 1_000_000;
                    const x = ((long + 180) / 360) * 100;
                    const y = ((90 - lat) / 180) * 100;
                    const color = r.status === "active" ? "var(--ok)"
                        : r.status === "suspended" ? "var(--danger)" : "var(--text-dim)";
                    return (
                        <div
                            key={r._id}
                            className="map-pin"
                            style={{ left: `${x}%`, top: `${y}%`, background: color, boxShadow: `0 0 10px ${color}` }}
                            title={`${r.routerId} — ${r.status} (score ${r.uptimeScore})`}
                        />
                    );
                })}
            </div>
            <div style={{ display: "flex", gap: 16, marginTop: 12, fontSize: 12, color: "var(--text-dim)" }}>
                <span><span className="map-pin" style={{ position: "static", display: "inline-block", background: "var(--ok)", transform: "none", marginRight: 5 }} />Active</span>
                <span><span className="map-pin" style={{ position: "static", display: "inline-block", background: "var(--danger)", transform: "none", marginRight: 5 }} />Suspended</span>
                <span><span className="map-pin" style={{ position: "static", display: "inline-block", background: "var(--text-dim)", transform: "none", marginRight: 5 }} />Other</span>
            </div>
        </div>
    );
}
