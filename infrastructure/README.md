# Infrastructure

Local development stack and CI for RouterPulse.

## Running the stack

```bash
# 1. Validator + program (host toolchain — see below for why)
solana-test-validator --reset
cd routerpulse && anchor build && anchor keys sync && anchor build && anchor deploy

# 2. Everything else
docker compose up --build
```

That brings up MongoDB, Redis, the indexer, the API (`:3001`, docs at
`/api/docs`) and the dashboard (`:3000`).

### Why the validator isn't in compose

`solana-test-validator` in a container is a poor fit: a large image, slow
startup, and the program still has to be built and deployed into it by
the host's Anchor/BPF toolchain anyway. More importantly, keeping it out
means this same compose file works unchanged against devnet — just set
`SOLANA_RPC_URL` / `SOLANA_WS_URL` and nothing else moves.

`host.docker.internal` (mapped via `extra_hosts`) is how the indexer
container reaches a validator running on the host.

### The IDL is a mounted build artifact

`routerpulse/target/idl/` is bind-mounted read-only into the indexer.
The IDL is produced by `anchor build` on the host and is what the
indexer decodes events against — the image can't generate it, so after
rebuilding the program, restart the indexer container to pick it up.

### `NEXT_PUBLIC_API_URL` is baked at build time

Next.js inlines `NEXT_PUBLIC_*` into the client bundle during
`next build`, so it's a Docker **build arg**, not a runtime env var.
Pointing the dashboard at a different API means rebuilding that image.

## CI (`.github/workflows/ci.yml`)

Four jobs, all on push and PR:

| Job | What it actually catches |
|---|---|
| `program` | `cargo check`, `clippy -D warnings`, and the 26 pure-math unit tests (uptime scoring, performance tiers, emission decay, vesting). No Solana toolchain needed, so it's fast. |
| `typescript` | Type-checks `indexer`, `api`, and `web` in a matrix. Catches cross-service drift — e.g. the API reading a field the indexer stopped writing. |
| `api-e2e` | Boots the API against **real** MongoDB and Redis service containers and runs the 21-test end-to-end suite: SIWS auth, replay rejection, RBAC, cursor pagination, feed ordering. No mocks. |
| `docker` | Builds all three images with layer caching, so a broken Dockerfile fails CI rather than deploy. |

### The CI seed data

CI has no Solana validator, so `api/test/seed-mongo.js` writes the same
document shapes the indexer produces. It deliberately mirrors
`indexer/src/projections.ts` and `reconcile.ts` rather than inventing a
convenient shape — token amounts as strings, base58 `_id`s, and event
data in `snake_case` exactly as the Anchor IDL emits it. If those
diverge and the seed doesn't, the API tests should start failing. That's
the point.

It lives in `api/test/` rather than a top-level scripts directory
because Node resolves modules from the script's own location, and that's
where the `mongodb` driver is installed. (Found the hard way — the first
version sat in `.github/scripts/` and failed with `Cannot find module
'mongodb'`.)

## What's deliberately not here yet

- **No production deployment target.** These images are built for local
  development. Shipping them would need a registry, secrets management
  (`JWT_SECRET` currently defaults to a dev value), non-root users,
  pinned base image digests, and resource limits.
- **No observability stack.** OpenTelemetry/Prometheus/Grafana is listed
  as Phase 8 work in the roadmap and hasn't been built — the API has a
  `/health` endpoint and that's it.
