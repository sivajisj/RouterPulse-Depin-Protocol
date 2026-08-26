# RouterPulse API

NestJS REST + WebSocket API over the [indexer's](../indexer/README.md)
MongoDB projection. Phase 4 of the [roadmap](../docs/PHASES.md).

Interactive OpenAPI docs are served at **`/api/docs`** once running.

## Where this sits

```
Solana ──▶ indexer ──▶ MongoDB ──▶  THIS API  ──▶ dashboard / clients
              │                        ▲
              └──▶ Redis pub/sub ──────┘  (WebSocket fanout)
```

This service is **read-only against MongoDB**. It never writes to the
indexer's collections — the indexer's idempotency guarantees only hold
while it's the sole writer. It also never talks to Solana directly:
anything needing chain state reads the indexer's reconciled projection,
and anything needing to *change* chain state is a transaction the user's
own wallet signs client-side. There is deliberately no server-side
keypair here, so this API has no custody of anything and cannot move
anyone's funds even if fully compromised.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Liveness + MongoDB/Redis dependency check |
| GET | `/api/v1/protocol` | Global config + cumulative stats (reconciled from chain) |
| GET | `/api/v1/protocol/epochs/current` | Current epoch number + seconds remaining |
| GET | `/api/v1/routers` | Cursor-paginated, filter by `status` / `owner` |
| GET | `/api/v1/routers/:routerPda` | One router's indexed state (404 if unknown) |
| GET | `/api/v1/routers/:routerPda/epochs` | That router's epoch history, newest first |
| GET | `/api/v1/routers/:routerPda/heartbeats` | Recent raw heartbeat events |
| GET | `/api/v1/analytics/network` | Router counts by status, avg uptime, total staked |
| GET | `/api/v1/analytics/regions` | Grouped by coarse lat/long, for a map view |
| GET | `/api/v1/analytics/epochs` | Recently finalized epochs across all routers |
| GET | `/api/v1/events` | Decoded event feed, newest first, filter by `name` |
| GET | `/api/v1/transactions/:signature` | One transaction + every event it emitted |
| GET | `/api/v1/admin/audit` | **Auth + RBAC required** — governance-relevant events |

WebSocket: connect with Socket.IO and listen for `event` messages —
each is one newly-indexed decoded event, fanned out from Redis.

## Auth: Sign-In-With-Solana

No passwords, no custody. Prove control of a wallet by signing a
server-issued single-use nonce:

```bash
# 1. request a challenge
curl "localhost:3001/api/v1/auth/challenge?wallet=<PUBKEY>"

# 2. sign the returned `message` with the wallet, then exchange it for a JWT
curl -X POST localhost:3001/api/v1/auth/verify \
  -H 'content-type: application/json' \
  -d '{"wallet":"<PUBKEY>","signature":"<BASE58_SIGNATURE>"}'

# 3. use it
curl localhost:3001/api/v1/admin/audit -H "Authorization: Bearer <TOKEN>"
```

The challenge is stored in Redis with a 5-minute TTL and **deleted on
first successful use**, so a captured signature can't mint a second
session. Verified with `tweetnacl` against the wallet's own public key.

### RBAC is bound to on-chain state, not a local role table

`ProtocolAuthorityGuard` checks the session wallet against whatever
address is *currently* the protocol's on-chain `authority` (as
reconciled by the indexer). If the real authority rotates — a multisig
migration, an emergency key change — access follows automatically, with
nothing to update in this service and no stale admin row to forget
about.

## Design notes worth knowing

- **Cursor pagination, never skip/limit.** `skip` degrades on large
  collections *and* silently drifts when rows are inserted between
  pages — which happens constantly here, since the indexer writes
  concurrently with API reads. Cursors are opaque base64 values so
  clients don't construct them by hand.
- **The event feed cursors on `blockTime`, not `_id`.** `_id` is
  `signature:index`, and base58 signatures don't sort chronologically —
  cursoring on `_id` would have produced a "newest first" feed in an
  arbitrary order. There's a test asserting the ordering specifically
  because this is easy to get subtly wrong and never notice.
- **Token amounts stay strings.** Aggregations sum via `$toDecimal`
  (Decimal128) rather than a plain `$sum` on the string field, which
  Mongo would coerce to a float and silently lose precision on — on
  exactly the numbers this project treats as money.
- **Rate limiting is a global guard**, so a newly added endpoint is
  protected by default rather than by remembering to decorate it.

## Running

```bash
cp .env.example .env     # point MONGO_URL/REDIS_URL at your instances
npm install
npm start                # http://localhost:3001, docs at /api/docs
npm test                 # end-to-end tests against the real stack
```

The test suite (`test/run.ts`) runs against real MongoDB, real Redis,
and a real HTTP server on an ephemeral port — no mocks. It needs the
indexer to have populated at least one router first.
