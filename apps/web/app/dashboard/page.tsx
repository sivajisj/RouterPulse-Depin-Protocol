import AppShell from "@/components/AppShell";

// TEMP: hardcoded. Step 2 replaces this with a fetch to
// GET /v1/network/overview on the Axum backend.
const METRICS = [
  { label: "Online devices", value: "0 / 0" },
  { label: "Network availability", value: "—" },
  { label: "Median latency", value: "—" },
  { label: "Epoch rewards", value: "—" },
];

export default function DashboardPage() {
  return (
    <AppShell>
      <h1 className="mb-6 text-xl font-medium">Overview</h1>
      <div className="grid grid-cols-4 gap-3">
        {METRICS.map((m) => (
          <div key={m.label} className="rounded-lg border border-border bg-panel p-4">
            <p className="text-xs text-gray-400">{m.label}</p>
            <p className="mt-1 text-2xl font-medium">{m.value}</p>
          </div>
        ))}
      </div>
      <p className="mt-8 text-sm text-gray-500">
        No devices enrolled yet. Device enrollment ships in Step 4 (Rust agent).
      </p>
    </AppShell>
  );
}
