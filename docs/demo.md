# RouterPulse — Demo Walkthrough

A ~12 minute walkthrough that shows the system working rather than
described. The ordering is deliberate: **show the thing running before
opening any code.**

The single most memorable moment is step 7 — deliberately killing a
router and watching the protocol take its money. Lead toward that.

---

## Before you start (~5 min, do it beforehand)

```bash
# terminal 1
solana-test-validator --reset

# terminal 2
solana config set --url http://127.0.0.1:8899 && solana airdrop 50
cd routerpulse && anchor deploy --provider.cluster http://127.0.0.1:8899

# seed protocol + a rewarded epoch, and confirm everything works end to end
cd ../web && npm run verify:operator     # expect 8/8

# terminal 3 — off-chain stack
cd indexer && npm start
cd api && npm start
cd web && npm run build && npm start
```

Check before anyone is watching:

- `curl localhost:3001/health` → `{"status":"ok","mongo":"up","redis":"up"}`
- `localhost:3000` renders with routers listed
- Phantom is set to **localhost** and holds the wallet at
  `~/.config/solana/id.json`, with SOL and reward tokens. Phantom wants
  base58, not the CLI's JSON byte array — convert it first, or the import
  fails in front of an audience:
  ```bash
  node -e "const b=require('bs58');const e=b.encode||b.default.encode;console.log(e(Uint8Array.from(require(process.env.HOME+'/.config/solana/id.json'))))"
  ```
  Do this well before the demo, and clear the scrollback afterwards —
  that string is the authority key.

> Epochs are 120s in this config. Two minutes of real time must pass
> before an epoch can be finalized — you cannot rush it. Plan the
> narration around that rather than standing in silence: the wait is a
> good moment for step 6.

---

## The walkthrough

### 1. Open the dashboard — "this is a real network"
`localhost:3000`. Fleet stats, uptime, staked totals, the map, and a
live event feed that is **already populated** (seeded server-side, so it
isn't an empty box).

Say: *every number here came from decoding on-chain events — nothing is
mocked, and nothing is a database the backend invented.*

### 2. Start the simulator — "those are physical routers"
```bash
cd routerpulse/simulator && npm start
```
Watch heartbeats appear in the terminal **and** stream into the
dashboard's live feed within a second or two.

Say: *each router signs with its own device key, not my wallet. If
someone steals a router, the worst they can do is send heartbeats.*

### 3. Router detail — "here's the identity split"
Click into a router. Point at **owner ≠ device pubkey**, and the
`device_key_version` counter.

Say: *a stolen device is recovered with one owner-signed
`rotate_device_key` — the router stays registered and keeps its history.*

### 4. Connect wallet + Sign in with Solana
Connect Phantom, click **Sign in with Solana**, approve the signature.

Say: *that's a signed message, not a transaction. It costs nothing and
moves no funds — it just proves I hold the key.*

### 5. The admin panel appears — "RBAC bound to the chain"
Because this wallet **is** the protocol authority, the governance audit
panel renders.

Say: *the API didn't look up a role in a database. It compared my
signed-in wallet against the authority address currently stored
on-chain. If the authority rotates to a multisig tomorrow, access
follows automatically with nothing to redeploy.*

**If asked to prove it:** switch to a second Phantom account, reload
`/operator`, and **sign in again** — same endpoint returns **403**. The
second sign-in is not optional: switching accounts discards the session
by design, and without one the panel simply disappears rather than
showing the refusal you're trying to demonstrate.

### 6. Register a router, live
Use the operator form. When the device key is revealed, say: *shown
once, never stored by this app — it belongs on the router.*

Then **stake** collateral and point out: *until this router holds the
minimum stake, `heartbeat` refuses to activate it. Collateral isn't a
policy, it's enforced in the instruction.*

### 7. ⭐ Break a router — watch it get slashed
This is the moment worth building to.

Kill one simulated router (Ctrl+C, or let the 60%-failure-rate one run).
It misses heartbeats. When the epoch closes:

```bash
# force the epoch closed and show the numbers
curl -s localhost:3001/api/v1/analytics/epochs?limit=5 | jq
```

Point at a low `uptimeBps` row: **reward 0, slash > 0**.

Say: *reward multiplier and slash percentage come out of the same tier
table. 90–99% uptime costs a quarter of the reward. Below 70% you earn
nothing and lose 10% of your stake. Marginal downtime is survivable;
sustained downtime is expensive — and that asymmetry is the whole
economic argument for why an operator keeps their hardware online.*

Then: *the slashed collateral goes to the treasury, and
`burn_treasury` destroys it permanently. The penalty is deflationary
for every holder rather than a transfer to whoever controls the
treasury.*

### 8. Claim and vest — "supply only grows as it vests"
Claim a finalized epoch. Point out the supply **does not change**.

Say: *claiming creates a vesting entitlement; it mints nothing.
`claim_vested` is the only instruction in the entire program that
increases supply, and it only mints the slice that has actually vested.
There is no pre-minted pool anywhere to drain.*

Release vested tokens, show the partial amount.

### 9. Explorer — "every step was a real transaction"
Open `/explorer`. Every action just taken is there as a decoded event
with its signature.

---

## Where to take it if they dig

| They ask | Go to |
|---|---|
| "How do you know it works?" | 38 on-chain integration tests, 26 unit, 21 API e2e, plus `npm run verify:operator` |
| "What went wrong building it?" | `docs/PHASES.md` — the BPF stack overflow the build *silently allowed*, the bootstrap deadlock, the `u64` overflow |
| "What about security?" | `docs/security.md` — threat model, and the honest gap: upgrade authority is still a single keypair |
| "Why not ClickHouse?" | Mongo aggregations are sufficient at this event volume; the crossover point is in `docs/PHASES.md` |
| "Is the DB the source of truth?" | No — Solana is. `reconcile.ts` re-reads on-chain accounts on an interval and overwrites the projection, logging drift |

## Lines worth having ready

- **On the reward design:** *"The original version paid out on a lifetime uptime average. A router could go dark forever and still look like it had 100% uptime, because nothing recompiled the average once heartbeats stopped. Rewards are now scoped to a closed epoch — an epoch you didn't participate in simply has no record to claim."*
- **On finding bugs:** *"The BPF stack overflow is the one I'd highlight. The build printed an error and still emitted a working `.so`. If I'd trusted the exit code instead of reading the output, I'd have shipped a program with undefined behaviour in `slash_router`."*
- **On what's missing:** *"The upgrade authority is still a single keypair. For production that has to be a multisig — it's the first thing I'd fix."*
