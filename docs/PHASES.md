# RouterPulse — Production Roadmap

RouterPulse started as a hackathon-style prototype: a single Anchor
program, a TypeScript simulator, and an integration test suite. The
goal is to evolve it into a small production-grade DePIN platform —
on-chain protocol, event-driven backend, and an enterprise Next.js
dashboard — without losing what already worked.

This file tracks that evolution honestly: what's done, what's
in-progress, and what's still ahead, so the story is easy to pick back
up across sessions and easy to explain in an interview.

Each phase is scoped to be independently shippable and independently
explainable — "I hardened the protocol first because a reward bug
undermines everything built on top of it" is a stronger interview
answer than "I built all the layers at once."

---

## Phase 0 — Baseline ✅ (this session)

- Audited the actual repository state (not assumptions) before changing anything.
- Confirmed the program compiles (`cargo check -p routerpulse --lib`) and the pure-math unit tests pass (`cargo test -p routerpulse --lib`, 13/13) after every change in this phase.
- Documented the real gaps found: `is_paused` was checked in `register_router` but **not** in `heartbeat` or `claim_reward`; reward accounting read lifetime `heartbeat_count`/`missed_heartbeats`, which lets a router that goes silent keep a stale, favorable uptime percentage indefinitely; the heartbeat signer was the operator's own wallet, with no separate device identity.

## Phase 1 — Protocol Hardening ✅ (this session)

The highest-priority items from the production plan, all in the Anchor program:

- **Pause enforcement.** `heartbeat` and `claim_reward` now both `require!(!protocol.is_paused)`. Previously only registration was blocked.
- **Epoch-based rewards.** Added a `RouterEpoch` PDA (`seeds = [router_epoch, router, epoch_number]`), a deterministic epoch clock on `Protocol` (`genesis_time` + `epoch_duration`, so client and program always agree on "current epoch" with no cross-router cranking needed), and two new instructions:
  - `finalize_router_epoch` — permissionless crank, closes an epoch once its time window has passed and locks in `uptime_bps`/`reward_amount` from heartbeats *actually received in that window*.
  - `claim_reward` now takes an `epoch_number` and pays out exactly that epoch's locked-in amount, exactly once (`claimed` flag on the epoch record).
  - This closes the "go silent forever, historical uptime% stays high" exploit path: a router that stops sending heartbeats simply never accrues a `RouterEpoch` record — and therefore never a reward — for the epochs it missed.
  - The old live `uptime_score` (+1 on time / -10 late, drives auto-suspension at score ≤ 20) is kept as a separate, complementary signal — a fast safety valve, not a reward input.
- **Device identity.** `Router` now stores `device_pubkey` (separate from `owner`) and `device_key_version`. `register_router` takes an initial device key; `heartbeat` requires that key to sign (not the owner wallet); a new `rotate_device_key` instruction (owner-signed) lets a lost or compromised device be recovered without re-registering.
- **New errors** for all of the above (`WrongEpochNumber`, `EpochNotEnded`, `EpochAlreadyFinalized`, `EpochNotFinalized`, `EpochAlreadyClaimed`, `EpochRouterMismatch`, `InvalidDeviceSigner`, `DeviceKeyUnchanged`, `InvalidEpochDuration`), all covered by tests.
- **Tests.** `tests/routerpulse.ts` was rewritten for the new instruction signatures and extended with: wrong-device-signer rejection, wrong-epoch-number rejection, pause blocking heartbeats, finalize-before-epoch-end rejection, claim-before-finalize rejection, double-claim rejection, double-finalize rejection, device-key rotation (+ non-owner rejection), and a full close-the-loop epoch test (heartbeat → wait for the real epoch window to pass → finalize → claim → verify balance).
- **Simulator.** Each simulated router now has its own throwaway device keypair (airdropped, never the operator wallet) and, after every heartbeat, best-effort finalizes + claims the previous epoch — so running the simulator now demonstrates the entire lifecycle live, not just heartbeats.

### Verification

The Solana/Anchor/BPF toolchain wasn't installed in the sandbox this phase was originally written in, so the first pass was verified with `cargo check`/`cargo test` only (type-checking and pure-math unit tests). The toolchain (Solana CLI, Anchor CLI 1.0.1 via avm, a local `solana-test-validator`) was installed in a follow-up session and the full integration suite was run for real. That surfaced three bugs pure `cargo check` couldn't catch, all fixed:

1. **`anchor.BN` resolved as `undefined`, not a constructor**, under this environment's specific Node 22 + mocha 10 + TypeScript 6 combination. Root cause: mocha's spec loader always attempts a native dynamic `import()` first; for a typeless `package.json`, Node reparses the `.ts` file as native ESM (stripping types itself, bypassing `ts-node` entirely), and `@coral-xyz/anchor`'s bundled CJS re-export of `BN` doesn't survive that specific CJS→ESM named-export interop. Fixed by importing `BN` directly from `bn.js` (a simple single-default-export package, unaffected) instead of going through `anchor.BN`, in `tests/routerpulse.ts` and `simulator/src/{config,router}.ts`. This is an environment/tooling quirk, not a protocol bug — worth knowing about since it would silently make *any* future test using `anchor.BN` "pass" for the wrong reason (the constructor throw gets swallowed by this file's `try { ... } catch (err) { assert.ok(err) }` negative-test pattern).
2. **`MIN_HEARTBEATS_PER_EPOCH` was left at `4` in `constants.rs`** while the test suite's `epoch_duration`/`heartbeat_interval` ratio (and the design rationale written into `docs/protocol.md`) assumed a floor of `2`. `initialize_protocol` correctly rejected the mismatched test config — good, that's the check working — but it meant the constant and the docs disagreed. Fixed by setting the constant to `2` to match the documented design.
3. **A test assertion was too strict**: `sends heartbeats inside the current epoch` asserted `routerEpoch.heartbeats === 1`, not accounting for the fact that the same router already received a couple of heartbeats earlier in the same short (120s) test epoch from the preceding `Heartbeat` suite. Loosened to `>= 1` — the protocol behavior (heartbeats accumulate correctly within an epoch across calls) was already correct; only the test's assumption was wrong.

**Result: 27/27 passing**, including the full real-time lifecycle test — register → heartbeat → wait for a genuine ~2 minute epoch window to close → `finalize_router_epoch` → `claim_reward` → balance verified → double-claim rejected → double-finalize rejected — executed against an actual local `solana-test-validator`, not mocked.

---

## Phase 2 — Tokenomics (planned)

- Replace the raw-SOL reward vault with an SPL (or Token-2022) reward mint.
- Staking: operators stake collateral to activate a router; uptime-scaled reward multiplier; slashing on sustained bad uptime.
- Vesting schedule for claimed rewards (cliff + linear).
- Emission schedule (per-epoch pool split across router operators / treasury / community).
- Security tests specific to CPI/token surfaces: wrong mint, wrong token authority, ATA substitution.

## Phase 3 — Indexer (planned)

- Node/TypeScript service subscribing to program logs/accounts over websocket, decoding via the Anchor IDL.
- Writes to MongoDB (operational state) with idempotent upserts keyed on `signature + instruction_index`.
- Backfill + reconciliation workers (Solana is always the source of truth).

## Phase 4 — Backend API (planned)

- NestJS REST + WebSocket API over the indexed MongoDB/Redis data: routers, rewards, staking, analytics, admin.
- Auth via wallet-signature verification, RBAC, rate limiting, OpenAPI docs.

## Phase 5 — Analytics (planned)

- ClickHouse for event-level analytics (uptime by region, reward distribution, staking TVL) separate from MongoDB's operational projection.

## Phase 6 — Enterprise Next.js Dashboard (planned)

- Wallet-connected operator dashboard: router explorer + detail, staking, rewards, live map (MapLibre), on-chain explorer, admin panel.

## Phase 7 — DEX Integration (planned)

- Treasury page with swap quotes via a DEX aggregator (not a custom AMM).

## Phase 8 — Production Engineering (planned)

- Docker Compose for local dev (Mongo/Redis/ClickHouse/API/indexer/worker/web), GitHub Actions CI (lint/build/test per workspace), staging → production promotion, RPC failover, observability (OpenTelemetry/Prometheus/Grafana).

## Phase 9 — Security Pass (planned)

- `cargo audit`/`clippy`, dependency/secret scanning, a written threat model, and an expanded on-chain attack-simulation suite once the token/staking surface from Phase 2 exists (double-claim, replay, CPI target substitution, treasury drain, etc. — several of these are already covered for the current SOL-vault design in Phase 1's test suite).

---

## Why this order

Everything above Phase 1 is built *on top of* the reward/security model. Building the indexer, backend, or dashboard against a protocol with a live reward-farming bug and no device-key separation would mean re-doing that work once the protocol changed underneath it — so protocol correctness came first.
