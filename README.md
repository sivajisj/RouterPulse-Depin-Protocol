# RouterPulse

A trustless Wi-Fi router uptime tracking and reward distribution protocol built on Solana.

Inspired by the real infrastructure problem that Wi-Fi networks like Wifi Dabba are solving , operators currently self-report uptime with no way to verify it. RouterPulse replaces that with cryptographic proof stored on-chain.

## The stack

```
Solana program (Rust/Anchor)      routerpulse/   epochs, staking, slashing, vesting, emissions
        │
        ├── simulator             routerpulse/simulator/   fake routers, full lifecycle
        │
        ▼
   indexer (Node/TS)              indexer/       decodes events → MongoDB, reconciles vs chain
        │
        ├──────────────▶ Redis pub/sub
        ▼                    │
   API (NestJS)              │     api/          REST + WebSocket, SIWS auth, on-chain RBAC
        │◀───────────────────┘
        ▼
   Dashboard (Next.js 14)         web/           Server Components, live feed, router map
```

| Directory | What it is |
|---|---|
| [`routerpulse/`](routerpulse/) | The Anchor program, simulator, and integration tests (documented below) |
| [`indexer/`](indexer/README.md) | Event-driven indexer: Solana → MongoDB, with backfill and reconciliation |
| [`api/`](api/README.md) | NestJS REST + WebSocket API, Sign-In-With-Solana auth, RBAC bound to on-chain authority |
| [`web/`](web/README.md) | Next.js 14 dashboard — network overview, router explorer, analytics, live event feed |
| [`infrastructure/`](infrastructure/README.md) | Docker Compose stack and CI notes |
| [`docs/PHASES.md`](docs/PHASES.md) | The full roadmap: what's built, what's not, and the real bugs found along the way |
| [`docs/security.md`](docs/security.md) | Threat model, authority model, dependency audit, and what a real audit would still need |
| [`docs/protocol.md`](docs/protocol.md) | On-chain design rationale — why epochs, why split identity, why the tier table |

**Run the whole off-chain stack:**

```bash
solana-test-validator --reset                      # terminal 1
cd routerpulse && anchor build && anchor keys sync && anchor build && anchor deploy
docker compose up --build                          # terminal 2 — Mongo, Redis, indexer, API, web
```

Dashboard at `localhost:3000`, API docs at `localhost:3001/api/docs`. See
[infrastructure/README.md](infrastructure/README.md) for why the validator
runs on the host rather than in compose.

---

## How It Works

Every router's **device key** — not the operator's wallet — sends a signed heartbeat transaction every few seconds. The program records that timestamp permanently on Solana. Nobody can fake it or change it after the fact.

Two independent systems consume that heartbeat:

```
Router device signs heartbeat
      ↓
Solana program records it in the Router PDA
      ↓                                   ↓
Live uptime score                  RouterEpoch PDA for the
(+1 on time, -10 late,             CURRENT epoch gets its
drives auto-suspension)            heartbeat counter incremented
      ↓                                   ↓
Router auto-suspended         Once the epoch's time window
if score <= 20                passes, anyone can call
                               finalize_router_epoch, which
                               locks in uptime% and reward from
                               heartbeats actually seen that epoch
                                   ↓
                          Operator claims that epoch's reward —
                          exactly once, from an immutable record
```

Rewards are never computed from a lifetime average that can go stale while a router is silently offline — see [docs/protocol.md](docs/protocol.md) for why that matters and how the epoch design closes it.

Device identity is deliberately separate from the operator wallet: `register_router` takes a `device_pubkey`, `heartbeat` requires that key to sign (not the owner), and `rotate_device_key` (owner-signed) recovers a lost or compromised device without re-registering the router.

### Real tokenomics, not a lamport transfer

A router can't heartbeat at all until its operator has posted collateral — `stake` moves real SPL tokens into a protocol-owned vault, and `heartbeat`'s first (activating) call structurally requires `staked_amount >= min_stake`. That's what makes the next part meaningful:

```
finalize_router_epoch reads uptime_bps for the epoch
      ↓
looks up (reward_multiplier, slash_%) from ONE performance-tier table
      ↓                                        ↓
reward = base × uptime × multiplier      slash = staked × slash_%
capped by the epoch's emission budget    executed by slash_router (CPI:
(extra routers dilute a fixed pool,      stake_vault → treasury)
they don't inflate supply)
      ↓
claim_reward converts the epoch into a cliff+linear vesting grant
— no tokens move yet
      ↓
claim_vested mints exactly the newly-vested slice to the operator
— the ONLY instruction in the program that increases supply
```

Reward and slash come from the same lookup table on purpose: 90–99% uptime costs a quarter of the reward, but sub-70% uptime earns nothing *and* slashes 10% of stake — marginal downtime is survivable, sustained downtime is expensive. `burn_treasury` (authority-gated) permanently destroys slashed collateral, so a bad operator's penalty is deflationary for every holder, not a transfer to whoever controls the treasury.

The mint authority is the protocol PDA itself — no human key can ever issue reward tokens outside `claim_vested`, and there's a hard-capped, authority-gated `mint_genesis` purely to solve the bootstrap problem (staking requires holding tokens; the only other mint path is vesting, which requires having already staked — nobody could ever get the first token without a genesis allocation).

See [docs/protocol.md](docs/protocol.md) for the full design rationale, including two real bugs this design work found and fixed along the way (a bootstrap deadlock, and a BPF stack-frame overflow the build silently allowed).

---

## Tech Stack

| Layer | Technology |
|---|---|
| On-chain program | Rust + Anchor 1.0 (`anchor-lang` / `anchor-spl`) |
| Token layer | SPL Token (mint, transfer, mint_to, burn — all via CPI) |
| Blockchain | Solana |
| Simulator + Tests | TypeScript + Node.js + `@solana/spl-token` |
| Local network | solana-test-validator |

---

## Project Structure

```
routerpulse/
├── programs/routerpulse/src/
│   ├── lib.rs                        all instructions wired here
│   ├── uptime.rs                     live score calculation (pure math)
│   ├── errors.rs                     custom error codes
│   ├── constants.rs                  shared numeric constants
│   ├── math.rs                       pure economic math (tiers, emissions, vesting)
│   ├── state/
│   │   ├── protocol.rs               global config PDA (epoch clock + tokenomics config)
│   │   ├── router.rs                 per-router PDA (owner + device identity + stake mirror)
│   │   ├── epoch.rs                  per-router-per-epoch reward + slash record
│   │   ├── stake.rs                  per-router collateral position
│   │   ├── vesting.rs                per-epoch reward entitlement (cliff + linear)
│   │   └── emission.rs               per-epoch emission budget
│   └── instructions/
│       ├── initialize_protocol.rs    bootstrap protocol, reward mint, stake vault, treasury
│       ├── register_router.rs        onboard a router + its device key
│       ├── heartbeat.rs              device proves router is online (gated on min_stake)
│       ├── finalize_router_epoch.rs  permissionless: close an epoch, lock in reward + slash
│       ├── claim_reward.rs           converts a finalized epoch into a vesting grant
│       ├── claim_vested.rs           mints the newly-vested slice (only place supply grows)
│       ├── stake.rs / unstake.rs     post / withdraw collateral (real SPL CPI)
│       ├── slash_router.rs           executes a locked-in slash (stake_vault → treasury)
│       ├── burn_treasury.rs          admin: permanently burns slashed collateral
│       ├── mint_genesis.rs           admin: hard-capped bootstrap distribution
│       ├── rotate_device_key.rs      owner recovers a lost/compromised device
│       ├── apply_penalty.rs          admin penalizes bad router
│       └── admin.rs                  pause, reinstate, decommission
├── simulator/
│   └── src/
│       ├── index.ts                  spawns all routers, bootstraps genesis tokens
│       ├── router.ts                 RouterSimulator: identity, staking, epoch settlement
│       └── config.ts                 wallet, program, PDA + epoch-number helpers
├── tests/
│   └── routerpulse.ts                integration tests incl. attack scenarios
└── scripts/
    ├── deploy.sh                     devnet deployment
    └── demo.sh                       demo script
```

See [docs/PHASES.md](docs/PHASES.md) for the full production roadmap (this repo started life as a hackathon-style prototype and is being hardened phase by phase) and [docs/protocol.md](docs/protocol.md) for the on-chain design rationale.

---

## Prerequisites

Install these before getting started.

```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env

# Solana CLI
sh -c "$(curl -sSfL https://release.solana.com/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Anchor — building the CLI from source needs these system libs on Linux
sudo apt-get update && sudo apt-get install -y pkg-config libssl-dev libudev-dev
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install latest && avm use latest
# this project pins anchor-lang 1.0.1 — anchor build/test will tell you to
# `avm install 1.0.1 && avm use 1.0.1` if your active CLI version doesn't match

# Node.js
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 20 && nvm use 20

# Yarn
npm install -g yarn
```

Verify everything is installed:

```bash
rustc --version    # 1.79+
solana --version   # 1.18+ (Agave/Anza)
anchor --version   # matches the version pinned in programs/routerpulse/Cargo.toml
node --version     # v20+
```

---

## Setup

```bash
# Clone the repo
git clone https://github.com/sivajisj/RouterPulse-Depin-Protocol.git
cd RouterPulse-Depin-Protocol/routerpulse

# Install dependencies
yarn install
cd simulator && npm install && cd ..

# Build the program (auto-generates target/deploy/routerpulse-keypair.json
# on first run — deploy keypairs are gitignored on purpose)
anchor build

# The freshly generated keypair won't match the declare_id!() committed in
# source — anchor build will tell you so. Fix it in one command, then rebuild:
anchor keys sync
anchor build
```

---

## Running Locally

**Terminal 1 — start the local validator**

```bash
solana-test-validator --reset
```

Keep this running. Do not close it.

**Terminal 2 — run the tests**

```bash
solana config set --url localhost
solana airdrop 20
anchor test --skip-local-validator
```

You should see the full suite passing (38 integration tests as of Phase 2). It takes several minutes for real — several tests deliberately wait out a genuine ~2 minute epoch window and a full vesting period rather than mocking the clock, because that's the actual behavior being verified.

**Terminal 2 — run the simulator**

```bash
cd simulator
npm start
```

You will see three routers register, stake collateral (topping up from the genesis allocation if needed), and send live heartbeats on-chain:

```
[router-delhi-001]     staked 1000000000 — now at protocol minimum
[router-mumbai-001]    ✅ #1 | score: 100 | status: active | epoch: 4 | staked: 1000000000
[router-delhi-001]     ❌ missed (total: 1)
[router-bangalore-001] 🔴 SUSPENDED — stopping
[router-bangalore-001] 🔒 epoch 3 finalized | uptime_bps: 5000 | reward: 0 | slash: 50000000
[router-bangalore-001] ⚔️  slashed 50000000 for epoch 3
[router-mumbai-001]    🎟️  epoch 3 reward granted to vesting
[router-mumbai-001]    💰 vested tokens minted for epoch 3
```

Press Ctrl+C to stop.

---

## Run Unit Tests (No Validator Needed)

```bash
cargo test -p routerpulse
```

26 pure-math tests: live uptime scoring, and the tokenomics module (`math.rs`) — performance-tier boundaries, basis-point rounding direction, emission decay, and vesting cliff/linear/saturation behavior.

---

## Deploy to Devnet

```bash
bash scripts/deploy.sh
```

---

## What the Simulator Shows

Three routers run in parallel with different failure rates:

| Router | Failure Rate | Behavior |
|---|---|---|
| router-mumbai-001 | 5% | Stays healthy, score near 100 |
| router-delhi-001 | 30% | Fluctuates, some misses |
| router-bangalore-001 | 60% | Score drops, gets auto-suspended |

Auto-suspension happens on-chain when the score reaches 20. No manual step needed — the program enforces it.

---

## Uptime Score (live, drives suspension only)

```
On time heartbeat  →  score + 1  (max 100)
Late heartbeat     →  score - 10 (min 0)
Score hits 20      →  router auto-suspended
```

## Epoch Reward & Slash Formula (drives payouts and penalties)

```
epoch_number        =  (now - genesis_time) / epoch_duration            [same on client and program]
expected_heartbeats =  epoch_duration / heartbeat_interval
uptime_bps          =  min(heartbeats_in_epoch, expected_heartbeats) × 10000 / expected_heartbeats

(reward_multiplier, slash_bps)  =  performance_tier(uptime_bps)          [one lookup table, math.rs]

reward  =  min( epoch_duration × reward_rate × uptime_bps/10000 × reward_multiplier/10000,  emission_remaining )
slash   =  staked_amount × slash_bps / 10000
```

| Uptime | Reward multiplier | Slash |
|---|---|---|
| ≥ 99% | 100% | 0% |
| 95–99% | 90% | 0% |
| 90–95% | 75% | 1% |
| 80–90% | 50% | 5% |
| 70–80% | 25% | 8% |
| < 70% | 0% | 10% |

`heartbeats_in_epoch` only ever counts heartbeats that actually landed inside that epoch's `[start_time, end_time)` window, recorded on a dedicated `RouterEpoch` PDA. A router that goes silent simply never accrues a record — and therefore never a reward — for the epochs it missed, instead of coasting on a stale lifetime average. `finalize_router_epoch` locks both numbers in once the window closes (anyone can call it — it's a pure function of already-public on-chain state, capped by that epoch's `EmissionSchedule` budget); `claim_reward` converts the locked-in reward into a vesting grant exactly once; `slash_router` executes the locked-in slash exactly once.

---

## Troubleshooting

| Error | Fix |
|---|---|
| `anchor: command not found` | Run `source ~/.bashrc` |
| `Connection refused` | Start `solana-test-validator` first |
| `Account does not exist` | Run `anchor test` before the simulator |
| `HeartbeatTooSoon` | Wait 1 second between heartbeats |
| `RouterSuspended` | Admin must call reinstate_router |
| `InvalidDeviceSigner` | Heartbeat must be signed by `router.device_pubkey`, not the owner wallet |
| `WrongEpochNumber` | Recompute epoch_number from `protocol.genesisTime`/`epochDuration` right before sending |
| `EpochNotEnded` | `finalize_router_epoch` can't run until `now >= router_epoch.end_time` |
| `EpochNotFinalized` / `EpochAlreadyClaimed` | Finalize before claiming; each epoch can only be claimed once |
| `InsufficientStake` | Router hasn't posted `protocol.minStake` yet — call `stake` before the first heartbeat |
| `StakeLocked` | `unstake` can't run until `now >= stake.lockedUntil` |
| `UnstakeBelowMinimum` | An active router must stay collateralized — decommission it first, or unstake less |
| `EpochNotFinalized` (on slash) / `EpochAlreadySlashed` | Finalize before slashing; each epoch is slashed at most once |
| `NothingVested` | Nothing new has vested since the last `claim_vested` — wait past the cliff or for more time to pass |
| `GenesisAllocationExhausted` | The fixed bootstrap allocation is used up — from here, tokens only come from vesting |
| `InvalidRewardMint` | An account's mint doesn't match `protocol.rewardMint` — check you derived the right PDAs |

---

## Full Setup Guide

For detailed setup instructions, troubleshooting, and demo walkthrough see [SETUP_AND_RUN_GUIDE.md](./routerpulse/SETUP_AND_RUN_GUIDE.md)
