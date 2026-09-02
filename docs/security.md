# RouterPulse — Security Notes

What's actually been done, what's deliberately out of scope, and what a
real audit would still need to look at. Phase 9 of the
[roadmap](PHASES.md).

This is **not** an audit report. Nothing here has been reviewed by a
third party, and the program has never been deployed to mainnet.

---

## Threat model

### What the protocol is defending against

| Threat | Mitigation | Where |
|---|---|---|
| Operator claims rewards for uptime they didn't deliver | Rewards computed only from heartbeats landing inside a specific closed epoch window, on a dedicated `RouterEpoch` PDA | `finalize_router_epoch.rs` |
| Router goes offline but keeps earning on a stale lifetime average | No `RouterEpoch` record accrues for epochs with no heartbeats — there's nothing to claim | `heartbeat.rs`, `state/epoch.rs` |
| Same epoch claimed twice | `claimed` flag on the epoch record **and** `init` (not `init_if_needed`) on the vesting PDA — two independent guards | `claim_reward.rs` |
| Same epoch slashed twice | `slashed` flag, set before the CPI (checks-effects-interactions) | `slash_router.rs` |
| Compromised physical device drains the operator's wallet | Device key is separate from owner; `heartbeat` requires the device key, and it can't move funds | `state/router.rs`, `heartbeat.rs` |
| Lost/stolen device permanently bricks a router | Owner-signed `rotate_device_key`, with `device_key_version` bumped for the audit trail | `rotate_device_key.rs` |
| Sybil: register many routers to inflate total issuance | Per-epoch `EmissionSchedule` caps total payout — extra routers dilute a fixed pool rather than expanding it | `finalize_router_epoch.rs`, `state/emission.rs` |
| Operator earns with nothing at risk | `heartbeat`'s activating call requires `staked_amount >= min_stake`; `unstake` won't drop an active router below it | `heartbeat.rs`, `unstake.rs` |
| Stake posted to pass a check, then immediately withdrawn | `locked_until` pushed forward on every stake | `stake.rs` |
| Admin mints unlimited supply | `genesis_allocation` fixed at init and enforced on-chain; after it's exhausted, vesting is the only mint path | `mint_genesis.rs` |
| Reward tokens minted before they're earned | `claim_reward` moves no tokens — it grants a vesting entitlement; `claim_vested` is the only instruction that mints | `claim_reward.rs`, `claim_vested.rs` |
| Protocol paused but users keep transacting | `require!(!protocol.is_paused)` on heartbeat, claim, vest, stake, unstake | throughout |

### Authority model

The protocol authority can: pause/resume, update the reward rate,
reinstate/decommission routers, apply penalties, mint from the
(capped) genesis allocation, and burn from the treasury.

The protocol authority **cannot**: mint beyond `genesis_allocation`,
take staked collateral (slashing moves it to the treasury and is
permissionless, with the amount fixed at finalization), freeze holder
balances (the mint has no freeze authority), or forge uptime.

The mint authority is the protocol PDA itself — there is no human-held
mint key anywhere in the system.

**Not done:** the upgrade authority is a single developer keypair. A
real deployment needs a multisig (Squads or similar) and a documented
upgrade/rollback procedure. This is the largest open gap.

---

## Arithmetic

- All reward/stake/slash math uses `checked_*` and propagates
  `RouterPulseError::Overflow` — no wrapping, no silent truncation.
- `apply_bps` computes its intermediate product in `u128`. This was a
  real bug caught by its own unit test: in `u64`, `amount * bps`
  overflows long before the *result* would, so a 100% multiplier failed
  on large amounts.
- Multiplication before division everywhere, so precision isn't lost to
  integer truncation.
- Rounding always truncates — never in the claimer's favour. There's a
  test asserting this specifically (`apply_bps_truncates_rather_than_rounding_up`).
- `initialize_protocol` rejects an `epoch_duration` shorter than
  `MIN_HEARTBEATS_PER_EPOCH` intervals, so `expected_heartbeats` can
  never be zero.

## Account validation

Every instruction re-derives PDAs from stored fields with
`seeds = [...], bump = <stored bump>` rather than trusting a
client-supplied address, so a substituted account fails Anchor's
constraint check before the handler body runs. Token accounts are
constrained with `token::mint` / `token::authority`, and the reward mint
is checked with `address = protocol.reward_mint`.

Cross-account relationships are checked explicitly where seeds alone
don't cover it — e.g. `router_epoch.router == router.key()`,
`stake.router == router.key()`.

---

## Off-chain services

- **The API holds no keypair.** It's read-only against MongoDB, never
  talks to Solana, and cannot move funds even if fully compromised.
  State changes are transactions the user's own wallet signs
  client-side.
- **Auth is Sign-In-With-Solana**: a server-issued single-use nonce
  (Redis, 5-min TTL), verified with `tweetnacl` against the wallet's own
  public key, and **deleted on first use** so a captured signature can't
  mint a second session. Tested: replay rejection, wrong-message
  signature rejection, garbage-token rejection.
- **RBAC is bound to chain-derived state**, not a local role table — the
  admin guard compares the session wallet against the protocol authority
  in the indexer-maintained projection, which no operator edits by hand.
  A rotation therefore propagates on its own, bounded by indexer latency
  rather than being instant; reconciliation caps how stale it can get.
  Tested: an authenticated non-authority wallet gets 403.
- **Rate limiting is a global guard**, so a new endpoint is protected by
  default rather than by remembering to decorate it.
- **MongoDB is never authoritative.** The reconciliation worker
  periodically re-fetches real on-chain accounts and overwrites the
  projection, logging drift.

---

## Dependency audit

Run as part of this phase, and the findings **fixed rather than
documented away**:

| Workspace | Before | After | What changed |
|---|---|---|---|
| `web` | 2 high | 0 high | Next.js 14 → 15 (14.x had no non-breaking fix). Required migrating `params`/`searchParams` to the async form Next 15 introduced. |
| `api` | 4 high | 0 high | NestJS 10 → 11 (fixes transitive `multer`, `js-yaml`, `lodash`). Required a cast for `@nestjs/jwt` 11's tightened `expiresIn` type. |
| `indexer` | 0 high | 0 high | — |

Both upgrades were verified, not assumed: the API's full 21-test suite
passes on NestJS 11, the web app builds and all routes render real data
on Next 15 (including query-param filtering), and both Docker images
still build.

Remaining moderate advisories are transitive dev-dependency issues with
no non-breaking fix. `cargo audit` was **not** run — the tool isn't
installed in this environment — which is a gap worth closing.

CI runs `clippy -D warnings` on every push. Two lints are allowed
narrowly, both from Anchor's macro expansion rather than handwritten
code, each with an inline comment explaining why (see
`lib.rs` and `instructions/mod.rs`).

---

## What a real audit would still need

Honest list of what hasn't been done:

1. **Multisig upgrade authority.** Currently a single dev keypair. Biggest gap.
2. **`cargo audit` / `cargo deny`** in CI for the Rust dependency tree.
3. **Fuzzing and property-based tests** on the math module. The unit
   tests cover tier boundaries and known edge cases; they don't cover
   the whole input space.
4. **Adversarial integration tests** — the current suite tests that
   correct behaviour works and that obvious misuse is rejected. It
   doesn't systematically attempt PDA substitution, wrong-mint
   injection, or CPI target confusion against every instruction.
5. **Timestamp manipulation.** The protocol trusts `Clock::get()`.
   Validator clock drift within the tolerance Solana allows could shift
   epoch boundaries slightly; the impact is bounded but unanalyzed.
6. **Economic modelling.** The tier table and emission curve are
   plausible, not simulated. Whether the incentives actually hold under
   adversarial operator behaviour at scale is untested.
7. **Secrets management.** `JWT_SECRET` defaults to a dev value in
   compose; production needs real secret injection.
8. **Rate limiting is per-instance, in-memory.** Horizontally scaling
   the API needs a shared (Redis) store, or the effective limit
   multiplies by instance count.
