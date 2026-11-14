// Drizzle schema for the G-Asisit Trading Dashboard.
//
// Tables mirror the data model in the project's Production Blueprint (V3)
// (~/workspace/g-asisit-work/README.md): Wallet + CoinTransaction ledger,
// Position as the source of truth for P/L, Trade history, Duel records,
// plus the prototype's ML Signals board and the 8-week build-order
// checklist. This artifact is the duel game only.

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// The player's own card, created in the onboarding flow (welcome →
// sign-in / sign-up → player-card setup). One row (id = 1) in this
// single-player edition. onboarded_at is set when setup completes;
// until then the app shows the new-player flow instead of the tabs.
export const playerProfile = sqliteTable("player_profile", {
  id: integer("id").primaryKey(),
  handle: text("handle").notNull().default(""),
  homeMarket: text("home_market").notNull().default(""),
  onboardedAt: integer("onboarded_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const wallet = sqliteTable("wallet", {
  id: integer("id").primaryKey(),
  // Coins are integers — no floats (blueprint §1 key DB rules).
  balance: integer("balance").notNull().default(0),
  mmr: integer("mmr").notNull().default(1000),
});

export const walletTxns = sqliteTable("wallet_txns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(), // starter_grant | duel_entry | duel_win | duel_refund | adjustment | opponent_escrow | opponent_escrow_release
  amount: integer("amount").notNull(), // signed: + credit, - debit
  label: text("label").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const positions = sqliteTable("positions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  qty: real("qty").notNull().default(0),
  avgCost: real("avg_cost").notNull().default(0),
  currentPrice: real("current_price").notNull().default(0),
  source: text("source").notNull().default("user"), // prototype | user
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const trades = sqliteTable("trades", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  side: text("side", { enum: ["buy", "sell"] }).notNull(),
  qty: real("qty").notNull(),
  price: real("price").notNull(),
  note: text("note").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const duels = sqliteTable("duels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  opponent: text("opponent").notNull(),
  wager: integer("wager").notNull(),
  durationLabel: text("duration_label").notNull().default("30 min"),
  status: text("status", {
    enum: ["open", "active", "completed", "void"],
  })
    .notNull()
    .default("open"),
  // Bot rival's matched escrow, recorded when the bot accepts (startDuel).
  // Creator escrow = wager (deducted at create). Pot = wager + opponentEscrow.
  // The bot's escrow is game-side, never deducted from the user's wallet.
  opponentEscrow: integer("opponent_escrow").notNull().default(0),
  opponentEscrowAt: integer("opponent_escrow_at", { mode: "timestamp_ms" }),
  winner: text("winner"), // "you" | "opponent" | null
  yourScore: real("your_score"),
  oppScore: real("opp_score"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
});

export const signals = sqliteTable("signals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  signal: text("signal").notNull(), // STRONG BUY | BUY | HOLD | SELL | STRONG SELL
  confidence: integer("confidence").notNull().default(50), // 0..100
  note: text("note").notNull().default(""),
  source: text("source").notNull().default("user"), // prototype | user
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Legacy table from the old prototype snapshot. Project-Mine is a
// separate project of Kass's and is NOT part of this game: no action
// reads or writes this table and it is not part of the game's state.
// The definition stays so the existing stored rows are not destroyed.
export const miningLogs = sqliteTable("mining_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  logDate: text("log_date").notNull(), // user-entered calendar date YYYY-MM-DD (or snapshot label date)
  hashrate: real("hashrate").notNull().default(0), // MH/s
  kasEarned: real("kas_earned").notNull().default(0),
  usdValue: real("usd_value").notNull().default(0),
  note: text("note").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const milestones = sqliteTable("milestones", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  week: integer("week").notNull(),
  label: text("label").notNull(),
  detail: text("detail").notNull().default(""),
  done: integer("done").notNull().default(0), // 0 | 1 — the user's own tracker checkbox
  // Verified build status, stored on the record so every UI surface
  // (Home chip, build-plan badges, Deploy Line list) reads the same
  // source: ready = built & verified here; app-scope = built for this
  // app edition with the named shipped-app limit in statusNote;
  // deploy-step = only happens at deploy; mixed = partly ready (Week 8:
  // prices ready, store submission is a deploy step).
  status: text("status", {
    enum: ["ready", "app-scope", "deploy-step", "mixed"],
  })
    .notNull()
    .default("deploy-step"),
  statusNote: text("status_note").notNull().default(""),
  sort: integer("sort").notNull().default(0),
});
