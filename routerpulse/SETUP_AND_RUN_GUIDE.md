# RouterPulse — Setup, Run & Demo Guide

> Complete guide to set up, run, test, and simulate RouterPulse from scratch.

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Blockchain | Solana | Fast, cheap, parallel execution |
| Smart Contract | Anchor 0.30 | Rust framework for Solana programs |
| Language (on-chain) | Rust | Memory safe, no overflow in BPF |
| Language (off-chain) | TypeScript | Node.js simulator and tests |
| Test Framework | Mocha + Chai | Anchor integration tests |
| Local Network | solana-test-validator | Local Solana node for development |

---

## Prerequisites

```bash
# 1. Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
rustc --version   # 1.79+

# 2. Solana CLI
sh -c "$(curl -sSfL https://release.solana.com/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana --version  # 1.18+

# 3. Anchor
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install latest && avm use latest
anchor --version  # 0.30+

# 4. Node.js
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 20 && nvm use 20
node --version    # v20+

# 5. Yarn
npm install -g yarn
```

---

## Project Structure

```
routerpulse/
├── programs/routerpulse/src/
│   ├── lib.rs                        entry point — all instructions wired here
│   ├── uptime.rs                     pure math module — live score calculation
│   ├── errors.rs                     custom error codes
│   ├── constants.rs                  shared numeric constants
│   ├── state/
│   │   ├── protocol.rs               global singleton PDA (epoch clock lives here)
│   │   ├── router.rs                 per-router PDA + RouterStatus enum + device identity
│   │   └── epoch.rs                  per-router-per-epoch reward record
│   └── instructions/
│       ├── initialize_protocol.rs    bootstrap the protocol
│       ├── register_router.rs        onboard a physical router + its device key
│       ├── heartbeat.rs              device check-in every N seconds
│       ├── finalize_router_epoch.rs  permissionless: close a finished epoch
│       ├── claim_reward.rs           operator collects one epoch's reward
│       ├── rotate_device_key.rs      owner recovers a lost/compromised device
│       ├── apply_penalty.rs          admin penalizes bad router
│       └── admin.rs                  pause/resume/reinstate/decommission
├── simulator/
│   └── src/
│       ├── index.ts                main entry — spawns all routers
│       ├── router.ts               RouterSimulator class
│       └── config.ts               wallet + program loader
├── tests/
│   └── routerpulse.ts              20 integration tests
├── scripts/
│   ├── deploy.sh                   devnet deployment
│   └── demo.sh                     interview demo script
└── Anchor.toml
```

---

## First Time Setup

```bash
# clone and enter project
git clone <your-repo-url>
cd routerpulse

# install node dependencies
yarn install

# install simulator dependencies
cd simulator && npm install && cd ..

# generate program keypair (first time only)
anchor keys gen

# paste the output Program ID into:
# 1. programs/routerpulse/src/lib.rs  → declare_id!("YOUR_ID")
# 2. Anchor.toml                       → routerpulse = "YOUR_ID"

# build the program
anchor build
```

---

## Running Locally

### Terminal 1 — Start Local Validator

```bash
# always reset to get clean state
solana-test-validator --reset
```

Keep this running. Never close it during testing.

### Terminal 2 — Configure and Fund Wallet

```bash
# point CLI to localnet
solana config set --url localhost

# check your wallet
solana address

# fund it (localnet only)
solana airdrop 10
solana balance
```

### Terminal 2 — Build and Test

```bash
# build the Rust program
anchor build

# run the full integration suite
anchor test --skip-local-validator
```

The suite now includes an epoch-reward lifecycle test that waits for a
real ~2-minute epoch window to close (rewards are only ever paid out
for an epoch that has actually ended on-chain — see
[docs/protocol.md](../docs/protocol.md)), so a full run takes a few
minutes rather than a few seconds. Everything else runs immediately.

---

## Running the Simulator

The simulator must run AFTER tests (tests create the Protocol account that the simulator reads).

### Terminal 2 — Start Simulator

```bash
cd simulator
npm start
```

You will see:
```
🚀 RouterPulse Simulator Starting...

✅ Protocol found
   Reward rate:    1000
   Total routers:  3
   Is paused:      false

📋 Registering routers...
[router-mumbai-001] already registered
[router-delhi-001] already registered
[router-bangalore-001] registered ✅

💓 Starting heartbeats...
[router-mumbai-001] starting — fail rate: 5%
[router-delhi-001] starting — fail rate: 30%
[router-bangalore-001] starting — fail rate: 60%

[router-mumbai-001] ✅ #1 | score: 100 | status: {"active":{}}
[router-delhi-001] ❌ missed (total: 1)
[router-bangalore-001] ❌ missed (total: 1)
...
[router-bangalore-001] 🔴 SUSPENDED — stopping
```

Press **Ctrl+C** to stop.

---

## Running Unit Tests (Pure Math — No Validator Needed)

```bash
# runs #[cfg(test)] inside uptime.rs
cargo test -p routerpulse 2>&1 | grep -E "test |ok|FAILED"
```

Expected: 12 tests passing

---

## Deploying to Devnet

```bash
bash scripts/deploy.sh
```

This script:
1. Switches Solana CLI to devnet
2. Checks SOL balance and airdrops if needed
3. Builds the program
4. Deploys to devnet
5. Prints the explorer URL

---

## Interview Demo — Run This

```bash
# terminal 1
solana-test-validator --reset

# terminal 2 — show tests passing
anchor test --skip-local-validator

# terminal 2 — show simulator
cd simulator && npm start

# terminal 2 — show architecture
bash scripts/demo.sh
```

---

## Common Commands

```bash
# rebuild after any Rust change
anchor build

# run all tests
anchor test --skip-local-validator

# check program logs
solana logs BD41MBys55QSTYgsL3S5RmkSu19PVqtfTje3XhZgnbtD

# check account state
solana account <PDA_ADDRESS>

# reset everything and start fresh
solana-test-validator --reset
anchor clean && anchor build

# run unit tests only
cargo test -p routerpulse

# check wallet balance
solana balance

# airdrop SOL (localnet only)
solana airdrop 10
```

---

## Environment Variables (Simulator)

The simulator reads from `~/.config/solana/id.json` by default.
To use a different keypair:

```bash
export HOME=/path/to/your/keypair/folder
```

---

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| `anchor: command not found` | PATH not set | `source ~/.bashrc` |
| `Connection refused` | Validator not running | Start `solana-test-validator` |
| `Account does not exist` | Protocol not initialized | Run `anchor test` first |
| `DeclaredProgramIdMismatch` | ID mismatch | Sync `declare_id!` with Anchor.toml |
| `Reached maximum depth` | Anchor auto-resolve loop | Use `.accountsPartial()` |
| `HeartbeatTooSoon` | Heartbeat sent twice in same block | Wait 1+ seconds between heartbeats |
| `RouterSuspended` | Score dropped below threshold | Admin must reinstate router |
| `InsufficientVaultBalance` | Vault is empty | Fund vault with SOL transfer |
| `InvalidDeviceSigner` | Heartbeat signed by owner instead of device key | Sign with `router.devicePubkey`, or `rotateDeviceKey` first |
| `WrongEpochNumber` | Client's epoch math is stale | Recompute from `protocol.genesisTime`/`epochDuration` right before sending |
| `EpochNotEnded` | Tried to finalize too early | Wait until `now >= router_epoch.end_time` |
| `EpochNotFinalized` / `EpochAlreadyClaimed` | Claimed before finalizing, or claimed twice | Finalize first; each epoch pays out exactly once |
