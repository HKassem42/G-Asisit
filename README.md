# G-Asisit — Production Blueprint (V3)

> **What:** A skill-based PvP trading game (paper-trading duels + tournaments) shipping to iOS + Android.
> **Why:** Turn the "hub/AI" trading PRD into a concrete, buildable, app-store-shippable product.
> **How:** Solo / small-team friendly stack — Expo + NestJS + Supabase + Redis — designed to scale to **50k DAU**.

---

## Table of Contents

- [0. System Overview + Stack](#0-system-overview--stack)
- [1. Data Model (Postgres Schema)](#1-data-model--postgres-schema)
- [2. Auth + User System](#2-auth--user-system)
- [3. Wallet + Coin System](#3-wallet--coin-system)
- [4. Duel System (Core Loop)](#4-duel-system--core-loop)
- [5. Trading Engine](#5-trading-engine)
- [6. Scoring Engine](#6-scoring-engine)
- [7. Realtime Architecture](#7-realtime-architecture)
- [8. Anti-Abuse (Day 1)](#8-anti-abuse--ship-day-1)
- [9. App Store + Legal](#9-app-store--legal)
- [10. Build Order — 8-Week Plan](#10-build-order--8-week-plan)
- [11. Current Prototype (Streamlit)](#11-current-prototype-streamlit)
- [Next Move](#next-move)

---

## 0) System Overview + Stack

### Core Tech Stack

| Layer             | Tech                                    | Reason                                                                   |
| ----------------- | --------------------------------------- | ------------------------------------------------------------------------ |
| **Mobile**        | React Native + Expo SDK 52              | One codebase, OTA updates, EAS builds straight to App Store / Play Store |
| **Backend**       | NestJS on Node.js 20                    | Modular services, first-class WebSocket gateways, TS end-to-end          |
| **Database**      | Supabase Postgres 16                    | ACID transactions for the wallet, Row Level Security, auth bundled       |
| **ORM**           | Prisma                                  | Type-safe DB access, painless migrations, plays well with NestJS         |
| **Realtime**      | Socket.io + Upstash Redis               | Room-based events, horizontal scale via the Redis adapter                |
| **Auth**          | Supabase Auth                           | Google / Apple OAuth, JWT, magic links                                   |
| **Market Data**   | Mock → Polygon.io WS                    | Start free with mock ticks, upgrade when live prices matter              |
| **Jobs / Cron**   | Trigger.dev or Railway Cron             | End duels / tournaments, daily rewards, payouts                          |
| **Infra**         | Railway (API) + Vercel (Web) + Expo EAS | ~$50–$100/mo MVP, autoscale built in                                     |
| **Feature Flags** | Unleash OSS or DB table                 | Kill switches without redeploys                                          |

### High-Level Architecture

```
                ┌──────────────────────────────────────────┐
                │              Expo Mobile App              │
                └──────────────┬───────────────────────────┘
                               │   HTTPS + WSS
                               ▼
                ┌──────────────────────────────────────────┐
                │           NestJS API (Railway)            │
                │                                          │
                │  Auth   Wallet   Duels   Trades  Score   │
                │  Tourney  Social  Realtime  AntiAbuse    │
                └──┬──────────┬──────────┬──────────┬──────┘
                   │          │          │          │
              Supabase    Supabase    Upstash    Polygon.io
              Auth (JWT)  Postgres    Redis        WS
                          (Prisma)  (Socket.io   (ticks)
                                     adapter)
                                        │
                                   Trigger.dev
                                   (cron / jobs)
```

### Core Services as NestJS Modules

- `auth` — login, sessions, device_id
- `users` — profiles, stats, MMR
- `wallet` — coins, txns, idempotency
- `tournaments` — tournaments, brackets
- `duels` — PvP create/accept/state machine
- `trades` — paper trades, positions, P/L calc
- `leaderboard` — ranking, snapshots
- `social` — chat, follows, rivals
- `realtime` — Socket.io rooms / events
- `anti-abuse` — cooldowns, flags, device checks

---

## 1) Data Model — Postgres Schema

The minimum tables you need. Drive everything with Prisma migrations.

```prisma
model User {
  id              String    @id @default(cuid())
  email           String    @unique
  username        String    @unique @db.VarChar(20)
  device_ids      String[]  // anti-abuse fingerprint history
  mmr             Int       @default(1000)
  created_at      DateTime  @default(now())
  wallet          Wallet?
  stats           UserStats?
}

model Wallet {
  user_id         String    @id
  balance         Int       @default(500) // coins as integer — no floats!
  user            User      @relation(fields: [user_id], references: [id])
  transactions    CoinTransaction[]
}

model CoinTransaction {
  id              String    @id @default(cuid())
  user_id         String
  client_txn_id   String    @unique // idempotency key from client
  type            TxnType   // starter_grant, duel_entry, duel_win, etc.
  amount          Int       // signed: + credit, - debit
  ref_id          String?   // duel_id or tournament_id
  created_at      DateTime  @default(now())
  @@index([user_id, created_at])
}

model Duel {
  id              String      @id @default(cuid())
  status          DuelStatus  // open | pending | active | completed | void
  creator_id      String
  opponent_id     String?
  wager           Int
  duration_sec    Int         // 1800, 14400, 86400
  ruleset_json    Json        // { starting_cash: 10000, allow_short: true }
  start_time      DateTime?
  end_time        DateTime?
  winner_id       String?
  pot_total       Int
  created_at      DateTime    @default(now())
  @@index([status, created_at])
}

model Trade {
  id              String    @id @default(cuid())
  user_id         String
  duel_id         String?   // null if it's a tournament trade
  tournament_id   String?
  symbol          String
  side            Side      // buy | sell
  qty             Decimal   @db.Decimal(18,8)
  price           Decimal   @db.Decimal(18,8)
  executed_at     DateTime  @default(now())
  client_txn_id   String    @unique
  @@index([duel_id, executed_at])
}

model Position {
  id              String    @id @default(cuid())
  user_id         String
  duel_id         String?
  tournament_id   String?
  symbol          String
  qty             Decimal   @db.Decimal(18,8)
  avg_cost        Decimal   @db.Decimal(18,8)
  updated_at      DateTime  @updatedAt
  @@unique([user_id, duel_id, symbol])
}
```

### Key DB Rules (read these twice)

- **All coin changes happen inside a single Postgres transaction.** Update `Wallet.balance` _and_ insert into `CoinTransaction` atomically. If either fails → full rollback.
- **`client_txn_id` prevents double-spend from network retries.** A unique constraint forces the database to reject duplicates — your API code doesn't even have to think about it.
- **`Position` table is the source of truth for P/L.** Recalculate on every trade; never sum the whole `Trade` history per request — it gets expensive fast.

---

## 2) Auth + User System

### User Story 1.1 — Sign Up
_As a user, I want to create an account so I can compete._

**Acceptance**
- Supabase Auth handles email/password + Google + Apple OAuth → returns a JWT.
- On the first JWT, NestJS `AuthGuard` lazily creates `User`, `Wallet`, and `UserStats` rows if they don't exist.
- Wallet starts at **500 coins**, written via a `CoinTransaction` of type `starter_grant` — inside a Prisma `$transaction` with the wallet insert.
- Capture `device_id` (via Expo Device) on signup and append to `User.device_ids`.

**Technical Notes**
- JWT travels in the `Authorization: Bearer …` header. Supabase RLS policies read `auth.uid()` and compare it against `user_id`.
- Expo: use `expo-auth-session` for OAuth, with a deep link back into the app.

### User Story 1.2 — Login

**Acceptance**
- Supabase returns a session + refresh token. Expo `SecureStore` persists both.
- Invalid login → 401 → app forces logout.
- Append the current `ip` + `device_id` on **every** login (for abuse detection later).

---

## 3) Wallet + Coin System

### User Story 2.1 — View Wallet
- **REST:** `GET /v1/wallet` → `{ balance, recent_txns[] }`
- **Realtime:** client joins the `user:{id}` socket room. Server emits `wallet_updated` on any txn.

### User Story 2.2 — Spend Coins
Client sends a `client_txn_id` (UUID). Server runs an atomic Prisma transaction:

```ts
await prisma.$transaction(async (tx) => {
  const wallet = await tx.wallet.update({
    where: { user_id, balance: { gte: entryFee } }, // atomic balance check
    data:  { balance: { decrement: entryFee } },
  });
  if (!wallet) throw new InsufficientFunds();

  await tx.coinTransaction.create({
    data: {
      user_id,
      amount: -entryFee,
      type: 'duel_entry',
      client_txn_id,
    },
  });
});
```

If the balance check fails, the row update returns nothing → exception → transaction rolls back. No partial deducts, no ghost coins.

### User Story 2.3 — Earn Coins
- **Cron:** a Trigger.dev job runs every 30s and finds `Duel` rows where `status = 'active' AND end_time <= now()`.
- **Payout:** same atomic txn shape as 2.2 but `amount = +pot_total`. Emit `wallet_updated` over Socket.io.

---

## 4) Duel System — Core Loop

This is V1. **Ship this before tournaments.**

### User Story 4.1 — Create Duel
- **API:** `POST /v1/duels`
- **Body:** `{ wager, duration_sec, ruleset, client_txn_id }`
- **Backend:**
  1. Reserve coins from creator (flow §2.2).
  2. Insert `Duel` with `status = 'open'`, `pot_total = wager`.
  3. Return `duel_id` + a deep link (`gasisit://duel/{id}`) for sharing.

### User Story 4.2 — Accept Duel
- **API:** `POST /v1/duels/:id/accept` with `{ client_txn_id }`
- **Backend Prisma txn:**
  1. Deduct coins from opponent.
  2. `Duel.status = 'active'`, `start_time = now()`, `pot_total += wager`.
  3. Create starting `Position` rows for both users: `cash = starting_cash`.
  4. Emit `duel_started` to room `duel:{id}`.

### User Story 4.3 — Live Duel Room
**Socket.io Rooms:** clients join `duel:{id}` on screen focus.

**Server-emitted events:**
- `price_tick` — every 1–5s from Polygon (or the mock provider).
- `score_update` — after every trade or material price tick.
- `chat_msg`
- `duel_ended`

**Throttling:** don't emit `score_update` per tick if the user has no position. Batch updates to **1 emit / second / duel** max.

### User Story 4.4 — Duel Ends
- **Trigger.dev cron** runs every 30s, queries `Duel` rows with `status = 'active' AND end_time <= now()`.
- **Flow:**
  1. Set `status = 'completing'`. Freeze trades for this `duel_id`.
  2. Run `ScoringService.calculate(duel_id)`. Store component scores.
  3. Winner = highest score. Transfer `pot_total` to winner via Wallet txn.
  4. Set `status = 'completed'`. Emit `duel_ended`.
  5. Update `UserStats`: wins / losses, MMR delta via ELO.

### User Story 4.5 — Matchmaking Queue
- **MVP:** skip this — use deep-link share to friends.
- **V1.1:** Redis list `mm:queue:{wager}`. `LPUSH` on "Find Match", `LPOP` to pair. Match only if MMR within ±200.

---

## 5) Trading Engine

### User Story 5.1 — Place Trade
- **API:** `POST /v1/trades` with `{ duel_id, symbol, side, qty, client_txn_id }`
- **Validation:** check the duel is `active`, confirm cash position covers `qty × price`.
- **Prisma txn:**
  1. Insert `Trade`.
  2. Upsert `Position` for that symbol — recompute `qty` and `avg_cost` (weighted average).
  3. Update cash position via `Position` where `symbol = '__CASH__'`.
  4. Emit `trade_executed` to the duel room.

### User Story 5.3 — Live P/L
- **Price ingest:** a NestJS service subscribes to Polygon's WebSocket. On each tick → `PUBLISH` to Redis channel `prices:{symbol}`.
- **RealtimeGateway:** subscribes to Redis, broadcasts to every duel room that has an open position in that symbol.
- **Calc:** `unrealized = (current_price - avg_cost) × qty`. Sum of (all positions + cash) = portfolio value.

---

## 6) Scoring Engine

A NestJS `ScoringService`. Runs at duel end **and** on-demand for the live score.

**Formula:**

```
Score = 0.40·R + 0.25·K + 0.15·C + 0.10·A + 0.10·B
```

| Component             | What it measures                         | Notes                                         |
| --------------------- | ---------------------------------------- | --------------------------------------------- |
| **R — Returns**       | `(end_pv - start_cash) / start_cash`     | Normalize 0–100; cap at ±50% to kill outliers |
| **K — Risk-adjusted** | Sharpe-ish: `mean_return / stdev_return` | Penalize if `trades < 3`                      |
| **C — Consistency**   | `winning_trades / total_trades`          | —                                             |
| **A — Activity**      | `min(trades / 10, 1) × 100`              | Rewards activity up to 10 trades, then flat   |
| **B — Bonus**         | `+10` for winner, `0` for loser          | —                                             |

**Store each component separately** so you can re-tune weights without re-running history.

---

## 7) Realtime Architecture

### Socket.io Namespaces / Rooms

- `user:{id}` — wallet updates, push notifications
- `duel:{id}` — price ticks, trades, scores, chat for that duel
- `lb:global` — top-10 rank changes

### NestJS Gateway

```ts
@WebSocketGateway({ cors: true })
export class RealtimeGateway {
  @SubscribeMessage('join_duel')
  handleJoin(@MessageBody() duel_id: string, @ConnectedSocket() client) {
    client.join(`duel:${duel_id}`);
  }
}
```

### Scale Plan
Start with **1 Railway instance**. Add the **Redis adapter** from day 1. When you cross **>10k concurrent sockets**, spin up a 2nd instance — Redis pub/sub keeps rooms in sync.

---

## 8) Anti-Abuse — Ship Day 1

### User Story 9.1 — Prevent Coin Farming
- **Cooldown table:** `(user_a, user_b, last_duel_at)`. Before accept, check it exists. Insert a 24-hour row on duel create.
- **Device check:** if creator `device_ids ∩ opponent device_ids ≠ ∅`, flag `void` and refund. Runs inside the accept txn.
- **Min trades:** at duel end, if `trade_count < 3` → set duel `void` → 50% pot burned, 50% refunded. Kills 1-trade wins.
- **Rate limits:** NestJS `@Throttle()` — 5 duels created / hr, 60 trades / hr.

### User Story 9.2 — Admin Review
- **Next.js Admin on Vercel:** a simple table of `CoinTransaction` rows where `flagged = true`. Actions: `reverse`, `ban_user`.
- **Ban:** sets `User.banned = true`. `AuthGuard` rejects JWTs from banned users.

---

## 9) App Store + Legal

- **No real money** — every UI string says "coins" / "virtual cash". Store listing positions this as an **educational trading simulator**.
- **No house cut for MVP.** App Store rule 5.3.4 flags games of chance. You're skill-based, but take 0% rake until legal review says otherwise.
- **Age 17+** in App Store Connect — required because of the "Simulated Gambling" descriptor.
- **Privacy** — Expo EAS needs a Privacy Manifest. You collect `email` + `device_id`. Disclose this is for anti-fraud.
- **Terms** — include "Coins have no cash value" in onboarding, not buried in legalese.

---

## 10) Build Order — 8-Week Plan

| Week  | Goal                | Deliverable                                                                     |
| ----- | ------------------- | ------------------------------------------------------------------------------- |
| **1** | Auth + Wallet       | Expo app login via Google. See 500 coins. Wallet API + DB live.                 |
| **2** | Trading Core        | Place buy/sell for AAPL with mock prices. Positions + P/L update live.          |
| **3** | Duel Flow           | Create duel, accept via deep link, coins escrowed correctly.                    |
| **4** | Realtime            | Socket.io working. Two phones see each other's trades live.                     |
| **5** | Scoring + End       | Duels auto-end, score calc runs, winner paid, loser sees the result.            |
| **6** | Anti-Abuse + Polish | Cooldowns, device check, min trades. App looks shippable.                       |
| **7** | TestFlight Beta     | EAS submit to TestFlight. 20 friends testing duels. Crush bugs.                 |
| **8** | Store Submit        | Screenshots, listing, submit iOS + Android. Wire up Polygon.io for real prices. |

> **Definition of MVP:** a stranger downloads the app, signs up, duels a friend, and wins/loses coins with **zero bugs**. Everything else is V1.1.

---

## 11) Current Prototype (Streamlit)

A Python + Streamlit prototype lives in this repo for fast iteration on the **scoring formula** and **trading UX** before the React Native rewrite.

**Run it locally:**

```bash
pip install -r requirements.txt
streamlit run app.py
```

Mockup screenshots of target UI flows live in `./screenshots/`.

---

## Next Move

This is now buildable. Immediate next steps:

1. **Init repos:** `gasisit-api` (NestJS) + `gasisit-mobile` (Expo).
2. **DB:** create a Supabase project, run the first Prisma migration with `User`, `Wallet`, `CoinTransaction`.
3. **Steel thread:** hard-code one duel with two test users. Make `POST /trades` update both their scores live over Socket.io.

> Want the Prisma schema file + the NestJS `WalletService.spend()` with the `$transaction` block already written? That's your day-1 code — say the word.
