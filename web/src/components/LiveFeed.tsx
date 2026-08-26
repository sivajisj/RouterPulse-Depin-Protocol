"use client";

import { useEffect, useState } from "react";
import { io, Socket } from "socket.io-client";
import { API_URL, EventDoc, shortAddress } from "@/lib/api";

/// The one genuinely interactive part of the dashboard: subscribes to
/// the API's Socket.IO gateway and prepends events as they're indexed.
///
/// Seeded from the server with the most recent events so the panel is
/// populated on first paint rather than empty until something happens
/// on-chain — which, on a quiet network, could be a long time.
export function LiveFeed({ initial }: { initial: EventDoc[] }) {
    const [events, setEvents] = useState<EventDoc[]>(initial);
    const [connected, setConnected] = useState(false);

    useEffect(() => {
        const socket: Socket = io(API_URL, { transports: ["websocket"] });

        socket.on("connect", () => setConnected(true));
        socket.on("disconnect", () => setConnected(false));
        socket.on("connect_error", () => setConnected(false));

        socket.on("event", (ev: EventDoc) => {
            setEvents(prev => {
                // The same event can arrive twice if the socket
                // reconnects and the indexer republishes — de-dupe on the
                // event's own id rather than trusting arrival order.
                if (prev.some(e => e._id === ev._id)) return prev;
                return [ev, ...prev].slice(0, 50);
            });
        });

        return () => { socket.close(); };
    }, []);

    return (
        <div className="card">
            <div className="card-title" style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Live Activity</span>
                <span style={{ textTransform: "none", letterSpacing: 0 }}>
                    {connected
                        ? <><span className="live-dot" />streaming</>
                        : <span style={{ color: "var(--text-dim)" }}>offline</span>}
                </span>
            </div>
            <div className="feed">
                {events.length === 0 && <div className="empty">No events yet.</div>}
                {events.map(ev => (
                    <div key={ev._id} className="feed-row">
                        <span className="feed-name">{ev.name}</span>
                        <span className="feed-meta mono">
                            {ev.data?.router_id ?? shortAddress(ev.data?.router ?? ev.data?.owner)}
                        </span>
                        <span className="feed-meta" style={{ marginLeft: "auto" }}>
                            slot {ev.slot}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}
