import AppShell from "@/components/AppShell";

export default function DevicesPage() {
  return (
    <AppShell>
      <h1 className="mb-6 text-xl font-medium">Devices</h1>
      <div className="rounded-lg border border-border bg-panel p-8 text-center text-sm text-gray-400">
        No devices registered yet. This table wires up to{" "}
        <code className="text-gray-300">GET /v1/devices</code> once the Axum backend
        exists (Step 2).
      </div>
    </AppShell>
  );
}
