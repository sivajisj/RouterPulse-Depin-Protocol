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

## Phase 3 — Indexer ✅ (this session)

A new standalone service, `indexer/` (Node/TypeScript, MongoDB) — see [indexer/README.md](../indexer/README.md) for the full architecture writeup. Summary:

- **One decode path, two feeds.** `backfill.ts` (`getSignaturesForAddress` + `getTransaction`, oldest-first) and `live.ts` (`connection.onLogs`) both funnel through a single `ingest.ts: processSignature()`, decoding events via Anchor's `EventParser` against the built IDL. No second implementation to let the two drift apart.
- **Idempotent by construction.** Each signature is atomically claimed with a unique-key insert into `transactions` before any event is written; a duplicate claim (backfill re-observing something live already processed, or a re-run) stops immediately. This matters concretely because `routers.heartbeatCount` is `$inc`-based, not `$set`-based — replaying it would silently inflate the count.
- **Mongo is a projection, never authoritative.** `events` is an append-only raw log; `routers`/`epochs` are derived from it for fast queries; `reconcile.ts` runs on an interval, re-fetches the *actual* on-chain `Protocol` and every `Router` account, and overwrites the projection — logging drift when it finds any. Solana stays the source of truth structurally, not by policy.
- **Three real bugs, found by actually running it against the local validator + a local MongoDB, not by writing and trusting the code:**
  1. **Event field names are `snake_case`, not `camelCase`.** This Anchor/anchor-lang version's IDL keeps Rust's field names verbatim on event *type* definitions, unlike the account/instruction client layer (`program.account.router.fetch()`), which does camelCase. `event.data` is `Record<string, unknown>`, so `d.routerId` silently read `undefined` instead of failing to compile — it only surfaced as a runtime crash inside `Buffer.from(undefined)` three call frames away. Every event handler in `projections.ts` now deliberately uses the real (`snake_case`) field names, documented inline so it doesn't get "corrected" back.
  2. **`solana-test-validator`'s websocket isn't at the RPC URL with the scheme swapped.** It's on RPC port + 1 (8900 next to the default 8899), which is not what `Connection`'s auto-derivation assumes (and that assumption *is* correct for real RPC providers). Fixed with an explicit `WS_URL` override, used only for local validators.
  3. **A crash mid-batch could permanently strand a signature.** Because a signature is marked claimed *before* its events are projected (a deliberate idempotency choice — see above), an unhandled throw partway through projecting a multi-event transaction left every later event in that same transaction un-projectable forever: the signature would never be retried, and the raw event data would still exist in `events` but nothing downstream would ever apply it. Fixed by catching and logging per-event inside the projection loop rather than letting one failure abort the batch; `reconcile.ts`'s periodic full re-fetch is the backstop that keeps `routers` correct even when a projection update is lost this way.
- **Verified live**, not just built: ran the indexer against the actual local validator and a local `mongod`, confirmed `getSignaturesForAddress`-based backfill genuinely works against `solana-test-validator` (worth noting since it's easy to assume otherwise), then generated fresh activity via the Phase 1/2 simulator while the indexer's live subscription was running and watched matching events land in MongoDB in real time — heartbeat counts, uptime scores, and stake balances all correct.
- **Known gap, left for a future session:** the admin instructions (`pause_protocol`, `resume_protocol`, `reinstate_router`, `decommission_router`, `update_reward_rate`) never emit `#[event]`s — only `msg!` logs. `reconcile.ts` still catches their *effects* on its next pass, but there's no event-level audit trail for who changed what, when, the way there is for every other action.

## Phase 4 — Backend API ✅ (this session)

New standalone NestJS service, `api/` — REST + WebSocket over the indexer's MongoDB projection. Full details in [api/README.md](../api/README.md).

- **Read-only, zero-custody by design.** Never writes to the indexer's collections (its idempotency guarantees only hold with a single writer), never talks to Solana directly, and holds no server-side keypair — so it cannot move anyone's funds even if fully compromised. State changes are transactions the user's own wallet signs client-side.
- **Sign-In-With-Solana auth.** Server issues a single-use nonce (Redis, 5-min TTL), the wallet signs it, `tweetnacl` verifies against the wallet's own pubkey, and the challenge is deleted on first use so a captured signature can't mint a second session. Returns a short-lived JWT.
- **RBAC bound to live on-chain state, not a local role table.** `ProtocolAuthorityGuard` checks the session wallet against whatever address is *currently* the on-chain protocol authority. If that authority rotates, access follows automatically — nothing to update here, no stale admin row to forget.
- **Real-time fanout without a second chain subscription.** The indexer publishes each newly-indexed event to Redis; the WebSocket gateway subscribes and re-broadcasts over Socket.IO. That's what lets this API be horizontally scaled later without every instance opening its own Solana subscription, or clients on instance A missing events instance B observed. Publishing is fire-and-forget and non-fatal — Redis going down costs live updates, never data.
- **Two subtle bugs found by running it, not by review:**
  1. **ioredis "Connection in subscriber mode" unhandled error** — `duplicate()` starts connecting immediately, and ioredis's ready-check issues `INFO` after the connection has already entered subscriber mode, throwing as an *unhandled* error event. Fixed with a dedicated connection using `enableReadyCheck: false` plus an explicit error handler.
  2. **The event feed was cursoring on `_id`** — which is `signature:index`, and base58 signatures don't sort chronologically, so a "newest first" feed paginated in essentially arbitrary order. Switched to `blockTime`, with a test asserting the ordering because this is easy to get wrong and never notice.
- **Also**: cursor pagination throughout (never skip/limit — it drifts when the indexer inserts between pages, which happens constantly), token amounts summed via `$toDecimal`/Decimal128 rather than a float-coercing `$sum`, global rate-limit guard so new endpoints are protected by default, and OpenAPI docs at `/api/docs`.
- **Verified against the real stack**: 21/21 end-to-end tests (real MongoDB, real Redis, real HTTP server, no mocks) covering pagination advancement, 404 vs empty-200, feed ordering, SIWS happy path, replay rejection, wrong-message-signature rejection, garbage-token rejection, and an authenticated-but-not-authority wallet correctly getting 403. Then confirmed the **full live chain end to end** — ran the simulator against the validator with the indexer and API both up and a Socket.IO client connected, and watched 7 real events flow Solana → indexer → Redis → WebSocket → client with correctly decoded payloads.

- NestJS REST + WebSocket API over the indexed MongoDB/Redis data: routers, rewards, staking, analytics, admin.
- Auth via wallet-signature verification, RBAC, rate limiting, OpenAPI docs.

## Phase 5 — ClickHouse Analytics ❌ (not built — see "Still open")

- ClickHouse for event-level analytics (uptime by region, reward distribution, staking TVL) separate from MongoDB's operational projection.

## Phase 6 — Enterprise Next.js Dashboard ✅ (this session)

New `web/` app — Next.js 14 App Router over the Phase 4 API. Details in [web/README.md](../web/README.md).

- **Server Components by default, client JS only where it's earned.** Every page fetches server-side and ships HTML; the only meaningful Client Component is the live event feed, because it's the only thing that genuinely needs a persistent connection. The build output makes this concrete: the dashboard route is ~13.6 kB of JS (the Socket.IO client) while `/routers`, `/analytics`, `/explorer` and `/routers/[pda]` are ~180 B each. Marking the tree `"use client"` would have shipped Socket.IO to every route for nothing.
- **Pages**: network overview (fleet stats, supply/burn/slash totals, router map, live feed), filterable router table with uptime meters, per-router detail showing owner-vs-device identity and the full per-epoch reward/slash breakdown, analytics (fleet composition, regional grouping, recent finalized epochs), and a raw decoded event explorer filterable by event type.
- **The live feed is seeded server-side** with recent events so it paints populated instead of sitting empty until something happens on-chain, and de-dupes on event id since a socket reconnect can redeliver.
- **Token amounts never touch `Number`.** They're 9-decimal base-unit strings that routinely exceed `Number.MAX_SAFE_INTEGER`; formatting goes through `BigInt` only. A `parseFloat` here would silently corrupt exactly the values this project treats as money.
- **The map is hand-rolled** (equirectangular projection of the fixed-point lat/long already on each router) rather than MapLibre — no tile provider, no API key, no network call, so the dashboard works fully offline.
- **Verified end to end, against the real running stack**: production build clean, all five routes returning 200 with genuinely indexed data (4 real routers, real token totals, real decoded event names — not empty shells), unknown router PDA correctly 404ing. Then the full chain live: ran the simulator against the validator with indexer + API + web all up and a Socket.IO client attached — **15 real events streamed through** (including `RouterSlashed`), and the dashboard's heartbeat counter moved 33 → 39 from actual on-chain activity.
- **Honest gap**: no wallet adapter yet. The API's Sign-In-With-Solana flow is built and tested, but this dashboard is read-only and doesn't connect a wallet, so the authenticated admin view isn't wired up here. That's the clear next step for this app.

## Phase 7 — DEX Integration ❌ (not built — see "Still open")

- Treasury page with swap quotes via a DEX aggregator (not a custom AMM).

## Phase 8 — Docker + CI/CD ✅ (partial, this session)

Local stack reproducibility and continuous integration. Details in [infrastructure/README.md](../infrastructure/README.md).

- **`docker compose up` brings up the whole off-chain stack** — MongoDB, Redis, indexer, API, dashboard — with health-gated startup ordering so the indexer and API don't race their dependencies.
- **The validator is deliberately *not* containerized.** It's a poor fit (large image, slow start, and the program still needs the host's Anchor/BPF toolchain to build and deploy into it), and leaving it out means the same compose file works unchanged against devnet by changing one env var. The indexer reaches a host-run validator via `host.docker.internal`.
- **Two Docker-specific gotchas documented rather than left as traps**: the IDL is a host build artifact bind-mounted read-only (the image can't produce it, so a program rebuild needs an indexer restart), and `NEXT_PUBLIC_API_URL` is a *build arg* not a runtime var, because Next.js inlines it into the client bundle at build time.
- **CI runs four jobs on every push and PR**: the Anchor program (`cargo check`, `clippy -D warnings`, 26 unit tests — no Solana toolchain needed, so it's fast), a TypeScript type-check matrix across `indexer`/`api`/`web` (catches cross-service drift, e.g. the API reading a field the indexer stopped writing), the API's 21-test end-to-end suite against **real** MongoDB and Redis service containers, and a Docker build of all three images.
- **Getting `clippy -D warnings` to actually pass surfaced real issues**, rather than being waved through: fixed `== false` comparisons and manual range checks in `register_router`, then hit two lints that *couldn't* be fixed conventionally — Anchor's `#[program]` macro expansion triggers `diverging_sub_expression`, and its generated `__client_accounts_*` modules are only reachable through glob re-exports that unavoidably make `instructions::handler` ambiguous. Attempting to replace the globs with an explicit export list broke the build outright. Both are now narrowly-scoped `#![allow(...)]`s with comments explaining exactly why, so CI still fails on genuine findings.
- **A CI bug caught before it ever ran**: the seed script initially lived in `.github/scripts/` and failed with `Cannot find module 'mongodb'` — Node resolves modules from the script's own directory, not the working directory. Moved into `api/test/` where the driver actually is.
- **Verified, not assumed**: all three Docker images build successfully, `docker compose config` validates, the seed script runs, and the API's full 21-test suite passes against freshly-seeded CI-shaped data — the exact sequence the `api-e2e` job runs. Clippy passes clean at `-D warnings` and the program still builds to BPF with no stack-frame regressions.

### Not done in this phase

Observability (OpenTelemetry/Prometheus/Grafana), a production deployment target (registry, secrets management, non-root users, pinned digests, resource limits), and load testing remain open. The compose stack is explicitly for local development.

## Phase 9 — Security Pass ✅ (partial, this session)

Threat model, authority model, and a dependency audit where the findings were **fixed rather than documented away**. Full writeup in [docs/security.md](security.md).

- **[docs/security.md](security.md)** documents the threat model (12 concrete attacks and where each is mitigated), the authority model (what the protocol authority can and — importantly — cannot do), the arithmetic guarantees, and the account-validation approach.
- **Dependency audit, with the high-severity findings actually resolved:**
  - `web`: 2 high → **0 high**. Next.js 14 had no non-breaking fix, so upgraded 14 → 15, which required migrating `params`/`searchParams` to the async form Next 15 introduced (a genuine breaking change that the build caught).
  - `api`: 4 high → **0 high**. Upgraded NestJS 10 → 11, clearing transitive `multer`, `js-yaml` and `lodash` advisories; required a documented cast for `@nestjs/jwt` 11's tightened `expiresIn` type.
  - `indexer`: already clean.
- **Both upgrades verified, not assumed**: the API's full 21-test suite passes on NestJS 11; the web app builds and every route renders real indexed data on Next 15, with query-param filtering confirmed working (checked table rows specifically, since filter-button labels appear in the HTML regardless); both Docker images still build.
- **Honest list of what a real audit would still need** is in the doc rather than glossed over — the largest gap being that the **upgrade authority is still a single developer keypair**, where production needs a multisig. Also open: `cargo audit` in CI (the tool isn't installed here), fuzzing/property tests on the math module, systematic adversarial tests for PDA substitution and CPI target confusion, timestamp-manipulation analysis, economic simulation, real secrets management, and a shared-store rate limiter (the current one is per-instance and in-memory, so it multiplies by instance count when scaled).

---

## Still open

**Phase 5 (ClickHouse analytics)** and **Phase 7 (DEX integration)** were not built. The analytics that exist are MongoDB aggregations served by the API, which is sufficient at this data volume; ClickHouse would matter at event volumes this project hasn't reached. DEX integration was descoped in favour of finishing the dashboard and infrastructure.

**Phase 8** is partial: Docker Compose and CI are done, but observability (OpenTelemetry/Prometheus/Grafana), a production deployment target, and load testing are not.

**Operator transactions are now built and verified** — see below. What remains unverified is the browser-wallet UX itself (one human pass with Phantom), not the instruction logic.

---

## Wallet adapter ✅ (closed after Phase 9)

The gap listed above as "most valuable next piece of work" is now done:

- **Sign-In-With-Solana in the browser.** `useSession` requests a nonce, has the wallet sign it, and trades the signature for a session JWT. The wallet signs a *message*, never a transaction — signing in costs nothing and moves no funds. A stored session is discarded when the connected wallet changes, so switching wallets can't leave you authenticated as the previous one.
- **`/operator`** lists the routers the connected wallet owns and renders an admin audit panel only for the on-chain protocol authority. The page just calls the endpoint and reacts to 200 vs 403 — the API resolves "is this the authority" against live on-chain state, not a role in a database, so it follows an authority rotation automatically.
- **A real dependency conflict, caught by the build:** several `@solana/wallet-adapter-*` packages pull in `@types/react` 19 while this app is on React 18. Two copies in the tree make the JSX types incompatible (19's `ReactNode` gained `Promise<ReactNode>`), which surfaces as the misleading "ConnectionProvider cannot be used as a JSX component". Pinned via npm `overrides` — which also needed a clean reinstall, since npm silently reused the existing tree and left the nested copies in place.
- **Verified against the live stack**, not just compiled: all five routes return 200, the operator page renders its wallet-gated state, and the exact handshake the browser performs was replayed against the running API — the authority wallet signs in and gets 200 on `/admin/audit`, a random wallet signs in but gets **403**, a reused nonce gets **401**, and a signature forged by a different keypair gets **401**.


## Operator transactions ✅ (closed after the wallet adapter)

The dashboard can now drive the full operator lifecycle — register, stake, claim, vest — with transactions built and signed client-side, since the API holds no keypair and deliberately cannot act for a user.

- **`RegisterRouter`** generates the router's device identity in the browser and shows the secret exactly once, to be copied onto the hardware. It's never persisted: the owner/device split only means anything if a compromised device can't move funds.
- **`RouterActions`** covers stake / claim epoch / release vested, driven off the indexed projection.
- **`useTx`** models transaction phases separately so the UI can say *"waiting for your wallet"* — the only step a user can act on. Program errors map to what an operator should do differently (`InsufficientStake`, `StakeLocked`, `NothingVested`, …).
- **PDA derivations live in a framework-free `pdas.ts`**, so the verification script imports the *same* code the UI uses rather than a parallel re-implementation that could drift.

**Verified with `npm run verify:operator` against a live validator — 8/8**: register (device key provably ≠ owner), stake (vault credited to the exact base unit), device-signed heartbeat, finalize (100% uptime → 240000000 reward, no slash), claim (**mint supply unchanged**, proving claiming really doesn't mint), vest (partial slice, as a linear schedule should).

Two things surfaced while running it:
- A first pass sent one heartbeat into a two-heartbeat epoch, which correctly scored 50% uptime and landed in the bottom tier: **zero reward, 10% slashed**. The protocol was right; the script was wrong. It's also the cheapest way to make slashing fire in a demo.
- `@solana/spl-token` was a devDependency despite being imported in app code — would have broken a production install.

**Still unverified:** wallet-adapter UI behaviour and the `useTx` phase transitions, which need one human pass with a browser wallet.

---

## A dropped-event bug found while rehearsing the demo

Preparing `docs/demo.md` surfaced an epoch marked `claimed: true` in MongoDB with **no reward, uptime, or finalized flag**, while the chain had it fully finalized at 10000bps / 240000000. Two separate defects:

1. **A transient `getTransaction` miss claimed the signature forever.** `ingest.ts` treated a `null` response like a reverted transaction and recorded the signature. But `null` usually just means *not queryable yet* — a log notification routinely arrives before the RPC will serve the transaction at that commitment. Because backfill skips already-claimed signatures, those events were lost permanently with nothing to retry them.
2. **`reconcile.ts` never covered epochs**, so nothing repaired the damage — which is precisely the failure mode reconciliation exists to catch. Epoch records underpin every reward figure the dashboard shows.

Both fixed, and verified against the genuinely corrupted record rather than a synthetic one: reconcile reported `epoch drift wpf6…:1: finalized undefined -> true, reward undefined -> 240000000`, and the API then returned both epochs correctly.

This is the strongest argument in the whole project for why reconciliation exists: the event stream **did** silently lose data, and the periodic re-read from chain is what caught it.
