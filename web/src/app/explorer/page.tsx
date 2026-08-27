import { api, shortAddress } from "@/lib/api";
import { ApiOffline } from "@/components/ui";

const EVENT_TYPES = [
    "HeartbeatReceived", "RouterRegistered", "CollateralStaked",
    "RouterEpochFinalized", "RewardClaimed", "VestedRewardClaimed", "RouterSlashed",
];

// Next 15 made `searchParams` and `params` async — they're Promises now,
// so every page that reads them has to await first.
export default async function ExplorerPage({
    searchParams,
}: {
    searchParams: Promise<{ name?: string }>;
}) {
    const { name } = await searchParams;
    const page = await api.events(60, name);

    if (!page) {
        return (
            <>
                <h1 className="page-title">Explorer</h1>
                <ApiOffline />
            </>
        );
    }

    return (
        <>
            <h1 className="page-title">Explorer</h1>
            <p className="page-sub">
                Every decoded program event, newest first — the append-only audit log the
                indexer builds directly from on-chain transaction logs.
            </p>

            <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
                <a
                    href="/explorer"
                    className={`badge ${!name ? "badge-active" : "badge-inactive"}`}
                    style={{ padding: "4px 12px" }}
                >
                    all
                </a>
                {EVENT_TYPES.map(t => (
                    <a
                        key={t}
                        href={`/explorer?name=${t}`}
                        className={`badge ${name === t ? "badge-active" : "badge-inactive"}`}
                        style={{ padding: "4px 12px", textTransform: "none" }}
                    >
                        {t}
                    </a>
                ))}
            </div>

            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <table>
                    <thead>
                        <tr>
                            <th>Event</th><th>Subject</th><th>Slot</th>
                            <th>Signature</th><th>Time</th>
                        </tr>
                    </thead>
                    <tbody>
                        {page.items.length === 0 && (
                            <tr><td colSpan={5} className="empty">No events match this filter.</td></tr>
                        )}
                        {page.items.map(ev => (
                            <tr key={ev._id}>
                                <td style={{ fontWeight: 600, color: "var(--accent)" }}>{ev.name}</td>
                                <td className="mono">
                                    {ev.data?.router_id ?? shortAddress(ev.data?.router ?? ev.data?.owner ?? ev.data?.recipient)}
                                </td>
                                <td className="mono" style={{ color: "var(--text-dim)" }}>{ev.slot}</td>
                                <td className="mono" style={{ color: "var(--text-dim)" }}>{shortAddress(ev.signature, 6)}</td>
                                <td style={{ color: "var(--text-dim)", fontSize: 12.5 }}>
                                    {ev.blockTime ? new Date(ev.blockTime * 1000).toLocaleTimeString() : "—"}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </>
    );
}
