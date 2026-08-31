# Deploying RouterPulse

Getting from "runs on my laptop" to a URL someone else can open.

Everything here is mechanical — the decisions are already made. Budget
~2 hours, most of it waiting on builds and DNS.

---

## 0. What you need first

| Thing | Why | Cost |
|---|---|---|
| ~5 devnet SOL | Program deploys are expensive (rent for the program account) | free, but **rate-limited** |
| MongoDB Atlas account | Indexed projection | free tier fine |
| Redis Cloud account | Live event fanout | free tier fine |
| Vercel account | Dashboard hosting | free tier fine |
| Somewhere for indexer + API | They're long-running processes — Vercel can't host them | Railway/Render/Fly free tier |

> **The devnet SOL is the blocker.** `solana airdrop` is aggressively
> rate-limited. Use <https://faucet.solana.com> with your wallet address,
> which usually works when the CLI won't. You need it *before* anything
> else here matters.

---

## 1. Deploy the program to devnet

```bash
solana config set --url https://api.devnet.solana.com
solana balance                                   # need ~5 SOL

cd routerpulse
anchor build
anchor keys sync                                 # devnet gets its own program ID
anchor build                                     # rebuild so the ID is baked in
anchor deploy --provider.cluster devnet
```

Note the program ID it prints — everything downstream needs it.

```bash
# refresh the dashboard's vendored IDL to match what you just deployed
cd ../web && npm run sync-idl
```

Then initialize the protocol on devnet. `web/scripts/verify-operator-flow.ts`
already does exactly this (protocol + genesis + a full lifecycle), so it
doubles as your smoke test:

```bash
RPC_URL=https://api.devnet.solana.com npm run verify:operator   # expect 8/8
```

If that passes, devnet is live and working. **Don't proceed until it does.**

---

## 2. MongoDB Atlas

1. Create a free M0 cluster.
2. Database Access → add a user, save the password.
3. Network Access → allow `0.0.0.0/0` (free tier can't do VPC peering; the connection string is still credentialed).
4. Copy the connection string: `mongodb+srv://USER:PASS@cluster.mongodb.net`

## 3. Redis Cloud

Create a free database, copy the connection URL:
`redis://default:PASS@host:port`

---

## 4. Indexer + API (Railway, Render, or Fly)

Both are long-running processes — **Vercel cannot host them**. Vercel
functions are request-scoped and will kill a websocket subscription.

Deploy each as its own service from this repo:

**Indexer** — root directory `indexer/`, start command `npm start`:

```
RPC_URL=https://api.devnet.solana.com
WS_URL=wss://api.devnet.solana.com
MONGO_URL=<atlas string>
MONGO_DB=routerpulse
REDIS_URL=<redis cloud url>
IDL_PATH=./routerpulse-idl.json
RECONCILE_INTERVAL_MS=30000
```

> `IDL_PATH` matters: the default points at `../routerpulse/target/`,
> which is gitignored build output and won't exist on a deploy host.
> Copy the IDL into `indexer/` before deploying:
> `cp routerpulse/target/idl/routerpulse.json indexer/routerpulse-idl.json`

**API** — root directory `api/`, start command `npm start`:

```
PORT=3001
MONGO_URL=<atlas string>
MONGO_DB=routerpulse
REDIS_URL=<redis cloud url>
JWT_SECRET=<generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
JWT_EXPIRES_IN=1h
CORS_ORIGINS=https://<your-vercel-domain>
RATE_LIMIT_TTL_MS=60000
RATE_LIMIT_MAX=120
```

> `JWT_SECRET` must be a real random value. The default in
> `.env.example` is `dev-only-change-me` and anyone who reads this repo
> can forge sessions with it.
>
> `CORS_ORIGINS` must be your **exact** Vercel origin including
> `https://` and no trailing slash, or the dashboard's fetches fail with
> an opaque CORS error rather than something diagnosable.

Verify: `curl https://<api-host>/health` → `{"status":"ok","mongo":"up","redis":"up"}`

---

## 5. Dashboard (Vercel)

Import the repo, set **root directory** to `web/`.

```
NEXT_PUBLIC_API_URL=https://<api-host>
NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com
```

Both are `NEXT_PUBLIC_*` because the browser needs them — they are
public by nature. Don't put anything secret behind that prefix.

After the first deploy, go back and set the API's `CORS_ORIGINS` to the
real Vercel domain, then redeploy the API.

---

## 6. Smoke test the deployed stack

```bash
curl https://<api-host>/health
curl https://<api-host>/api/v1/protocol
curl https://<api-host>/api/v1/analytics/network
```

Then in the browser:
1. Dashboard loads with real routers
2. Connect Phantom **set to devnet**
3. Sign in with Solana → admin panel appears (you're the authority)
4. Register a router → it appears after the indexer catches up

To make the network look alive, point the simulator at devnet:

```bash
cd routerpulse/simulator
RPC_URL=https://api.devnet.solana.com npm start
```

---

## Gotchas worth knowing before you hit them

- **Public devnet RPC is rate-limited.** The indexer polls `getTransaction` per signature and will get throttled. If it does, use a free Helius/QuickNode devnet endpoint instead — same URL swap, no code change.
- **Devnet state is not permanent.** Devnet gets reset periodically. Your program and all protocol state can vanish. Don't treat a devnet deployment as a durable demo; be ready to redeploy.
- **The vendored IDL can drift.** If you change the program and redeploy without `npm run sync-idl`, the dashboard sends instructions the program rejects on discriminator mismatch. It fails loudly, but it's confusing if you don't expect it.
- **The upgrade authority is a single keypair.** Same caveat as `docs/security.md` — fine for devnet, not for mainnet. Move it to a multisig before anything real.
