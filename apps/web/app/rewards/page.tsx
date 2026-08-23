import AppShell from "@/components/AppShell";

export default function RewardsPage() {
  return (
    <AppShell>
      <h1 className="mb-6 text-xl font-medium">Rewards</h1>
      <div className="rounded-lg border border-border bg-panel p-8 text-center text-sm text-gray-400">
        No claimable epochs yet. This wires up to{" "}
        <code className="text-gray-300">GET /v1/rewards</code> and the Reward PDA claim
        instruction once Step 6 (SPL rewards) ships.
      </div>
    </AppShell>
  );
}
