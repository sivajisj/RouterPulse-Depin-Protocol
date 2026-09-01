# RouterPulse — Testing & Verification Runbook

How to bring the whole system up and prove it works, from nothing.

Every command here has been run, and every expected output below is
copied from a real run — not written from memory. If your output differs
from what's shown, something genuinely changed.

**Total time:** ~20 minutes, most of it waiting on epochs and builds.

---

## What you're verifying

| Layer | How it's proven | Time |
|---|---|---|
| Economic math | 26 Rust unit tests | seconds |
| On-chain protocol | 40 integration tests vs a live validator | ~4 min |
| **Full lifecycle** | **21-step end-to-end script** | ~4 min |
| Indexer | Backfill + reconciliation against real chain data | ~1 min |
| API | 21 e2e tests | ~1 min |
| API under load | Concurrency + rate limiter | 15 s |
| Dashboard | Build + every route renders | ~2 min |

---

## 0. Prerequisites

```bash
rustc --version     # 1.79+
solana --version    # 1.18+ (Agave)
anchor --version    # must match anchor-lang in programs/routerpulse/Cargo.toml
node --version      # v20+
mongod --version    # 7.0+
redis-server -v
```

> **Anchor version must match the pinned `anchor-lang`.** If it doesn't,
> `anchor build` refuses to run and tells you which version to install:
> `avm install <version> && avm use <version>`.

On Linux, building the Anchor CLI from source also needs:

```bash
sudo apt-get install -y pkg-config libssl-dev libudev-dev
```

---

## 1. Start the datastores

Non-default ports, so nothing collides with a system-wide install:

```bash
mkdir -p /tmp/rp/{mongo,redis}
mongod --dbpath /tmp/rp/mongo --port 27117 --bind_ip 127.0.0.1 \
       --logpath /tmp/rp/mongod.log --fork
redis-server --port 6390 --dir /tmp/rp/redis --daemonize yes
```

**Verify:**

```bash
mongosh --port 27117 --quiet --eval 'db.runCommand({ping:1}).ok'   # → 1
redis-cli -p 6390 ping                                             # → PONG
```

---

## 2. Start the validator and deploy

```bash
solana-test-validator --reset          # terminal 1 — leave running
```

```bash
# terminal 2
solana config set --url http://127.0.0.1:8899
solana airdrop 50

cd routerpulse
anchor build
anchor deploy --provider.cluster http://127.0.0.1:8899
```

**Expected:**
```
Program Id: 4nVLSAiwNCBiepWwHdiafKcGzKHtaKu8YSPk24REG6d4
Deploy success
```

> **First clone?** The deploy keypair is gitignored, so `anchor build`
> generates a new one that won't match the committed `declare_id!`. The
> build says so. Fix with `anchor keys sync && anchor build`, then note
> that your program ID differs from the one above — that's expected.

---

## 3. Rust unit tests — the economic math

No validator needed; these are pure functions.

```bash
cd routerpulse
cargo test -p routerpulse --lib
```

**Expected:** `test result: ok. 26 passed; 0 failed`

### What the 26 cover

**`uptime.rs` — live scoring (drives suspension, not rewards)**

| Test | Asserts |
|---|---|
| `test_on_time_increases_score` | +1 on a punctual heartbeat |
| `test_late_decreases_score` | −10 on a late one |
| `test_score_caps_at_100` / `test_score_floors_at_0` | Saturation at both ends |
| `test_exactly_at_interval_is_on_time` | Boundary is inclusive |
| `test_one_second_over_is_late` | …and one second past is not |
| `test_should_suspend_at_threshold` | Auto-suspension fires at ≤ 20 |
| `test_uptime_percentage_*` | Perfect / partial / zero-count cases |
| `test_recovery_is_slow` | Recovery takes 10 good beats to undo one miss |
| `test_one_miss_wipes_ten_recoveries` | The asymmetry is deliberate |

**`math.rs` — the token economics**

| Test | Asserts |
|---|---|
| `tier_boundaries_are_inclusive_at_the_bottom_of_each_band` | No off-by-one at tier edges |
| `good_uptime_is_never_slashed_and_bad_uptime_always_is` | The tier table's core invariant |
| `apply_bps_computes_percentages` | Basic correctness |
| `apply_bps_truncates_rather_than_rounding_up` | Rounding favours the protocol, never the claimant |
| **`apply_bps_does_not_spuriously_overflow_at_max_amount`** | **Caught a real `u64` overflow at a 100% multiplier** |
| `emission_decays_once_per_year_of_epochs` | Geometric decay |
| `emission_is_flat_when_epochs_per_year_is_zero` | Degenerate config doesn't divide by zero |
| `nothing_vests_before_the_cliff` | Cliff is respected |
| `cliff_releases_linear_accrual_since_start_as_a_step` | Cliff releases accrued value as a jump |
| `vesting_is_linear_between_cliff_and_end` | Linear in the middle |
| `everything_vests_at_and_after_the_end` | Terminates at 100% |
| `zero_duration_vests_immediately_once_past_the_cliff` | Degenerate schedule |
| `vesting_never_exceeds_total_even_at_max_amount` | Cannot over-release |

That overflow test is worth calling out: the naive `apply_bps` overflowed
`u64` for large amounts even at a 100% multiplier — a no-op case. It was
caught here, before it ever reached a validator, and fixed with a `u128`
intermediate.

Also run the linter the way CI does:

```bash
cargo clippy -p routerpulse --lib -- -D warnings
```

---

## 4. On-chain integration tests

```bash
cd routerpulse
anchor test --skip-local-validator
```

**Expected:** `40 passing (4m)`

> **Four minutes is correct, not a hang.** Several tests wait out real
> epoch boundaries. Epoch closure is the mechanism the entire reward
> design rests on — mocking the clock would test the wrong thing.

> **Run this against a freshly `--reset` validator.** These tests assert
> on exact balance *deltas*; accumulated state from earlier runs makes
> them fail for reasons that have nothing to do with the code. If you see
> failures like `expected '10900000000' to equal '10000000000'`, that's
> what happened.

### All 40, by suite

**Protocol Initialization (2)**
- creates the protocol, reward mint, stake vault and treasury
- rejects a vesting duration shorter than its cliff

**Genesis Distribution (3)**
- mints the initial distribution so operators can bootstrap a stake
- rejects genesis minting from a non-authority
- enforces the genesis cap — the authority cannot mint unbounded supply

**Router Registration & Device Identity (3)**
- registers a router whose device key differs from the owner wallet
- rejects invalid latitude
- rejects device key rotation from a non-owner

**Staking (5)**
- blocks heartbeats from an uncollateralized router
- stakes collateral, moving real tokens into the protocol vault
- rejects a zero stake
- rejects unstaking more than is staked
- rejects an unstake that would drop an active router below the minimum

**Heartbeat (5)**
- first heartbeat activates the collateralized router
- rejects a replay within the same block
- rejects a signer that is not the registered device key
- rejects a wrong epoch number
- blocks heartbeats while the protocol is paused

**Epoch Rewards, Emissions and Vesting (9)**
- records heartbeats inside the current epoch
- rejects finalization before the epoch has ended
- rejects claiming before finalization
- finalizes once the epoch closes, opening the epoch's emission budget
- rejects double finalization
- claims the epoch into a vesting schedule — granting rights, not tokens
- rejects double claiming the same epoch
- mints only the vested portion, and only ever the un-released delta
- fully vests and then has nothing left to release

**Slashing (5)**
- opens an epoch with a single heartbeat, then goes dark
- finalizes the bad epoch into a reduced reward and a real slash
- executes the slash, moving collateral from the stake vault to the treasury
- rejects slashing the same epoch twice
- burns slashed collateral out of the treasury, reducing total supply

**Unstaking (2)**
- returns collateral from the vault to the operator
- rejects an unstake from a non-owner

**Admin Controls (6)**
- pauses and resumes the protocol
- updates the reward rate
- emits an auditable event when the protocol is paused and resumed
- records both the old and new reward rate on update
- rejects admin actions from a non-authority
- rejects a treasury burn from a non-authority

Note the shape: roughly **half of these assert that something is
refused.** A protocol is defined as much by what it rejects as by what it
allows.

---

## 5. ⭐ The full lifecycle

This is the one to run if you only run one. It plays out the entire
economic story and asserts at every step.

```bash
cd routerpulse
npm run lifecycle
```

Against devnet instead:

```bash
RPC_URL=https://api.devnet.solana.com npm run lifecycle
```

### What it does

Two routers are onboarded. One performs; one goes dark. The protocol
rewards the first, slashes the second, burns the proceeds, recovers a
compromised device key, and lets the good operator exit — then checks the
money adds up.

### Real output

```
▸ 1. Bootstrap — protocol, reward mint, stake vault, treasury
   ✅ protocol initialized — mint authority is the protocol PDA, supply starts at 0
      mint authority: 6KrwRxVVD3nu… (the PDA, not a human key)
      freeze authority: none — nobody can freeze balances

▸ 2. Genesis — the bootstrap problem
   ✅ operator funded — balance 1000.000 RTP
      genesis is hard-capped: 1000.000 of 100000.000 used

▸ 3. Onboarding — a good router and one that will fail
   ✅ both registered; device key ≠ owner wallet — a stolen router cannot move funds

▸ 4. Collateral — staking is a structural gate, not a policy
   ✅ uncollateralized router refused — heartbeat requires min_stake
   ✅ vault credited exactly 20.000 RTP across both routers

▸ 5. Uptime — the good router performs, the bad one goes dark
   ✅ good router: 2/2 heartbeats · bad router: 1/2
   ✅ heartbeat from the wrong device key rejected

▸ 6. Finalization — waiting 117s for epoch 0 to close
      good: 10000bps → reward 0.240, slash 0.000
      bad : 5000bps → reward 0.000, slash 1.000
   ✅ good uptime earns full reward, no slash
   ✅ sub-70% uptime earns nothing AND is slashed — same tier table drives both

▸ 7. Claim — creates an entitlement, moves no tokens
   ✅ supply unchanged — claiming grants rights, it does not mint
   ✅ double-claim rejected

▸ 8. Vesting — the only instruction that increases supply
   ✅ released 0.036 of 0.240 — a partial slice, as linear vesting should

▸ 9. Slashing — collateral actually moves, then is destroyed
   ✅ 1.000 RTP moved from stake vault to treasury
   ✅ double-slash rejected
   ✅ burned 1.000 — the penalty is deflationary, not a transfer to the treasury operator

▸ 10. Device recovery — rotate a compromised key
   ✅ rotated to a new device, version 1 — stake and history intact
   ✅ the old device key is dead

▸ 11. Governance — pause is enforced, and auditable
   ✅ pause actually blocks heartbeats
      event records 2000000 → 3000000, and the acting authority
   ✅ governance actions emit an auditable event, not just a log line

▸ 12. Exit — withdraw collateral above the minimum
   ✅ withdrew exactly 5.000 RTP

▸ 13. Reconciliation — does the money add up?
   ✅ on-chain supply 999.036 == totalMinted − totalBurned
      staked 14.000 · slashed 1.000 · burned 1.000

✅ 21 passed, 0 failed
```

### The four lines to point at in a demo

| Line | Why it matters |
|---|---|
| `uncollateralized router refused` | Collateral is enforced in the instruction, not by convention |
| `5000bps → reward 0.000, slash 1.000` | One table pays and punishes; 50% uptime earns nothing *and* costs stake |
| `supply unchanged — claiming grants rights` | No pre-minted pool exists to drain |
| `supply == totalMinted − totalBurned` | The books balance against the chain, not against our own bookkeeping |

---

## 6. Indexer

```bash
cd indexer
cp .env.example .env      # then edit
```

```
RPC_URL=http://127.0.0.1:8899
WS_URL=ws://127.0.0.1:8900
MONGO_URL=mongodb://127.0.0.1:27117
MONGO_DB=routerpulse_local
IDL_PATH=../routerpulse/target/idl/routerpulse.json
REDIS_URL=redis://127.0.0.1:6390
```

> **`WS_URL` is not optional locally.** `solana-test-validator` serves its
> websocket on **RPC port + 1** (8900), not the RPC URL with the scheme
> swapped — which is what `Connection` assumes, and gets right for real
> RPC providers. Omit it and live indexing silently never fires.

> **Use a per-cluster database name.** localnet and devnet derive
> identical PDAs but are entirely different accounts. Point the indexer
> at a new cluster without changing `MONGO_DB` and you merge two chains
> into one collection.

```bash
npm install && npm start
```

**Expected:**
```
[backfill] done: 13 signature(s), 12 event(s) applied.
[reconcile] protocol + 2 router(s) + 2 epoch(s) reconciled
✅ Indexer running.
```

**Verify it landed:**

```bash
mongosh --port 27117 routerpulse_local --quiet --eval '
  ["routers","epochs","events","protocol"].forEach(c =>
    print(c + ": " + db.getCollection(c).countDocuments()))'
```

### Prove reconciliation actually repairs things

This is the most interesting thing the indexer does. Corrupt the
projection by hand, then watch it heal:

```bash
mongosh --port 27117 routerpulse_local --quiet --eval '
  db.epochs.updateOne({}, {$unset: {finalized:"", rewardAmount:""}})'

cd indexer && npm run reconcile
```

**Expected** — it names the drift rather than silently patching:

```
[reconcile] epoch drift <pda>:1: finalized undefined -> true, reward undefined -> 240000000
```

---

## 7. API

```bash
cd api
cp .env.example .env    # set MONGO_DB to match the indexer's
npm install && npm run build && npm start
```

```bash
npm test
```

**Expected:** `21 passing, 0 failing`

> One test **skips** when there's only a single page of routers indexed —
> that's data-dependent, not a failure. Run the simulator first if you
> want all 21 to execute.

### All 21

| # | Test | What it really checks |
|---|---|---|
| 1 | `GET /health` returns ok with both dependencies up | Mongo *and* Redis are actually pinged, not assumed |
| 2 | `/api/v1/protocol` returns the reconciled protocol account | Reconciliation ran at least once |
| 3 | `/api/v1/protocol/epochs/current` derives a live epoch number | Client never re-implements the epoch formula |
| 4 | `/api/v1/routers` returns a page of indexed routers | Basic read path |
| 5 | router list respects the limit | Limit is clamped, not trusted |
| 6 | cursor pagination advances without repeating rows | *Skips without enough data* |
| 7 | `/api/v1/routers/:pda` returns that specific router | |
| 8 | `/api/v1/routers/:pda/epochs` returns a page | |
| 9 | unknown router PDA returns 404, not an empty 200 | A missing thing must not look like an empty thing |
| 10 | `/api/v1/analytics/network` aggregates router counts | |
| 11 | total staked is a precise string, not a lossy float | `$toDecimal`, not `$sum` on a string |
| 12 | `/api/v1/events` returns decoded events newest-first | |
| 13 | event feed is *actually* ordered newest-first | Caught a real bug: cursoring on `_id` sorts base58, not time |
| 14 | admin endpoint rejects an unauthenticated request | |
| 15 | `/api/v1/auth/challenge` issues a nonce message | |
| 16 | `/api/v1/auth/verify` accepts a valid signature, returns a JWT | Full ed25519 verification |
| 17 | issued token is a JWT | |
| 18 | authenticated non-authority wallet is refused (403) | **RBAC against on-chain state** |
| 19 | replaying a consumed challenge is rejected | Nonce is single-use |
| 20 | signature over the wrong message is rejected | |
| 21 | garbage bearer token is rejected | |

Tests 18–21 are the security core: signing in is not the same as being
authorized, a nonce cannot be replayed, and a signature over anything
other than the issued challenge is worthless.

### Every endpoint

| Method | Path | Auth |
|---|---|---|
| GET | `/health` | — |
| GET | `/api/v1/protocol` | — |
| GET | `/api/v1/protocol/epochs/current` | — |
| GET | `/api/v1/routers` (`?status=&owner=&cursor=&limit=`) | — |
| GET | `/api/v1/routers/:routerPda` | — |
| GET | `/api/v1/routers/:routerPda/epochs` | — |
| GET | `/api/v1/routers/:routerPda/heartbeats` | — |
| GET | `/api/v1/analytics/network` | — |
| GET | `/api/v1/analytics/regions` | — |
| GET | `/api/v1/analytics/epochs` | — |
| GET | `/api/v1/events` (`?name=&cursor=&limit=`) | — |
| GET | `/api/v1/transactions/:signature` | — |
| GET | `/api/v1/auth/challenge?wallet=` | — |
| POST | `/api/v1/auth/verify` | — |
| GET | `/api/v1/admin/audit` | **JWT + on-chain authority** |

Interactive docs at `http://localhost:3001/api/docs`.

### Verify auth by hand

```bash
API=http://localhost:3001
WALLET=$(solana address)

# 1. get a challenge
curl -s "$API/api/v1/auth/challenge?wallet=$WALLET"

# 2. unauthenticated admin access is refused
curl -s -o /dev/null -w "%{http_code}\n" "$API/api/v1/admin/audit"   # → 401
```

Signing requires a keypair, so the full round trip lives in
`api/test/run.ts` — it signs with `~/.config/solana/id.json`, exchanges
the signature for a JWT, and confirms the authority wallet gets **200**
while a freshly generated wallet gets **403**.

**Load test:**

> **The API must be running first** — the load test only generates
> traffic, it doesn't start anything. `cd api && npm run build && npm start`
> in another terminal. And note the API is on **3001**; 3000 is the
> dashboard.

```bash
npm run test:load

# against a deployed instance
API_URL=https://routerpulse-api.onrender.com npm run test:load

# heavier
CONCURRENCY=50 DURATION_S=30 npm run test:load
```

Real numbers from this stack (with cloud datastores):

```
requests     6437  (429/s)
  ok         838
  rate-limited 5599
  failed     0
latency: p50 82ms · p95 874ms · p99 1082ms
```

Two things to read from that: the **rate limiter works** (shed 87% of a
flood with zero errors), and the p50→p95 gap is dominated by **remote
datastore round-trips**, not the API. Point it at local Mongo/Redis and
the tail collapses.

---

## 8. Dashboard

```bash
cd web
cp .env.example .env   # NEXT_PUBLIC_API_URL=http://localhost:3001
npm install && npm run build && npm start
```

**Expected build output** — note the JS sizes, they're the point:

```
Route (app)                    Size    First Load JS
┌ ƒ /                        13.9 kB      116 kB      ← Socket.IO, live feed
├ ○ /operator                66.6 kB      257 kB      ← wallet adapter
├ ƒ /routers                   168 B      106 kB
├ ƒ /analytics                 168 B      106 kB
└ ƒ /explorer                  123 B      103 kB
```

Read-only routes cost ~168 B because they're Server Components. Only the
live feed and the operator page ship real JavaScript, and both have a
reason to.

**Verify every route:**

```bash
for p in / /routers /operator /analytics /explorer; do
  printf "%-12s " "$p"; curl -s -o /dev/null -w "%{http_code}\n" localhost:3000$p
done
```

All should be `200`.

### Wallet flow (manual — needs a browser)

1. Phantom → set network to **Localhost** (or Devnet)
2. Import the key from `~/.config/solana/id.json`
3. Open `/operator` → **Connect Wallet** → **Sign in with Solana**
4. The admin panel appears — you're the protocol authority
5. Connect any *other* wallet and the same endpoint returns **403**

That 403 is the demo. The API resolves authority against **live on-chain
state**, not a database role.

---

## 9. Make the network look alive

```bash
cd routerpulse/simulator
npm install && npm start
```

Three simulated routers with different failure rates. The 60%-failure one
will get suspended and slashed on its own — which is the cheapest way to
show slashing fire in a demo.

---

## Appendix A — instruction coverage

All 18 instructions, and where each is exercised.

| Instruction | Unit | Integration | Lifecycle | UI |
|---|---|---|---|---|
| `initialize_protocol` | | ✅ | ✅ | |
| `mint_genesis` | | ✅ | ✅ | |
| `register_router` | | ✅ | ✅ | ✅ |
| `rotate_device_key` | | ✅ | ✅ | ✅ |
| `heartbeat` | ✅ math | ✅ | ✅ | simulator |
| `stake` | | ✅ | ✅ | ✅ |
| `unstake` | | ✅ | ✅ | ✅ |
| `finalize_router_epoch` | ✅ math | ✅ | ✅ | |
| `claim_reward` | | ✅ | ✅ | ✅ |
| `claim_vested` | ✅ math | ✅ | ✅ | ✅ |
| `slash_router` | ✅ math | ✅ | ✅ | |
| `burn_treasury` | | ✅ | ✅ | |
| `pause_protocol` / `resume_protocol` | | ✅ | ✅ | |
| `update_reward_rate` | | ✅ | ✅ | |
| `apply_penalty` | | ✅ | | |
| `reinstate_router` | | ✅ | | |
| `decommission_router` | | ✅ | | |

Two gaps worth naming: `reinstate_router` and `decommission_router` are
covered by integration tests but not by the lifecycle script, and neither
has a UI. Nothing is entirely untested.

---

## Appendix B — the lifecycle script, step by step

`npm run lifecycle` runs 13 acts and makes 21 assertions.

| Act | Asserts | Proves |
|---|---|---|
| 1. Bootstrap | 1 | Mint authority is a PDA; no freeze authority; supply starts at 0 |
| 2. Genesis | 1 | Bootstrap is possible *and* hard-capped |
| 3. Onboarding | 1 | Device key ≠ owner wallet |
| 4. Collateral | 2 | Uncollateralized router refused; vault credited exactly |
| 5. Uptime | 2 | Divergent behaviour recorded; wrong device key rejected |
| 6. Finalization | 2 | Good uptime pays and isn't slashed; <70% pays nothing and is slashed |
| 7. Claim | 2 | **Supply unchanged**; double-claim rejected |
| 8. Vesting | 1 | Only a partial slice is released |
| 9. Slash & burn | 3 | Collateral moves; double-slash rejected; burn reduces supply |
| 10. Device recovery | 2 | Rotation works; **the old key is dead** |
| 11. Governance | 2 | Pause is enforced; the action is auditable |
| 12. Exit | 1 | Withdrawal is exact |
| 13. Reconciliation | 1 | `supply == totalMinted − totalBurned` |

### Tuning it

Constants at the top of `routerpulse/scripts/full-lifecycle.ts`:

```ts
const HEARTBEAT_INTERVAL = 60;   // on-chain floor
const EPOCH_DURATION     = 120;  // on-chain floor (2 × heartbeat interval)
```

**You cannot make this materially faster.** `MIN_HEARTBEATS_PER_EPOCH`
is 2 and `heartbeat_interval` has a 60s floor, so 120s is the shortest
legal epoch. The wait is the protocol, not the test.

---

## Appendix C — environment variables

**`indexer/.env`**

| Variable | Local | Notes |
|---|---|---|
| `RPC_URL` | `http://127.0.0.1:8899` | |
| `WS_URL` | `ws://127.0.0.1:8900` | **RPC port + 1** locally. Unset for real providers |
| `MONGO_URL` | `mongodb://127.0.0.1:27117` | |
| `MONGO_DB` | `routerpulse_local` | **One database per cluster** |
| `REDIS_URL` | `redis://127.0.0.1:6390` | Optional; without it there's no live fanout |
| `IDL_PATH` | `../routerpulse/target/idl/routerpulse.json` | Gitignored build output — copy it in when deploying |
| `RECONCILE_INTERVAL_MS` | `30000` | |
| `BACKFILL_PAGE_SIZE` | `1000` | |

**`api/.env`**

| Variable | Local | Notes |
|---|---|---|
| `PORT` | `3001` | |
| `MONGO_URL` / `MONGO_DB` | match the indexer | Reads the indexer's output |
| `REDIS_URL` | `redis://127.0.0.1:6390` | Auth nonces + live fanout |
| `JWT_SECRET` | *generate one* | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `JWT_EXPIRES_IN` | `1h` | |
| `CORS_ORIGINS` | `http://localhost:3000` | Exact origin, no trailing slash |
| `RATE_LIMIT_TTL_MS` / `RATE_LIMIT_MAX` | `60000` / `120` | |

> The committed default `JWT_SECRET` is `dev-only-change-me`. Anyone who
> reads this repo can forge sessions with it. Generate a real one for
> anything reachable from outside your machine.

**`web/.env`**

| Variable | Local |
|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:3001` |
| `NEXT_PUBLIC_RPC_URL` | `http://localhost:8899` |

Both are `NEXT_PUBLIC_*` because the browser needs them — they're baked
into the bundle at **build** time. Changing either requires a rebuild,
and nothing secret may go behind that prefix.

---

## Troubleshooting

Every one of these was hit for real while building this.

| Symptom | Cause | Fix |
|---|---|---|
| `DeclaredProgramIdMismatch` | Deploy keypair is gitignored; a fresh clone generates a new one | `anchor keys sync && anchor build` |
| Integration tests fail on balance deltas | Accumulated state from an earlier run | Restart validator with `--reset` |
| Live indexing never fires locally | `WS_URL` unset; validator's websocket is on port **8900** | Set `WS_URL=ws://127.0.0.1:8900` |
| Indexer dies with `429` | Public devnet RPC throttling | It retries with backoff now; for heavy use switch to a Helius/QuickNode endpoint |
| Indexer exits on startup | An index in the target DB conflicts with one it wants | It logs and continues now. A **unique** index on `routerId` is genuinely wrong here — drop it |
| Dashboard sends rejected instructions | Vendored IDL drifted from the deployed program | `cd web && npm run sync-idl`, rebuild |
| Deployed API 404s on every route | `app.listen(port)` binds localhost, unreachable in a container | Already fixed — binds `0.0.0.0`. The tell is `x-render-routing: no-server` in the headers |
| `BigInt literals are not available` | Package tsconfig targets es6 | Use `npm run lifecycle`, which overrides target to ES2020 |
| First request to hosted API 404s | Render free tier sleeps when idle | Ping `/health` every 5 min with UptimeRobot |

---

## One-shot verification

Everything except the browser step:

```bash
# assumes validator running + program deployed
cd routerpulse && cargo test -p routerpulse --lib          # 26 passing
cd routerpulse && anchor test --skip-local-validator       # 40 passing
cd routerpulse && npm run lifecycle                        # 21 passed
cd api        && npm test                                  # 21 passing
cd web        && npm run build                             # compiles clean
```

**87 automated tests + the 21-step lifecycle.** If all of those are
green, the system works end to end.
