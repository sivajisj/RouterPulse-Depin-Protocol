"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSession, authedFetch } from "@/lib/useSession";
import { RegisterRouter } from "@/components/RegisterRouter";
import { RouterActions } from "@/components/RouterActions";
import {
    API_URL, RouterDoc, EpochDoc, Page, EventDoc,
    formatTokens, shortAddress, timeAgo,
} from "@/lib/api";

/// The operator view: what the *connected wallet* owns, plus an admin
/// panel that only renders for the on-chain protocol authority.
///
/// A Client Component rather than a Server Component because everything
/// here is scoped to a wallet the server doesn't know about — the
/// connection lives entirely in the browser.
export default function OperatorPage() {
    const { wallet, session, isAuthenticated } = useSession();
    const [routers, setRouters] = useState<RouterDoc[] | null>(null);
    const [audit, setAudit] = useState<EventDoc[] | null>(null);
    const [adminStatus, setAdminStatus] = useState<number | null>(null);
    const [loading, setLoading] = useState(false);
    const [selected, setSelected] = useState<string | null>(null);
    const [epochs, setEpochs] = useState<EpochDoc[]>([]);
    const [refreshKey, setRefreshKey] = useState(0);

    // Bumped after any successful transaction. The indexer needs a
    // moment to observe and project the event, so this re-fetches on a
    // short delay rather than immediately — reading back too fast would
    // show pre-transaction state and look like the action failed.
    const refresh = () => setTimeout(() => setRefreshKey(k => k + 1), 1500);

    // Owned routers are public data — no session needed, just a wallet.
    useEffect(() => {
        if (!wallet) { setRouters(null); return; }
        setLoading(true);
        fetch(`${API_URL}/api/v1/routers?owner=${wallet}&limit=100`)
            .then(r => r.json())
            .then((p: Page<RouterDoc>) => setRouters(p.items ?? []))
            .catch(() => setRouters([]))
            .finally(() => setLoading(false));
    }, [wallet, refreshKey]);

    // Epoch history for whichever router the operator has expanded.
    useEffect(() => {
        if (!selected) { setEpochs([]); return; }
        fetch(`${API_URL}/api/v1/routers/${selected}/epochs?limit=50`)
            .then(r => r.json())
            .then((p: Page<EpochDoc>) => setEpochs(p.items ?? []))
            .catch(() => setEpochs([]));
    }, [selected, refreshKey]);

    // The admin probe is the interesting part: the API decides whether
    // this wallet is the authority by comparing against live on-chain
    // state, so the UI just asks and reacts to 200 vs 403.
    useEffect(() => {
        if (!isAuthenticated || !session) { setAudit(null); setAdminStatus(null); return; }
        authedFetch<EventDoc[]>("/api/v1/admin/audit?limit=20", session.accessToken)
            .then(({ ok, status, data }) => {
                setAdminStatus(status);
                setAudit(ok && Array.isArray(data) ? data : null);
            })
            .catch(() => setAdminStatus(0));
    }, [isAuthenticated, session]);

    if (!wallet) {
        return (
            <>
                <h1 className="page-title">Operator</h1>
                <p className="page-sub">Your routers, rewards, and — if you hold the authority key — the admin panel.</p>
                <div className="notice">
                    Connect a wallet using the button in the top right to see the routers it owns.
                </div>
            </>
        );
    }

    return (
        <>
            <h1 className="page-title">Operator</h1>
            <p className="page-sub mono">{wallet}</p>

            {!isAuthenticated && (
                <div className="notice">
                    Wallet connected. <strong>Sign in with Solana</strong> to prove you control it —
                    that unlocks the admin panel if this wallet is the protocol authority.
                    Signing is a message, not a transaction: it costs nothing and moves no funds.
                </div>
            )}

            <div className="card" style={{ padding: 0, marginBottom: 14 }}>
                <div className="card-title" style={{ padding: "16px 16px 0" }}>
                    Your Routers {routers && `(${routers.length})`}
                </div>
                <table>
                    <thead>
                        <tr>
                            <th>Router</th><th>Status</th><th>Score</th>
                            <th>Staked</th><th>Rewards</th><th>Last Seen</th><th />
                        </tr>
                    </thead>
                    <tbody>
                        {loading && <tr><td colSpan={7} className="empty">Loading…</td></tr>}
                        {!loading && routers?.length === 0 && (
                            <tr><td colSpan={7} className="empty">
                                This wallet doesn&apos;t own any indexed routers yet.
                            </td></tr>
                        )}
                        {routers?.map(r => (
                            <tr key={r._id}>
                                <td>
                                    <Link href={`/routers/${r._id}`} style={{ color: "var(--accent)", fontWeight: 600 }}>
                                        {r.routerId}
                                    </Link>
                                </td>
                                <td><span className={`badge badge-${r.status}`}>{r.status}</span></td>
                                <td>{r.uptimeScore}</td>
                                <td className="mono">{formatTokens(r.stakedAmount)}</td>
                                <td className="mono">{formatTokens(r.totalRewards)}</td>
                                <td style={{ color: "var(--text-dim)" }}>{timeAgo(r.lastHeartbeat)}</td>
                                <td>
                                    <button
                                        className="link-btn"
                                        onClick={() => setSelected(selected === r._id ? null : r._id)}
                                    >
                                        {selected === r._id ? "hide" : "manage"}
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {selected && routers?.find(r => r._id === selected) && (
                <div style={{ marginBottom: 14 }}>
                    <RouterActions
                        router={routers.find(r => r._id === selected)!}
                        epochs={epochs}
                        onDone={refresh}
                    />
                </div>
            )}

            <div style={{ marginBottom: 14 }}>
                <RegisterRouter onRegistered={refresh} />
            </div>

            {isAuthenticated && (
                <div className="card" style={{ padding: 0 }}>
                    <div className="card-title" style={{ padding: "16px 16px 0" }}>
                        Admin — Governance Audit Log
                    </div>

                    {adminStatus === 403 && (
                        <div style={{ padding: "0 16px 16px", color: "var(--text-dim)", fontSize: 13 }}>
                            This wallet is signed in, but it isn&apos;t the protocol authority, so the API
                            refused with <strong>403</strong>. That check runs against the authority
                            address currently stored on-chain — not a role in a database — so it follows
                            automatically if the authority ever rotates.
                        </div>
                    )}

                    {adminStatus === 200 && audit && (
                        <table>
                            <thead>
                                <tr><th>Event</th><th>Subject</th><th>Amount</th><th>Slot</th></tr>
                            </thead>
                            <tbody>
                                {audit.length === 0 && (
                                    <tr><td colSpan={4} className="empty">No governance events recorded yet.</td></tr>
                                )}
                                {audit.map(ev => (
                                    <tr key={ev._id}>
                                        <td style={{ fontWeight: 600, color: "var(--accent)" }}>{ev.name}</td>
                                        <td className="mono">
                                            {ev.data?.router_id ?? shortAddress(ev.data?.router ?? ev.data?.recipient)}
                                        </td>
                                        <td className="mono">{formatTokens(ev.data?.amount)}</td>
                                        <td className="mono" style={{ color: "var(--text-dim)" }}>{ev.slot}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}

                    {adminStatus !== null && adminStatus !== 200 && adminStatus !== 403 && (
                        <div style={{ padding: "0 16px 16px", color: "var(--text-dim)", fontSize: 13 }}>
                            Couldn&apos;t reach the admin endpoint (status {adminStatus || "network error"}).
                        </div>
                    )}
                </div>
            )}
        </>
    );
}
