// Actions for the G-Asisit Trading Dashboard.
//
// Logic follows the project's Production Blueprint (V3):
// - Wallet coins are integers; every balance change writes a ledger row.
// - Positions are the source of truth for P/L; avg cost is a weighted
//   average recomputed on every buy (blueprint §5.1).
// - Unrealized P/L = (current_price - avg_cost) x qty (blueprint §5.3),
//   computed client-side from the rows returned here.
// - Creating a duel escrows the wager; completing it pays the pot
//   (2 x wager) to the winner; voiding refunds the wager (§3/§4).

import {
defineAction,
z,
type ActionsModule,
type Ctx,
} from "@hatch/space-sdk";
import { asc, desc, eq } from "drizzle-orm";
import * as schema from "./schema";

const okResponse = z.object({ ok: z.boolean(), message: z.string() });

// Guest access (platform v27) — action classification for this game:
// - Playing the game IS the intended use of this artifact, so the
//   gameplay loop (onboarding/profile, trades, price refresh, duels,
//   signals) is open to whoever can open the app, owner or guest.
//   There are no per-user private rows or blobs to partition: the
//   league is one shared game state by design, as it has been since
//   the first build. Verified in the audit browser session, which
//   carries no owner viewer — the full new-player flow completes
//   there, exactly as it does for the owner locally.
// - Owner-only (guarded below): the admin levers that sit outside
//   play — importPrototype (one-time seed), adjustWallet (arbitrary
//   coin mint/burn), deletePosition (removes a book row outright),
//   toggleMilestone (the owner's own build tracker). A missing viewer
//   is NOT proof of ownership: only an explicit isOwner === true may
//   run them, and a denial returns a clear result, never a throw,
//   and never touches state.
const OWNER_ONLY_MESSAGE =
  "Owner-only: guests can watch the league, but only the owner can change it. Nothing was changed.";
function isOwner(ctx: Ctx): boolean {
  return ctx.viewer?.isOwner === true;
}

function round8(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

// Live BTC/USD spot from the free Coinbase public API (no key). Returns
// null on any failure so callers leave state untouched and say so.
async function fetchBtcSpotPrice(): Promise<number | null> {
  try {
    const res = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot", {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: { amount?: string; base?: string; currency?: string };
    };
    if (json.data?.base !== "BTC" || json.data?.currency !== "USD") return null;
    const amount = Number(json.data.amount);
    return Number.isFinite(amount) && amount > 0 ? amount : null;
  } catch {
    return null;
  }
}

// BTC/USD-only edition: BTC is the sole tradable market at launch
// (more pairs arrive in a later edition). Any spelling of the pair
// (BTC, BTCUSD, BTC/USD, BTC-USD) normalizes to the stored symbol
// "BTC"; everything else is rejected server-side, so the rule holds
// no matter what the client sends.
function normalizeTradableSymbol(raw: string): string | null {
  const s = raw.trim().toUpperCase().replace(/[\s/_-]+/g, "");
  return s === "BTC" || s === "BTCUSD" ? "BTC" : null;
}

const BTC_ONLY_MESSAGE =
  "This edition trades BTC/USD only — more pairs arrive in a later edition. Nothing was recorded.";

const stateResponse = z.object({
  profile: z
    .object({
      handle: z.string(),
      home_market: z.string(),
      onboarded: z.boolean(),
    })
    .nullable(),
  wallet: z.object({ balance: z.number(), mmr: z.number() }),
  walletTxns: z.array(
    z.object({
      id: z.number(),
      type: z.string(),
      amount: z.number(),
      label: z.string(),
      created_at: z.string(),
    }),
  ),
  positions: z.array(
    z.object({
      id: z.number(),
      symbol: z.string(),
      qty: z.number(),
      avg_cost: z.number(),
      current_price: z.number(),
      source: z.string(),
      updated_at: z.string(),
    }),
  ),
  trades: z.array(
    z.object({
      id: z.number(),
      symbol: z.string(),
      side: z.string(),
      qty: z.number(),
      price: z.number(),
      note: z.string(),
      created_at: z.string(),
    }),
  ),
  duels: z.array(
    z.object({
      id: z.number(),
      opponent: z.string(),
      wager: z.number(),
      duration_label: z.string(),
      status: z.string(),
      opponent_escrow: z.number(),
      opponent_escrow_at: z.string().nullable(),
      winner: z.string().nullable(),
      your_score: z.number().nullable(),
      opp_score: z.number().nullable(),
      created_at: z.string(),
      completed_at: z.string().nullable(),
    }),
  ),
  signals: z.array(
    z.object({
      id: z.number(),
      symbol: z.string(),
      signal: z.string(),
      confidence: z.number(),
      note: z.string(),
      source: z.string(),
      created_at: z.string(),
    }),
  ),
  milestones: z.array(
    z.object({
      id: z.number(),
      week: z.number(),
      label: z.string(),
      detail: z.string(),
      done: z.boolean(),
      status: z.enum(["ready", "app-scope", "deploy-step", "mixed"]),
      status_note: z.string(),
    }),
  ),
});

type StateResponse = z.infer<typeof stateResponse>;

type DuelRow = typeof schema.duels.$inferSelect;

// Record the bot rival's matched escrow. Rivals in this single-user
// edition are bots (no human invite / deep link exists here), so the
// accept step is: the named bot rival accepts and escrows a matching
// wager on the game side. That escrow is written on the duel row AND
// as a zero-amount ledger entry — zero because it is not the user's
// money and must never move the user's balance; the row exists so
// both sides of the pot are visible in the coin ledger. Idempotent.
async function recordBotEscrow(ctx: Ctx, d: DuelRow): Promise<boolean> {
  if (d.opponentEscrow > 0) return false;
  const db = ctx.db<typeof schema>();
  await db
    .update(schema.duels)
    .set({ opponentEscrow: d.wager, opponentEscrowAt: new Date() })
    .where(eq(schema.duels.id, d.id));
  await db.insert(schema.walletTxns).values({
    type: "opponent_escrow",
    amount: 0,
    label: `${d.opponent} (bot rival) accepted & matched escrow — ${d.wager} coins into the pot (bot side, not your wallet) · pot now ${d.wager * 2}`,
  });
  return true;
}

// Ledger note when a voided duel releases the bot's escrow back to the
// game side. Zero-amount for the same reason as recordBotEscrow.
async function releaseBotEscrow(ctx: Ctx, d: DuelRow): Promise<void> {
  if (d.opponentEscrow <= 0) return;
  const db = ctx.db<typeof schema>();
  await db.insert(schema.walletTxns).values({
    type: "opponent_escrow_release",
    amount: 0,
    label: `${d.opponent} (bot rival) escrow of ${d.opponentEscrow} coins released — duel voided (bot side, not your wallet)`,
  });
}

async function loadState(ctx: Ctx): Promise<StateResponse> {
  const db = ctx.db<typeof schema>();
  let walletRows = await db.select().from(schema.wallet);
  if (walletRows.length === 0) {
    await db.insert(schema.wallet).values({ id: 1, balance: 0, mmr: 1000 });
    walletRows = await db.select().from(schema.wallet);
  }
  const w = walletRows[0] ?? { balance: 0, mmr: 1000 };

  const profileRows = await db.select().from(schema.playerProfile);
  const prof = profileRows[0];

  const [txns, positions, trades, duels, signals, milestones] =
    await Promise.all([
      db
        .select()
        .from(schema.walletTxns)
        .orderBy(desc(schema.walletTxns.id))
        .limit(50),
      db.select().from(schema.positions).orderBy(asc(schema.positions.symbol)),
      db
        .select()
        .from(schema.trades)
        .orderBy(desc(schema.trades.id))
        .limit(100),
      db.select().from(schema.duels).orderBy(desc(schema.duels.id)).limit(50),
      db
        .select()
        .from(schema.signals)
        .orderBy(desc(schema.signals.id))
        .limit(50),
      db
        .select()
        .from(schema.milestones)
        .orderBy(asc(schema.milestones.sort)),
    ]);

  return {
    profile: prof
      ? {
          handle: prof.handle,
          home_market: prof.homeMarket,
          onboarded: prof.onboardedAt != null,
        }
      : null,
    wallet: { balance: w.balance, mmr: w.mmr },
    walletTxns: txns.map((t) => ({
      id: t.id,
      type: t.type,
      amount: t.amount,
      label: t.label,
      created_at: t.createdAt.toISOString(),
    })),
    positions: positions.map((p) => ({
      id: p.id,
      symbol: p.symbol,
      qty: p.qty,
      avg_cost: p.avgCost,
      current_price: p.currentPrice,
      source: p.source,
      updated_at: p.updatedAt.toISOString(),
    })),
    trades: trades.map((t) => ({
      id: t.id,
      symbol: t.symbol,
      side: t.side,
      qty: t.qty,
      price: t.price,
      note: t.note,
      created_at: t.createdAt.toISOString(),
    })),
    duels: duels.map((d) => ({
      id: d.id,
      opponent: d.opponent,
      wager: d.wager,
      duration_label: d.durationLabel,
      status: d.status,
      opponent_escrow: d.opponentEscrow ?? 0,
      opponent_escrow_at: d.opponentEscrowAt
        ? d.opponentEscrowAt.toISOString()
        : null,
      winner: d.winner ?? null,
      your_score: d.yourScore ?? null,
      opp_score: d.oppScore ?? null,
      created_at: d.createdAt.toISOString(),
      completed_at: d.completedAt ? d.completedAt.toISOString() : null,
    })),
    signals: signals.map((s) => ({
      id: s.id,
      symbol: s.symbol,
      signal: s.signal,
      confidence: s.confidence,
      note: s.note,
      source: s.source,
      created_at: s.createdAt.toISOString(),
    })),
    milestones: milestones.map((m) => ({
      id: m.id,
      week: m.week,
      label: m.label,
      detail: m.detail,
      done: m.done === 1,
      status: m.status,
      status_note: m.statusNote,
    })),
  };
}

export const Actions = {
  getState: defineAction({
    description: "Load the full league state: wallet, positions, trades, duels, signals, and build milestones.",
    request: z.object({}),
    response: stateResponse,
    async handler(ctx): Promise<StateResponse> {
      return loadState(ctx);
    },
  }),

  // New-player setup: saves the player card (handle + home market),
  // marks onboarding complete, and pays the one-time 500-coin starter
  // grant (blueprint §2) if it was never granted. Idempotent on the
  // grant: a starter_grant ledger row is the proof it was paid, so
  // replaying setup (or signing in again) never pays twice.
  completeOnboarding: defineAction({
    description: "Finish new-player setup: save the player card, mark onboarding complete, and pay the one-time 500-coin starter grant if it was never granted.",
    request: z.object({
      handle: z.string().trim().min(2).max(20),
      homeMarket: z.string().trim().max(40).default(""),
    }),
    response: z.object({
      ok: z.boolean(),
      message: z.string(),
      granted: z.boolean(),
    }),
    async handler(ctx, args) {
      if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(args.handle)) {
        return {
          ok: false,
          message:
            "That handle won't work — use 2–20 characters: letters, numbers, spaces, dots, dashes or underscores.",
          granted: false,
        };
      }
      const db = ctx.db<typeof schema>();
      const now = new Date();
      const existing = await db.select().from(schema.playerProfile);
      if (existing.length === 0) {
        await db.insert(schema.playerProfile).values({
          id: 1,
          handle: args.handle,
          homeMarket: args.homeMarket,
          onboardedAt: now,
        });
      } else {
        await db
          .update(schema.playerProfile)
          .set({
            handle: args.handle,
            homeMarket: args.homeMarket,
            onboardedAt: now,
            updatedAt: now,
          })
          .where(eq(schema.playerProfile.id, 1));
      }

      let walletRows = await db.select().from(schema.wallet);
      if (walletRows.length === 0) {
        await db
          .insert(schema.wallet)
          .values({ id: 1, balance: 0, mmr: 1000 });
        walletRows = await db.select().from(schema.wallet);
      }
      const w = walletRows[0];
      const txns = await db.select().from(schema.walletTxns);
      const alreadyGranted = txns.some((t) => t.type === "starter_grant");
      let granted = false;
      if (w && !alreadyGranted) {
        await db
          .update(schema.wallet)
          .set({ balance: w.balance + 500 })
          .where(eq(schema.wallet.id, w.id));
        await db.insert(schema.walletTxns).values({
          type: "starter_grant",
          amount: 500,
          label: "Starter grant — 500 coins for joining the league (blueprint §2)",
        });
        granted = true;
      }
      ctx.invalidateQueries();
      return {
        ok: true,
        message: granted
          ? `Welcome to the league, ${args.handle} — 500 starter coins are in your wallet.`
          : `Welcome to the league, ${args.handle} — your starter coins were already claimed, so your balance stands as it was.`,
        granted,
      };
    },
  }),

  // Player-card edits after setup (Profile tab settings). Never
  // touches onboarding state or the wallet.
  updateProfile: defineAction({
    description: "Update the player card's handle and home market from the Profile settings.",
    request: z.object({
      handle: z.string().trim().min(2).max(20),
      homeMarket: z.string().trim().max(40).default(""),
    }),
    response: okResponse,
    async handler(ctx, args) {
      if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(args.handle)) {
        return {
          ok: false,
          message:
            "That handle won't work — use 2–20 characters: letters, numbers, spaces, dots, dashes or underscores.",
        };
      }
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.playerProfile);
      if (existing.length === 0) {
        await db.insert(schema.playerProfile).values({
          id: 1,
          handle: args.handle,
          homeMarket: args.homeMarket,
        });
      } else {
        await db
          .update(schema.playerProfile)
          .set({
            handle: args.handle,
            homeMarket: args.homeMarket,
            updatedAt: new Date(),
          })
          .where(eq(schema.playerProfile.id, 1));
      }
      ctx.invalidateQueries();
      return { ok: true, message: "Player card updated." };
    },
  }),

  // One-time import of the exact values from the user's Streamlit
  // prototype (app.py) + blueprint starter state. Idempotent: it only
  // seeds tables that are still empty, and never overwrites user edits.
  importPrototype: defineAction({
    description: "One-time import of the exact Streamlit prototype snapshot (portfolio, signals, starter wallet, build plan) into empty tables.",
    request: z.object({}),
    response: z.object({ imported: z.boolean(), message: z.string() }),
    async handler(ctx) {
      if (!isOwner(ctx)) {
        return { imported: false, message: OWNER_ONLY_MESSAGE };
      }
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.positions);
      const existingSignals = await db.select().from(schema.signals);
      const existingMilestones = await db.select().from(schema.milestones);
      if (
        existing.length > 0 ||
        existingSignals.length > 0 ||
        existingMilestones.length > 0
      ) {
        return { imported: false, message: "Prototype already imported." };
      }

      // Wallet: 500-coin starter grant (blueprint §2, User Story 1.1).
      let walletRows = await db.select().from(schema.wallet);
      if (walletRows.length === 0) {
        await db
          .insert(schema.wallet)
          .values({ id: 1, balance: 0, mmr: 1000 });
        walletRows = await db.select().from(schema.wallet);
      }
      const w = walletRows[0];
      if (w && w.balance === 0) {
        await db
          .update(schema.wallet)
          .set({ balance: 500 })
          .where(eq(schema.wallet.id, 1));
        await db.insert(schema.walletTxns).values({
          type: "starter_grant",
          amount: 500,
          label: "Starter grant — blueprint §2 (500 coins on signup)",
        });
      }

      // One-money coin system: the book starts CLEAN — 500 coins, 0 BTC.
      // The old prototype dollar portfolio (BTC 0.52 / ETH / KAS) is
      // retired (migration 0008 deletes prototype positions); a fresh
      // import must never resurrect it, so no positions are seeded here.
      // Players open their first BTC position by spending coins.

      // ML Signals from app.py tab 3.
      await db.insert(schema.signals).values([
        {
          symbol: "KAS",
          signal: "STRONG BUY",
          confidence: 94,
          note: "VisualML Signals tab — Streamlit prototype",
          source: "prototype",
        },
        {
          symbol: "BTC",
          signal: "BUY",
          confidence: 87,
          note: "VisualML Signals tab — Streamlit prototype",
          source: "prototype",
        },
        {
          symbol: "ETH",
          signal: "HOLD",
          confidence: 52,
          note: "VisualML Signals tab — Streamlit prototype",
          source: "prototype",
        },
      ]);

      // 8-week build order from README §10, each with its verified
      // status stored on the record (kept in sync with migration 0004,
      // which sets the same values on already-imported rows). Ready =
      // built & verified in this app; app-scope = built for this app
      // edition, limit named in the note; deploy-step = deploy only;
      // mixed (Week 8) = prices ready, store submission is deploy.
      const plan: Array<{
        week: number;
        label: string;
        detail: string;
        status: "ready" | "app-scope" | "deploy-step" | "mixed";
        statusNote: string;
      }> = [
        { week: 1, label: "Auth + Wallet", detail: "Expo login via Google · 500-coin starter wallet · Wallet API + DB live", status: "ready", statusNote: "Wallet, integer coins, and the full ledger run live in this app (Google sign-in itself ships with the mobile build)." },
        { week: 2, label: "Trading Core", detail: "Buy/sell with mock prices · positions + live P/L", status: "ready", statusNote: "Paper trading core live: weighted-average cost, positions, live P/L." },
        { week: 3, label: "Duel Flow", detail: "Create duel · accept via deep link · coins escrowed correctly", status: "app-scope", statusNote: "Create, then the bot rival accepts and matches escrow (recorded in the ledger), then live battle. Limit: bot accept, not a human deep-link — rivals here are bots and are labeled as bots; human invite / deep-link accept belongs to the shipped app." },
        { week: 4, label: "Realtime", detail: "Socket.io rooms · both players see each other's trades live", status: "app-scope", statusNote: "The board refreshes itself every 15 seconds. Limit: polling, not Socket.io — Socket.io rooms belong to the shipped app." },
        { week: 5, label: "Scoring + End", detail: "Duels auto-end · score calc runs · winner paid", status: "ready", statusNote: "Server-side auto-score and auto-end from your real record (blueprint §6: R·K·C·A·B), pot paid or refunded." },
        { week: 6, label: "Anti-Abuse + Polish", detail: "Cooldowns · device check · min-trades rule", status: "app-scope", statusNote: "Under-3-trades auto-void, 5 duels/hour and 60 trades/hour caps, 24h rematch cooldown — all enforced server-side. Limit: the shared-device check belongs to the shipped app." },
        { week: 7, label: "TestFlight Beta", detail: "EAS submit · 20 friends testing duels", status: "deploy-step", statusNote: "TestFlight beta happens when you say deploy — not built, not faked." },
        { week: 8, label: "Store Submit", detail: "Screenshots + listing · Polygon.io for real prices", status: "mixed", statusNote: "Live BTC/USD price via the free Coinbase public API is ready — no key, no account, no cost (BTC/USD is the only market in this edition). Store submission is a deploy step, when you say deploy; Polygon.io is no longer required." },
      ];
      await db.insert(schema.milestones).values(
        plan.map((p, i) => ({
          week: p.week,
          label: p.label,
          detail: p.detail,
          done: 0,
          status: p.status,
          statusNote: p.statusNote,
          sort: i,
        })),
      );

      ctx.invalidateQueries();
      return { imported: true, message: "Prototype snapshot imported." };
    },
  }),

  // Paper trade: inserts the trade and upserts the position with a
  // weighted-average cost, exactly per blueprint §5.1.
  addTrade: defineAction({
    description: "Record a BTC/USD paper trade and update the position with weighted-average cost.",
    request: z.object({
      symbol: z.string().min(1).max(12),
      side: z.enum(["buy", "sell"]),
      qty: z.number().positive(),
      price: z.number().positive(),
      note: z.string().max(200).default(""),
    }),
    response: okResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const symbol = normalizeTradableSymbol(args.symbol);
      if (!symbol) return { ok: false, message: BTC_ONLY_MESSAGE };

      // Anti-abuse (blueprint §7): 60 trades per hour rate cap.
      const recentTrades = await db.select().from(schema.trades);
      const tradesLastHour = recentTrades.filter(
        (t) => Date.now() - t.createdAt.getTime() < 3600_000,
      ).length;
      if (tradesLastHour >= 60) {
        return {
          ok: false,
          message:
            "Rate limit: 60 trades per hour max (blueprint anti-abuse). Nothing was recorded.",
        };
      }

      const rows = await db
        .select()
        .from(schema.positions)
        .where(eq(schema.positions.symbol, symbol));
      const pos = rows[0];

      if (args.side === "buy") {
        if (!pos) {
          await db.insert(schema.positions).values({
            symbol,
            qty: args.qty,
            avgCost: args.price,
            currentPrice: args.price,
            source: "user",
          });
        } else {
          const newQty = round8(pos.qty + args.qty);
          const newAvg =
            newQty > 0
              ? round8((pos.qty * pos.avgCost + args.qty * args.price) / newQty)
              : args.price;
          await db
            .update(schema.positions)
            .set({
              qty: newQty,
              avgCost: newAvg,
              currentPrice: args.price,
              updatedAt: new Date(),
            })
            .where(eq(schema.positions.id, pos.id));
        }
      } else {
        if (!pos || pos.qty <= 0) {
          return {
            ok: false,
            message: `No open ${symbol} position to sell.`,
          };
        }
        if (args.qty > pos.qty + 1e-9) {
          return {
            ok: false,
            message: `You only hold ${pos.qty} ${symbol}.`,
          };
        }
        const newQty = round8(pos.qty - args.qty);
        if (newQty <= 1e-9) {
          await db
            .delete(schema.positions)
            .where(eq(schema.positions.id, pos.id));
        } else {
          await db
            .update(schema.positions)
            .set({ qty: newQty, currentPrice: args.price, updatedAt: new Date() })
            .where(eq(schema.positions.id, pos.id));
        }
      }

      await db.insert(schema.trades).values({
        symbol,
        side: args.side,
        qty: args.qty,
        price: args.price,
        note: args.note,
      });
      ctx.invalidateQueries();
      return { ok: true, message: "Trade recorded." };
    },
  }),

  // --- One-money coin trading -------------------------------------
  // Coins are the ONLY money in the game: the 500-coin starter wallet
  // funds BOTH trades and duel wagers. A buy spends whole coins from
  // the wallet at the live Coinbase spot price (fractional BTC behind
  // the scenes, qty = coins / price). A sell closes a slice of the
  // position measured in current coin value: selling N coins' worth
  // removes N / livePrice BTC and credits exactly N coins, so price
  // moves land in the wallet as coin P/L. Coins in (cost) for the
  // position = qty x avg_cost; current value = qty x live price.
  buyBtcWithCoins: defineAction({
    description: "Buy BTC by spending whole coins from the wallet at the live Coinbase price (coins are the game's only money).",
    request: z.object({
      coins: z.number().int().positive().max(1000000),
    }),
    response: okResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const recentTrades = await db.select().from(schema.trades);
      const tradesLastHour = recentTrades.filter(
        (t) => Date.now() - t.createdAt.getTime() < 3600_000,
      ).length;
      if (tradesLastHour >= 60) {
        return {
          ok: false,
          message:
            "Rate limit: 60 trades per hour max (blueprint anti-abuse). Nothing was recorded.",
        };
      }
      const walletRows = await db.select().from(schema.wallet);
      const w = walletRows[0];
      if (!w) return { ok: false, message: "Wallet not initialized." };
      if (args.coins > w.balance) {
        return {
          ok: false,
          message: `You tried to spend ${args.coins} coins but only ${w.balance} free coins are in your wallet. Coins locked in BTC or escrowed in a duel can't be spent twice.`,
        };
      }
      const price = await fetchBtcSpotPrice();
      if (price == null) {
        return {
          ok: false,
          message:
            "Couldn't reach Coinbase for the live BTC price — no coins were spent. Try again in a moment.",
        };
      }
      const qty = round8(args.coins / price);
      if (!(qty > 0)) {
        return { ok: false, message: "That coin amount buys too little BTC to record." };
      }
      const rows = await db
        .select()
        .from(schema.positions)
        .where(eq(schema.positions.symbol, "BTC"));
      const pos = rows[0];
      if (!pos) {
        await db.insert(schema.positions).values({
          symbol: "BTC",
          qty,
          avgCost: price,
          currentPrice: price,
          source: "user",
        });
      } else {
        const newQty = round8(pos.qty + qty);
        const newAvg =
          newQty > 0
            ? round8((pos.qty * pos.avgCost + qty * price) / newQty)
            : price;
        await db
          .update(schema.positions)
          .set({ qty: newQty, avgCost: newAvg, currentPrice: price, updatedAt: new Date() })
          .where(eq(schema.positions.id, pos.id));
      }
      await db
        .update(schema.wallet)
        .set({ balance: w.balance - args.coins })
        .where(eq(schema.wallet.id, w.id));
      await db.insert(schema.walletTxns).values({
        type: "trade_buy",
        amount: -args.coins,
        label: `Bought BTC with ${args.coins} coins @ $${price.toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
      });
      await db.insert(schema.trades).values({
        symbol: "BTC",
        side: "buy",
        qty,
        price,
        note: `${args.coins} coins in`,
      });
      ctx.invalidateQueries();
      return {
        ok: true,
        message: `Bought ${qty} BTC with ${args.coins} coins @ $${price.toLocaleString("en-US", { maximumFractionDigits: 2 })}. ${w.balance - args.coins} free coins left.`,
      };
    },
  }),

  sellBtcForCoins: defineAction({
    description: "Sell a coin-value slice of the BTC position (or close it all) at the live Coinbase price, crediting coins back to the wallet.",
    request: z.object({
      coins: z.number().int().positive().max(1000000).optional(),
      closeAll: z.boolean().default(false),
    }),
    response: okResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const recentTrades = await db.select().from(schema.trades);
      const tradesLastHour = recentTrades.filter(
        (t) => Date.now() - t.createdAt.getTime() < 3600_000,
      ).length;
      if (tradesLastHour >= 60) {
        return {
          ok: false,
          message:
            "Rate limit: 60 trades per hour max (blueprint anti-abuse). Nothing was recorded.",
        };
      }
      const rows = await db
        .select()
        .from(schema.positions)
        .where(eq(schema.positions.symbol, "BTC"));
      const pos = rows[0];
      if (!pos || pos.qty <= 0) {
        return { ok: false, message: "No open BTC position to sell." };
      }
      const price = await fetchBtcSpotPrice();
      if (price == null) {
        return {
          ok: false,
          message:
            "Couldn't reach Coinbase for the live BTC price — nothing was sold. Try again in a moment.",
        };
      }
      const currentValue = pos.qty * price;
      let credit: number;
      let qtyToSell: number;
      if (args.closeAll) {
        credit = Math.round(currentValue);
        qtyToSell = pos.qty;
        if (credit <= 0) {
          return { ok: false, message: "Your BTC position is worth less than 1 coin right now — nothing to close." };
        }
      } else {
        if (args.coins == null) {
          return { ok: false, message: "Pick how many coins' worth of BTC to sell, or close all." };
        }
        if (args.coins > currentValue + 1e-9) {
          return {
            ok: false,
            message: `You tried to sell ${args.coins} coins' worth but your BTC position is only worth ${Math.floor(currentValue)} coins right now.`,
          };
        }
        credit = args.coins;
        qtyToSell = round8(credit / price);
      }
      const walletRows = await db.select().from(schema.wallet);
      const w = walletRows[0];
      if (!w) return { ok: false, message: "Wallet not initialized." };
      const newQty = round8(pos.qty - qtyToSell);
      if (args.closeAll || newQty <= 1e-9) {
        await db.delete(schema.positions).where(eq(schema.positions.id, pos.id));
      } else {
        await db
          .update(schema.positions)
          .set({ qty: newQty, currentPrice: price, updatedAt: new Date() })
          .where(eq(schema.positions.id, pos.id));
      }
      await db
        .update(schema.wallet)
        .set({ balance: w.balance + credit })
        .where(eq(schema.wallet.id, w.id));
      await db.insert(schema.walletTxns).values({
        type: "trade_sell",
        amount: credit,
        label: `Sold BTC for ${credit} coins @ $${price.toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
      });
      await db.insert(schema.trades).values({
        symbol: "BTC",
        side: "sell",
        qty: qtyToSell,
        price,
        note: `${credit} coins out`,
      });
      ctx.invalidateQueries();
      return {
        ok: true,
        message: `Sold ${qtyToSell} BTC for ${credit} coins @ $${price.toLocaleString("en-US", { maximumFractionDigits: 2 })}. ${w.balance + credit} free coins now.`,
      };
    },
  }),

  // Live quote refresh (Week 8 price feed): pulls the real BTC/USD spot
  // price from the free Coinbase public API (no key, no account, no cost)
  // and writes it into the BTC position's current_price. BTC/USD is the
  // only market in this edition, so only the BTC-USD spot pair is
  // fetched. The blueprint's originally named provider, Polygon.io, is
  // no longer required — the free Coinbase feed covers the price need.
  // The UI labels this source honestly. On any fetch failure nothing
  // changes (the last known price stands).
  refreshPrices: defineAction({
    description: "Fetch the live BTC/USD spot price from the free Coinbase public API and update the BTC position's current price.",
    request: z.object({}),
    response: z.object({
      ok: z.boolean(),
      message: z.string(),
      updated: z.array(
        z.object({ symbol: z.string(), price: z.number() }),
      ),
      asOf: z.string().nullable(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const url =
        "https://api.coinbase.com/v2/prices/BTC-USD/spot";
      let quotes: Record<string, number> = {};
      try {
        const res = await fetch(url, {
          headers: { accept: "application/json" },
        });
        if (!res.ok) {
          return {
            ok: false,
            message: `Coinbase quote source returned ${res.status} — price left unchanged (last known price stands).`,
            updated: [],
            asOf: null,
          };
        }
        const json = (await res.json()) as {
          data?: { amount?: string; base?: string; currency?: string };
        };
        // Coinbase returns the spot amount as a string; only accept it
        // if it is for the BTC-USD pair and parses to a positive number.
        if (json.data?.base === "BTC" && json.data?.currency === "USD") {
          const amount = Number(json.data.amount);
          if (Number.isFinite(amount) && amount > 0) quotes.BTC = amount;
        }
      } catch {
        return {
          ok: false,
          message:
            "Couldn't reach the Coinbase quote source — prices left unchanged (last known price stands).",
          updated: [],
          asOf: null,
        };
      }
      if (Object.keys(quotes).length === 0) {
        return {
          ok: false,
          message:
            "Coinbase quote source sent no usable BTC/USD price — price left unchanged (last known price stands).",
          updated: [],
          asOf: null,
        };
      }
      const rows = await db.select().from(schema.positions);
      const updated: Array<{ symbol: string; price: number }> = [];
      for (const p of rows) {
        // BTC/USD only: legacy holdings (ETH/KAS) are never repriced here.
        if (p.symbol.toUpperCase() !== "BTC") continue;
        const q = quotes[p.symbol.toUpperCase()];
        if (typeof q === "number" && q > 0) {
          await db
            .update(schema.positions)
            .set({ currentPrice: q, updatedAt: new Date() })
            .where(eq(schema.positions.id, p.id));
          updated.push({ symbol: p.symbol, price: q });
        }
      }
      ctx.invalidateQueries();
      const asOf = new Date().toISOString();
      return {
        ok: true,
        message:
          updated.length > 0
            ? `Live prices refreshed from Coinbase (free public API — no key needed): ${updated.map((u) => `${u.symbol} $${u.price.toLocaleString("en-US", { maximumFractionDigits: u.price < 1 ? 5 : 2 })}`).join(" · ")}`
            : "Live quote fetched, but you hold no BTC position — nothing to update.",
        updated,
        asOf,
      };
    },
  }),

  // Real BTC/USD candles from the free Coinbase Exchange public API
  // (no key). Candles come back as [time, low, high, open, close,
  // volume] arrays, newest first; we return them oldest-first.
  getBtcCandles: defineAction({
    description: "Fetch real BTC/USD candles from the free Coinbase public API for the market chart (24H, 7D, or 1M range).",
    request: z.object({ range: z.enum(["24H", "7D", "1M"]) }),
    response: z.object({
      ok: z.boolean(),
      message: z.string(),
      candles: z.array(
        z.object({
          t: z.number(),
          open: z.number(),
          high: z.number(),
          low: z.number(),
          close: z.number(),
          volume: z.number(),
        }),
      ),
    }),
    async handler(_ctx, args) {
      const granularity =
        args.range === "24H" ? 3600 : args.range === "7D" ? 21600 : 86400;
      const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${granularity}`;
      try {
        const res = await fetch(url, {
          headers: { accept: "application/json", "user-agent": "paper-trading-league" },
        });
        if (!res.ok) {
          return {
            ok: false,
            message: `Coinbase candle source returned ${res.status} — chart shows your stored price instead.`,
            candles: [],
          };
        }
        const raw = (await res.json()) as unknown;
        if (!Array.isArray(raw)) {
          return { ok: false, message: "Coinbase sent no usable candles — chart shows your stored price instead.", candles: [] };
        }
        const candles = raw
          .filter((r): r is number[] => Array.isArray(r) && r.length >= 6 && r.every((n) => typeof n === "number" && Number.isFinite(n)))
          .map((r) => ({ t: r[0]!, low: r[1]!, high: r[2]!, open: r[3]!, close: r[4]!, volume: r[5]! }))
          .sort((a, b) => a.t - b.t)
          .slice(args.range === "24H" ? -24 : args.range === "7D" ? -28 : -30);
        if (candles.length === 0) {
          return { ok: false, message: "Coinbase sent no usable candles — chart shows your stored price instead.", candles: [] };
        }
        return { ok: true, message: "Coinbase candles loaded.", candles };
      } catch {
        return {
          ok: false,
          message: "Couldn't reach Coinbase for candles — chart shows your stored price instead.",
          candles: [],
        };
      }
    },
  }),

  updatePrice: defineAction({
    description: "Manually set the current price of the BTC position (legacy holdings are not editable).",
    request: z.object({
      positionId: z.number().int().positive(),
      currentPrice: z.number().positive(),
    }),
    response: okResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.positions)
        .where(eq(schema.positions.id, args.positionId));
      const pos = rows[0];
      if (!pos) return { ok: false, message: "Position not found." };
      if (pos.symbol.toUpperCase() !== "BTC") {
        return {
          ok: false,
          message: `${pos.symbol} is a legacy holding from the prototype — it stays on the books but is not tradable in this BTC/USD-only edition, so its price can't be edited here.`,
        };
      }
      await db
        .update(schema.positions)
        .set({ currentPrice: args.currentPrice, updatedAt: new Date() })
        .where(eq(schema.positions.id, args.positionId));
      ctx.invalidateQueries();
      return { ok: true, message: "Price updated." };
    },
  }),

  deletePosition: defineAction({
    description: "Remove a position row from the book.",
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args) {
      if (!isOwner(ctx)) return { ok: false, message: OWNER_ONLY_MESSAGE };
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.positions)
        .where(eq(schema.positions.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, message: "Position removed." };
    },
  }),

  adjustWallet: defineAction({
    description: "Adjust the coin balance by a whole-coin amount and record it in the ledger.",
    request: z.object({
      amount: z.number().int().refine((n) => n !== 0, "Amount cannot be zero"),
      label: z.string().min(1).max(120),
    }),
    response: okResponse,
    async handler(ctx, args) {
      if (!isOwner(ctx)) return { ok: false, message: OWNER_ONLY_MESSAGE };
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.wallet);
      const w = rows[0];
      if (!w) return { ok: false, message: "Wallet not initialized." };
      const next = w.balance + args.amount;
      if (next < 0) {
        return { ok: false, message: "Balance can't go below zero." };
      }
      await db
        .update(schema.wallet)
        .set({ balance: next })
        .where(eq(schema.wallet.id, w.id));
      await db.insert(schema.walletTxns).values({
        type: "adjustment",
        amount: args.amount,
        label: args.label,
      });
      ctx.invalidateQueries();
      return { ok: true, message: "Wallet adjusted." };
    },
  }),

  createDuel: defineAction({
    description: "Create a duel against a bot rival, escrowing the wager from the wallet.",
    request: z.object({
      opponent: z.string().min(1).max(40),
      wager: z.number().int().positive(),
      durationLabel: z.string().min(1).max(30),
    }),
    response: z.object({
      ok: z.boolean(),
      message: z.string(),
      duelId: z.number().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      // Anti-abuse (blueprint §7): max 5 duels created per hour, and a
      // 24h rematch cooldown against the same opponent after a completed
      // duel. Bot-rival names compare case-insensitively.
      const now = Date.now();
      const allDuels = await db.select().from(schema.duels);
      const createdLastHour = allDuels.filter(
        (d) => now - d.createdAt.getTime() < 3600_000,
      ).length;
      if (createdLastHour >= 5) {
        return {
          ok: false,
          message:
            "Rate limit: 5 duels per hour max (blueprint anti-abuse). Your existing duels are untouched — try again in a bit.",
          duelId: null,
        };
      }
      const oppKey = args.opponent.trim().toLowerCase();
      const recentRematch = allDuels.find(
        (d) =>
          d.status === "completed" &&
          d.completedAt != null &&
          d.opponent.trim().toLowerCase() === oppKey &&
          now - d.completedAt.getTime() < 24 * 3600_000,
      );
      if (recentRematch) {
        return {
          ok: false,
          message: `Rematch cooldown: you finished a duel vs ${recentRematch.opponent} less than 24h ago (blueprint anti-abuse). Pick another rival, or wait out the cooldown.`,
          duelId: null,
        };
      }
      const rows = await db.select().from(schema.wallet);
      const w = rows[0];
      if (!w) return { ok: false, message: "Wallet not initialized.", duelId: null };
      if (args.wager > w.balance) {
        return {
          ok: false,
          message: `Wager is ${args.wager} coins but your balance is ${w.balance}.`,
          duelId: null,
        };
      }
      await db
        .update(schema.wallet)
        .set({ balance: w.balance - args.wager })
        .where(eq(schema.wallet.id, w.id));
      await db.insert(schema.walletTxns).values({
        type: "duel_entry",
        amount: -args.wager,
        label: `Duel entry vs ${args.opponent} (${args.durationLabel})`,
      });
      const inserted = await db
        .insert(schema.duels)
        .values({
          opponent: args.opponent.trim(),
          wager: args.wager,
          durationLabel: args.durationLabel,
          status: "open",
        })
        .returning({ id: schema.duels.id });
      ctx.invalidateQueries();
      return {
        ok: true,
        message: "Duel created — wager escrowed.",
        duelId: inserted[0]?.id ?? null,
      };
    },
  }),

  startDuel: defineAction({
    description: "Accept a duel: the bot rival's matched escrow is recorded and the battle goes live.",
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.duels)
        .where(eq(schema.duels.id, args.id));
      const d = rows[0];
      if (!d) return { ok: false, message: "Duel not found." };
      if (d.status !== "open") {
        return { ok: false, message: `Duel is already ${d.status}.` };
      }
      // The accept step in this single-user edition: the named bot
      // rival accepts and matches your escrow (recorded on the duel +
      // in the ledger). There is no human invite link here.
      await recordBotEscrow(ctx, d);
      await db
        .update(schema.duels)
        .set({ status: "active" })
        .where(eq(schema.duels.id, d.id));
      ctx.invalidateQueries();
      return {
        ok: true,
        message: `${d.opponent} (bot rival) accepted and matched your escrow — ${d.wager} + ${d.wager} coins. Pot is ${d.wager * 2}. Battle is live.`,
      };
    },
  }),

  completeDuel: defineAction({
    description: "Finish a duel with manually entered final scores and pay the pot to the winner.",
    request: z.object({
      id: z.number().int().positive(),
      winner: z.enum(["you", "opponent"]),
      yourScore: z.number().min(0).max(100),
      oppScore: z.number().min(0).max(100),
    }),
    response: okResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.duels)
        .where(eq(schema.duels.id, args.id));
      const d = rows[0];
      if (!d) return { ok: false, message: "Duel not found." };
      if (d.status !== "open" && d.status !== "active") {
        return { ok: false, message: `Duel is already ${d.status}.` };
      }
      const walletRows = await db.select().from(schema.wallet);
      const w = walletRows[0];
      if (!w) return { ok: false, message: "Wallet not initialized." };
      // A duel can only pay a 2× pot if both escrows are on record —
      // if it is being finished straight from "open", the bot rival's
      // accept + matched escrow is recorded first.
      await recordBotEscrow(ctx, d);

      let balance = w.balance;
      let mmr = w.mmr;
      if (args.winner === "you") {
        const pot = d.wager * 2;
        balance += pot;
        mmr += 25;
        await db.insert(schema.walletTxns).values({
          type: "duel_win",
          amount: pot,
          label: `Duel win vs ${d.opponent} — pot payout`,
        });
      } else {
        mmr = Math.max(0, mmr - 15);
      }
      await db
        .update(schema.wallet)
        .set({ balance, mmr })
        .where(eq(schema.wallet.id, w.id));
      await db
        .update(schema.duels)
        .set({
          status: "completed",
          winner: args.winner,
          yourScore: args.yourScore,
          oppScore: args.oppScore,
          completedAt: new Date(),
        })
        .where(eq(schema.duels.id, d.id));
      ctx.invalidateQueries();
      return {
        ok: true,
        message:
          args.winner === "you"
            ? `You won the pot of ${d.wager * 2} coins. MMR +25.`
            : "Duel lost. MMR −15.",
      };
    },
  }),

  // Auto-score & finish a duel from the player's real record in this
  // dashboard (blueprint §6 formula). Your side is computed from your
  // actual positions + trades. The rival side is a bot performance card
  // derived deterministically from the duel id + rival name — it is game
  // mechanics for a bot opponent, clearly labelled as such in the UI,
  // not a real person's trading record.
  autoCompleteDuel: defineAction({
    description: "Auto-score a duel from the player's real BTC record with the blueprint formula and settle the pot (voids under 3 trades).",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({
      ok: z.boolean(),
      message: z.string(),
      yourScore: z.number().nullable(),
      oppScore: z.number().nullable(),
      winner: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.duels)
        .where(eq(schema.duels.id, args.id));
      const d = rows[0];
      if (!d)
        return { ok: false, message: "Duel not found.", yourScore: null, oppScore: null, winner: null };
      if (d.status !== "open" && d.status !== "active") {
        return { ok: false, message: `Duel is already ${d.status}.`, yourScore: null, oppScore: null, winner: null };
      }

      const clampN = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
      const scoreOf = (input: { returnsPct: number; sharpe: number; winRate: number; trades: number; winner: boolean }) => {
        const r = clampN(input.returnsPct, -50, 50) + 50;
        let k = clampN(((input.sharpe + 1) / 4) * 100, 0, 100);
        if (input.trades < 3) k *= 0.5;
        const c = clampN(input.winRate, 0, 100);
        const a = Math.min(input.trades / 10, 1) * 100;
        const b = input.winner ? 10 : 0;
        return r * 0.4 + k * 0.25 + c * 0.15 + a * 0.1 + b * 0.1;
      };

      // --- Your real record (BTC/USD only: duels are scored on the
      // BTC position and BTC trades; legacy holdings don't count) ---
      const [allPositions, allTrades] = await Promise.all([
        db.select().from(schema.positions),
        db.select().from(schema.trades),
      ]);
      const posRows = allPositions.filter(
        (p) => p.symbol.toUpperCase() === "BTC",
      );
      const tradeRows = allTrades.filter(
        (t) => t.symbol.toUpperCase() === "BTC",
      );
      const cost = posRows.reduce((s, p) => s + p.qty * p.avgCost, 0);
      const value = posRows.reduce((s, p) => s + p.qty * p.currentPrice, 0);
      const returnsPct = cost > 0 ? ((value - cost) / cost) * 100 : 0;
      const winningPos = posRows.filter((p) => p.currentPrice > p.avgCost).length;
      const winRate = posRows.length > 0 ? (winningPos / posRows.length) * 100 : 50;
      const tradeCount = tradeRows.length;
      // Simple risk proxy from position dispersion of P/L %.
      const pls = posRows.map((p) => (p.avgCost > 0 ? ((p.currentPrice - p.avgCost) / p.avgCost) * 100 : 0));
      const mean = pls.length ? pls.reduce((a, b) => a + b, 0) / pls.length : 0;
      const sd = pls.length > 1 ? Math.sqrt(pls.reduce((s, x) => s + (x - mean) ** 2, 0) / pls.length) : 10;
      const sharpe = sd > 0 ? clampN(mean / sd, -1, 3) : 0;

      // Anti-abuse (blueprint): under 3 trades = void.
      if (tradeCount < 3) {
        const walletRows0 = await db.select().from(schema.wallet);
        const w0 = walletRows0[0];
        if (w0) {
          await db.update(schema.wallet).set({ balance: w0.balance + d.wager }).where(eq(schema.wallet.id, w0.id));
          await db.insert(schema.walletTxns).values({
            type: "duel_refund",
            amount: d.wager,
            label: `Duel auto-voided vs ${d.opponent} — under 3 trades (blueprint anti-abuse)`,
          });
        }
        await releaseBotEscrow(ctx, d);
        await db.update(schema.duels).set({ status: "void", completedAt: new Date() }).where(eq(schema.duels.id, d.id));
        ctx.invalidateQueries();
        return { ok: true, message: "Duel auto-voided: fewer than 3 trades on your record (blueprint anti-abuse rule). Wager refunded.", yourScore: null, oppScore: null, winner: null };
      }

      // Finishing a duel pays a 2× pot, so the bot rival's matched
      // escrow must be on record first (it is, if the duel went
      // through Accept; this covers finishing straight from "open").
      await recordBotEscrow(ctx, d);

      // --- Bot rival card (deterministic game mechanics) ---
      let seed = d.id * 7919;
      for (const ch of d.opponent) seed = (seed * 31 + ch.charCodeAt(0)) % 100000;
      const rnd = (salt: number) => {
        const x = Math.sin(seed + salt * 9973) * 10000;
        return x - Math.floor(x);
      };
      const oppReturns = Math.round((rnd(1) * 44 - 14) * 10) / 10; // -14% .. +30%
      const oppSharpe = Math.round((rnd(2) * 2.6 - 0.4) * 10) / 10;
      const oppWinRate = Math.round(35 + rnd(3) * 45);
      const oppTrades = 3 + Math.floor(rnd(4) * 10);

      // Winner bonus B depends on the winner, so score both ways and compare pre-bonus totals.
      const baseYou = scoreOf({ returnsPct, sharpe, winRate, trades: tradeCount, winner: false });
      const baseOpp = scoreOf({ returnsPct: oppReturns, sharpe: oppSharpe, winRate: oppWinRate, trades: oppTrades, winner: false });
      const winner = baseYou >= baseOpp ? "you" : "opponent";
      const yourScore = Math.round((baseYou + (winner === "you" ? 1 : 0)) * 10) / 10;
      const oppScore = Math.round((baseOpp + (winner === "opponent" ? 1 : 0)) * 10) / 10;

      const walletRows = await db.select().from(schema.wallet);
      const w = walletRows[0];
      if (!w) return { ok: false, message: "Wallet not initialized.", yourScore: null, oppScore: null, winner: null };
      let balance = w.balance;
      let mmr = w.mmr;
      if (winner === "you") {
        const pot = d.wager * 2;
        balance += pot;
        mmr += 25;
        await db.insert(schema.walletTxns).values({
          type: "duel_win",
          amount: pot,
          label: `Duel win vs ${d.opponent} — auto-scored pot payout`,
        });
      } else {
        mmr = Math.max(0, mmr - 15);
      }
      await db.update(schema.wallet).set({ balance, mmr }).where(eq(schema.wallet.id, w.id));
      await db.update(schema.duels).set({
        status: "completed",
        winner,
        yourScore,
        oppScore,
        completedAt: new Date(),
      }).where(eq(schema.duels.id, d.id));
      ctx.invalidateQueries();
      return {
        ok: true,
        message: winner === "you"
          ? `Auto-scored ${yourScore} – ${oppScore}. You took the pot of ${d.wager * 2} coins. MMR +25.`
          : `Auto-scored ${yourScore} – ${oppScore}. ${d.opponent} (bot rival) took the pot. MMR −15.`,
        yourScore,
        oppScore,
        winner,
      };
    },
  }),

  voidDuel: defineAction({
    description: "Void an open or active duel and refund the wager.",
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.duels)
        .where(eq(schema.duels.id, args.id));
      const d = rows[0];
      if (!d) return { ok: false, message: "Duel not found." };
      if (d.status !== "open" && d.status !== "active") {
        return { ok: false, message: `Duel is already ${d.status}.` };
      }
      const walletRows = await db.select().from(schema.wallet);
      const w = walletRows[0];
      if (!w) return { ok: false, message: "Wallet not initialized." };
      await db
        .update(schema.wallet)
        .set({ balance: w.balance + d.wager })
        .where(eq(schema.wallet.id, w.id));
      await db.insert(schema.walletTxns).values({
        type: "duel_refund",
        amount: d.wager,
        label: `Duel voided vs ${d.opponent} — wager refunded`,
      });
      await releaseBotEscrow(ctx, d);
      await db
        .update(schema.duels)
        .set({ status: "void", completedAt: new Date() })
        .where(eq(schema.duels.id, d.id));
      ctx.invalidateQueries();
      return { ok: true, message: "Duel voided — wager refunded." };
    },
  }),

  addSignal: defineAction({
    description: "Post a BTC/USD signal to the signal board.",
    request: z.object({
      symbol: z.string().min(1).max(12),
      signal: z.enum(["STRONG BUY", "BUY", "HOLD", "SELL", "STRONG SELL"]),
      confidence: z.number().int().min(0).max(100),
      note: z.string().max(200).default(""),
    }),
    response: okResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const symbol = normalizeTradableSymbol(args.symbol);
      if (!symbol) return { ok: false, message: BTC_ONLY_MESSAGE };
      await db.insert(schema.signals).values({
        symbol,
        signal: args.signal,
        confidence: args.confidence,
        note: args.note,
        source: "user",
      });
      ctx.invalidateQueries();
      return { ok: true, message: "Signal added." };
    },
  }),

  deleteSignal: defineAction({
    description: "Remove a signal from the signal board.",
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.signals).where(eq(schema.signals.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, message: "Signal removed." };
    },
  }),

  toggleMilestone: defineAction({
    description: "Set the user's own done checkbox on a build-plan milestone.",
    request: z.object({
      id: z.number().int().positive(),
      done: z.boolean(),
    }),
    response: okResponse,
    async handler(ctx, args) {
      if (!isOwner(ctx)) return { ok: false, message: OWNER_ONLY_MESSAGE };
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.milestones)
        .set({ done: args.done ? 1 : 0 })
        .where(eq(schema.milestones.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, message: "Milestone updated." };
    },
  }),
} satisfies ActionsModule;
