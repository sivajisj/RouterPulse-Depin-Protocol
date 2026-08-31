"use client";

import { useState } from "react";
import { Keypair, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import { useWallet } from "@solana/wallet-adapter-react";
import { useProgram, protocolPda, routerPda, BN } from "@/lib/useProgram";
import { useTx } from "@/lib/useTx";
import { TxStatus } from "./TxStatus";

/// Registers a router and, in the same step, mints it a *device
/// identity* — a keypair distinct from the operator's wallet.
///
/// The device key is generated in the browser and shown exactly once,
/// to be copied onto the physical router. It is deliberately never
/// persisted here: this app has no business holding it, and the whole
/// point of the split is that a compromised device can only send
/// heartbeats, never move funds. Losing it is recoverable by the owner
/// via `rotate_device_key` without re-registering the router.
export function RegisterRouter({ onRegistered }: { onRegistered?: () => void }) {
    const { publicKey } = useWallet();
    const program = useProgram();
    const { state, run, reset, busy } = useTx();

    const [routerId, setRouterId] = useState("");
    const [lat, setLat] = useState("19.0760");
    const [long, setLong] = useState("72.8777");
    const [device, setDevice] = useState<Keypair | null>(null);
    const [revealed, setRevealed] = useState(false);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!program || !publicKey) return;

        const deviceKp = Keypair.generate();
        const router = routerPda(publicKey, routerId);

        // Coordinates are stored as fixed-point integers (degrees ×
        // 1e6) because Solana's BPF target has no floating point.
        const latFixed  = Math.round(parseFloat(lat) * 1_000_000);
        const longFixed = Math.round(parseFloat(long) * 1_000_000);

        const sig = await run(
            () => program.methods
                .registerRouter(routerId, new BN(latFixed), new BN(longFixed), deviceKp.publicKey)
                .accountsPartial({
                    router,
                    protocol: protocolPda(),
                    owner: publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .rpc(),
            async () => { onRegistered?.(); },
        );

        if (sig) { setDevice(deviceKp); setRevealed(false); }
    };

    if (device) {
        return (
            <div className="card">
                <div className="card-title">Router registered — save the device key now</div>
                <p style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 12 }}>
                    This key is what the physical router uses to sign heartbeats. It is shown
                    once and is <strong>not stored anywhere by this dashboard</strong>. Copy it
                    onto the device now. If you lose it, you can issue a new one with
                    <code> rotate_device_key</code> — the router stays registered.
                </p>
                <div className="kv"><span>Device public key</span><span className="mono">{device.publicKey.toBase58()}</span></div>
                <div style={{ marginTop: 10 }}>
                    {revealed ? (
                        <textarea
                            readOnly
                            className="secret-box"
                            value={bs58.encode(device.secretKey)}
                            onFocus={e => e.currentTarget.select()}
                        />
                    ) : (
                        <button className="btn-primary" onClick={() => setRevealed(true)}>
                            Reveal device secret key
                        </button>
                    )}
                </div>
                <button
                    className="link-btn"
                    style={{ marginTop: 12 }}
                    onClick={() => { setDevice(null); reset(); setRouterId(""); }}
                >
                    Done — register another
                </button>
            </div>
        );
    }

    return (
        <form className="card" onSubmit={submit}>
            <div className="card-title">Register a router</div>
            <div className="form-row">
                <label>
                    Router ID
                    <input
                        value={routerId}
                        onChange={e => setRouterId(e.target.value)}
                        placeholder="router-mumbai-002"
                        maxLength={32}
                        required
                    />
                </label>
                <label>
                    Latitude
                    <input value={lat} onChange={e => setLat(e.target.value)} required />
                </label>
                <label>
                    Longitude
                    <input value={long} onChange={e => setLong(e.target.value)} required />
                </label>
            </div>
            <button className="btn-primary" disabled={busy || !program || !routerId}>
                {busy ? "Working…" : "Register router"}
            </button>
            <TxStatus state={state} />
        </form>
    );
}
