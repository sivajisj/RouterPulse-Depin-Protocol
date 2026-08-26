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

## Phase 2 — Tokenomics ✅ (this session)

Replaced the raw-SOL reward vault entirely with a real SPL token economy:

- **Reward mint.** A new SPL mint, created as a PDA (`seeds = [reward_mint]`) at `initialize_protocol` time with the protocol PDA as its *only* mint authority and no freeze authority — no human key can ever issue or freeze reward tokens. Supply starts at zero: there is no pre-mine.
- **Staking.** A `Stake` PDA per router (`seeds = [stake, router]`) backs a pooled, protocol-owned `stake_vault` token account. `stake`/`unstake` move real tokens via SPL CPI (owner-signed in, protocol-PDA-signed out via `invoke_signed`). `heartbeat`'s very first (activating) call now requires `router.staked_amount >= protocol.min_stake` — collateral is enforced structurally, not just by convention. `unstake` blocks an active router from dropping below the minimum; it must be decommissioned first.
- **Uptime-tiered rewards *and* slashing from one table.** `math::performance_tier` (pure, exhaustively unit-tested) maps an epoch's `uptime_bps` to a reward multiplier and a slash percentage in the same lookup — reward decays gently from 100% down to 90%, then falls off a cliff below 70% (0 reward, 10% slashed). `finalize_router_epoch` locks in both `reward_amount` and `slash_amount` together; `slash_router` (separate, permissionless, since it moves tokens) executes the slash exactly once per epoch via CPI from `stake_vault` to `treasury`.
- **Emission budget.** A lazily-created `EmissionSchedule` PDA per epoch number caps how much that epoch can ever pay out in total (`math::epoch_emission`, decaying geometrically per "year" of epochs). Every router's reward is clamped to whatever remains of the epoch's budget when it finalizes — extra routers dilute a fixed pool instead of inflating supply, which is what actually stops a Sybil-registration attack from being profitable.
- **Vesting, not lump-sum minting.** `claim_reward` no longer moves any tokens — it converts a finalized epoch into a `RewardVesting` entitlement (cliff + linear, `math::vested_amount`). `claim_vested` is the *only* instruction in the whole program that mints, and it only ever mints the newly-vested delta for one specific entitlement. Total supply therefore only ever grows in lockstep with what has actually vested; there's no pool sitting anywhere that could be drained.
- **The bootstrap problem, found by writing the tests, not by design review.** Staking requires already holding reward tokens; the only mint path was vesting; vesting requires having already earned and staked. Nobody could ever get the first token. Fixed with a `genesis_allocation` field on `Protocol`, fixed at `initialize_protocol` and enforced on-chain in a new `mint_genesis` instruction — authority-gated, but hard-capped, so the authority's total issuing power is bounded and auditable from day one rather than unlimited.
- **Treasury burn.** `burn_treasury` (authority-gated) permanently destroys slashed collateral via SPL `burn` CPI, closing the loop: bad performance moves tokens to the treasury, burning makes that a real deflationary penalty instead of a transfer of value to whoever controls the treasury.
- **A real BPF stack-frame bug, caught by the build, not by review.** `SlashRouter`'s account validation exceeded the BPF VM's hard 4096-byte stack-frame limit by 24 bytes once `Protocol` grew to hold all the new tokenomics config — the build printed `Error: ... Exceeding the maximum stack offset may cause undefined behavior` and *still emitted a `.so`*, which is the trap: it would have shipped a program that could misbehave at runtime on that one instruction. Fixed by boxing `Protocol` (`Box<Account<'info, Protocol>>`) in that one Accounts struct to move it off the stack.
- **Tests.** 12 new pure-math unit tests (tier boundaries, bps rounding direction, emission decay, vesting cliff/linear/saturation — including one that caught a real `u64` overflow in the naive `apply_bps` implementation before it ever touched a validator) plus a full integration suite: genesis-cap enforcement, collateral gating on activation, real token-balance deltas on stake/unstake, the whole epoch → finalize → claim → vest → fully-vested lifecycle, a second router deliberately run at 50% uptime to prove the bottom tier actually pays nothing and actually gets slashed, slash execution with balance assertions, double-slash rejection, and a treasury burn that reconciles against on-chain mint supply. **38/38 passing** against a real local validator.

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
