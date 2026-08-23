import ConnectWalletButton from "@/components/ConnectWalletButton";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-[#0a0b0d] text-white">
      <div className="text-center">
        <p className="text-lg font-medium">RouterPulse</p>
        <p className="mt-1 text-sm text-gray-400">
          Sign in by proving ownership of your operator wallet.
        </p>
      </div>
      <ConnectWalletButton />
    </div>
  );
}
