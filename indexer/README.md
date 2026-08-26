# RouterPulse Indexer

Event-driven Node/TypeScript service that turns the RouterPulse Anchor
program's on-chain activity into queryable MongoDB collections. This is
Phase 3 of the [production roadmap](../docs/PHASES.md) — it exists so a
future backend API / dashboard has something fast to query instead of
re-deriving router state from raw transactions on every request.

## Architecture

```
Solana (source of truth)
    │
    ├── getSignaturesForAddress + getTransaction  ──▶  backfill.ts   (historical catch-up)
    │
    └── connection.onLogs (websocket)              ──▶  live.ts       (real-time)
                                    │
                                    ▼
                          ingest.ts: processSignature()
                                    │
                    ┌───────────────┼────────────────┐
                    ▼               ▼                ▼
              events (raw,   routers / epochs   transactions
              append-only)   (derived            (one row per
                              projections)        signature —
                                    ▲              idempotency gate)
                                    │
                          reconcile.ts, on an interval:
                          re-fetches the REAL Protocol/Router
                          accounts and overwrites the projection,
                          logging any drift it finds
```

Three things are true by design, not by accident:

- **Solana is always the source of truth.** `events` is an append-only decoded log; `routers`/`epochs` are projections built from it; `reconcile.ts` periodically re-fetches the actual on-chain accounts and overwrites the projection with them, logging when it finds drift. Nothing in Mongo is ever treated as authoritative over the chain.
- **Backfill and live share one code path** (`ingest.ts: processSignature`). A transaction seen by both never gets applied twice — see "Idempotency" below — and there is no second implementation of event decoding to let the two drift apart.
- **A partial failure can't silently strand a signature.** Once a signature is claimed, it will never be retried — so a bug in projecting one event out of several in the same transaction is caught and logged per-event rather than aborting the batch (see the git history for the exact bug this was written in response to).

## Idempotency

Every signature is atomically claimed with a plain unique-key insert into
`transactions` (`_id: signature`) before its events are ever written.
If that insert fails with a duplicate-key error, the signature was
already processed — by backfill, by live, or by a previous run — and
processing stops immediately, before touching `events` or the
projections. This is why `$inc`-based projection fields
(`routers.heartbeatCount`) never double-count even though backfill and
the live subscription can genuinely observe the same signature.

## Collections

| Collection | Keyed by | Purpose |
|---|---|---|
| `events` | `signature:index` | Every decoded event, verbatim — the append-only audit log |
| `transactions` | `signature` | One row per signature; also the idempotency gate |
| `routers` | router PDA (base58) | Current router state, event-derived and reconciliation-corrected |
| `epochs` | `router:epochNumber` | Per-epoch finalize/claim/vest/slash history |
| `protocol` | `"protocol"` (singleton) | Global config + cumulative stats, written only by `reconcile.ts` |
| `sync_cursors` | `"backfill"` | Bookkeeping for the last backfill run |

## Running

```bash
cp .env.example .env
# edit .env: point RPC_URL/WS_URL at your validator, MONGO_URL at your MongoDB
npm install
npm start
```

`npm start` runs a one-time backfill, then starts the live subscription
and the reconciliation loop together. Individual pieces can also be run
standalone:

```bash
npm run backfill    # one-time historical catch-up, safe to re-run
npm run reconcile   # one-time on-chain -> Mongo reconciliation pass
```

### A local-validator-specific gotcha

`solana-test-validator` serves its pubsub websocket on **RPC port + 1**
(8900 alongside the default 8899 RPC port) — not on the RPC URL with
just the scheme swapped, which is what `@solana/web3.js`'s `Connection`
assumes by default (and gets right for real RPC providers, where
`https://...` → `wss://...` on the same host is correct). Set `WS_URL`
explicitly for a local validator; leave it unset for devnet/mainnet.

## Known limitations (honest, for the next session)

- **Admin instructions emit no events.** `pause_protocol`, `resume_protocol`, `reinstate_router`, `decommission_router`, and `update_reward_rate` only ever wrote to program logs via `msg!`, never `emit!` — a gap from Phase 1/2, not something this indexer can work around. `reconcile.ts` still catches the *effects* of these (a paused protocol, a reinstated router) on its next pass, but there's no event-level audit trail for *who* changed *what, when* the way there is for every other action. Worth an on-chain follow-up.
- **Event field names are `snake_case`, not `camelCase`** — this specific Anchor/anchor-lang version's IDL generator keeps Rust's field names verbatim in event type definitions, unlike the account/instruction client layer (`Program.account.router.fetch()`) which *does* camelCase. This bit hard during development: TypeScript couldn't catch it (`event.data` is `Record<string, unknown>`), so `d.routerId` silently read as `undefined` instead of failing to compile, and only threw at runtime deep inside `Buffer.from(undefined)`. Every field access in `projections.ts` is deliberately `snake_case` for this reason — don't "fix" it to camelCase without re-checking the actual IDL (`node -e "console.log(require('../routerpulse/target/idl/routerpulse.json').types.find(t=>t.name==='EventName'))"`).
- No query API yet — that's Phase 4. This service only writes; nothing external reads from it yet except `mongosh` by hand.
