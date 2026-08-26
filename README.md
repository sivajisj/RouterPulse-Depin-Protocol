# RouterPulse

A trustless Wi-Fi router uptime tracking and reward distribution protocol built on Solana.

Inspired by the real infrastructure problem that Wi-Fi networks like Wifi Dabba are solving , operators currently self-report uptime with no way to verify it. RouterPulse replaces that with cryptographic proof stored on-chain.

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

---

## Tech Stack

| Layer | Technology |
|---|---|
| On-chain program | Rust + Anchor 0.30 |
| Blockchain | Solana |
| Simulator + Tests | TypeScript + Node.js |
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
│   ├── state/
│   │   ├── protocol.rs               global config PDA (epoch clock lives here)
│   │   ├── router.rs                 per-router PDA (owner + device identity)
│   │   └── epoch.rs                  per-router-per-epoch reward record
│   └── instructions/
│       ├── initialize_protocol.rs    bootstrap the protocol
│       ├── register_router.rs        onboard a router + its device key
│       ├── heartbeat.rs              device proves router is online
│       ├── finalize_router_epoch.rs  permissionless: close a finished epoch
│       ├── claim_reward.rs           operator collects one epoch's reward
│       ├── rotate_device_key.rs      owner recovers a lost/compromised device
│       ├── apply_penalty.rs          admin penalizes bad router
│       └── admin.rs                  pause, reinstate, decommission
├── simulator/
│   └── src/
│       ├── index.ts                  spawns all routers
│       ├── router.ts                 RouterSimulator class (owner + device identity)
│       └── config.ts                 wallet, program, epoch-number helpers
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

# Anchor
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install latest && avm use latest

# Node.js
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 20 && nvm use 20

# Yarn
npm install -g yarn
```

Verify everything is installed:

```bash
rustc --version    # 1.79+
solana --version   # 1.18+
anchor --version   # 0.30+
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

# Build the program
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
solana airdrop 10
anchor test --skip-local-validator
```

You should see 20 tests passing.

**Terminal 2 — run the simulator**

```bash
cd simulator
npm start
```

You will see three routers sending live heartbeats on-chain:

```
[router-mumbai-001]    ✅ #1 | score: 100 | status: active
[router-delhi-001]     ❌ missed (total: 1)
[router-bangalore-001] 🔴 SUSPENDED — stopping
```

Press Ctrl+C to stop.

---

## Run Unit Tests (No Validator Needed)

```bash
cargo test -p routerpulse
```

12 pure math tests for the uptime score calculation.

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

## Epoch Reward Formula (drives payouts)

```
epoch_number        =  (now - genesis_time) / epoch_duration            [same on client and program]
expected_heartbeats =  epoch_duration / heartbeat_interval
uptime_bps          =  min(heartbeats_in_epoch, expected_heartbeats) × 10000 / expected_heartbeats
reward               =  epoch_duration × reward_rate × uptime_bps / 10000
```

`heartbeats_in_epoch` only ever counts heartbeats that actually landed inside that epoch's `[start_time, end_time)` window, recorded on a dedicated `RouterEpoch` PDA. A router that goes silent simply never accrues a record — and therefore never a reward — for the epochs it missed, instead of coasting on a stale lifetime average. `finalize_router_epoch` locks the numbers in once the window closes (anyone can call it — it's a pure function of already-public on-chain state); `claim_reward` then pays out that exact, immutable amount exactly once.

---

## Troubleshooting

| Error | Fix |
|---|---|
| `anchor: command not found` | Run `source ~/.bashrc` |
| `Connection refused` | Start `solana-test-validator` first |
| `Account does not exist` | Run `anchor test` before the simulator |
| `HeartbeatTooSoon` | Wait 1 second between heartbeats |
| `RouterSuspended` | Admin must call reinstate_router |
| `InsufficientVaultBalance` | Fund the vault with SOL |
| `InvalidDeviceSigner` | Heartbeat must be signed by `router.device_pubkey`, not the owner wallet |
| `WrongEpochNumber` | Recompute epoch_number from `protocol.genesisTime`/`epochDuration` right before sending |
| `EpochNotEnded` | `finalize_router_epoch` can't run until `now >= router_epoch.end_time` |
| `EpochNotFinalized` / `EpochAlreadyClaimed` | Finalize before claiming; each epoch can only be claimed once |

---

## Full Setup Guide

For detailed setup instructions, troubleshooting, and demo walkthrough see [SETUP_AND_RUN_GUIDE.md](./routerpulse/SETUP_AND_RUN_GUIDE.md)
