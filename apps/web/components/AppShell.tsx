import Sidebar from "@/components/Sidebar";

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-[#0a0b0d] text-white">
      <Sidebar />
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
