# RouterPulse Dashboard

Next.js 15 (App Router) dashboard over the [API](../api/README.md).
Phase 6 of the [roadmap](../docs/PHASES.md); the wallet layer was added
after Phase 9.

## Pages

| Route | What it shows |
|---|---|
| `/` | Network overview — fleet stats, token supply/burn/slash totals, router map, live event feed |
| `/routers` | Filterable router table with uptime meters and stake |
| `/routers/[pda]` | One router: owner/device identity, heartbeat history, per-epoch reward & slash breakdown |
| `/operator` | The connected wallet's routers, plus an admin audit panel for the protocol authority |
| `/analytics` | Fleet composition, regional breakdown, recently finalized epochs |
| `/explorer` | Raw decoded event log, filterable by event type |

## Wallet + Sign-In-With-Solana

`/operator` is the one wallet-aware page. Connecting is enough to see
the routers a wallet owns (that's public data); **signing in** proves
control of the wallet and unlocks the admin panel.

The handshake is: request a nonce → wallet signs it → trade the
signature for a session JWT. The wallet signs a *message*, never a
transaction, so signing in costs nothing and moves no funds. The nonce
is single-use and expires in five minutes.

The admin panel is gated by whether the API returns 200 or 403 — and
the API decides that by comparing the session wallet against the
authority address currently stored **on-chain**, not a role in a
database. If the real authority rotates, access follows on the next
reconciliation pass with nothing to change here.

The connection this provider holds is used only for signing; every
*read* on every page still goes through the API's indexed projection.

## Server Components by default

Every page that can be a Server Component is one: it fetches from the
API on the server and ships HTML. Only two things are client-side, and
both have a reason — `LiveFeed` needs a persistent socket, and
`/operator` is scoped to a wallet the server has no knowledge of.

That shows up in the build output:

```
/                13.9 kB   ← Socket.IO client for the live feed
/operator        3.9 kB    ← wallet adapter + SIWS
/routers          168 B
/routers/[pda]    168 B
/analytics        168 B
/explorer         123 B
```

The read-only pages cost essentially nothing. Making the whole tree
`"use client"` would have shipped Socket.IO *and* the wallet adapter to
every route for nothing.

The live feed is also **seeded server-side** with recent events, so it
renders populated on first paint instead of sitting empty until
something happens on-chain — which on a quiet network could be minutes.

## Notes worth knowing

- **Token amounts are never parsed to `Number`.** They're base-unit
  strings with 9 decimals that routinely exceed
  `Number.MAX_SAFE_INTEGER`; `formatTokens` in `src/lib/api.ts` formats
  them with `BigInt` only. Passing one through `parseFloat` to display
  it would silently corrupt the value.
- **`cache: "no-store"` on every fetch.** This is live operational data
  the indexer is actively rewriting — a cached router list showing
  "active" for a router that just got suspended is worse than a
  slightly slower page.
- **The live feed de-dupes on event id.** A socket reconnect can
  redeliver events, so arrival order alone isn't trusted.
- **The map is hand-rolled**, not MapLibre. A simple equirectangular
  projection of the fixed-point lat/long already stored on each router —
  no tile provider, no API key, no network call, so the dashboard works
  fully offline. A production build would swap in real tiles.
- **No wallet adapter yet.** The API's Sign-In-With-Solana flow is built
  and tested (see `api/README.md`), but this dashboard is currently
  read-only and doesn't connect a wallet, so the authenticated admin
  view isn't wired up here. That's the honest next step for this app.

## Running

Needs the API (`api/`, port 3001) running, which needs MongoDB, Redis,
and the indexer.

```bash
cp .env.example .env     # NEXT_PUBLIC_API_URL, defaults to localhost:3001
npm install
npm run dev              # http://localhost:3000
npm run build && npm start   # production build
```
