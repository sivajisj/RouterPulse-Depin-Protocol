import Link from "next/link";
import { notFound } from "next/navigation";
import { api, formatTokens, formatBps, shortAddress, timeAgo } from "@/lib/api";
import { Stat, StatusBadge, ScoreMeter } from "@/components/ui";

export default async function RouterDetailPage({ params }: { params: { pda: string } }) {
    const [router, epochs] = await Promise.all([
        api.router(params.pda),
        api.routerEpochs(params.pda),
    ]);

    if (!router) notFound();

    return (
        <>
            <Link href="/routers" className="back-link">← All routers</Link>
            <h1 className="page-title">{router.routerId}</h1>
            <p className="page-sub mono">{router._id}</p>

            <div className="grid grid-4" style={{ marginBottom: 14 }}>
                <Stat label="Status" value={<StatusBadge status={router.status} />} />
                <Stat label="Uptime Score" value={<ScoreMeter score={router.uptimeScore ?? 0} />} sub="drives auto-suspension" />
                <Stat label="Staked" value={formatTokens(router.stakedAmount)} sub="RPT collateral at risk" />
                <Stat label="Lifetime Rewards" value={formatTokens(router.totalRewards)} sub="granted across all epochs" />
            </div>

            <div className="grid grid-2">
                <div className="card">
                    <div className="card-title">Identity & History</div>
                    <dl className="kv">
                        <dt>Owner</dt>
                        <dd className="mono">{router.owner}</dd>
                        <dt>Device key</dt>
                        <dd className="mono">{router.devicePubkey}</dd>
                        <dt>Key version</dt>
                        <dd>
                            v{router.deviceKeyVersion ?? 0}
                            {(router.deviceKeyVersion ?? 0) > 0 && (
                                <span style={{ color: "var(--text-dim)" }}> (rotated {router.deviceKeyVersion}×)</span>
                            )}
                        </dd>
                        <dt>Heartbeats</dt>
                        <dd>{router.heartbeatCount ?? 0} received, {router.missedHeartbeats ?? 0} missed</dd>
                        <dt>Last heartbeat</dt>
                        <dd>{timeAgo(router.lastHeartbeat)}</dd>
                        <dt>Registered</dt>
                        <dd>{timeAgo(router.registeredAt)}</dd>
                        <dt>Penalties</dt>
                        <dd>{formatTokens(router.totalPenalties)} slashed lifetime</dd>
                    </dl>
                    <p style={{ marginTop: 14, fontSize: 12.5, color: "var(--text-dim)" }}>
                        The device key signs heartbeats; the owner wallet holds funds. They are
                        deliberately separate, so a compromised router can never move tokens.
                    </p>
                </div>

                <div className="card" style={{ padding: 0 }}>
                    <div className="card-title" style={{ padding: "16px 16px 0" }}>Epoch History</div>
                    <table>
                        <thead>
                            <tr>
                                <th>Epoch</th>
                                <th>Uptime</th>
                                <th>Multiplier</th>
                                <th>Reward</th>
                                <th>Slash</th>
                                <th>State</th>
                            </tr>
                        </thead>
                        <tbody>
                            {(epochs?.items ?? []).length === 0 && (
                                <tr><td colSpan={6} className="empty">No finalized epochs yet.</td></tr>
                            )}
                            {(epochs?.items ?? []).map(e => (
                                <tr key={e._id}>
                                    <td className="mono">{e.epochNumber}</td>
                                    <td>{formatBps(e.uptimeBps)}</td>
                                    <td style={{ color: "var(--text-dim)" }}>{formatBps(e.rewardMultiplierBps)}</td>
                                    <td className="mono">{formatTokens(e.rewardAmount)}</td>
                                    <td className="mono" style={{ color: e.slashAmount && e.slashAmount !== "0" ? "var(--danger)" : "var(--text-dim)" }}>
                                        {formatTokens(e.slashAmount)}
                                    </td>
                                    <td style={{ fontSize: 12, color: "var(--text-dim)" }}>
                                        {e.slashed ? "slashed " : ""}
                                        {e.claimed ? "claimed" : e.finalized ? "finalized" : "open"}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </>
    );
}
