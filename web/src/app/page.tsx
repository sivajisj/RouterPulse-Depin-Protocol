import { api, formatTokens, shortAddress } from "@/lib/api";
import { Stat, ApiOffline, RouterMap } from "@/components/ui";
import { LiveFeed } from "@/components/LiveFeed";

// Server Component: everything below is fetched on the server and sent
// as HTML. Only <LiveFeed> ships JS to the browser, because only it
// actually needs a persistent connection.
export default async function DashboardPage() {
    const [network, protocol, epoch, routersPage, events] = await Promise.all([
        api.network(),
        api.protocol(),
        api.currentEpoch(),
        api.routers("?limit=100"),
        api.events(20),
    ]);

    if (!network || !protocol) {
        return (
            <>
                <h1 className="page-title">Network Overview</h1>
                <ApiOffline />
            </>
        );
    }

    const routers = routersPage?.items ?? [];
    const active = network.byStatus?.active ?? 0;

    return (
        <>
            <h1 className="page-title">Network Overview</h1>
            <p className="page-sub">
                Live state of the RouterPulse DePIN network, indexed from Solana.
                {epoch && <> Currently in epoch <strong>{epoch.epochNumber}</strong>, {epoch.secondsRemaining}s remaining.</>}
            </p>

            <div className="grid grid-4" style={{ marginBottom: 14 }}>
                <Stat label="Routers" value={network.totalRouters} sub={`${active} active`} />
                <Stat label="Avg Uptime Score" value={Math.round(network.averageUptimeScore ?? 0)} sub="0–100, drives suspension" />
                <Stat label="Total Staked" value={formatTokens(network.totalStakedIndexed)} sub="RPT collateral" />
                <Stat label="Heartbeats" value={(network.totalHeartbeatsRecorded ?? 0).toLocaleString()} sub="lifetime, all routers" />
            </div>

            <div className="grid grid-4" style={{ marginBottom: 14 }}>
                <Stat label="Total Minted" value={formatTokens(protocol.totalMinted)} sub="genesis + vested rewards" />
                <Stat label="Total Burned" value={formatTokens(protocol.totalBurned)} sub="slashed collateral destroyed" />
                <Stat label="Total Slashed" value={formatTokens(protocol.totalSlashed)} sub="penalties enforced" />
                <Stat
                    label="Protocol Status"
                    value={protocol.isPaused
                        ? <span style={{ color: "var(--danger)" }}>Paused</span>
                        : <span style={{ color: "var(--ok)" }}>Live</span>}
                    sub={`authority ${shortAddress(protocol.authority)}`}
                />
            </div>

            <div className="grid grid-2">
                <RouterMap routers={routers} />
                <LiveFeed initial={events?.items ?? []} />
            </div>
        </>
    );
}
