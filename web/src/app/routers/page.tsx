import Link from "next/link";
import { api, formatTokens, shortAddress, timeAgo } from "@/lib/api";
import { StatusBadge, ScoreMeter, ApiOffline } from "@/components/ui";

export default async function RoutersPage({
    searchParams,
}: {
    searchParams: { status?: string };
}) {
    const qs = searchParams.status ? `?limit=100&status=${searchParams.status}` : "?limit=100";
    const page = await api.routers(qs);

    if (!page) {
        return (
            <>
                <h1 className="page-title">Routers</h1>
                <ApiOffline />
            </>
        );
    }

    const filters = ["all", "active", "suspended", "inactive"];

    return (
        <>
            <h1 className="page-title">Routers</h1>
            <p className="page-sub">Every router indexed from on-chain registration and heartbeat events.</p>

            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                {filters.map(f => {
                    const active = f === "all" ? !searchParams.status : searchParams.status === f;
                    return (
                        <Link
                            key={f}
                            href={f === "all" ? "/routers" : `/routers?status=${f}`}
                            className={`badge ${active ? "badge-active" : "badge-inactive"}`}
                            style={{ padding: "4px 12px" }}
                        >
                            {f}
                        </Link>
                    );
                })}
            </div>

            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <table>
                    <thead>
                        <tr>
                            <th>Router</th>
                            <th>Status</th>
                            <th>Uptime Score</th>
                            <th>Staked</th>
                            <th>Heartbeats</th>
                            <th>Last Seen</th>
                            <th>Owner</th>
                        </tr>
                    </thead>
                    <tbody>
                        {page.items.length === 0 && (
                            <tr><td colSpan={7} className="empty">No routers match this filter.</td></tr>
                        )}
                        {page.items.map(r => (
                            <tr key={r._id}>
                                <td>
                                    <Link href={`/routers/${r._id}`} style={{ color: "var(--accent)", fontWeight: 600 }}>
                                        {r.routerId}
                                    </Link>
                                </td>
                                <td><StatusBadge status={r.status} /></td>
                                <td><ScoreMeter score={r.uptimeScore ?? 0} /></td>
                                <td className="mono">{formatTokens(r.stakedAmount)}</td>
                                <td className="mono">{r.heartbeatCount ?? 0}</td>
                                <td style={{ color: "var(--text-dim)" }}>{timeAgo(r.lastHeartbeat)}</td>
                                <td className="mono" style={{ color: "var(--text-dim)" }}>{shortAddress(r.owner)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </>
    );
}
