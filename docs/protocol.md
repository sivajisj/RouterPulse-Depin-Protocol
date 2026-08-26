# RouterPulse — On-Chain Protocol Design

This is the interview-ready explanation of the on-chain program as it
stands after Phase 1 (see [PHASES.md](PHASES.md) for the roadmap this
fits into). It covers *why* the design looks the way it does, not just
what the code does.

## PDA scheme

```
protocol      seeds = ["protocol"]
reward_vault  seeds = ["reward_vault", protocol]
router        seeds = ["router", owner, router_id]
router_epoch  seeds = ["router_epoch", router, epoch_number.to_le_bytes()]
```

Every instruction re-derives these from stored fields rather than
trusting a client-supplied address (`seeds = [...], bump = <stored
bump>`), so a substituted or forged account simply fails Anchor's
constraint check before the handler body ever runs.

## Two identities per router: owner vs. device

`Router` stores both:
- `owner: Pubkey` — the wallet that registers the router, rotates the
  device key, and receives reward claims. This key should live in a
  normal wallet, not on the physical device.
- `device_pubkey: Pubkey` — the only key allowed to sign `heartbeat`
  (enforced by an Anchor `constraint`, not just convention). This is
  the key that actually sits on the router hardware.

Separating them means a compromised or stolen device can never move
funds — the worst it can do is send heartbeats — and recovery is a
single owner-signed `rotate_device_key` call, not a full
re-registration. `device_key_version` is bumped on every rotation so
an indexer can distinguish "old device, new device" heartbeats in the
event log after a recovery.

## Two uptime signals, deliberately not one

It would be simpler to have a single uptime number that both drives
suspension and computes rewards. RouterPulse intentionally keeps two:

1. **Live `uptime_score`** (0–100, on `Router`) — updated on every
   heartbeat (+1 on time, -10 late, saturating), and it's what
   `should_suspend` checks. This needs to react *immediately* — a
   flapping router should get auto-suspended within a couple of missed
   heartbeats, not wait for an epoch boundary.
2. **Per-epoch `RouterEpoch.heartbeats`** — the only thing
   `finalize_router_epoch`/`claim_reward` ever read. This needs to be
   *auditable and bounded to a specific closed time window*, which the
   live score is not (it's a running EWMA-like counter with memory
   spanning the router's entire lifetime).

Collapsing these into one number was the actual bug in the pre-Phase-1
version: `claim_reward` used to multiply elapsed time by a *lifetime*
uptime percentage. A router with a long history of good uptime could
go completely silent and still show close to 100% historical uptime
indefinitely, because nothing ever incremented `missed_heartbeats`
once heartbeats stopped arriving. Splitting the two signals closes
that path structurally: an epoch a router didn't participate in simply
never gets a `RouterEpoch` record, so it can't be claimed, full stop —
there's no stale average to coast on.

## Why epochs are deterministic, not cranked

`Protocol.genesis_time` + `Protocol.epoch_duration` make "what epoch
is it right now" a pure function of the clock:

```rust
epoch_number_at(ts) = (ts - genesis_time) / epoch_duration
```

Both the client (building a `heartbeat` transaction) and the program
(validating it) compute this independently and must agree — the
instruction takes `epoch_number` as an explicit argument specifically
*because* Anchor needs it to derive the `RouterEpoch` PDA seeds before
the handler runs, and the handler then asserts it matches
`protocol.epoch_number_at(now)` (`WrongEpochNumber` otherwise). No
global "advance the epoch" instruction is needed — there's no shared
mutable counter for concurrent routers to contend on, which matters on
Solana where transactions touching the same account serialize.

`finalize_router_epoch` is intentionally permissionless: it only reads
already-public on-chain state (`now`, and the epoch's own heartbeat
count) and writes a value that's a pure function of that state, so
letting anyone call it (an indexer, a keeper bot, the operator) is
safe and removes the operator as a required party in their own payout
path — a bot can crank it forward without holding any authority.

## Reward math, and why it's basis-points-safe

```rust
expected_heartbeats = epoch_duration / heartbeat_interval
uptime_bps           = min(heartbeats, expected_heartbeats) * 10_000 / expected_heartbeats
reward_amount        = epoch_duration * reward_rate * uptime_bps / 10_000
```

- All arithmetic is `checked_*`, propagating `RouterPulseError::Overflow` rather than panicking or wrapping.
- Multiplication happens before division everywhere (`heartbeats * 10_000` before `/ expected`) to preserve precision.
- `heartbeats.min(expected_heartbeats)` clamps uptime at 100% — a router sending heartbeats faster than `heartbeat_interval` (the simulator does, deliberately, to keep demos fast) can't inflate its reward past the epoch's cap.
- `initialize_protocol` rejects an `epoch_duration` shorter than a handful of heartbeat intervals (`InvalidEpochDuration`), so `expected_heartbeats` can never be zero.

## What Phase 1 deliberately did not change

- The reward vault is still raw SOL moved via `invoke_signed` against a system-owned PDA. Phase 2 replaces this with an SPL/Token-2022 mint plus staking and slashing — that's a bigger surface (CPI target validation, ATA handling, mint authority) that deserves its own hardening pass rather than being bolted onto the epoch redesign.
- `apply_penalty`, `pause_protocol`/`resume_protocol`, `reinstate_router`, `decommission_router` are unchanged — they were already authority-gated correctly; the gap was specifically that *pause* wasn't enforced on the user-facing instructions, which Phase 1 fixed.
