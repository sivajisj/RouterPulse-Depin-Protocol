import Link from "next/link";
import { api, formatTokens, formatBps, shortAddress } from "@/lib/api";
import { Stat, ApiOffline } from "@/components/ui";

export default async function AnalyticsPage() {
    const [network, regions, epochs] = await Promise.all([
        api.network(),
        api.regions(),
        api.recentEpochs(25),
    ]);

    if (!network) {
        return (
            <>
                <h1 className="page-title">Analytics</h1>
                <ApiOffline />
            </>
        );
    }

    const statuses = Object.entries(network.byStatus ?? {});
    const total = network.totalRouters || 1;

    return (
        <>
            <h1 className="page-title">Analytics</h1>
            <p className="page-sub">Aggregated from the indexed projection of on-chain state.</p>

            <div className="grid grid-4" style={{ marginBottom: 14 }}>
                <Stat label="Routers" value={network.totalRouters} />
                <Stat label="Avg Score" value={Math.round(network.averageUptimeScore ?? 0)} />
                <Stat label="Staked" value={formatTokens(network.totalStakedIndexed)} />
                <Stat label="Heartbeats" value={(network.totalHeartbeatsRecorded ?? 0).toLocaleString()} />
            </div>

            <div className="grid grid-2" style={{ marginBottom: 14 }}>
                <div className="card">
                    <div className="card-title">Fleet Composition</div>
                    {statuses.length === 0 && <div className="empty">No routers indexed.</div>}
                    {statuses.map(([status, count]) => {
                        const pct = ((count as number) / total) * 100;
                        const color = status === "active" ? "var(--ok)"
                            : status === "suspended" ? "var(--danger)" : "var(--text-dim)";
                        return (
                            <div key={status} style={{ marginBottom: 12 }}>
                                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 13 }}>
                                    <span style={{ textTransform: "capitalize" }}>{status}</span>
                                    <span style={{ color: "var(--text-dim)" }}>{count as number} ({pct.toFixed(0)}%)</span>
                                </div>
                                <div className="meter">
                                    <div className="meter-fill" style={{ width: `${pct}%`, background: color }} />
                                </div>
                            </div>
                        );
                    })}
                </div>

                <div className="card" style={{ padding: 0 }}>
                    <div className="card-title" style={{ padding: "16px 16px 0" }}>By Region</div>
                    <table>
                        <thead>
                            <tr><th>Lat / Long</th><th>Routers</th><th>Avg Score</th></tr>
                        </thead>
                        <tbody>
                            {(regions ?? []).length === 0 && (
                                <tr><td colSpan={3} className="empty">No location data.</td></tr>
                            )}
                            {(regions ?? []).map((r: any, i: number) => (
                                <tr key={i}>
                                    <td className="mono">{r._id?.lat}°, {r._id?.long}°</td>
                                    <td>{r.routerCount}</td>
                                    <td>{Math.round(r.avgUptimeScore ?? 0)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            <div className="card" style={{ padding: 0 }}>
                <div className="card-title" style={{ padding: "16px 16px 0" }}>Recently Finalized Epochs</div>
                <table>
                    <thead>
                        <tr>
                            <th>Router</th><th>Epoch</th><th>Uptime</th>
                            <th>Multiplier</th><th>Reward</th><th>Slash</th>
                        </tr>
                    </thead>
                    <tbody>
                        {(epochs ?? []).length === 0 && (
                            <tr><td colSpan={6} className="empty">No epochs finalized yet.</td></tr>
                        )}
                        {(epochs ?? []).map(e => (
                            <tr key={e._id}>
                                <td>
                                    <Link href={`/routers/${e.router}`} className="mono" style={{ color: "var(--accent)" }}>
                                        {shortAddress(e.router, 6)}
                                    </Link>
                                </td>
                                <td className="mono">{e.epochNumber}</td>
                                <td>{formatBps(e.uptimeBps)}</td>
                                <td style={{ color: "var(--text-dim)" }}>{formatBps(e.rewardMultiplierBps)}</td>
                                <td className="mono">{formatTokens(e.rewardAmount)}</td>
                                <td className="mono" style={{ color: e.slashAmount && e.slashAmount !== "0" ? "var(--danger)" : "var(--text-dim)" }}>
                                    {formatTokens(e.slashAmount)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </>
    );
}
