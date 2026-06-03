# RouterPulse

A trustless Wi-Fi router uptime tracking and reward distribution protocol built on Solana.

Inspired by the real infrastructure problem that Wi-Fi networks like Wifi Dabba are solving — operators currently self-report uptime with no way to verify it. RouterPulse replaces that with cryptographic proof stored on-chain.

---

## How It Works

Every router sends a signed heartbeat transaction every few seconds. The program records that timestamp permanently on Solana. Nobody can fake it or change it after the fact. Rewards are calculated automatically based on verified uptime — no trust required between the operator and the network.

```
Router sends heartbeat
      ↓
Solana program records timestamp in PDA
      ↓
Uptime score updated (on time +1, late -10)
      ↓
Operator claims rewards based on verified uptime
```

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
│   ├── lib.rs                      all instructions wired here
│   ├── uptime.rs                   score calculation (pure math)
│   ├── errors.rs                   custom error codes
│   ├── state/
│   │   ├── protocol.rs             global config PDA
│   │   └── router.rs               per-router PDA
│   └── instructions/
│       ├── initialize_protocol.rs  bootstrap the protocol
│       ├── register_router.rs      onboard a router device
│       ├── heartbeat.rs            router proves it is online
│       ├── claim_reward.rs         operator collects rewards
│       ├── apply_penalty.rs        admin penalizes bad router
│       └── admin.rs                pause, reinstate, decommission
├── simulator/
│   └── src/
│       ├── index.ts                spawns all routers
│       ├── router.ts               RouterSimulator class
│       └── config.ts               wallet and program loader
├── tests/
│   └── routerpulse.ts              integration tests
└── scripts/
    ├── deploy.sh                   devnet deployment
    └── demo.sh                     demo script
```

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

## Uptime Score

```
On time heartbeat  →  score + 1  (max 100)
Late heartbeat     →  score - 10 (min 0)
Score hits 20      →  router auto-suspended
```

## Reward Formula

```
uptime %  =  (heartbeats sent - missed) × 100 / total heartbeats
reward    =  elapsed seconds × reward rate × uptime % / 100
```

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

---

## Full Setup Guide

For detailed setup instructions, troubleshooting, and demo walkthrough see [SETUP_AND_RUN_GUIDE.md](./SETUP_AND_RUN_GUIDE.md)
