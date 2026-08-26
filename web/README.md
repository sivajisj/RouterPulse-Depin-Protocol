# RouterPulse Dashboard

Next.js 14 (App Router) dashboard over the [API](../api/README.md).
Phase 6 of the [roadmap](../docs/PHASES.md).

## Pages

| Route | What it shows |
|---|---|
| `/` | Network overview — fleet stats, token supply/burn/slash totals, router map, live event feed |
| `/routers` | Filterable router table with uptime meters and stake |
| `/routers/[pda]` | One router: owner/device identity, heartbeat history, per-epoch reward & slash breakdown |
| `/analytics` | Fleet composition, regional breakdown, recently finalized epochs |
| `/explorer` | Raw decoded event log, filterable by event type |

## Server Components by default

Every page is a Server Component that fetches from the API on the
server and ships HTML. The **only** Client Component that matters is
`LiveFeed` — it's the one piece that genuinely needs a persistent
connection, so it's the one piece that gets client JS.

That shows up in the build output: the dashboard is ~13.6 kB of route
JS (the Socket.IO client), while `/routers`, `/analytics`, `/explorer`
and `/routers/[pda]` are ~180 B each. Making the whole tree
`"use client"` would have shipped Socket.IO to every route for nothing.

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
