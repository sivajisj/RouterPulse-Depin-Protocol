# RouterPulse — Complete Guide & Interview Prep

Everything about this project in one place: what it is, what changed from
the original prototype, how each layer works, and the questions an
interviewer will actually ask — with answers that hold up under
follow-up.

**Read the "Before vs After" section first.** The story of *what was
wrong and how you found it* is more compelling than the feature list, and
it's the part nobody else's portfolio project has.

---

## 1. The 30-second version

> RouterPulse is a Solana DePIN protocol where Wi-Fi routers stake
> collateral and earn epoch-scoped token rewards for cryptographically
> proven uptime. Sustained downtime gets slashed. Around it sits an
> event-driven indexer, a NestJS API, and a Next.js dashboard — so the
> whole thing is observable, not just deployable.

**The sentence that makes it interesting:**

> *"A router earns money by proving it was online."* Every word in that
> sentence had to be made unfakeable — and the first version failed at
> exactly one of them.

---

## 2. Before vs After — what actually changed

The original prototype worked, in the sense that it compiled and its
tests passed. It was also economically broken in a way tests didn't
catch.

| | Original prototype | Now |
|---|---|---|
| **Reward basis** | Lifetime uptime average | Epoch-scoped `RouterEpoch` record |
| **Reward asset** | Raw SOL from a vault | SPL token, PDA-owned mint |
| **Heartbeat signer** | Operator's own wallet | Separate device key |
| **Collateral** | None | Staking gates activation |
| **Downtime penalty** | Score decrement only | Real token slashing |
| **Payout timing** | Immediate | Cliff + linear vesting |
| **Supply control** | Unbounded vault | Per-epoch emission cap |
| **Emergency pause** | Flag existed, unenforced on heartbeat/claim | Enforced |
| **Governance trail** | `msg!` logs only | 19 events, all indexed |
| **Off-chain** | Nothing | Indexer + API + dashboard |
| **Tests** | ~20 | **87** |
| **Deployment** | Local only | devnet + Render + Vercel |

### The bug that motivated the rewrite

The original computed rewards as:

```
reward = elapsed_time × reward_rate × lifetime_uptime_percentage
```

`lifetime_uptime_percentage` came from counters on the router account.
When a router stopped sending heartbeats, **nothing recomputed it** —
there's no cron on a blockchain. A router with a good history could go
dark permanently and still present as ~100% healthy, accruing rewards for
time it spent offline.

**The fix wasn't a patch, it was a re-architecture:** rewards are now
scoped to a *closed epoch*. An epoch a router didn't participate in
simply has no `RouterEpoch` account — so there is nothing to claim. The
exploit isn't guarded against; it's structurally impossible.

> This is the single best thing to lead with. It shows you can find a
> flaw in your own design, and that you fix causes rather than symptoms.

---

## 3. Architecture

```
        Solana devnet  ← source of truth, always
              │
   ┌──────────┴───────────┐
   │                      │
 backfill            live websocket
(getSignaturesForAddress)  (onLogs)
   │                      │
   └──────────┬───────────┘
              ▼
      processSignature()   ← ONE code path, idempotent
              │
   ┌──────────┼────────────────┐
   ▼          ▼                ▼
 events    routers/epochs   transactions
 (raw,     (projections)    (idempotency gate)
  append-only)   ▲
                 │
        reconcile.ts (interval)
        re-reads chain accounts,
        overwrites projection,
        logs drift
              │
              ▼
      Redis pub/sub ──► NestJS API ──► Next.js dashboard
```

**The load-bearing idea:** MongoDB is a *projection*, never the truth.
Solana is the truth. Reconciliation exists because the event stream can
lose data — and in this project, it demonstrably did.

---

## 4. The lifecycle, step by step

### ① Registration — two identities
A router gets a **device key** distinct from the owner wallet.

*Why:* routers live in cafés and basements. Steal one and you get a key
that can only send heartbeats — never move funds. Recovery is one
owner-signed `rotate_device_key`; the router keeps its history and stake.

### ② Staking — collateral gates activation
`heartbeat`'s activating call requires `staked_amount >= min_stake`.

*Why:* you cannot slash someone who staked nothing. Without collateral,
the entire penalty system is decorative.

### ③ Heartbeats — proof, scoped to a window
Each lands in the `RouterEpoch` PDA for the current epoch.

### ④ Finalization — one table decides reward *and* punishment

| Uptime | Reward multiplier | Slash |
|---|---|---|
| ≥ 99% | 100% | — |
| 95–99% | 90% | — |
| 90–95% | 75% | 1% |
| 80–90% | 50% | 5% |
| 70–80% | 25% | 8% |
| **< 70%** | **0%** | **10%** |

*Why one table:* marginal downtime is survivable, sustained downtime is
expensive. That asymmetry **is** the economic argument for keeping
hardware online.

`finalize_router_epoch` is **permissionless** — it reads only public
state and writes a pure function of it, so anyone can crank it. That
removes the operator as a required party in their own payout.

### ⑤ Claiming — mints nothing
`claim_reward` creates a vesting grant. Supply doesn't move.

### ⑥ Vesting — the only path to new supply
`claim_vested` is the **sole instruction that increases supply**, and
only by the slice that has actually vested.

*Why:* there is no pre-minted pool anywhere to drain. Supply grows only
in lockstep with proven work.

### ⑦ Slashing & burning
Slashed collateral moves to the treasury; `burn_treasury` destroys it.
Deflationary for every holder rather than a transfer to whoever controls
the treasury.

---

## 5. Interview questions, by depth

### On-chain / protocol

**Q: Why epochs instead of a running average?**
> An average has no one to recompute it when heartbeats stop — there's no
> cron on-chain. A router could go dark and keep looking healthy. Epochs
> invert it: reward is derived from a closed window, and a window you
> didn't participate in has no record to claim against.

**Q: Why is the device key separate from the owner wallet?**
> Physical security. Routers sit in public places. If the wallet signed
> heartbeats, stealing hardware would mean stealing spending authority.
> Split identity means a compromised device can only send heartbeats, and
> `rotate_device_key` recovers without losing history or stake.

**Q: Walk me through your PDA scheme.**
> `protocol` is a singleton. `router` is derived from (owner, router_id),
> so identity is the address itself. `router_epoch` from (router,
> epoch_number), which is what makes per-epoch accounting possible.
> Bumps are stored and reused rather than re-derived, and every
> instruction validates seeds — a substituted account fails Anchor's
> constraint before the handler body runs.

**Q: Where do you use CPI, and how do you sign?**
> SPL Token for transfer, mint_to and burn. The protocol PDA is the mint
> and vault authority, so those calls use `invoke_signed` with the
> protocol seeds. The mint authority being a PDA is deliberate: no human
> key can issue tokens outside `claim_vested`.

**Q: How do you prevent overflow?**
> Checked arithmetic everywhere, propagating a custom error instead of
> panicking. `apply_bps` uses a `u128` intermediate — the naive `u64`
> version overflowed at a 100% multiplier for large amounts, which a unit
> test caught before it ever reached a validator.

**Q: What's a BPF stack frame limit?** *(they may not ask — you should raise it)*
> 4KB per frame. `slash_router`'s account validation exceeded it once
> `Protocol` grew. The alarming part is the build **printed an error and
> still emitted a working `.so`** — if I'd trusted the exit code I'd have
> shipped undefined behaviour. Fixed by boxing the account onto the heap.

### Backend / distributed systems

**Q: How do you guarantee you don't double-process an event?**
> Each signature is atomically claimed with a unique-key insert before
> any event is written. A duplicate claim stops immediately. That matters
> concretely because one projection field uses `$inc` — replaying would
> silently inflate a counter, unlike the `$set` fields which are
> naturally idempotent.

**Q: What happens if the indexer misses an event?**
> It did, in practice. A transient RPC `null` was treated as a permanent
> failure and the signature was marked processed forever. An epoch sat in
> MongoDB marked `claimed` with no reward while the chain had it
> finalized. Two fixes: don't claim a signature on a transient null, and
> extend reconciliation to cover epochs. Reconciliation is the backstop —
> it re-reads chain state on an interval and overwrites the projection.

**Q: Why cursor pagination rather than offset?**
> Offset drifts. The indexer writes concurrently with API reads, so rows
> shift between pages and users see duplicates or gaps. A cursor anchored
> to a sort key is stable. I also had to fix my own first attempt — I
> cursored on `_id`, but base58 signatures don't sort chronologically, so
> "newest first" paginated in arbitrary order.

**Q: How does your auth work?**
> Sign-In-With-Solana: server issues a nonce, the wallet signs it as a
> *message* (not a transaction — costs nothing, moves no funds), and the
> signature is verified with ed25519 and exchanged for a JWT. The nonce is
> single-use and expires in 5 minutes.

**Q: How is authorization decided?**
> This is the part I'd highlight. There's no role column anyone can edit:
> the guard compares the session wallet against the protocol authority as
> **derived from chain state** — the `protocol` projection the indexer
> maintains from events and the reconcile pass. If the authority rotates
> to a multisig tomorrow, access follows automatically with nothing to
> redeploy and no migration.

> **Follow-up you should expect: "So you hit an RPC on every admin
> request?"** No — it reads the projection, so it's a single indexed
> Mongo lookup. That's deliberate. An RPC per admin call would add
> latency to every request and would take the admin API down whenever the
> RPC provider was down, which is trading a real availability property
> for a freshness one I don't need. The cost is that a rotation lands at
> indexer latency rather than instantly, and reconciliation bounds how
> stale that can get. If the threat model demanded instant revocation I'd
> read the account directly and cache it with a short TTL — but I'd want
> that to be a decision, not an accident.

### Frontend

**Q: Why Server Components?**
> Read-only pages have no reason to ship JavaScript. They fetch on the
> server and send HTML — about 168 bytes of route JS. Only two things are
> client-side and both have a reason: the live feed needs a persistent
> socket, and the operator page is scoped to a wallet the server can't
> know about.

**Q: How do you handle token amounts in the UI?**
> They never touch `Number`. They're base-unit strings with 9 decimals
> that routinely exceed `MAX_SAFE_INTEGER`; formatting goes through
> `BigInt`. Aggregations in MongoDB use `$toDecimal` for the same reason —
> a plain `$sum` on a string field silently coerces to a double.

---

## 6. Questions *you* should ask back

Asking these signals you think about systems, not just features.

- *"How do you handle RPC provider failover in production — do you run your own validators?"*
- *"How much of your indexing is event-driven vs. account-polling, and where have you been bitten?"*
- *"What does your upgrade authority setup look like — multisig threshold, timelock?"*
- *"How do you decide what belongs on-chain vs off-chain as the protocol grows?"*

---

## 7. If they push on weaknesses

Say these **before** being asked. Volunteering gaps reads as senior.

| Gap | The honest answer |
|---|---|
| Upgrade authority is one keypair | *"Biggest real gap. Production needs a multisig with a timelock. It's the first thing I'd fix."* |
| No observability | *"No OpenTelemetry or metrics. I'd instrument the indexer first — indexer lag is the metric that actually predicts user-visible staleness."* |
| Indexer not hosted | *"The site stays up without it, but new activity stops flowing. Needs an always-on worker."* |
| ClickHouse / DEX descoped | *"MongoDB aggregations are sufficient at this event volume. I'd move to ClickHouse when per-event analytics outgrow it — the reasoning is written down in PHASES.md rather than pretending it was always the plan."* |
| Rate limiter in-memory | *"Per-instance, so the effective limit multiplies by instance count. Needs a shared store."* |

**Never say "production-grade."** Say **"production-shaped."** The
distinction is real and interviewers notice both the accuracy and the
self-awareness.

---

## 8. Numbers you can defend

| | |
|---|---|
| Instructions / accounts / events / errors | 18 / 6 / 19 / 46 |
| Rust | ~2,950 lines |
| TypeScript | ~3,690 lines |
| On-chain integration tests | 40 |
| Rust unit tests | 26 |
| API e2e tests | 21 |
| **Total** | **87** + load test |
| Load test | p50 70ms, p95 937ms; limiter shed 87% of a 429 req/s flood, zero errors |

---

## 9. The six bugs — your best material

1. **BPF stack overflow** — build errored *and still emitted a working binary*
2. **Bootstrap deadlock** — staking needed tokens, minting needed vesting, vesting needed staking; nobody could get the first token
3. **Indexer losing events permanently** — transient null marked a signature done forever
4. **`u64` overflow** in `apply_bps` at a 100% multiplier
5. **`app.listen()` on localhost** — green deploy, 404 everywhere; the header told the truth while the status code lied
6. **Foreign UNIQUE index** on a shared Atlas cluster, incompatible with PDA-based identity

**The closing line:**

> *"Every one of those came from running the system, not reading it. The
> reconciliation layer exists because the event stream genuinely lost
> data — I watched it happen, then built for it."*
