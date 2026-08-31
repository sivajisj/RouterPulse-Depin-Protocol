# RouterPulse — Résumé & Interview Reference

Everything below is **verified against the actual repository**, not
aspirational. If a number appears here you can defend it, because it came
from running the thing.

Keep this honest. The fastest way to lose an interviewer is to claim
something they then probe and find hollow.

---

## Links

| | |
|---|---|
| Repo | https://github.com/sivajisj/RouterPulse-Depin-Protocol |
| Dashboard | https://web-indol-xi-67.vercel.app |
| API | https://routerpulse-api.onrender.com |
| Program (devnet) | `4nVLSAiwNCBiepWwHdiafKcGzKHtaKu8YSPk24REG6d4` |

---

## The one-sentence pitch

> A Solana DePIN protocol where Wi-Fi routers stake collateral and earn
> epoch-scoped token rewards from cryptographically-proven uptime, with
> sustained downtime triggering on-chain slashing — plus the indexer,
> API and dashboard that make it observable.

If you only get one more sentence:

> Rewards are scoped to a closed epoch rather than a lifetime average,
> because an average lets a router go dark forever and still look
> healthy — nothing recomputes it once heartbeats stop.

---

## Verified numbers

| Metric | Value |
|---|---|
| On-chain instructions | **18** |
| On-chain account types | **6** |
| On-chain events | **19** |
| Custom error codes | **46** |
| Rust (program) | ~2,950 lines |
| TypeScript (indexer + API + web) | ~3,690 lines |
| On-chain integration tests | **40** |
| Rust unit tests | **26** |
| API end-to-end tests | **21** |
| Operator transaction verification | **8/8** against devnet |
| **Total automated tests** | **87** + a load test |

---

## Tech stack

**On-chain**
Rust · Anchor 1.0 (`anchor-lang`, `anchor-spl`) · Solana · SPL Token ·
PDAs & canonical bumps · CPI with `invoke_signed` · checked arithmetic

**Backend**
Node.js · TypeScript · NestJS 11 · MongoDB · Redis (pub/sub) ·
Socket.IO · JWT · `tweetnacl` (ed25519 signature verification) ·
OpenAPI/Swagger · `@nestjs/throttler`

**Frontend**
Next.js 15 (App Router, React Server Components) · React 18 ·
Solana Wallet Adapter (Phantom, Solflare) · Socket.IO client

**Infrastructure**
Docker & Docker Compose · GitHub Actions (4 jobs) · Vercel · Render ·
MongoDB Atlas · Redis Cloud · `solana-test-validator` · Anchor/avm

**Testing**
Mocha · Chai · Supertest · Rust `#[cfg(test)]` · custom load harness

---

## Features, by layer

### On-chain protocol
- **Epoch-scoped rewards** — a `RouterEpoch` PDA per (router, epoch); an epoch a router didn't participate in has no record, so it cannot be claimed
- **Split identity** — device key signs heartbeats, owner wallet holds funds; a stolen router can only send heartbeats
- **Device key rotation** — recovery without re-registering; router keeps history and stake
- **Staking as a structural gate** — `heartbeat` refuses to activate an uncollateralized router
- **One tier table drives reward *and* slash** — ≥99% pays full; <70% pays nothing and slashes 10%
- **Emission budget per epoch** — extra routers dilute a fixed pool rather than inflating supply
- **Cliff + linear vesting** — `claim_reward` grants entitlement and mints nothing; `claim_vested` is the only instruction that increases supply
- **Deflationary penalty** — slashed collateral is burned, not redistributed
- **Hard-capped genesis allocation** — bounded, auditable bootstrap
- **Emergency pause** enforced on heartbeat and claim paths
- **Full governance audit trail** — every admin action emits an event naming the actor

### Indexer
- Dual ingestion (historical backfill + live websocket) through **one shared code path**
- **Idempotent by construction** — signatures atomically claimed before any write
- **Self-healing reconciliation** — periodically re-reads chain accounts and overwrites its own projection, logging drift
- Retry with exponential backoff + jitter on transient RPC failures
- Redis pub/sub fanout for real-time UI

### API
- REST + WebSocket, **cursor-based pagination** (not offset — offset drifts under concurrent writes)
- **Sign-In-With-Solana** — nonce → signature → JWT; single-use, 5-minute expiry
- **RBAC bound to on-chain state** — authority checked against the live chain, not a database role
- Rate limiting, OpenAPI docs, Decimal128 aggregation for token amounts

### Dashboard
- Server Components by default — read-only routes ship ~168 B of JS
- Wallet connect + full operator lifecycle: register, stake, claim, vest, unstake, rotate device key
- Live event feed, server-seeded so it renders populated on first paint

---

## Résumé bullets

### Long form (project section)

> **RouterPulse — Solana DePIN Protocol** · *Rust, Anchor, TypeScript, NestJS, Next.js, MongoDB, Redis*
> - Built a DePIN protocol where routers stake collateral and earn epoch-scoped token rewards from cryptographically-proven uptime; sustained downtime triggers on-chain slashing. **40 integration tests against a live validator, 87 automated tests total.**
> - Redesigned reward accounting after discovering the original paid against a lifetime uptime average — a router could go offline indefinitely and still appear 100% healthy.
> - Built an event-driven indexer (Solana → MongoDB) with idempotent ingestion and periodic on-chain reconciliation, **which caught a real bug silently dropping events**.
> - Implemented Sign-In-With-Solana auth in NestJS with **RBAC resolved against live on-chain authority state** rather than a stored role.
> - Deployed end to end: Anchor program on devnet, API on Render, Next.js dashboard on Vercel, MongoDB Atlas + Redis Cloud.

### Short form (2 lines)

> **RouterPulse** — Solana DePIN protocol (Rust/Anchor) with epoch-scoped rewards, staking, slashing and vesting, plus an event-driven indexer, NestJS API and Next.js dashboard. Deployed to devnet; 87 automated tests.

### One-liner (skills list)

> Solana/Anchor DePIN protocol with staking, slashing, vesting and a full TypeScript indexer/API/dashboard stack — live on devnet.

---

## The bugs — your strongest material

Every one was found by **running** the system, not reading it. Lead with
these; they're what separates you from someone who followed a tutorial.

| # | Bug | Why it lands |
|---|---|---|
| 1 | **BPF stack-frame overflow** in `slash_router` | The build printed an error and **still emitted a working `.so`**. Trusting the exit code would have shipped undefined behaviour. |
| 2 | **Bootstrap deadlock** | Staking needed tokens; minting needed vesting; vesting needed staking. *Nobody could ever obtain the first token.* Fixed with a hard-capped genesis allocation. |
| 3 | **Indexer silently losing events forever** | A transient RPC `null` marked a signature permanently processed. An epoch sat in MongoDB marked `claimed` with no reward, while the chain showed it finalized at 240000000. |
| 4 | **`u64` overflow in `apply_bps`** | Overflowed at a 100% multiplier for large amounts. Caught by its own unit test before it ever reached a validator. |
| 5 | **`app.listen()` bound to localhost** | Deploy went green, no crash logs, **404 on every route**. The status code lied; `x-render-routing: no-server` in the headers told the truth. |
| 6 | **Foreign `UNIQUE` index** on a shared Atlas cluster | A leftover index from an old project — wrong here, since router identity is the PDA of (owner, router_id) and two operators may share a router_id. |

**The line to use:**

> *"Bug 3 is why reconciliation exists in this project. The event stream
> genuinely did lose data — the periodic re-read from chain is what
> caught it. That's not a failure mode I designed around defensively;
> it's one I watched happen and then built for."*

---

## Talking points by role

**Blockchain / protocol**
Epoch design vs lifetime averages · PDA derivation and canonical bumps ·
CPI with `invoke_signed` · why the mint authority is a PDA · why claiming
mints nothing · BPF stack limits

**Backend / distributed systems**
Idempotency via atomic claim · why Mongo is a projection and Solana the
source of truth · reconciliation as a correctness backstop · cursor vs
offset pagination · retry with jitter · rate limiting

**Full-stack**
Server Components and where the client boundary belongs (~168 B on read
routes) · SIWS as non-custodial auth · RBAC from chain state · why token
amounts never touch `Number`

---

## Known gaps — say these before you're asked

Volunteering these reads as senior. Getting caught omitting them doesn't.

- **Upgrade authority is a single keypair.** Production needs a multisig. Biggest real security gap.
- **No observability** — no OpenTelemetry, metrics or tracing.
- **Indexer isn't hosted** — the site stays up without it, but new on-chain activity stops flowing.
- **Render free tier sleeps**; first request after idle can 404.
- **ClickHouse and DEX integration deliberately descoped** — reasoning in `docs/PHASES.md`. MongoDB aggregations are sufficient at this event volume.
- **Rate limiter is per-instance and in-memory** — multiplies by instance count when scaled.

Say **"production-shaped,"** never "production-grade."

---

## Further reading in this repo

| Doc | What's in it |
|---|---|
| [`PHASES.md`](PHASES.md) | Full build history, every bug, and why things were descoped |
| [`protocol.md`](protocol.md) | On-chain design rationale |
| [`security.md`](security.md) | Threat model, authority model, dependency audit |
| [`demo.md`](demo.md) | 12-minute live walkthrough |
| [`deployment.md`](deployment.md) | Devnet + cloud deployment and its gotchas |
