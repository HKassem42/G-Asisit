import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

type State = ApiResponse<typeof api, "getState">;
type Position = State["positions"][number];
type Duel = State["duels"][number];

// ---------- formatting helpers ----------

function fmtUsd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtPrice(n: number): string {
  if (n >= 1000)
    return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

function fmtQty(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// ---------- scoring engine (blueprint §6) ----------
// Score = 0.40·R + 0.25·K + 0.15·C + 0.10·A + 0.10·B
// R: returns normalized 0–100, capped at ±50%
// K: risk-adjusted (Sharpe-ish); penalized when trades < 3
// C: consistency = winning trades / total trades
// A: activity = min(trades / 10, 1) × 100
// B: bonus = +10 winner, 0 loser (as written in V3)

function computeScore(input: {
  returnsPct: number;
  sharpe: number;
  winRate: number;
  trades: number;
  winner: boolean;
}) {
  const r = clamp(input.returnsPct, -50, 50) + 50;
  let k = clamp(((input.sharpe + 1) / 4) * 100, 0, 100);
  const kPenalized = input.trades < 3;
  if (kPenalized) k = k * 0.5;
  const c = clamp(input.winRate, 0, 100);
  const a = Math.min(input.trades / 10, 1) * 100;
  const b = input.winner ? 10 : 0;
  const parts = [
    { key: "R", label: "Returns", raw: r, weight: 0.4 },
    { key: "K", label: "Risk control", raw: k, weight: 0.25 },
    { key: "C", label: "Consistency", raw: c, weight: 0.15 },
    { key: "A", label: "Activity", raw: a, weight: 0.1 },
    { key: "B", label: "Badge bonus", raw: b, weight: 0.1 },
  ];
  const total = parts.reduce((sum, p) => sum + p.raw * p.weight, 0);
  return { parts, total, kPenalized };
}

// ---------- league identity, derived from real state ----------
// Level, tier and XP all come from the wallet's real MMR — the same
// numbers the server moves when a duel finishes (+25 win / −15 loss).

function levelOf(mmr: number): number {
  return Math.max(1, Math.floor((mmr - 1000) / 100) + 1);
}

function xpIntoLevel(mmr: number): number {
  return clamp(((mmr - 1000) % 100 + 100) % 100, 0, 100);
}

function tierOf(mmr: number): string {
  if (mmr >= 1250) return "Platinum";
  if (mmr >= 1100) return "Gold";
  if (mmr >= 950) return "Silver";
  return "Bronze";
}

// Quests are computed from the player's real record — a quest shows
// done only when the stored data says so, and its progress bar is the
// real count over the real target.
type Quest = { name: string; detail: string; now: number; target: number };

function questsOf(s: {
  wins: number;
  completed: number;
  btcTrades: number;
  mmr: number;
  hasBtcPosition: boolean;
  userSignals: number;
}): Quest[] {
  return [
    { name: "First Blood", detail: "Win your first duel", now: s.wins, target: 1 },
    { name: "Warm-Up Laps", detail: "Record 3 BTC/USD trades", now: s.btcTrades, target: 3 },
    { name: "Duelist", detail: "Finish 3 duels, win or lose", now: s.completed, target: 3 },
    { name: "The Climb", detail: "Reach 1100 MMR", now: Math.max(0, s.mmr - 1000), target: 100 },
    { name: "Open a Book", detail: "Hold a BTC/USD position", now: s.hasBtcPosition ? 1 : 0, target: 1 },
    { name: "Signal Caller", detail: "Post a BTC/USD signal of your own", now: s.userSignals, target: 1 },
  ];
}

// Badges likewise: earned strictly from the real record; unearned
// badges render locked with the requirement named.
type Badge = { name: string; req: string; earned: boolean };

function badgesOf(s: {
  wins: number;
  completed: number;
  winRate: number;
  btcTrades: number;
  balance: number;
  appReady: number;
}): Badge[] {
  return [
    { name: "First Win", req: "Win a duel", earned: s.wins >= 1 },
    { name: "Sharpshooter", req: "60%+ win rate across 3+ finished duels", earned: s.completed >= 3 && s.winRate >= 60 },
    { name: "Active Trader", req: "Record 10 BTC/USD trades", earned: s.btcTrades >= 10 },
    { name: "Veteran", req: "Finish 5 duels", earned: s.completed >= 5 },
    { name: "Coin Baron", req: "Hold 1,000 coins", earned: s.balance >= 1000 },
    { name: "League Ready", req: "6 of 8 build weeks app-ready", earned: s.appReady >= 6 },
  ];
}

// ---------- shared bits ----------

function SectionTitle({
  children,
  right,
}: {
  children: string;
  right?: string;
  num?: string;
}) {
  return (
    <div className="mb-4 mt-2">
      <div className="flex items-center gap-2.5">
        <h2 className="font-display text-[20px] leading-none font-black tracking-tight text-[var(--text)]">
          {children}
        </h2>
      </div>
      {right ? (
        <p className="mt-1.5 text-[12px] leading-snug text-[var(--dim)]">{right}</p>
      ) : null}
    </div>
  );
}

const inputCls =
  "w-full rounded-2xl border border-[var(--border)] bg-[var(--surface2)] px-3 py-2.5 text-[var(--text)] placeholder:text-[var(--faint)] focus:outline-2 focus:outline-[var(--accent)]";
const labelCls =
  "mb-1.5 block text-[11px] font-bold tracking-[0.08em] text-[var(--dim)] uppercase";
const primaryBtn =
  "rounded-full bg-[var(--accent)] px-5 py-2.5 font-display text-sm font-black tracking-wide text-[var(--accent-ink)] uppercase disabled:opacity-40";
const ghostBtn =
  "rounded-full border border-[var(--border-strong)] bg-[var(--surface2)] px-4 py-2 text-sm font-semibold text-[var(--text)] disabled:opacity-40";
const cardCls =
  "rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] elev";

// ---------- icon system ----------
// One consistent line-icon set for the whole product: 24px grid,
// 1.7 stroke, round caps, currentColor. No emoji anywhere in the UI.
// One deliberate exception: the bottom tab bar uses the full-color
// TabIcon artwork further below — Kass explicitly prefers the
// colorful tab icons from his screenshot there.

type IconName =
  | "home"
  | "swords"
  | "chart"
  | "trophy"
  | "user"
  | "coin"
  | "bolt"
  | "refresh"
  | "clock"
  | "shield"
  | "chevron"
  | "x"
  | "bitcoin"
  | "layers"
  | "target"
  | "wallet"
  | "signal"
  | "check"
  | "lock"
  | "medal"
  | "flame";

const ICON_PATHS: Record<IconName, ReactNode> = {
  home: (
    <>
      <path d="M3.5 10.8 12 3.5l8.5 7.3" />
      <path d="M5.5 9.5V20a.8.8 0 0 0 .8.8h11.4a.8.8 0 0 0 .8-.8V9.5" />
      <path d="M9.8 20.5v-6h4.4v6" />
    </>
  ),
  swords: (
    <>
      <path d="m4 4 11.5 11.5" />
      <path d="M13.5 13.5 17 17l-2.5 2.5a1.4 1.4 0 0 1-2 0L10 17z" />
      <path d="M15.6 6.4 19 3l1 4.2-3.4 3.4" />
      <path d="m20 4-11.5 11.5" />
      <path d="M10.5 13.5 7 17l2.5 2.5a1.4 1.4 0 0 0 2 0L14 17z" />
      <path d="M8.4 6.4 5 3 4 7.2l3.4 3.4" />
    </>
  ),
  chart: (
    <>
      <path d="M4 20.5h16.5" />
      <path d="m5 15.5 4.5-5 3.5 3L18.5 7" />
      <path d="M14.8 7h3.7v3.7" />
    </>
  ),
  trophy: (
    <>
      <path d="M7.5 4h9v5.5a4.5 4.5 0 0 1-9 0z" />
      <path d="M7.5 5.5H4a3.5 3.5 0 0 0 3.6 4.5M16.5 5.5H20a3.5 3.5 0 0 1-3.6 4.5" />
      <path d="M12 14v3M8.5 20.5h7M12 17l-1 3.5h2z" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M5 20.2c.9-3.4 3.7-5.2 7-5.2s6.1 1.8 7 5.2" />
    </>
  ),
  coin: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M15.2 9.2c-.6-1-1.7-1.5-3.2-1.5-1.9 0-3.2 1-3.2 2.4 0 3.3 6.6 1.7 6.6 4.1 0 1.4-1.5 2.3-3.4 2.3-1.6 0-2.9-.6-3.5-1.7M12 5.8v12.4" />
    </>
  ),
  bolt: <path d="M13 2.8 4.8 13.5h5.4L9.4 21.2l8.4-10.9h-5.5z" />,
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20.2 3.8v4h-4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.2 5 5.8v5.4c0 4.6 3 7.7 7 9.3 4-1.6 7-4.7 7-9.3V5.8z" />
      <path d="m9 11.6 2.2 2.2 3.8-4" />
    </>
  ),
  chevron: <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  bitcoin: (
    <>
      <circle cx="12" cy="12" r="8.8" />
      <path d="M9.2 7.2h3.6a2.3 2.3 0 0 1 0 4.6H9.2zM9.2 11.8h4a2.4 2.4 0 0 1 0 4.8H9.2zM10.4 5.6v13M13.4 5.6v2.2M13.4 16.2v2.2" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3.5 9 4.7-9 4.7-9-4.7z" />
      <path d="m4.5 12.8 7.5 3.9 7.5-3.9M4.5 16.8l7.5 3.9 7.5-3.9" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.8" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  wallet: (
    <>
      <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z" />
      <path d="M4 9.5h16M16.8 14.8h.4" />
    </>
  ),
  signal: (
    <>
      <path d="M4 19.5v-5M9 19.5v-9M14 19.5V7M19 19.5V4" />
    </>
  ),
  check: <path d="m4.5 12.5 5 5 10-11" />,
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </>
  ),
  medal: (
    <>
      <circle cx="12" cy="14.5" r="5.5" />
      <path d="m8.8 9.8L6 3.5h4l2 3.6 2-3.6h4l-2.8 6.3" />
    </>
  ),
  flame: (
    <path d="M12 3.5c.8 3-1.2 4.6-2.6 6.2C8 11.3 7.5 12.8 7.5 14.5a4.5 4.5 0 0 0 9 0c0-1.2-.5-2.2-1.1-3.2-.5 1-1.2 1.7-2.1 2.1.3-3.1-.3-6.9-1.3-9.9z" />
  ),
};

export function Icon({
  name,
  size = 22,
  className,
  strokeWidth = 1.7,
}: {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

// ---------- bottom tab bar icons (full color) ----------
// Kass's preferred tab look, drawn as crisp multi-color SVG artwork
// (not emoji, not monochrome line icons): red-roof house, crossed
// silver swords, white chart card with a red rising line, gold
// trophy, blue profile silhouette. The icons stay in full color on
// BOTH active and inactive tabs; only the label color and the top
// indicator line change with the active tab.

type TabIconName = "home" | "battle" | "trade" | "league" | "profile";

function TabSword() {
  return (
    <>
      <path d="M24 3.5 27.2 11v19h-6.4V11z" fill="url(#tabBlade)" />
      <path d="M24 7v23" stroke="#ffffff" strokeOpacity="0.55" strokeWidth="1.1" />
      <rect x="15.8" y="30" width="16.4" height="3.8" rx="1.9" fill="#d99a16" />
      <rect x="22.3" y="33.8" width="3.4" height="7" fill="#5b4632" />
      <circle cx="24" cy="42.6" r="2.3" fill="#d99a16" />
    </>
  );
}

const TAB_ICON_ART: Record<TabIconName, ReactNode> = {
  home: (
    <>
      <rect x="31.5" y="10" width="5" height="9" fill="#b03a3e" />
      <rect x="12" y="24" width="24" height="17" fill="#f5e6c4" />
      <path d="M5 26 24 8l19 18z" fill="#e5484d" />
      <path d="M5 26 24 8l19 18h-5.2L24 13.4 10.2 26z" fill="#c93338" opacity="0.55" />
      <rect x="14.6" y="28.5" width="5" height="5" rx="0.8" fill="#79c4e8" />
      <rect x="28.4" y="28.5" width="5" height="5" rx="0.8" fill="#79c4e8" />
      <path d="M21 41v-8.6a3 3 0 0 1 6 0V41z" fill="#9c6b30" />
      <circle cx="9.5" cy="40.5" r="4.2" fill="#43b04c" />
      <circle cx="38.5" cy="40.5" r="4.2" fill="#43b04c" />
      <rect x="5" y="41" width="38" height="3.6" rx="1.8" fill="#35963f" />
    </>
  ),
  battle: (
    <>
      <defs>
        <linearGradient id="tabBlade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#eef2f6" />
          <stop offset="0.5" stopColor="#aeb9c4" />
          <stop offset="1" stopColor="#7e8b99" />
        </linearGradient>
      </defs>
      <g transform="rotate(40 24 24)">
        <TabSword />
      </g>
      <g transform="rotate(-40 24 24)">
        <TabSword />
      </g>
    </>
  ),
  trade: (
    <>
      <rect x="6" y="8" width="36" height="32" rx="3" fill="#f7f9fb" stroke="#c3ccd4" strokeWidth="1.2" />
      <path d="M15 8v32M24 8v32M33 8v32M6 16h36M6 24h36M6 32h36" stroke="#dde4ea" strokeWidth="1" />
      <path d="M10.5 32.5 18.5 24l6 3.2L36 14.5" fill="none" stroke="#e5322d" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M30.8 13.2 37.2 12.2 36.2 18.6z" fill="#e5322d" />
      <circle cx="10.5" cy="32.5" r="2.1" fill="#e5322d" />
    </>
  ),
  league: (
    <>
      <defs>
        <linearGradient id="tabGold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffd94d" />
          <stop offset="0.55" stopColor="#f0b41c" />
          <stop offset="1" stopColor="#cf8a0e" />
        </linearGradient>
      </defs>
      <path d="M13 10.5H8.6v2.8a6.4 6.4 0 0 0 6.9 6.1" fill="none" stroke="#e3a812" strokeWidth="3.2" strokeLinecap="round" />
      <path d="M35 10.5h4.4v2.8a6.4 6.4 0 0 1-6.9 6.1" fill="none" stroke="#e3a812" strokeWidth="3.2" strokeLinecap="round" />
      <path d="M13 7h22v7.2a11 11 0 0 1-22 0z" fill="url(#tabGold)" />
      <rect x="12" y="5.4" width="24" height="3" rx="1.5" fill="#ffdf6b" />
      <path d="M24 11.6l1.6 3.3 3.6.4-2.7 2.4.8 3.5L24 19.3l-3.3 1.9.8-3.5-2.7-2.4 3.6-.4z" fill="#fff2b0" />
      <rect x="22.4" y="25" width="3.2" height="5.4" fill="#d99a16" />
      <rect x="15" y="30.4" width="18" height="3.6" rx="1" fill="#b97e10" />
      <rect x="13" y="34.6" width="22" height="3.4" rx="1.2" fill="#a8740c" />
    </>
  ),
  profile: (
    <>
      <defs>
        <linearGradient id="tabBlue" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6db3f2" />
          <stop offset="1" stopColor="#2f6fd0" />
        </linearGradient>
      </defs>
      <circle cx="24" cy="16" r="8.2" fill="url(#tabBlue)" />
      <path d="M8.5 43c0-9.6 7-15.2 15.5-15.2S39.5 33.4 39.5 43z" fill="url(#tabBlue)" />
    </>
  ),
};

export function TabIcon({ name, size = 27 }: { name: TabIconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      {TAB_ICON_ART[name]}
    </svg>
  );
}

// Circular monogram avatar — the product's avatar treatment for the
// player and bot rivals (initials, tinted disc, hairline ring).
const AVATAR_COLORS: Record<string, string> = {
  K: "#c6f135",
  NV: "#00e5c7",
  BT: "#ff5252",
  KK: "#7c5cff",
  SE: "#38bdf8",
  PP: "#f472b6",
  HQ: "#ffc93c",
  BOT: "#94a3b8",
};

function AvatarDisc({
  initials,
  size = 44,
  accent = false,
  gold = false,
  fontSize = 13,
}: {
  initials: string;
  size?: number;
  accent?: boolean;
  gold?: boolean;
  fontSize?: number;
}) {
  const ring = gold
    ? "var(--gold)"
    : AVATAR_COLORS[initials] ?? "var(--teal)";
  const inner = size - 6;
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-full"
      style={{
        width: size,
        height: size,
        background: `conic-gradient(from 210deg, ${ring}, ${ring}88, ${ring})`,
        boxShadow: gold
          ? "0 0 18px rgba(255,201,60,0.45)"
          : `0 0 12px ${ring}44`,
      }}
    >
      <span
        className="font-display grid place-items-center rounded-full font-black"
        style={{
          width: inner,
          height: inner,
          fontSize,
          background: accent
            ? "linear-gradient(150deg,#d9ff5c,#9ecf1e)"
            : "linear-gradient(150deg,#232c40,#11151f)",
          color: accent ? "#0a0f00" : "#ffffff",
        }}
      >
        {initials}
      </span>
    </span>
  );
}

// ---------- arena rivals (bot opponents) ----------
// The rival cards are the game's published bot league: fixed league
// personas with a card MMR and win rate, labeled as bots everywhere.
// The player's own numbers always come from stored state, never here.

const RIVALS: Array<{ name: string; initials: string; style: string; mmr: number; winRate: number; tagline: string }> = [
  { name: "Nova", initials: "NV", style: "Momentum chaser", mmr: 1240, winRate: 58, tagline: "Buys BTC breakouts, never looks back." },
  { name: "BearTrap", initials: "BT", style: "Contrarian", mmr: 1185, winRate: 54, tagline: "Fades the crowd on every pump." },
  { name: "KasKing", initials: "KK", style: "BTC range trader", mmr: 1090, winRate: 51, tagline: "Farms the BTC range, session after session." },
  { name: "SteadyEddie", initials: "SE", style: "Low-risk grinder", mmr: 1035, winRate: 49, tagline: "Small wins, tiny drawdowns." },
  { name: "PixelPete", initials: "PP", style: "Chart-pattern sniper", mmr: 960, winRate: 44, tagline: "Sees triangles in his sleep." },
  { name: "HodlQueen", initials: "HQ", style: "Diamond hands", mmr: 905, winRate: 42, tagline: "Never sold. Ever. That's the strategy." },
];

// ---------- quests + badges + activity (all from real state) ----------

function QuestsSection({ quests }: { quests: Quest[] }) {
  return (
    <section className="mt-8">
      <SectionTitle num="02" right="progress is your real record">Season quests</SectionTitle>
      <div className="space-y-2">
        {quests.map((q) => {
          const done = q.now >= q.target;
          const pct = clamp((q.now / q.target) * 100, 0, 100);
          return (
            <div
              key={q.name}
              className={`${cardCls} flex items-center gap-3 px-4 py-3 ${done ? "" : "opacity-90"}`}
              style={done ? { borderColor: "var(--gold-deep)" } : undefined}
            >
              <span
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full"
                style={{
                  background: done ? "var(--gold)" : "var(--surface2)",
                  color: done ? "var(--accent-ink)" : "var(--faint)",
                  boxShadow: "inset 0 0 0 1px var(--border)",
                }}
                aria-hidden
              >
                <Icon name={done ? "check" : "lock"} size={16} strokeWidth={2.2} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-display text-sm font-extrabold">
                  {q.name}
                  {done ? (
                    <span className="mono ml-2 text-[10px] font-bold tracking-wide uppercase" style={{ color: "var(--gold)" }}>
                      complete
                    </span>
                  ) : null}
                </p>
                <p className="break-words text-xs text-[var(--dim)]">{q.detail}</p>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--surface2)]">
                  <div
                    className="bar-anim h-full rounded-full"
                    style={{
                      width: `${Math.max(pct, done ? 100 : 3)}%`,
                      background: done ? "var(--gold)" : "var(--accent)",
                    }}
                  />
                </div>
              </div>
              <span className="mono shrink-0 text-xs font-bold text-[var(--dim)]">
                {Math.min(q.now, q.target)}/{q.target}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TrophyShelf({ wins, badges }: { wins: number; badges: Badge[] }) {
  const shelf: Array<{ label: string; need: number }> = [
    { label: "First Cup", need: 1 },
    { label: "Triple Crown", need: 3 },
    { label: "High Five", need: 5 },
    { label: "Perfect Ten", need: 10 },
  ];
  return (
    <section className="mt-8">
      <SectionTitle num="04" right="earned from your record only">Trophy shelf & badges</SectionTitle>
      <div className="grid grid-cols-4 gap-2">
        {shelf.map((t) => {
          const earned = wins >= t.need;
          return (
            <div
              key={t.label}
              className={`${cardCls} px-2 py-3 text-center`}
              style={earned ? { borderColor: "var(--gold-deep)" } : undefined}
              aria-label={earned ? `Trophy earned: ${t.label}` : `Trophy locked: ${t.label} — win ${t.need} duel${t.need > 1 ? "s" : ""}`}
            >
              <span className="flex justify-center" style={{ color: earned ? "var(--gold)" : "var(--faint)" }}>
                <Icon name="trophy" size={26} strokeWidth={earned ? 2 : 1.5} />
              </span>
              <p className="font-display mt-1.5 text-[11px] leading-tight font-extrabold">{t.label}</p>
              <p className="mono mt-0.5 text-[10px] text-[var(--dim)]">
                {earned ? "on the shelf" : `${t.need} win${t.need > 1 ? "s" : ""} to earn`}
              </p>
            </div>
          );
        })}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {badges.map((b) => (
          <div
            key={b.name}
            className={`${cardCls} flex items-center gap-2.5 px-3 py-2.5`}
            aria-label={b.earned ? `Badge earned: ${b.name}` : `Badge locked: ${b.name} — ${b.req}`}
          >
            <span style={{ color: b.earned ? "var(--gold)" : "var(--faint)" }}>
              <Icon name={b.earned ? "medal" : "lock"} size={20} />
            </span>
            <div className="min-w-0">
              <p className="font-display break-words text-[13px] font-extrabold">{b.name}</p>
              <p className="break-words text-[11px] text-[var(--dim)]">
                {b.earned ? "Earned" : b.req}
              </p>
            </div>
          </div>
        ))}
      </div>
      <p className="mono mt-2 text-xs text-[var(--dim)]">
        Nothing here is decorative: every trophy and badge lights up only when your stored record earns it.
      </p>
    </section>
  );
}

// Activity feed: the wallet ledger, your trades, and duel results,
// merged and ordered by their real timestamps. Nothing is invented —
// an empty record shows an honest empty feed.
function ActivityFeed({ data }: { data: State }) {
  type Item = { key: string; at: number; icon: IconName; color: string; text: string; meta: string };
  const items: Item[] = [];
  for (const t of data.walletTxns) {
    items.push({
      key: `txn-${t.id}`,
      at: new Date(t.created_at).getTime(),
      icon: "coin",
      color: t.amount > 0 ? "var(--gain)" : t.amount < 0 ? "var(--loss)" : "var(--dim)",
      text: t.label,
      meta: t.amount === 0 ? "bot side · ledger" : `${t.amount >= 0 ? "+" : ""}${t.amount} coins · ${fmtDate(t.created_at)}`,
    });
  }
  for (const t of data.trades) {
    items.push({
      key: `trade-${t.id}`,
      at: new Date(t.created_at).getTime(),
      icon: "chart",
      color: t.side === "buy" ? "var(--gain)" : "var(--loss)",
      text: `${t.side.toUpperCase()} ${fmtQty(t.qty)} ${t.symbol.toUpperCase() === "BTC" ? "BTC/USD" : t.symbol} @ $${fmtPrice(t.price)}${t.note ? ` — ${t.note}` : ""}`,
      meta: `paper trade · ${fmtDate(t.created_at)}`,
    });
  }
  for (const d of data.duels) {
    if (d.status === "completed" && d.completed_at) {
      items.push({
        key: `duel-${d.id}`,
        at: new Date(d.completed_at).getTime(),
        icon: "trophy",
        color: d.winner === "you" ? "var(--gold)" : "var(--red)",
        text:
          d.winner === "you"
            ? `Victory over ${d.opponent} — you took the ${d.wager + d.opponent_escrow}-coin pot`
            : `${d.opponent} took the pot in your ${d.duration_label} duel`,
        meta: `final score ${d.your_score ?? "—"} – ${d.opp_score ?? "—"} · ${fmtDate(d.completed_at)}`,
      });
    } else if (d.status === "void" && d.completed_at) {
      items.push({
        key: `duel-${d.id}`,
        at: new Date(d.completed_at).getTime(),
        icon: "shield",
        color: "var(--dim)",
        text: `Duel vs ${d.opponent} voided — wager refunded`,
        meta: fmtDate(d.completed_at),
      });
    }
  }
  items.sort((a, b) => b.at - a.at);
  const top = items.slice(0, 8);
  return (
    <section className="mt-8">
      <SectionTitle num="03" right="straight from your record">League activity</SectionTitle>
      {top.length === 0 ? (
        <p className={`${cardCls} p-4 text-sm text-[var(--dim)]`}>
          Quiet arena so far. Your first trade, duel, or coin movement lands here the moment it happens.
        </p>
      ) : (
        <div className={`overflow-hidden ${cardCls}`} style={{ borderRadius: "var(--radius)" }}>
          {top.map((it, i) => (
            <div
              key={it.key}
              className={`flex items-center gap-3 bg-[var(--surface)] px-4 py-3 ${i > 0 ? "border-t border-[var(--border)]" : ""}`}
            >
              <span
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--surface2)]"
                style={{ color: it.color, boxShadow: "inset 0 0 0 1px var(--border)" }}
                aria-hidden
              >
                <Icon name={it.icon} size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-semibold">{it.text}</p>
                <p className="mono break-words text-[11px] text-[var(--dim)]">{it.meta}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------- real BTC chart (Coinbase candles) ----------

type Candle = { t: number; open: number; high: number; low: number; close: number; volume: number };
type CandleRange = "24H" | "7D" | "1M";

function useCandles(range: CandleRange) {
  return useQuery({
    queryKey: ["candles", range],
    queryFn: () => api.getBtcCandles({ range }),
    staleTime: 60_000,
  });
}

function BtcSparkline() {
  const q = useCandles("24H");
  const candles: Candle[] = q.data?.ok ? q.data.candles : [];
  if (candles.length < 2) {
    return (
      <p className="mono mt-4 text-[11px] text-[var(--dim)]">
        {q.isPending ? "Loading live BTC chart…" : "Live chart unavailable right now — your stored price still stands."}
      </p>
    );
  }
  const closes = candles.map((c) => c.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const pts = closes
    .map((v, i) => `${(i / (closes.length - 1)) * 100},${30 - ((v - min) / Math.max(max - min, 1)) * 26}`)
    .join(" ");
  const up = closes[closes.length - 1]! >= closes[0]!;
  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="mono min-w-0 text-[11px] font-bold tracking-widest text-[var(--dim)] uppercase">BTC/USD · 24H · Coinbase</p>
        <p className="mono shrink-0 text-sm font-bold whitespace-nowrap" style={{ color: up ? "var(--accent)" : "var(--red)" }}>
          ${fmtPrice(closes[closes.length - 1]!)}
        </p>
      </div>
      <svg viewBox="0 0 100 34" className="mt-1.5 w-full" style={{ height: 56 }} preserveAspectRatio="none" role="img" aria-label={`BTC/USD 24 hour line chart, last price ${fmtPrice(closes[closes.length - 1]!)} dollars`}>
        <polyline points={pts} fill="none" stroke={up ? "var(--accent)" : "var(--red)"} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function CandleChart({ candles }: { candles: Candle[] }) {
  const W = 360;
  const H = 190;
  const max = Math.max(...candles.map((c) => c.high));
  const min = Math.min(...candles.map((c) => c.low));
  const span = Math.max(max - min, 1);
  const y = (v: number) => 8 + ((max - v) / span) * (H - 24);
  const step = W / candles.length;
  const bw = Math.max(3, step * 0.55);
  const last = candles[candles.length - 1]!;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`BTC/USD candlestick chart, high ${fmtPrice(max)}, low ${fmtPrice(min)}, last ${fmtPrice(last.close)}`}>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="var(--border)" strokeWidth="0.6" strokeDasharray="3 4" />
        ))}
        {candles.map((c, i) => {
          const cx = i * step + step / 2;
          const up = c.close >= c.open;
          const col = up ? "var(--accent)" : "var(--red)";
          const top = y(Math.max(c.open, c.close));
          const bot = y(Math.min(c.open, c.close));
          return (
            <g key={c.t}>
              <line x1={cx} x2={cx} y1={y(c.high)} y2={y(c.low)} stroke={col} strokeWidth="1.1" />
              <rect x={cx - bw / 2} y={top} width={bw} height={Math.max(bot - top, 1.6)} fill={col} rx="1" />
            </g>
          );
        })}
      </svg>
      <span className="mono absolute right-0 rounded-md bg-[var(--accent)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--accent-ink)]" style={{ top: `${(y(last.close) / H) * 100}%` }}>
        {fmtPrice(last.close)}
      </span>
    </div>
  );
}

// ---------- stakes ladder (room tiers; pot shown is the real 2× pot) ----------

function StakesLadder({ onPick }: { onPick: (wager: number) => void }) {
  const tiers = [
    { name: "Practice Arena", wager: 50, glow: "glow-violet", note: "Learn the room. Small pot, full scoring." },
    { name: "Mid Stakes", wager: 100, glow: "glow-teal", note: "The standard league room." },
    { name: "High Roller", wager: 250, glow: "glow-violet", note: "Biggest pot on the ladder this season." },
  ];
  return (
    <section className="mb-6">
      <SectionTitle num="01" right="tap a room to set your wager — pot is the real 2× escrow">Stakes ladder</SectionTitle>
      <div className="space-y-3">
        {tiers.map((t) => (
          <div key={t.name} className={`rounded-[var(--radius)] bg-[var(--surface)] p-4 ${t.glow}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-display text-lg leading-tight font-black">{t.name}</p>
                <p className="mt-0.5 text-xs text-[var(--dim)]">{t.note}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="mono text-[10px] font-bold tracking-widest text-[var(--dim)] uppercase">Prize pool</p>
                <p className="mono font-display text-2xl leading-none font-black text-[var(--accent)]">{t.wager * 2}</p>
                <p className="mono mt-0.5 text-[10px] text-[var(--dim)]">coins · entry {t.wager}</p>
              </div>
            </div>
            <button
              type="button"
              className="mt-3 w-full rounded-full bg-[var(--accent)] py-3 font-display text-sm font-black tracking-wide text-[var(--accent-ink)] uppercase"
              onClick={() => onPick(t.wager)}
              aria-label={`Enter ${t.name}: set wager to ${t.wager} coins in the duel creator`}
            >
              Enter now
            </button>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-[var(--dim)]">
        Rooms are hosted by the bot rivals below — pick a tier, then name your rival in the creator. Winner takes the full pot.
      </p>
    </section>
  );
}

// ---------- featured rooms (the bot rivals, presented as duel rooms) ----------

function FeaturedRooms({ onChallenge }: { onChallenge: (name: string) => void }) {
  return (
    <section className="mt-8">
      <SectionTitle num="01" right="bot rooms · BTC/USD">Featured rooms</SectionTitle>
      <div className="space-y-2.5">
        {RIVALS.map((r, i) => (
          <div key={r.name} className={`${cardCls} flex items-center gap-3 p-3.5 ${i % 2 === 0 ? "glow-teal" : "glow-violet"}`}>
            <AvatarDisc initials={r.initials} size={48} fontSize={14} />
            <div className="min-w-0 flex-1">
              <p className="font-display break-words font-extrabold">
                {r.name}'s Room
                <span className="mono ml-2 rounded-full bg-[var(--surface2)] px-1.5 py-0.5 align-middle text-[10px] font-bold text-[var(--dim)] uppercase">
                  bot rival
                </span>
              </p>
              <p className="break-words text-xs text-[var(--dim)]">
                {r.style} — {r.tagline}
              </p>
              <p className="mono mt-1 text-[11px] text-[var(--dim)]">
                MMR {r.mmr} · win rate {r.winRate}% · entry from 50 · winner takes 2× pot
              </p>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--surface2)]">
                <div className="bar-anim h-full" style={{ width: `${r.winRate}%`, background: "var(--text)" }} />
              </div>
            </div>
            <button
              type="button"
              className={`${primaryBtn} shrink-0 px-3.5`}
              onClick={() => onChallenge(r.name)}
              aria-label={`Enter ${r.name}'s room — opens the duel creator in the Battle tab with ${r.name} filled in`}
            >
              Enter
            </button>
          </div>
        ))}
      </div>
      <p className="mono mt-2 text-xs text-[var(--dim)]">
        Every room is hosted by a bot rival in this single-user edition — there is no human invite
        link. Your wager escrows when you create the duel; the bot's matched escrow is recorded
        when it accepts, and the pot becomes a real 2× your wager.
      </p>
    </section>
  );
}

// ---------- main app ----------

type TabKey = "home" | "battle" | "trade" | "league" | "more";

export function App() {
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<string>("");
  // Mobile-app shell: exactly one tab screen is shown at a time, like
  // a phone app — no long dashboard scroll.
  const [tab, setTab] = useState<TabKey>("home");
  const [challengeReq, setChallengeReq] = useState<{
    name: string;
    nonce: number;
  } | null>(null);
  const [wagerReq, setWagerReq] = useState<{ wager: number; nonce: number } | null>(null);

  const state = useQuery({
    queryKey: ["state"],
    queryFn: () => api.getState({}),
    // Near-realtime feel (Week 4 equivalent): the board refreshes itself
    // every 15 seconds so a live duel screen stays current without a
    // manual reload. True Socket.io rooms are the mobile app's job.
    refetchInterval: 15000,
    // A single transient failure must never strand the player on an
    // error screen: retry with backoff, and keep showing the last good
    // state if a background refresh fails.
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 4000),
  });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["state"] });

  const go = (t: TabKey) => {
    setTab(t);
    window.scrollTo({ top: 0 });
  };
  const scrollToCreate = () =>
    window.setTimeout(
      () =>
        document
          .getElementById("create-duel")
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      80,
    );
  const challengeRival = (name: string) => {
    setChallengeReq({ name, nonce: Date.now() });
    go("battle");
    scrollToCreate();
  };
  const startDuelFlow = () => {
    go("battle");
    scrollToCreate();
  };
  const pickTier = (wager: number) => {
    setWagerReq({ wager, nonce: Date.now() });
    scrollToCreate();
  };

  const liveMut = useMutation({
    mutationFn: () => api.refreshPrices({}),
    onSuccess: (r) => {
      setFeedback(r.message);
      if (r.ok) refresh();
    },
    onError: () =>
      setFeedback(
        "Live price refresh failed — prices left unchanged. You can still update prices by hand in the Trade tab.",
      ),
  });

  const importMut = useMutation({
    mutationFn: () => api.importPrototype({}),
    onSuccess: (r) => {
      setFeedback(r.message);
      refresh();
    },
  });

  if (state.isPending) {
    return (
      <div className="min-h-screen bg-[var(--bg)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <main className="px-4 py-16 text-center">
          <p className="mono text-sm text-[var(--dim)]">Loading the league…</p>
        </main>
      </div>
    );
  }

  if (!state.data) {
    return (
      <div className="min-h-screen bg-[var(--bg)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <main className="px-4 py-16 text-center">
          <p className="text-[var(--red)]">Couldn't load the league.</p>
          <button
            type="button"
            className={`${ghostBtn} mt-4`}
            onClick={() => state.refetch()}
          >
            Retry
          </button>
        </main>
      </div>
    );
  }

  const data = state.data;
  const isEmpty =
    data.positions.length === 0 &&
    data.signals.length === 0 &&
    data.milestones.length === 0;

  const totalValue = data.positions.reduce(
    (s, p) => s + p.qty * p.current_price,
    0,
  );
  const costBasis = data.positions.reduce((s, p) => s + p.qty * p.avg_cost, 0);
  const unrealized = totalValue - costBasis;
  const unrealizedPct = costBasis > 0 ? (unrealized / costBasis) * 100 : 0;
  const duelWins = data.duels.filter(
    (d) => d.status === "completed" && d.winner === "you",
  ).length;
  const duelLosses = data.duels.filter(
    (d) => d.status === "completed" && d.winner === "opponent",
  ).length;
  const completedDuels = duelWins + duelLosses;
  const winRate = completedDuels > 0 ? (duelWins / completedDuels) * 100 : 0;
  const btcTrades = data.trades.filter(
    (t) => t.symbol.toUpperCase() === "BTC",
  ).length;
  const level = levelOf(data.wallet.mmr);
  const tier = tierOf(data.wallet.mmr);
  const liveDuelCount = data.duels.filter(
    (d) => d.status === "open" || d.status === "active",
  ).length;
  // Build progress is computed from the milestone records themselves
  // (their stored status), so the chip can never drift from the data:
  // app-ready = weeks whose record status is ready or app-scope.
  const totalWeeks = data.milestones.length;
  const appReadyCount = data.milestones.filter(
    (m) => m.status === "ready" || m.status === "app-scope",
  ).length;
  const pricesLive = data.milestones.some(
    (m) => m.week === 8 && m.status === "mixed",
  );
  const deploySteps = data.milestones.filter(
    (m) => m.status === "deploy-step" || m.status === "mixed",
  );

  const quests = questsOf({
    wins: duelWins,
    completed: completedDuels,
    btcTrades,
    mmr: data.wallet.mmr,
    hasBtcPosition: data.positions.some((p) => p.symbol.toUpperCase() === "BTC"),
    userSignals: data.signals.filter(
      (s) => s.source === "user" && s.symbol.toUpperCase() === "BTC",
    ).length,
  });
  const badges = badgesOf({
    wins: duelWins,
    completed: completedDuels,
    winRate,
    btcTrades,
    balance: data.wallet.balance,
    appReady: appReadyCount,
  });

  return (
    <div className="min-h-screen bg-black text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      {/* Phone column: full-bleed on a phone; on wider screens it sits
          centered at phone width like the app it previews. */}
      <div className="relative mx-auto flex min-h-screen w-full max-w-[430px] flex-col bg-[var(--bg)] sm:border-x sm:border-[var(--border)]">
        {/* ===== APP BAR ===== */}
        <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--bg)]">
          <div className="flex h-14 items-center gap-2.5 px-4">
            <AvatarDisc initials="K" size={38} accent fontSize={15} />
            <div className="min-w-0 flex-1">
              <p className="font-display break-words text-[15px] leading-tight font-extrabold tracking-tight">
                Kass
              </p>
              <p className="mono break-words text-[11px] leading-tight text-[var(--dim)]">
                {tier} · Level {level} · MMR {data.wallet.mmr}
              </p>
            </div>
            <span className="mono flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--surface2)] px-3 py-1.5 text-sm font-bold" style={{ boxShadow: "inset 0 0 0 1px var(--border)" }}>
              <Icon name="coin" size={15} className="text-[var(--gold)]" />
              {data.wallet.balance.toLocaleString()}
            </span>
          </div>
          {liveDuelCount > 0 ? (
            <button
              type="button"
              onClick={() => go("battle")}
              className="flex w-full items-center justify-center gap-1.5 bg-[var(--accent)] px-4 py-1.5 text-center text-xs font-bold text-[var(--accent-ink)]"
              aria-label={`${liveDuelCount} live or open duel${liveDuelCount > 1 ? "s" : ""} — go to Battle tab`}
            >
              <Icon name="swords" size={14} strokeWidth={2} />
              {liveDuelCount} duel{liveDuelCount > 1 ? "s" : ""} live in the arena — tap to open Battle
            </button>
          ) : null}
        </header>

        <main className="w-full min-w-0 flex-1 px-4 pt-4 pb-28">
          {feedback ? (
            <p
              role="status"
              className="mono mb-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface2)] px-3 py-2.5 text-[13px]"
            >
              {feedback}
            </p>
          ) : null}

          <div key={tab} className="tab-enter">
          {/* ===== HOME TAB — LEAGUE HQ ===== */}
          {tab === "home" ? (
            <>
              {/* Season banner */}
              <div className="hero-wash overflow-hidden rounded-[var(--radius)] p-5">
                <div className="flex items-center gap-2">
                  <span className="live-dot h-2.5 w-2.5 rounded-full bg-[var(--accent)]" aria-hidden />
                  <p className="mono text-[11px] font-bold tracking-[0.18em] text-[var(--accent)] uppercase">
                    Season 1 · Live now
                  </p>
                  <span className="mono ml-auto rounded-full bg-[var(--surface2)] px-2 py-0.5 text-[10px] font-bold tracking-wide text-[var(--dim)] uppercase">
                    BTC/USD
                  </span>
                </div>
                <p className="mono mt-4 text-[11px] font-bold tracking-[0.18em] text-[var(--dim)] uppercase">
                  Your book value
                </p>
                <h1 className="mono mt-1 text-[42px] leading-none font-bold tracking-tight">
                  {fmtUsd(totalValue)}
                </h1>
                <p
                  className="mono mt-2 text-[13px] font-semibold"
                  style={{ color: unrealized >= 0 ? "var(--gain)" : "var(--loss)" }}
                >
                  {unrealized >= 0 ? "+" : "−"}{fmtUsd(Math.abs(unrealized))} ({unrealizedPct >= 0 ? "+" : ""}{unrealizedPct.toFixed(1)}%)
                  <span className="font-normal text-[var(--dim)]"> all time · paper book</span>
                </p>
                <p className="mt-3 max-w-[320px] text-sm leading-relaxed text-[var(--dim)]">
                  1v1 BTC/USD duels, scored like a sports league. Win rooms, climb the board.
                </p>
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={startDuelFlow}
                    className="rounded-full bg-[var(--accent)] px-5 py-3 font-display text-sm font-black text-[var(--accent-ink)]"
                  >
                    Enter a duel
                  </button>
                  <button
                    type="button"
                    onClick={() => go("trade")}
                    className="rounded-full bg-[var(--surface3)] px-5 py-3 font-display text-sm font-black text-[var(--text)]"
                  >
                    Trade BTC
                  </button>
                </div>
                <BtcSparkline />
              </div>

              {/* Player card hero */}
              <div className="elev mt-4 rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] p-5">
                <div className="flex items-center gap-3.5">
                  <AvatarDisc initials="K" size={58} accent fontSize={22} />
                  <div className="min-w-0 flex-1">
                    <p className="font-display break-words text-xl leading-tight font-black">
                      Kass
                    </p>
                    <p className="mono text-[11px] text-[var(--dim)]">
                      {tier} tier · Level {level} trader
                    </p>
                    <div className="mt-2">
                      <div className="flex justify-between text-[11px] font-semibold text-[var(--dim)]">
                        <span>XP to level {level + 1}</span>
                        <span className="mono">{xpIntoLevel(data.wallet.mmr)}/100</span>
                      </div>
                      <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-[var(--surface2)]">
                        <div
                          className="bar-anim h-full rounded-full bg-[var(--accent)]"
                          style={{ width: `${Math.max(xpIntoLevel(data.wallet.mmr), 4)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-4 gap-2 text-center">
                  <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface2)] px-1 py-2.5">
                    <p className="mono font-display text-lg leading-none font-extrabold">{data.wallet.mmr}</p>
                    <p className="mt-1 text-[10px] font-bold tracking-wide text-[var(--dim)] uppercase">MMR</p>
                  </div>
                  <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface2)] px-1 py-2.5">
                    <p className="mono font-display text-lg leading-none font-extrabold">{duelWins}–{duelLosses}</p>
                    <p className="mt-1 text-[10px] font-bold tracking-wide text-[var(--dim)] uppercase">W – L</p>
                  </div>
                  <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface2)] px-1 py-2.5">
                    <p className="mono font-display text-lg leading-none font-extrabold">{data.wallet.balance.toLocaleString()}</p>
                    <p className="mt-1 text-[10px] font-bold tracking-wide text-[var(--dim)] uppercase">Coins</p>
                  </div>
                  <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface2)] px-1 py-2.5">
                    <p className="mono font-display text-lg leading-none font-extrabold" style={{ color: unrealized >= 0 ? "var(--gain)" : "var(--loss)" }}>
                      {unrealizedPct >= 0 ? "+" : ""}{unrealizedPct.toFixed(1)}%
                    </p>
                    <p className="mt-1 text-[10px] font-bold tracking-wide text-[var(--dim)] uppercase">Book P/L</p>
                  </div>
                </div>
                <p className="mono mt-3 text-[11px] text-[var(--dim)]">
                  Book value {fmtUsd(totalValue)} · unrealized {unrealized >= 0 ? "+" : "−"}{fmtUsd(Math.abs(unrealized))} · win a duel +25 MMR, lose −15
                </p>
                <div className="mt-3 grid grid-cols-4 gap-2">
                  <button
                    type="button"
                    onClick={() => go("battle")}
                    className="flex flex-col items-center gap-1.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface2)] py-3 text-[11px] font-bold"
                    aria-label="Quick action: go to Battle tab to duel"
                  >
                    <Icon name="swords" size={21} className="text-[var(--accent)]" />Duel
                  </button>
                  <button
                    type="button"
                    onClick={() => go("trade")}
                    className="flex flex-col items-center gap-1.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface2)] py-3 text-[11px] font-bold"
                    aria-label="Quick action: go to Trade tab"
                  >
                    <Icon name="chart" size={21} className="text-[var(--accent)]" />Trade
                  </button>
                  <button
                    type="button"
                    onClick={() => liveMut.mutate()}
                    disabled={liveMut.isPending}
                    className="flex flex-col items-center gap-1.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface2)] py-3 text-[11px] font-bold disabled:opacity-40"
                    aria-label="Quick action: refresh the live BTC/USD price"
                  >
                    <Icon name="refresh" size={21} className="text-[var(--accent)]" />
                    {liveMut.isPending ? "Fetching" : "BTC price"}
                  </button>
                  <button
                    type="button"
                    onClick={() => go("league")}
                    className="flex flex-col items-center gap-1.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface2)] py-3 text-[11px] font-bold"
                    aria-label="Quick action: go to League tab"
                  >
                    <Icon name="trophy" size={21} className="text-[var(--gold)]" />League
                  </button>
                </div>
              </div>

              {isEmpty ? (
                <div className="mt-4 rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--surface)] p-4">
                  <p className="font-display font-bold">Start from your Streamlit prototype</p>
                  <p className="mt-1 text-sm text-[var(--dim)]">
                    Import the exact snapshot from app.py — the prototype portfolio (BTC tradable;
                    ETH / KAS stay as legacy holdings), VisualML signals,
                    the 500-coin starter wallet, and the 8-week build plan. Everything stays
                    editable afterward.
                  </p>
                  <button
                    type="button"
                    className={`${primaryBtn} mt-3 w-full`}
                    disabled={importMut.isPending}
                    onClick={() => importMut.mutate()}
                  >
                    {importMut.isPending ? "Importing…" : "Import prototype snapshot"}
                  </button>
                </div>
              ) : null}

              <FeaturedRooms onChallenge={challengeRival} />
              <QuestsSection quests={quests} />
              <ActivityFeed data={data} />

              {totalWeeks > 0 ? (
              <button
                type="button"
                onClick={() => go("more")}
                className="mt-8 flex w-full items-center gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 text-left"
                aria-label={`Build progress: ${appReadyCount} of ${totalWeeks} weeks app-ready${pricesLive ? " plus live prices" : ""} — open Profile tab for the build plan`}
              >
                <Icon name="shield" size={24} className="shrink-0 text-[var(--accent)]" />
                <span className="min-w-0 flex-1">
                  <span className="font-display block text-sm font-bold">
                    Build: {appReadyCount} of {totalWeeks} weeks app-ready
                    {pricesLive ? " · prices live" : ""}
                  </span>
                  <span className="block text-xs text-[var(--dim)]">
                    {deploySteps
                      .map((m) =>
                        m.status === "mixed"
                          ? `Week ${m.week} ${m.label.toLowerCase()}`
                          : `Week ${m.week} ${m.label}`,
                      )
                      .join(" + ")}{" "}
                    are deploy steps — they wait for your “deploy”
                  </span>
                </span>
                <Icon name="chevron" size={16} className="shrink-0 text-[var(--dim)]" />
              </button>
              ) : null}
            </>
          ) : null}

          {/* ===== BATTLE TAB — TOURNAMENT LOBBY + LIVE ROOM ===== */}
          {tab === "battle" ? (
            <>
              <StakesLadder onPick={pickTier} />
              <RulesCard />
              <BattleScreen
                duels={data.duels}
                trades={btcTrades}
                positions={data.positions}
                setFeedback={setFeedback}
                refresh={refresh}
                onStartDuel={startDuelFlow}
              />
              <DuelsSection
                duels={data.duels}
                balance={data.wallet.balance}
                setFeedback={setFeedback}
                refresh={refresh}
                challengeReq={challengeReq}
                wagerReq={wagerReq}
              />
            </>
          ) : null}

          {/* ===== TRADE TAB — TRADING ROOM ===== */}
          {tab === "trade" ? (
            <PortfolioSection
              positions={data.positions}
              trades={data.trades}
              setFeedback={setFeedback}
              refresh={refresh}
            />
          ) : null}

          {/* ===== LEAGUE TAB — STANDINGS ===== */}
          {tab === "league" ? (
            <>
              <LeagueSection wins={duelWins} losses={duelLosses} mmr={data.wallet.mmr} duels={data.duels} winRate={winRate} btcTrades={btcTrades} />
              <TrophyShelf wins={duelWins} badges={badges} />
              <GameCharts
                positions={data.positions}
                txns={data.walletTxns}
                wins={duelWins}
                losses={duelLosses}
              />
              <ScoreCalculator trades={btcTrades} />
            </>
          ) : null}

          {/* ===== PROFILE TAB — PLAYER CARD + BUILD ===== */}
          {tab === "more" ? (
            <>
              <PlayerCard
                mmr={data.wallet.mmr}
                balance={data.wallet.balance}
                wins={duelWins}
                losses={duelLosses}
                trades={data.trades.length}
                level={level}
                tier={tier}
                totalWon={data.duels
                  .filter((d) => d.status === "completed" && d.winner === "you")
                  .reduce((s, d) => s + d.wager + d.opponent_escrow, 0)}
                badges={badges}
                onChallenge={() => go("battle")}
              />
              <TrophyShelf wins={duelWins} badges={badges} />
              <WalletSection
                balance={data.wallet.balance}
                txns={data.walletTxns}
                setFeedback={setFeedback}
                refresh={refresh}
              />
              <SignalsSection signals={data.signals} setFeedback={setFeedback} refresh={refresh} />
              <ScreensGallery />
              <BuildPlanSection milestones={data.milestones} refresh={refresh} />
              <DeployLineSection milestones={data.milestones} />
              <BlueprintSection />
            </>
          ) : null}
          </div>
        </main>

        {/* ===== BOTTOM TAB BAR ===== */}
        <nav
          aria-label="App tabs"
          className="elev-pop fixed bottom-0 left-1/2 z-30 w-full max-w-[430px] -translate-x-1/2 border-t border-[var(--border)] bg-black"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          <div className="grid grid-cols-5">
            {(
              [
                ["home", "home", "Home"],
                ["battle", "battle", "Battle"],
                ["trade", "trade", "Trade"],
                ["league", "league", "League"],
                ["more", "profile", "Profile"],
              ] as Array<[TabKey, TabIconName, string]>
            ).map(([key, icon, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => go(key)}
                aria-label={`${label} tab`}
                aria-current={tab === key ? "page" : undefined}
                className="relative flex min-h-[62px] flex-col items-center justify-center gap-1 py-2 transition-colors"
                style={{ color: tab === key ? "var(--accent)" : "var(--dim)" }}
              >
                {tab === key ? (
                  <span className="absolute top-0 h-[3px] w-11 rounded-full bg-[var(--accent)]" aria-hidden />
                ) : null}
                <span className="relative leading-none" aria-hidden>
                  <TabIcon name={icon} size={27} />
                  {key === "battle" && liveDuelCount > 0 ? (
                    <span className="mono absolute -top-1.5 -right-3 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--red)] px-0.5 text-[10px] font-bold text-white">
                      {liveDuelCount}
                    </span>
                  ) : null}
                </span>
                <span
                  className="text-[11px] tracking-wide"
                  style={{ fontWeight: tab === key ? 800 : 600 }}
                >
                  {label}
                </span>
              </button>
            ))}
          </div>
        </nav>
      </div>
    </div>
  );
}

// ---------- verified build status (stored on the milestone records) ----------
// Each milestone row carries its own status + status_note from the
// server (getState), and the Home chip, the build-plan badges, and the
// deploy-line list all render from those records — there is no
// client-side status map that can drift from the data. These helpers
// only translate a record's status value into a pill label and tone:
// ready = built & verified here; app-scope = built for this app
// edition, with the shipped-app limit named in the record's note;
// deploy-step = deploy only, never badged ready; mixed (Week 8) =
// prices ready, store submission is a deploy step.

type MilestoneStatus = State["milestones"][number]["status"];

function statusPill(status: MilestoneStatus): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "app-scope":
      return "Ready — app scope";
    case "mixed":
      return "Prices ready · store = deploy step";
    case "deploy-step":
      return "Deploy step";
  }
}

function statusTone(status: MilestoneStatus): "ready" | "partial" | "deploy" {
  switch (status) {
    case "ready":
      return "ready";
    case "app-scope":
    case "mixed":
      return "partial";
    case "deploy-step":
      return "deploy";
  }
}

// ---------- league rules card ----------
// The scoring weights shown here are the exact blueprint §6 weights
// the server scores with — the same five components, in the same
// order, rendered as labeled bars so the rulebook is visible before
// anyone escrows a coin.

function RulesCard() {
  const weights = [
    { key: "R", label: "Returns", w: 40, note: "your BTC/USD P/L, capped at ±50%" },
    { key: "K", label: "Risk control", w: 25, note: "risk-adjusted return; halved under 3 trades" },
    { key: "C", label: "Consistency", w: 15, note: "share of positions in profit" },
    { key: "A", label: "Activity", w: 10, note: "trades placed, up to 10" },
    { key: "B", label: "Badge bonus", w: 10, note: "winner's bonus" },
  ];
  return (
    <section className="mb-6">
      <div className={`${cardCls} elev p-4`}>
        <p className="font-display flex items-center gap-2 text-base font-extrabold">
          <Icon name="shield" size={19} className="text-[var(--accent)]" /> League rules — how a duel is won
        </p>
        <p className="mt-1 text-sm text-[var(--dim)]">
          Scored like a sports league, not a slot machine: five components, weighted. Your score
          comes from your real BTC/USD book — nothing else counts.
        </p>
        <div className="mt-3 space-y-2">
          {weights.map((x) => (
            <div key={x.key} className="flex items-center gap-2">
              <span className="mono w-4 text-xs font-bold text-[var(--accent)]">{x.key}</span>
              <span className="w-24 shrink-0 text-xs font-bold">{x.label}</span>
              <div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--surface2)]">
                <div className="bar-anim h-full rounded-full bg-[var(--accent)]" style={{ width: `${x.w}%` }} />
              </div>
              <span className="mono w-9 text-right text-xs font-bold">{x.w}%</span>
              <span className="hidden">{x.note}</span>
            </div>
          ))}
        </div>
        <ul className="mono mt-3 space-y-1 text-[11px] leading-relaxed text-[var(--dim)]">
          <li>· R returns ±50% cap · K risk control · C consistency · A activity · B winner bonus — blueprint §6.</li>
          <li>· Escrow: your wager leaves your wallet when you create the room; the bot rival matches it on accept. Pot = 2× wager, winner takes all.</li>
          <li>· A duel needs at least 3 trades on your record to auto-score — under 3, it voids and your wager is refunded.</li>
          <li>· House rules: max 5 duels and 60 trades per hour, and a 24h rematch cooldown against the same rival after a finished duel.</li>
        </ul>
      </div>
    </section>
  );
}

// ---------- live battle room (VS screen) ----------

function BattleScreen({ duels, trades, positions, setFeedback, refresh, onStartDuel }: {
  duels: State["duels"];
  trades: number;
  positions: State["positions"];
  setFeedback: (s: string) => void;
  refresh: () => void;
  onStartDuel: () => void;
}) {
  // Only a genuinely live room (open or active) takes over this screen.
  // A finished or voided duel must never be presented as the live room —
  // with no live duel, the room shows its honest empty state instead.
  const featured = duels.find((d) => d.status === "active") ?? duels.find((d) => d.status === "open");
  // Duels are scored on BTC/USD only — legacy holdings never count.
  const btcPositions = positions.filter((p) => p.symbol.toUpperCase() === "BTC");
  const cost = btcPositions.reduce((s, p) => s + p.qty * p.avg_cost, 0);
  const value = btcPositions.reduce((s, p) => s + p.qty * p.current_price, 0);
  const retPct = cost > 0 ? ((value - cost) / cost) * 100 : 0;
  const winPos = btcPositions.filter((p) => p.current_price > p.avg_cost).length;
  const preview = computeScore({ returnsPct: retPct, sharpe: 1, winRate: btcPositions.length ? (winPos / btcPositions.length) * 100 : 50, trades, winner: false });
  const isLive = featured != null && (featured.status === "open" || featured.status === "active");

  return (
    <section>
      <SectionTitle num="01" right="refreshes every 15s">Live room</SectionTitle>
      {!featured ? (
        <div className={`${cardCls} p-5 text-center`}>
          <Icon name="swords" size={36} className="mx-auto text-[var(--dim)]" />
          <p className="font-display mt-2 font-bold">The room is empty</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-[var(--dim)]">Create a duel room below and it takes over this screen — versus header, live score build-up, pot, and the one-tap auto-score finish.</p>
          <button type="button" className={`${primaryBtn} mt-3`} onClick={onStartDuel}>Create your first room</button>
        </div>
      ) : (
        <div className="glow-teal overflow-hidden rounded-[var(--radius)] bg-[var(--surface)]">
          <div className="relative px-4 pt-4 pb-3">
            <div className="flex items-center justify-center gap-2">
              {isLive ? <span className="live-dot h-2 w-2 rounded-full bg-[var(--accent)]" aria-hidden /> : null}
              <p className="mono text-[11px] font-bold tracking-[0.2em] uppercase" style={{ color: isLive ? "var(--accent)" : "var(--dim)" }}>
                {featured.status === "active" ? "Live duel" : featured.status === "open" ? "Room open — waiting on accept" : featured.status}
              </p>
              <span className="mono rounded-full bg-[var(--surface2)] px-2 py-0.5 text-[10px] font-bold tracking-wide text-[var(--dim)] uppercase">
                BTC/USD · {featured.duration_label}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-4">
              <div className="min-w-0 text-center">
                <span className="flex justify-center"><AvatarDisc initials="K" size={56} accent fontSize={19} /></span>
                <p className="font-display mt-1 break-words font-black">YOU</p>
                <p className="mono text-xs text-[var(--dim)]">{trades} trades · {retPct >= 0 ? "+" : ""}{retPct.toFixed(1)}% P/L</p>
                <p className="mono font-display mt-1 text-4xl font-black text-[var(--accent)]">{featured.your_score != null ? featured.your_score.toFixed(1) : preview.total.toFixed(1)}</p>
                <p className="mono text-[11px] text-[var(--dim)]">{featured.your_score != null ? "final score" : "live projected score"}</p>
              </div>
              <div className="text-center">
                <p className="font-display text-3xl font-black sm:text-4xl">VS</p>
                <p className="mono mt-2 text-xs">Pot<br /><span className="font-display text-xl font-black" style={{ color: "var(--gold)" }}>{featured.wager + featured.opponent_escrow}</span><br />coins</p>
              </div>
              <div className="min-w-0 text-center">
                <span className="flex justify-center"><AvatarDisc initials={RIVALS.find((r) => r.name === featured.opponent)?.initials ?? "BOT"} size={56} fontSize={16} /></span>
                <p className="font-display mt-1 break-words font-black">{featured.opponent.toUpperCase()}</p>
                <p className="mono text-xs text-[var(--dim)]">bot rival</p>
                <p className="mono font-display mt-1 text-4xl font-black" style={{ color: "var(--red)" }}>{featured.opp_score != null ? featured.opp_score.toFixed(1) : "?"}</p>
                <p className="mono text-[11px] text-[var(--dim)]">{featured.opp_score != null ? "final score" : "revealed at the finish"}</p>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-px border-t border-[var(--border)] bg-[var(--border)] text-center">
            <div className="bg-[var(--surface)] px-2 py-2.5">
              <p className="text-[10px] font-semibold tracking-wide text-[var(--dim)] uppercase">Your escrow</p>
              <p className="mono mt-0.5 text-sm font-bold">{featured.wager} coins</p>
            </div>
            <div className="bg-[var(--surface)] px-2 py-2.5">
              <p className="text-[10px] font-semibold tracking-wide text-[var(--dim)] uppercase">Pot</p>
              <p className="mono mt-0.5 text-sm font-bold text-[var(--accent)]">
                {featured.wager + featured.opponent_escrow} coins
              </p>
            </div>
            <div className="bg-[var(--surface)] px-2 py-2.5">
              <p className="text-[10px] font-semibold tracking-wide text-[var(--dim)] uppercase">{featured.opponent} (bot) escrow</p>
              <p className="mono mt-0.5 text-sm font-bold">
                {featured.opponent_escrow > 0 ? `${featured.opponent_escrow} coins` : "pending"}
              </p>
            </div>
          </div>
          <div className="border-t border-[var(--border)] px-4 py-3 sm:px-5">
            <p className="mb-1 text-xs font-semibold tracking-wide text-[var(--dim)] uppercase">Your score build-up — the five league components</p>
            <div className="space-y-1.5">
              {preview.parts.map((p) => (
                <div key={p.key} className="flex items-center gap-2">
                  <span className="mono w-4 text-xs font-bold">{p.key}</span>
                  <span className="w-24 shrink-0 break-words text-[11px] text-[var(--dim)]">{p.label}</span>
                  <div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--surface2)]">
                    <div className="bar-anim h-full bg-[var(--accent)]" style={{ width: `${clamp(p.raw, 0, 100)}%` }} />
                  </div>
                  <span className="mono w-10 text-right text-xs">{p.raw.toFixed(0)}</span>
                </div>
              ))}
            </div>
            {featured.status === "open" ? (
              <p className="mono mt-3 text-xs text-[var(--dim)]">Accept step, exactly as it works here: {featured.opponent} is a bot rival in this single-user app — there is no human invite link. Your {featured.wager} coins are already escrowed from create. Tapping accept records the bot's matched escrow of {featured.wager} coins on the duel and in the coin ledger (bot side — never taken from your wallet), the pot becomes a real {featured.wager * 2}, and the battle goes live.</p>
            ) : null}
            {featured.status === "open" || featured.status === "active" ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {featured.status === "open" ? (
                  <button type="button" className={primaryBtn} onClick={() => api.startDuel({ id: featured.id }).then((r) => { setFeedback(r.message); refresh(); })}>{featured.opponent} (bot) accepts &amp; matches escrow</button>
                ) : null}
                <button type="button" className={`${primaryBtn} inline-flex items-center gap-1.5`} onClick={() => api.autoCompleteDuel({ id: featured.id }).then((r) => { setFeedback(r.message); refresh(); })}><Icon name="bolt" size={15} strokeWidth={2} /> Auto-score &amp; finish</button>
                <button type="button" className={ghostBtn} onClick={() => api.voidDuel({ id: featured.id }).then((r) => { setFeedback(r.message); refresh(); })}>Void (refund)</button>
              </div>
            ) : featured.status === "completed" ? (
              <p className="mono mt-3 text-sm font-semibold" style={{ color: featured.winner === "you" ? "var(--gold)" : "var(--red)" }}>
                {featured.winner === "you" ? `Victory — you took the ${featured.wager * 2}-coin pot.` : `Defeat — ${featured.opponent} took the pot. Rematch from the rooms below.`}
              </p>
            ) : (
              <p className="mono mt-3 text-sm text-[var(--dim)]">This duel was voided and the wager refunded.</p>
            )}
            <p className="mono mt-2 text-[11px] text-[var(--dim)]">Anti-abuse: auto-score needs at least 3 trades on your record, or the duel voids and refunds (blueprint rule).</p>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------- simple charts ----------

function GameCharts({ positions, txns, wins, losses }: {
  positions: State["positions"];
  txns: State["walletTxns"];
  wins: number;
  losses: number;
}) {
  const total = positions.reduce((s, p) => s + p.qty * p.current_price, 0);
  const colors = ["var(--accent)", "var(--text)", "var(--gold)", "var(--gain)", "var(--loss)", "var(--faint)"];
  // Coin balance walk from the real ledger, oldest → newest.
  const walk: number[] = [];
  let bal = 0;
  [...txns].reverse().forEach((t) => { bal += t.amount; walk.push(bal); });
  const wMax = Math.max(...walk, 1);
  const wMin = Math.min(...walk, 0);
  const pts = walk.length > 1 ? walk.map((v, i) => `${(i / (walk.length - 1)) * 100},${34 - ((v - wMin) / Math.max(wMax - wMin, 1)) * 30}`).join(" ") : "";
  const totalDuels = wins + losses;

  return (
    <section className="mt-8">
      <SectionTitle num="02" right="your real numbers, drawn simple">Season charts</SectionTitle>
      <div className="grid gap-4">
        <div className={`min-w-0 ${cardCls} p-4`}>
          <p className="font-display flex items-center gap-2 font-bold"><Icon name="layers" size={17} className="text-[var(--accent)]" /> Book mix</p>
          {positions.length === 0 ? <p className="mt-2 text-sm text-[var(--dim)]">No positions yet — your mix appears after your first trade.</p> : (
            <>
              <div className="mt-3 flex h-6 w-full overflow-hidden rounded-full" role="img" aria-label={`Portfolio mix: ${positions.map((p) => `${p.symbol} ${total > 0 ? Math.round((p.qty * p.current_price / total) * 100) : 0}%`).join(", ")}`}>
                {positions.map((p, i) => (
                  <div key={p.id} style={{ width: `${total > 0 ? (p.qty * p.current_price / total) * 100 : 0}%`, background: colors[i % colors.length] }} />
                ))}
              </div>
              <div className="mt-3 space-y-1.5">
                {positions.map((p, i) => (
                  <div key={p.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2"><span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: colors[i % colors.length] }} /><span className="mono font-semibold">{p.symbol}</span></span>
                    <span className="mono">{fmtUsd(p.qty * p.current_price)} · {total > 0 ? ((p.qty * p.current_price / total) * 100).toFixed(0) : 0}%</span>
                  </div>
                ))}
              </div>
            </>
          )}
          <p className="font-display mt-4 flex items-center gap-2 font-bold"><Icon name="trophy" size={17} className="text-[var(--gold)]" /> Duel record</p>
          {totalDuels === 0 ? <p className="mt-1 text-sm text-[var(--dim)]">No finished duels yet — your win bar starts with your first result.</p> : (
            <>
              <div className="mt-2 flex h-5 w-full overflow-hidden rounded-full" role="img" aria-label={`${wins} wins and ${losses} losses`}>
                <div className="h-full bg-[var(--gain)]" style={{ width: `${(wins / totalDuels) * 100}%` }} />
                <div className="h-full bg-[var(--loss)]" style={{ width: `${(losses / totalDuels) * 100}%` }} />
              </div>
              <p className="mono mt-1 text-xs text-[var(--dim)]">{wins} wins · {losses} losses · {Math.round((wins / totalDuels) * 100)}% win rate</p>
            </>
          )}
        </div>
        <div className={`min-w-0 ${cardCls} p-4`}>
          <p className="font-display flex items-center gap-2 font-bold"><Icon name="coin" size={17} className="text-[var(--gold)]" /> Coin balance journey</p>
          {walk.length > 1 ? (
            <>
              <svg viewBox="0 0 100 38" className="mt-2 w-full" role="img" aria-label={`Coin balance over ${walk.length} ledger entries, ending at ${walk[walk.length - 1]} coins`} preserveAspectRatio="none" style={{ height: 90 }}>
                <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
              </svg>
              <p className="mono text-xs text-[var(--dim)]">From your wallet ledger · now at {walk[walk.length - 1]?.toLocaleString()} coins</p>
            </>
          ) : <p className="mt-2 text-sm text-[var(--dim)]">Your balance line draws itself as wallet transactions happen.</p>}
        </div>
      </div>
    </section>
  );
}

// ---------- league standings: podium, table, compare ----------

function LeagueSection({ wins, losses, mmr, duels, winRate, btcTrades }: {
  wins: number;
  losses: number;
  mmr: number;
  duels: State["duels"];
  winRate: number;
  btcTrades: number;
}) {
  const rows = [
    ...RIVALS.map((r) => ({ name: r.name, initials: r.initials, mmr: r.mmr, w: Math.round(r.winRate / 4), l: Math.round((100 - r.winRate) / 4), winRate: r.winRate, you: false })),
    { name: "You", initials: "K", mmr, w: wins, l: losses, winRate, you: true },
  ].sort((a, b) => b.mmr - a.mmr);
  const completed = duels.filter((d) => d.status === "completed").length;
  const [compareName, setCompareName] = useState(RIVALS[0]?.name ?? "Nova");
  const rival = RIVALS.find((r) => r.name === compareName) ?? RIVALS[0];
  const yourRank = rows.findIndex((r) => r.you) + 1;
  const podium = rows.slice(0, 3);
  const podiumOrder = [podium[1], podium[0], podium[2]].filter(
    (x): x is (typeof rows)[number] => x != null,
  );
  const heights: Record<number, number> = { 0: 74, 1: 52, 2: 40 };

  const compareRows: Array<{ label: string; you: number; opp: number; youText: string; oppText: string; max: number }> = rival
    ? [
        { label: "MMR", you: mmr, opp: rival.mmr, youText: `${mmr}`, oppText: `${rival.mmr}`, max: Math.max(mmr, rival.mmr, 1) },
        { label: "Win rate", you: winRate, opp: rival.winRate, youText: `${Math.round(winRate)}%`, oppText: `${rival.winRate}%`, max: 100 },
        { label: "League level", you: levelOf(mmr), opp: levelOf(rival.mmr), youText: `Lv ${levelOf(mmr)}`, oppText: `Lv ${levelOf(rival.mmr)}`, max: Math.max(levelOf(mmr), levelOf(rival.mmr), 1) },
      ]
    : [];

  return (
    <section>
      <SectionTitle num="01" right="season 1 · bot league + you">Standings</SectionTitle>

      {/* Podium — top 3 by MMR, champion in gold */}
      <div className={`${cardCls} elev px-4 pt-4 pb-0`}>
        <div className="flex items-end justify-center gap-3">
          {podiumOrder.map((r) => {
            const rank = rows.indexOf(r);
            const isFirst = rank === 0;
            return (
              <div key={r.name} className="flex w-[31%] flex-col items-center">
                <AvatarDisc initials={r.initials} size={isFirst ? 52 : 42} gold={isFirst} accent={r.you && !isFirst} fontSize={isFirst ? 16 : 12} />
                <p className="font-display mt-1.5 max-w-full break-words text-[13px] font-extrabold">
                  {r.you ? "You" : r.name}
                </p>
                <p className="mono text-[11px]" style={{ color: isFirst ? "var(--gold)" : "var(--dim)" }}>
                  MMR {r.mmr}
                </p>
                <div
                  className="mt-2 grid w-full place-items-start justify-center rounded-t-2xl pt-1.5"
                  style={{
                    height: heights[rank] ?? 40,
                    background: isFirst
                      ? "linear-gradient(180deg, rgba(255,201,60,0.28), rgba(255,201,60,0.06))"
                      : "var(--surface2)",
                    borderTop: `2px solid ${isFirst ? "var(--gold)" : "var(--border-strong)"}`,
                  }}
                >
                  <span className="font-display text-lg font-black" style={{ color: isFirst ? "var(--gold)" : "var(--dim)" }}>
                    {rank + 1}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Full table */}
      <div className={`mt-3 overflow-hidden ${cardCls}`} style={{ borderRadius: "var(--radius)" }}>
        {rows.map((r, i) => (
          <div key={r.name} className={`flex items-center gap-3 px-4 py-2.5 ${i > 0 ? "border-t border-[var(--border)]" : ""} ${r.you ? "glow-lime bg-[var(--surface2)]" : "bg-[var(--surface)]"}`}>
            <span className="mono w-6 shrink-0 text-sm font-bold" style={{ color: i === 0 ? "var(--gold)" : "var(--dim)" }}>#{i + 1}</span>
            <AvatarDisc initials={r.initials} size={30} fontSize={10} accent={r.you} gold={i === 0 && !r.you} />
            <span className="min-w-0 flex-1 break-words font-display font-bold" title={r.you ? "You — that's you" : r.name}>
              {r.name}
              {r.you ? (
                <span className="mono ml-2 rounded-full bg-[var(--accent)] px-1.5 py-0.5 align-middle text-[9px] font-bold text-[var(--accent-ink)] uppercase">you</span>
              ) : null}
            </span>
            <span className="mono shrink-0 text-xs">{r.w}W–{r.l}L</span>
            <span className="mono shrink-0 text-right text-[13px] font-semibold">MMR {r.mmr}</span>
          </div>
        ))}
      </div>
      <p className="mono mt-2 text-xs text-[var(--dim)]">
        You're #{yourRank} of {rows.length} in this room. Your row is live from your real duels ({completed} completed). Rival rows are the game's bot league cards — in the shipped app these become real players. From the prototype snapshot: weekly league, rank #7 of 124, prize pool $2,450.
      </p>

      {/* Compare — you vs any rival, stat bars head-to-head */}
      {rival ? (
        <div className={`mt-4 ${cardCls} p-4`}>
          <p className="font-display flex items-center gap-2 font-extrabold">
            <Icon name="target" size={18} className="text-[var(--accent)]" /> Head-to-head
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Choose a rival to compare against">
            {RIVALS.map((r) => (
              <button
                key={r.name}
                type="button"
                aria-pressed={compareName === r.name}
                onClick={() => setCompareName(r.name)}
                className="rounded-full px-3 py-1.5 text-xs font-bold"
                style={
                  compareName === r.name
                    ? { background: "var(--accent)", color: "var(--accent-ink)" }
                    : { background: "var(--surface2)", color: "var(--dim)", boxShadow: "inset 0 0 0 1px var(--border)" }
                }
              >
                {r.name}
              </button>
            ))}
          </div>
          <div className="mt-4 space-y-3.5">
            {compareRows.map((row) => (
              <div key={row.label}>
                <div className="flex items-baseline justify-between text-xs font-bold">
                  <span style={{ color: "var(--accent)" }}>YOU · {row.youText}</span>
                  <span className="text-[var(--dim)] uppercase">{row.label}</span>
                  <span style={{ color: "var(--text)" }}>{row.oppText} · {rival.name.toUpperCase()}</span>
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  <div className="flex h-2.5 flex-1 justify-end overflow-hidden rounded-full bg-[var(--surface2)]">
                    <div className="bar-anim h-full rounded-full bg-[var(--accent)]" style={{ width: `${clamp((row.you / row.max) * 100, 0, 100)}%` }} />
                  </div>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-[var(--surface2)]">
                    <div className="bar-anim h-full rounded-full" style={{ width: `${clamp((row.opp / row.max) * 100, 0, 100)}%`, background: "var(--red)" }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="mono mt-3 text-[11px] text-[var(--dim)]">
            Your bars are your real record ({btcTrades} BTC trades, {completed} finished duels). {rival.name}'s bars are the bot's published league card — the same card the auto-scorer plays against.
          </p>
        </div>
      ) : null}
    </section>
  );
}

// ---------- score lab ----------

function ScoreCalculator({ trades }: { trades: number }) {
  const [returnsPct, setReturnsPct] = useState(12);
  const [sharpe, setSharpe] = useState(1.2);
  const [winRate, setWinRate] = useState(60);
  const [tradeCount, setTradeCount] = useState(Math.max(trades, 6));
  const [winner, setWinner] = useState(true);

  const { parts, total, kPenalized } = useMemo(
    () =>
      computeScore({
        returnsPct,
        sharpe,
        winRate,
        trades: tradeCount,
        winner,
      }),
    [returnsPct, sharpe, winRate, tradeCount, winner],
  );

  const slider = (
    label: string,
    value: number,
    set: (n: number) => void,
    min: number,
    max: number,
    step: number,
    display: string,
  ) => (
    <div>
      <div className="flex items-baseline justify-between">
        <label
          htmlFor={`slider-${label}`}
          className="text-xs font-semibold tracking-wide text-[var(--dim)] uppercase"
        >
          {label}
        </label>
        <span className="mono text-sm">{display}</span>
      </div>
      <input
        id={`slider-${label}`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => set(Number(e.target.value))}
        className="mt-1 w-full accent-[var(--accent)]"
      />
    </div>
  );

  return (
    <section className="mt-8">
      <SectionTitle num="03" right="blueprint §6">Score lab — know your number</SectionTitle>
      <div className={`grid gap-6 ${cardCls} p-4`}>
        <div className="space-y-4">
          {slider("Returns", returnsPct, setReturnsPct, -50, 50, 1, `${returnsPct > 0 ? "+" : ""}${returnsPct}%`)}
          {slider("Sharpe (risk-adj.)", sharpe, setSharpe, -1, 3, 0.1, sharpe.toFixed(1))}
          {slider("Win rate", winRate, setWinRate, 0, 100, 1, `${winRate}%`)}
          {slider("Trades in duel", tradeCount, setTradeCount, 0, 20, 1, `${tradeCount}`)}
          <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
            <input
              type="checkbox"
              checked={winner}
              onChange={(e) => setWinner(e.target.checked)}
              className="h-5 w-5 accent-[var(--accent)]"
            />
            Won the duel (bonus B)
          </label>
          {kPenalized ? (
            <p className="mono text-xs text-[var(--red)]">
              K halved — fewer than 3 trades (blueprint penalty).
            </p>
          ) : null}
        </div>
        <div>
          <p className="text-xs font-semibold tracking-wide text-[var(--dim)] uppercase">
            Duel score
          </p>
          <p className="mono font-display mt-1 text-5xl font-black text-[var(--accent)]">
            {total.toFixed(1)}
          </p>
          <p className="mono mt-1 text-xs text-[var(--dim)]">
            Score = 0.40·R + 0.25·K + 0.15·C + 0.10·A + 0.10·B
          </p>
          <div className="mt-4 space-y-2.5">
            {parts.map((p) => (
              <div key={p.key} className="flex items-center gap-2">
                <span className="mono w-6 text-sm font-semibold">{p.key}</span>
                <div className="h-3 flex-1 overflow-hidden rounded-sm bg-[var(--surface2)]">
                  <div
                    className="bar-anim h-full bg-[var(--accent)]"
                    style={{ width: `${clamp(p.raw, 0, 100)}%` }}
                  />
                </div>
                <span className="mono w-20 text-right text-xs text-[var(--dim)]">
                  {p.raw.toFixed(0)} × {p.weight.toFixed(2)} ={" "}
                  {(p.raw * p.weight).toFixed(1)}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-[var(--dim)]">
            This lab is a sandbox — slide the inputs to feel the formula. Live duels are scored
            server-side from your actual record with these exact weights.
          </p>
        </div>
      </div>
    </section>
  );
}

// ---------- trading room: BTC/USD hero, your book, trade ticket ----------

function PortfolioSection({
  positions,
  trades,
  setFeedback,
  refresh,
}: {
  positions: State["positions"];
  trades: State["trades"];
  setFeedback: (s: string) => void;
  refresh: () => void;
}) {
  // BTC/USD is the only tradable pair in this edition — the ticket is
  // locked to it (the server enforces the same rule).
  const symbol = "BTC";
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [qty, setQty] = useState("");
  const [price, setPrice] = useState("");
  const [note, setNote] = useState("");
  const [priceEdits, setPriceEdits] = useState<Record<number, string>>({});
  const [range, setRange] = useState<CandleRange>("24H");
  const candlesQ = useCandles(range);
  const candles: Candle[] = candlesQ.data?.ok ? candlesQ.data.candles : [];

  const tradeMut = useMutation({
    mutationFn: (args: {
      symbol: string;
      side: "buy" | "sell";
      qty: number;
      price: number;
      note: string;
    }) => api.addTrade(args),
    onSuccess: (r) => {
      setFeedback(r.message);
      if (r.ok) {
        setQty("");
        setPrice("");
        setNote("");
      }
      refresh();
    },
    onError: () => setFeedback("Trade failed — check the values and retry."),
  });

  const priceMut = useMutation({
    mutationFn: (args: { positionId: number; currentPrice: number }) =>
      api.updatePrice(args),
    onSuccess: (r) => {
      setFeedback(r.message);
      refresh();
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.deletePosition({ id }),
    onSuccess: (r) => {
      setFeedback(r.message);
      refresh();
    },
  });

  const livePriceMut = useMutation({
    mutationFn: () => api.refreshPrices({}),
    onSuccess: (r) => {
      setFeedback(r.message);
      if (r.ok) refresh();
    },
    onError: () =>
      setFeedback(
        "Live price refresh failed — prices left unchanged. You can still update prices by hand.",
      ),
  });

  const onTrade = (e: FormEvent) => {
    e.preventDefault();
    const q = Number(qty);
    const p = Number(price);
    if (!(q > 0) || !(p > 0)) {
      setFeedback("Enter a quantity and price for the BTC/USD trade.");
      return;
    }
    tradeMut.mutate({ symbol, side, qty: q, price: p, note });
  };

  const sorted = [...positions].sort(
    (a, b) => b.qty * b.current_price - a.qty * a.current_price,
  );
  const btcPos = positions.find((p) => p.symbol.toUpperCase() === "BTC");

  return (
    <section>
      <SectionTitle right="BTC/USD only · more pairs later">
        Trading room
      </SectionTitle>

      {/* Market view — big price, real Coinbase candles, range pills */}
      {(() => {
        const lastC = candles[candles.length - 1];
        const firstC = candles[0];
        const livePrice = lastC?.close ?? btcPos?.current_price;
        const chg = firstC && lastC && firstC.open > 0 ? ((lastC.close - firstC.open) / firstC.open) * 100 : null;
        const hi = candles.length ? Math.max(...candles.map((c) => c.high)) : null;
        const lo = candles.length ? Math.min(...candles.map((c) => c.low)) : null;
        const vol = candles.length ? candles.reduce((s, c) => s + c.volume, 0) : null;
        const scrollToTicket = (s: "buy" | "sell") => {
          setSide(s);
          document.getElementById("trade-ticket")?.scrollIntoView({ behavior: "smooth", block: "start" });
        };
        return (
          <div className="mb-4 overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 elev">
            <div className="flex items-center gap-2">
              <p className="font-display text-base font-black">BTC · Crypto</p>
              <span className="mono rounded-full bg-[var(--accent)] px-2 py-0.5 text-[10px] font-bold tracking-wide text-[var(--accent-ink)] uppercase">sole market</span>
              <span className="ml-auto flex items-center gap-1.5">
                <span className="live-dot h-2 w-2 rounded-full bg-[var(--accent)]" aria-hidden />
                <span className="mono text-[10px] font-bold tracking-widest text-[var(--accent)] uppercase">Live</span>
              </span>
            </div>
            <p className="mono mt-2 text-[46px] leading-none font-bold tracking-tight">
              {livePrice ? `$${fmtPrice(livePrice)}` : "—"}
            </p>
            <p className="mono mt-1.5 text-sm font-semibold" style={{ color: chg != null && chg < 0 ? "var(--red)" : "var(--accent)" }}>
              {chg != null ? `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}% · ${range}` : "—"}
              <span className="ml-2 text-[11px] font-normal text-[var(--dim)]">Coinbase · free public API</span>
            </p>
            <div className="mt-3">
              {candles.length >= 2 ? (
                <CandleChart candles={candles} />
              ) : (
                <p className="rounded-2xl bg-[var(--surface2)] px-4 py-6 text-center text-sm text-[var(--dim)]">
                  {candlesQ.isPending
                    ? "Loading real BTC candles from Coinbase…"
                    : `${candlesQ.data?.message ?? "Chart unavailable."} Showing your stored price above.`}
                </p>
              )}
            </div>
            <div className="mt-3 flex items-center gap-1 rounded-full bg-[var(--surface2)] p-1" role="group" aria-label="Chart range">
              <span className="flex items-center gap-1.5 px-2.5 text-xs font-bold text-[var(--dim)]">
                <span className="live-dot h-1.5 w-1.5 rounded-full bg-[var(--accent)]" aria-hidden /> Live
              </span>
              {(["24H", "7D", "1M"] as CandleRange[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={range === r}
                  onClick={() => setRange(r)}
                  className="flex-1 rounded-full py-2 text-sm font-black"
                  style={range === r ? { background: "var(--accent)", color: "var(--accent-ink)" } : { color: "var(--dim)" }}
                >
                  {r}
                </button>
              ))}
              <button
                type="button"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[var(--dim)] disabled:opacity-40"
                disabled={livePriceMut.isPending}
                onClick={() => { livePriceMut.mutate(); candlesQ.refetch(); }}
                aria-label="Refresh live BTC price and chart"
              >
                <Icon name="refresh" size={17} strokeWidth={2.2} />
              </button>
            </div>
            <div className="mono mt-3 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-2xl bg-[var(--surface2)] px-2 py-2.5">
                <p className="text-[10px] font-bold tracking-widest text-[var(--dim)] uppercase">High</p>
                <p className="mt-0.5 text-[13px] font-bold">{hi ? `$${fmtPrice(hi)}` : "—"}</p>
              </div>
              <div className="rounded-2xl bg-[var(--surface2)] px-2 py-2.5">
                <p className="text-[10px] font-bold tracking-widest text-[var(--dim)] uppercase">Low</p>
                <p className="mt-0.5 text-[13px] font-bold">{lo ? `$${fmtPrice(lo)}` : "—"}</p>
              </div>
              <div className="rounded-2xl bg-[var(--surface2)] px-2 py-2.5">
                <p className="text-[10px] font-bold tracking-widest text-[var(--dim)] uppercase">Volume</p>
                <p className="mt-0.5 text-[13px] font-bold">{vol ? `${vol.toLocaleString("en-US", { maximumFractionDigits: 0 })} BTC` : "—"}</p>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <button type="button" onClick={() => scrollToTicket("sell")} className="rounded-full bg-[var(--surface3)] py-4 font-display text-base font-black tracking-wide text-[var(--red)]" aria-label="Sell BTC — jumps to the trade ticket with Sell selected">
                Sell
              </button>
              <button type="button" onClick={() => scrollToTicket("buy")} className="rounded-full bg-[var(--accent)] py-4 font-display text-base font-black tracking-wide text-[var(--accent-ink)]" aria-label="Buy BTC — jumps to the trade ticket with Buy selected">
                Buy
              </button>
            </div>
            {/* Position card — deep purple, Robinhood-style stat pairs */}
            {btcPos ? (
              <div className="purple-card mt-4 rounded-[var(--radius)] p-5">
                <p className="font-display text-sm font-black tracking-wide">Your Position</p>
                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-4">
                  <div className="min-w-0">
                    <p className="mono text-[20px] leading-none font-bold">{fmtQty(btcPos.qty)}</p>
                    <p className="mt-1 text-xs text-[#c9bdf5]">Quantity (BTC)</p>
                  </div>
                  <div className="min-w-0">
                    <p className="mono text-[20px] leading-none font-bold">{fmtUsd(btcPos.qty * btcPos.current_price)}</p>
                    <p className="mt-1 text-xs text-[#c9bdf5]">Value</p>
                  </div>
                  <div className="min-w-0">
                    <p className="mono text-[20px] leading-none font-bold">${fmtPrice(btcPos.avg_cost)}</p>
                    <p className="mt-1 text-xs text-[#c9bdf5]">Average Cost</p>
                  </div>
                  <div className="min-w-0">
                    <p className="mono text-[20px] leading-none font-bold" style={{ color: btcPos.current_price >= btcPos.avg_cost ? "var(--accent)" : "var(--red)" }}>
                      {btcPos.avg_cost > 0 ? `${(((btcPos.current_price - btcPos.avg_cost) / btcPos.avg_cost) * 100).toFixed(2)}%` : "—"}
                    </p>
                    <p className="mt-1 text-xs text-[#c9bdf5]">Total Return %</p>
                  </div>
                </div>
                <div className="mt-4 space-y-2 border-t border-white/15 pt-3 text-sm">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[#c9bdf5]">Unrealized P/L</span>
                    <span className="mono font-bold" style={{ color: (btcPos.current_price - btcPos.avg_cost) * btcPos.qty >= 0 ? "var(--accent)" : "var(--red)" }}>
                      {(btcPos.current_price - btcPos.avg_cost) * btcPos.qty >= 0 ? "+" : "−"}{fmtUsd(Math.abs((btcPos.current_price - btcPos.avg_cost) * btcPos.qty))}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[#c9bdf5]">Current Price</span>
                    <span className="mono font-bold">${fmtPrice(btcPos.current_price)}</span>
                  </div>
                </div>
              </div>
            ) : (
              <p className="mt-4 rounded-2xl bg-[var(--surface2)] px-4 py-3 text-sm text-[var(--dim)]">
                No BTC position yet — your purple position card appears with your first buy below.
              </p>
            )}
          </div>
        );
      })()}

      {/* Your book */}
      <p className="mb-2 text-xs font-semibold tracking-wide text-[var(--dim)] uppercase">Your book</p>
      {sorted.length === 0 ? (
        <p className={`${cardCls} p-4 text-sm text-[var(--dim)]`}>
          No open positions. Log your first paper trade below — positions use
          weighted-average cost, per blueprint §5.
        </p>
      ) : (
        <div className={`overflow-hidden ${cardCls}`} style={{ borderRadius: "var(--radius)" }}>
          {sorted.map((p: Position, i: number) => {
            const value = p.qty * p.current_price;
            const pl = (p.current_price - p.avg_cost) * p.qty;
            const plPct =
              p.avg_cost > 0
                ? ((p.current_price - p.avg_cost) / p.avg_cost) * 100
                : 0;
            const editVal = priceEdits[p.id] ?? String(p.current_price);
            const isBtc = p.symbol.toUpperCase() === "BTC";
            return (
              <div
                key={p.id}
                className={`bg-[var(--surface)] p-4 ${i > 0 ? "border-t border-[var(--border)]" : ""}`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-display text-lg font-bold">
                    {isBtc ? "BTC/USD" : p.symbol}
                    {isBtc ? (
                      <span className="mono ml-2 rounded-full bg-[var(--accent)] px-2 py-0.5 align-middle text-[10px] font-bold text-[var(--accent-ink)] uppercase">
                        tradable
                      </span>
                    ) : (
                      <span className="mono ml-2 rounded-full bg-[var(--surface2)] px-2 py-0.5 align-middle text-[10px] font-bold text-[var(--dim)] uppercase">
                        legacy holding
                      </span>
                    )}
                    {p.source === "prototype" ? (
                      <span className="mono ml-2 text-xs font-normal text-[var(--dim)]">
                        prototype
                      </span>
                    ) : null}
                  </p>
                  <p className="mono text-lg font-semibold">{fmtUsd(value)}</p>
                </div>
                <p className="mono mt-1 text-sm text-[var(--dim)]">
                  {fmtQty(p.qty)} @ avg ${fmtPrice(p.avg_cost)} · P/L{" "}
                  <span
                    style={{ color: pl >= 0 ? "var(--gain)" : "var(--loss)" }}
                  >
                    {pl >= 0 ? "+" : "−"}
                    {fmtUsd(Math.abs(pl)).slice(0)} ({plPct >= 0 ? "+" : ""}
                    {plPct.toFixed(1)}%)
                  </span>
                </p>
                {isBtc ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label
                      htmlFor={`price-${p.id}`}
                      className="text-xs font-semibold text-[var(--dim)]"
                    >
                      Current price $
                    </label>
                    <input
                      id={`price-${p.id}`}
                      inputMode="decimal"
                      className="mono w-32 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface2)] px-2 py-1.5"
                      value={editVal}
                      onChange={(e) =>
                        setPriceEdits((m) => ({ ...m, [p.id]: e.target.value }))
                      }
                    />
                    <button
                      type="button"
                      className={ghostBtn}
                      disabled={priceMut.isPending}
                      onClick={() => {
                        const v = Number(editVal);
                        if (v > 0)
                          priceMut.mutate({
                            positionId: p.id,
                            currentPrice: v,
                          });
                      }}
                    >
                      Update price
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${p.symbol} position`}
                      className="px-2 py-2 text-sm font-semibold text-[var(--red)]"
                      onClick={() => deleteMut.mutate(p.id)}
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <p className="mono mt-2 text-xs text-[var(--dim)]">
                    Legacy holding from the prototype — it stays on the books, but it is not tradable in this BTC/USD-only edition and its price is not refreshed.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Trade ticket — the game action panel */}
      <form
        id="trade-ticket"
        onSubmit={onTrade}
        className={`elev mt-4 scroll-mt-20 ${cardCls} p-4`}
      >
        <p className="font-display flex items-center gap-2 font-extrabold">
          <Icon name="bolt" size={18} className="text-[var(--accent)]" /> Make your move — BTC/USD
        </p>
        <p className="mono mt-1 text-xs text-[var(--dim)]">
          Every trade feeds your duel score (activity + returns). BTC/USD is the only pair on the ticket this season.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface2)] p-1" role="group" aria-label="Trade side">
          <button
            type="button"
            aria-pressed={side === "buy"}
            className={`rounded-[var(--radius)] py-2.5 font-display text-sm font-extrabold tracking-wide ${side === "buy" ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "text-[var(--dim)]"}`}
            onClick={() => setSide("buy")}
          >
            BUY / LONG
          </button>
          <button
            type="button"
            aria-pressed={side === "sell"}
            className={`rounded-[var(--radius)] py-2.5 font-display text-sm font-extrabold tracking-wide ${side === "sell" ? "bg-[var(--red)] text-white" : "text-[var(--dim)]"}`}
            onClick={() => setSide("sell")}
          >
            SELL
          </button>
        </div>
        <select
          id="trade-side"
          className="sr-only"
          value={side}
          onChange={(e) => setSide(e.target.value as "buy" | "sell")}
          aria-label="Side"
          tabIndex={-1}
        >
          <option value="buy">Buy</option>
          <option value="sell">Sell</option>
        </select>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <span className={labelCls} id="trade-pair-label">Pair</span>
            <div
              role="img"
              aria-labelledby="trade-pair-label"
              aria-label="Pair: BTC/USD, Bitcoin versus US Dollar — the only tradable pair in this edition"
              className="flex items-center gap-2 rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface2)] px-3 py-2.5"
            >
              <Icon name="bitcoin" size={18} className="shrink-0 text-[var(--gold)]" />
              <span className="font-display text-sm font-extrabold">BTC/USD</span>
              <span className="mono ml-auto text-[10px] font-bold tracking-wide text-[var(--accent)] uppercase">only pair</span>
            </div>
          </div>
          <div>
            <label htmlFor="trade-qty" className={labelCls}>
              Quantity (BTC)
            </label>
            <input
              id="trade-qty"
              inputMode="decimal"
              className={inputCls}
              placeholder="0.10"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="trade-price" className={labelCls}>
              Price $ (per BTC)
            </label>
            <input
              id="trade-price"
              inputMode="decimal"
              className={inputCls}
              placeholder="65000.00"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="trade-note" className={labelCls}>
              Note (optional)
            </label>
            <input
              id="trade-note"
              className={inputCls}
              placeholder="Breakout entry"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
        <button
          type="submit"
          className="mt-4 w-full rounded-[var(--radius)] py-3.5 font-display text-base font-black tracking-wide disabled:opacity-40"
          style={
            side === "buy"
              ? { background: "var(--accent)", color: "var(--accent-ink)" }
              : { background: "var(--red)", color: "#fff" }
          }
          disabled={tradeMut.isPending}
        >
          {side === "buy" ? "EXECUTE BUY" : "EXECUTE SELL"}
        </button>
      </form>

      {trades.length > 0 ? (
        <div className="mt-4">
          <p className="mb-2 text-xs font-semibold tracking-wide text-[var(--dim)] uppercase">
            Room feed — your recent trades
          </p>
          <div className={`overflow-hidden ${cardCls}`} style={{ borderRadius: "var(--radius)" }}>
            {trades.slice(0, 10).map((t, i) => (
              <div
                key={t.id}
                className={`flex items-baseline justify-between gap-2 bg-[var(--surface)] px-4 py-2.5 ${i > 0 ? "border-t border-[var(--border)]" : ""}`}
              >
                <span className="mono text-sm">
                  <span
                    className="font-semibold"
                    style={{
                      color:
                        t.side === "buy" ? "var(--gain)" : "var(--loss)",
                    }}
                  >
                    {t.side.toUpperCase()}
                  </span>{" "}
                  {fmtQty(t.qty)} {t.symbol.toUpperCase() === "BTC" ? "BTC/USD" : t.symbol} @ ${fmtPrice(t.price)}
                  {t.note ? (
                    <span className="text-[var(--dim)]"> · {t.note}</span>
                  ) : null}
                </span>
                <span className="mono text-xs text-[var(--dim)]">
                  {fmtDate(t.created_at)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ---------- duel rooms: create + manage ----------

function DuelsSection({
  duels,
  balance,
  setFeedback,
  refresh,
  challengeReq,
  wagerReq,
}: {
  duels: State["duels"];
  balance: number;
  setFeedback: (s: string) => void;
  refresh: () => void;
  challengeReq: { name: string; nonce: number } | null;
  wagerReq: { wager: number; nonce: number } | null;
}) {
  const [opponent, setOpponent] = useState("");
  // Featured-room "Enter" buttons land here with the rival prefilled.
  useEffect(() => {
    if (challengeReq) setOpponent(challengeReq.name);
  }, [challengeReq]);
  const [wager, setWager] = useState("100");
  // Stakes-ladder "Enter now" buttons land here with the tier wager set.
  useEffect(() => {
    if (wagerReq) setWager(String(wagerReq.wager));
  }, [wagerReq]);
  const [duration, setDuration] = useState("30 min");
  const [scores, setScores] = useState<
    Record<number, { you: string; opp: string; winner: "you" | "opponent" }>
  >({});

  const createMut = useMutation({
    mutationFn: () =>
      api.createDuel({
        opponent,
        wager: Number(wager),
        durationLabel: duration,
      }),
    onSuccess: (r) => {
      setFeedback(r.message);
      if (r.ok) setOpponent("");
      refresh();
    },
    onError: () => setFeedback("That didn't go through — try again."),
  });

  const onCreate = (e: FormEvent) => {
    e.preventDefault();
    if (!opponent.trim() || !(Number(wager) > 0)) {
      setFeedback("Name an opponent and a wager above zero.");
      return;
    }
    createMut.mutate();
  };

  // Duel-scoped actions call the API directly and share the same
  // feedback + refresh handling.
  const startDuel = (id: number) =>
    api.startDuel({ id }).then((r) => {
      setFeedback(r.message);
      refresh();
    });
  const voidDuel = (id: number) =>
    api.voidDuel({ id }).then((r) => {
      setFeedback(r.message);
      refresh();
    });
  const completeDuel = (d: Duel) => {
    const s = scores[d.id] ?? { you: "", opp: "", winner: "you" as const };
    const you = Number(s.you);
    const opp = Number(s.opp);
    if (!(you >= 0) || !(opp >= 0) || s.you === "" || s.opp === "") {
      setFeedback("Enter both final scores to complete the duel.");
      return;
    }
    api
      .completeDuel({
        id: d.id,
        winner: s.winner,
        yourScore: you,
        oppScore: opp,
      })
      .then((r) => {
        setFeedback(r.message);
        refresh();
      });
  };

  const statusColor = (s: string) =>
    s === "active"
      ? "var(--accent)"
      : s === "completed"
        ? "var(--dim)"
        : s === "void"
          ? "var(--red)"
          : "var(--text)";

  const wagerNum = Number(wager);
  const potPreview = Number.isFinite(wagerNum) && wagerNum > 0 ? wagerNum * 2 : 0;

  return (
    <section className="mt-8">
      <SectionTitle right="winner takes the pot">
        Duel rooms
      </SectionTitle>

      <form
        id="create-duel"
        onSubmit={onCreate}
        className={`scroll-mt-20 ${cardCls} elev p-4`}
        style={{ borderColor: "var(--border-strong)" }}
      >
        <p className="font-display flex items-center gap-2 font-extrabold">
          <Icon name="swords" size={18} className="text-[var(--accent)]" /> Open a room — BTC/USD duel
        </p>
        <p className="mono mt-1 text-xs leading-relaxed text-[var(--dim)]">
          Your wager escrows from your wallet on create (balance: {balance.toLocaleString()} coins).
          The bot rival matches it on accept and the pot becomes a real 2× your wager — winner
          takes it, voiding refunds you. Your score comes from your BTC position and BTC trades only.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="duel-opponent" className={labelCls}>
              Opponent (bot rival)
            </label>
            <input
              id="duel-opponent"
              className={inputCls}
              placeholder="Rival's name"
              value={opponent}
              onChange={(e) => setOpponent(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="duel-duration" className={labelCls}>
              Duration
            </label>
            <select
              id="duel-duration"
              className={inputCls}
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            >
              <option>30 min</option>
              <option>4 hours</option>
              <option>24 hours</option>
            </select>
          </div>
        </div>
        <div className="mt-3">
          <span className={labelCls} id="wager-label">Wager (coins)</span>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby="wager-label">
            {[50, 100, 250].map((amt) => (
              <button
                key={amt}
                type="button"
                aria-pressed={wager === String(amt)}
                onClick={() => setWager(String(amt))}
                className="rounded-full px-4 py-2 font-display text-sm font-extrabold"
                style={
                  wager === String(amt)
                    ? { background: "var(--accent)", color: "var(--accent-ink)" }
                    : { background: "var(--surface2)", color: "var(--text)", boxShadow: "inset 0 0 0 1px var(--border)" }
                }
              >
                {amt}
              </button>
            ))}
            <input
              id="duel-wager"
              aria-label="Wager in coins"
              inputMode="numeric"
              className="mono w-28 rounded-full border border-[var(--border)] bg-[var(--surface2)] px-3 py-2"
              value={wager}
              onChange={(e) => setWager(e.target.value)}
            />
            <span className="mono ml-auto text-xs font-bold" style={{ color: "var(--gold)" }}>
              {potPreview > 0 ? `Pot pays ${potPreview} coins` : "Pot = 2× wager"}
            </span>
          </div>
        </div>
        <button
          type="submit"
          className="mt-4 w-full rounded-[var(--radius)] bg-[var(--accent)] py-3 font-display text-sm font-black tracking-wide text-[var(--accent-ink)] disabled:opacity-40"
          disabled={createMut.isPending}
        >
          ESCROW &amp; OPEN ROOM
        </button>
      </form>

      {duels.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--dim)]">
          No rooms yet this season. Open your first one above — duels are the core loop of the league.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {duels.map((d) => {
            const s = scores[d.id] ?? {
              you: "",
              opp: "",
              winner: "you" as const,
            };
            const live = d.status === "open" || d.status === "active";
            return (
              <div
                key={d.id}
                className={`${cardCls} relative overflow-hidden p-4`}
              >
                <span aria-hidden className="absolute top-0 bottom-0 left-0 w-[6px] bg-[var(--accent)]" style={{ opacity: d.status === "void" ? 0.25 : 1 }} />
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-display font-bold">
                    You vs {d.opponent}
                    <span
                      className="mono ml-2 text-xs font-semibold uppercase"
                      style={{ color: statusColor(d.status) }}
                    >
                      {d.status}
                    </span>
                  </p>
                  <p className="mono text-sm text-[var(--dim)]">
                    {d.wager} coins · {d.duration_label} · pot{" "}
                    <span style={{ color: "var(--gold)" }}>{d.wager + d.opponent_escrow}</span>
                  </p>
                </div>
                <p className="mono mt-1 text-xs text-[var(--dim)]">
                  Escrow — you: {d.wager} coins · {d.opponent} (bot):{" "}
                  {d.opponent_escrow > 0
                    ? `${d.opponent_escrow} coins matched${d.opponent_escrow_at ? ` · ${fmtDate(d.opponent_escrow_at)}` : ""}`
                    : "pending — recorded when the bot accepts"}
                </p>
                {d.status === "completed" ? (
                  <p className="mono mt-1 text-sm">
                    Final score {d.your_score} – {d.opp_score} ·{" "}
                    {d.winner === "you" ? (
                      <span style={{ color: "var(--gold)" }}>
                        you took the pot
                      </span>
                    ) : (
                      <span style={{ color: "var(--red)" }}>
                        {d.opponent} took the pot
                      </span>
                    )}
                  </p>
                ) : null}
                {live ? (
                  <div className="mt-3 flex flex-wrap items-end gap-2">
                    {d.status === "open" ? (
                      <button
                        type="button"
                        className={ghostBtn}
                        onClick={() => startDuel(d.id)}
                      >
                        {d.opponent} (bot) accepts &amp; matches escrow
                      </button>
                    ) : null}
                    <div>
                      <label
                        htmlFor={`score-you-${d.id}`}
                        className={labelCls}
                      >
                        Your score
                      </label>
                      <input
                        id={`score-you-${d.id}`}
                        inputMode="decimal"
                        className="mono w-24 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface2)] px-2 py-2"
                        value={s.you}
                        onChange={(e) =>
                          setScores((m) => ({
                            ...m,
                            [d.id]: { ...s, you: e.target.value },
                          }))
                        }
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`score-opp-${d.id}`}
                        className={labelCls}
                      >
                        Their score
                      </label>
                      <input
                        id={`score-opp-${d.id}`}
                        inputMode="decimal"
                        className="mono w-24 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface2)] px-2 py-2"
                        value={s.opp}
                        onChange={(e) =>
                          setScores((m) => ({
                            ...m,
                            [d.id]: { ...s, opp: e.target.value },
                          }))
                        }
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`winner-${d.id}`}
                        className={labelCls}
                      >
                        Winner
                      </label>
                      <select
                        id={`winner-${d.id}`}
                        className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface2)] px-2 py-2"
                        value={s.winner}
                        onChange={(e) =>
                          setScores((m) => ({
                            ...m,
                            [d.id]: {
                              ...s,
                              winner: e.target.value as "you" | "opponent",
                            },
                          }))
                        }
                      >
                        <option value="you">You</option>
                        <option value="opponent">{d.opponent}</option>
                      </select>
                    </div>
                    <button
                      type="button"
                      className={`${primaryBtn} inline-flex items-center gap-1.5`}
                      onClick={() =>
                        api.autoCompleteDuel({ id: d.id }).then((r) => {
                          setFeedback(r.message);
                          refresh();
                        })
                      }
                    >
                      <Icon name="bolt" size={15} strokeWidth={2} /> Auto-score from my BTC trades
                    </button>
                    <button
                      type="button"
                      className={ghostBtn}
                      onClick={() => completeDuel(d)}
                    >
                      Complete manually & pay pot
                    </button>
                    <button
                      type="button"
                      className={ghostBtn}
                      onClick={() => voidDuel(d.id)}
                    >
                      Void (refund)
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ---------- wallet: balance, adjust, full ledger ----------

function WalletSection({
  balance,
  txns,
  setFeedback,
  refresh,
}: {
  balance: number;
  txns: State["walletTxns"];
  setFeedback: (s: string) => void;
  refresh: () => void;
}) {
  const [adjAmount, setAdjAmount] = useState("");
  const [adjLabel, setAdjLabel] = useState("");

  const adjMut = useMutation({
    mutationFn: () =>
      api.adjustWallet({ amount: Number(adjAmount), label: adjLabel }),
    onSuccess: (r) => {
      setFeedback(r.message);
      if (r.ok) {
        setAdjAmount("");
        setAdjLabel("");
      }
      refresh();
    },
    onError: () => setFeedback("That didn't go through — try again."),
  });

  const onAdjust = (e: FormEvent) => {
    e.preventDefault();
    const amt = Number(adjAmount);
    if (!Number.isInteger(amt) || amt === 0 || !adjLabel.trim()) {
      setFeedback("Enter a whole-coin amount (can be negative) and a label.");
      return;
    }
    adjMut.mutate();
  };

  return (
    <section className="mt-8">
      <SectionTitle num="02" right="integer coins · every move is a ledger row">Coin wallet</SectionTitle>
      <div className="gold-wash elev rounded-[var(--radius)] border border-[var(--border-strong)] p-5">
        <p className="mono flex items-center gap-1.5 text-[11px] font-bold tracking-[0.18em] text-[var(--dim)] uppercase">
          <Icon name="coin" size={14} className="text-[var(--gold)]" /> Balance
        </p>
        <p className="mono font-display mt-1 text-[38px] leading-none font-black">
          {balance.toLocaleString()} <span className="text-lg text-[var(--gold)]">coins</span>
        </p>
        <p className="mono mt-2 text-[11px] text-[var(--dim)]">
          Coins have no cash value — they're the league's score-keeping currency.
        </p>
      </div>

      <div className="mt-3 grid gap-3">
        <form
          onSubmit={onAdjust}
          className={`${cardCls} p-4`}
        >
          <p className="font-display font-bold">Adjust wallet</p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="adj-amount" className={labelCls}>
                Coins (+ / −)
              </label>
              <input
                id="adj-amount"
                inputMode="numeric"
                className={inputCls}
                placeholder="250"
                value={adjAmount}
                onChange={(e) => setAdjAmount(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="adj-label" className={labelCls}>
                Reason
              </label>
              <input
                id="adj-label"
                className={inputCls}
                placeholder="Daily reward"
                value={adjLabel}
                onChange={(e) => setAdjLabel(e.target.value)}
              />
            </div>
          </div>
          <button
            type="submit"
            className={`${ghostBtn} mt-3`}
            disabled={adjMut.isPending}
          >
            Apply adjustment
          </button>
        </form>

        <div className={`${cardCls} p-4`}>
          <p className="font-display flex items-center gap-2 font-bold">
            <Icon name="wallet" size={17} className="text-[var(--gold)]" /> Wallet history
          </p>
          {txns.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--dim)]">
              No transactions yet.
            </p>
          ) : (
            <div className="mt-2 space-y-1.5">
              {txns.slice(0, 12).map((t) => (
                <div
                  key={t.id}
                  className="flex items-baseline justify-between gap-2"
                >
                  <span className="min-w-0 flex-1 break-words text-sm">{t.label}</span>
                  <span className="mono shrink-0 text-[11px] text-[var(--faint)]">{fmtDate(t.created_at)}</span>
                  {t.amount === 0 ? (
                    <span className="mono shrink-0 text-xs font-semibold text-[var(--dim)]">
                      bot side
                    </span>
                  ) : (
                    <span
                      className="mono shrink-0 text-sm font-semibold"
                      style={{
                        color: t.amount >= 0 ? "var(--gain)" : "var(--loss)",
                      }}
                    >
                      {t.amount >= 0 ? "+" : ""}
                      {t.amount}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------- the collectible player card ----------

function PlayerCard({
  mmr,
  balance,
  wins,
  losses,
  trades,
  level,
  tier,
  totalWon,
  badges,
  onChallenge,
}: {
  mmr: number;
  balance: number;
  wins: number;
  losses: number;
  trades: number;
  level: number;
  tier: string;
  totalWon: number;
  badges: Badge[];
  onChallenge: () => void;
}) {
  const completed = wins + losses;
  const wr = completed > 0 ? Math.round((wins / completed) * 100) : null;
  return (
    <section>
      <div className="glow-teal elev-pop overflow-hidden rounded-[var(--radius)] bg-[var(--surface)]">
        <div className="relative px-5 pt-6 pb-5">
          <div className="flex items-center justify-between">
            <span className="mono rounded-full bg-[var(--surface2)] px-3 py-1 text-[10px] font-bold tracking-[0.18em] uppercase">
              Season 1 · Player card
            </span>
            <span className="mono rounded-full bg-[var(--surface2)] px-3 py-1 text-[10px] font-bold tracking-[0.18em] text-[var(--gold)] uppercase">
              {tier} tier
            </span>
          </div>
          <div className="relative mx-auto mt-5 w-fit">
            <AvatarDisc initials="K" size={104} accent fontSize={40} />
            <span className="mono absolute -right-2 -bottom-1 grid h-8 w-8 place-items-center rounded-full bg-[var(--accent)] text-[13px] font-black text-[var(--accent-ink)]" style={{ boxShadow: "0 0 14px rgba(198,241,53,0.5)" }} aria-label={`Level ${level}`}>
              {level}
            </span>
          </div>
          <p className="font-display mt-3 text-center text-[30px] leading-none font-black">
            Kass
          </p>
          <p className="mt-1.5 text-center text-sm font-semibold text-[var(--accent)]">
            {tier} · Level {level}
          </p>
          <p className="mono mt-1 text-center text-[11px] text-[var(--dim)]">
            MMR {mmr} · {trades} trades on record · {balance.toLocaleString()} coins
          </p>
          <div className="mx-auto mt-3 max-w-[280px]">
            <div className="flex justify-between text-[11px] font-semibold text-[var(--dim)]">
              <span>XP to level {level + 1}</span>
              <span className="mono">{xpIntoLevel(mmr)}/100</span>
            </div>
            <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-[var(--surface2)]">
              <div
                className="bar-anim h-full rounded-full bg-[var(--accent)]"
                style={{ width: `${Math.max(xpIntoLevel(mmr), 4)}%` }}
              />
            </div>
          </div>
          <div className="mt-5 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-2xl bg-[var(--surface2)] px-2 py-3">
              <p className="mono font-display text-xl leading-none font-black">{wins} – {losses}</p>
              <p className="mt-1.5 text-[10px] font-bold tracking-widest text-[var(--dim)] uppercase">Duel Record</p>
            </div>
            <div className="rounded-2xl bg-[var(--surface2)] px-2 py-3">
              <p className="mono font-display text-xl leading-none font-black">{wr != null ? `${wr}%` : "—"}</p>
              <p className="mt-1.5 text-[10px] font-bold tracking-widest text-[var(--dim)] uppercase">Win Rate</p>
            </div>
            <div className="rounded-2xl bg-[var(--surface2)] px-2 py-3">
              <p className="mono font-display text-xl leading-none font-black text-[var(--gold)]">{totalWon.toLocaleString()}</p>
              <p className="mt-1.5 text-[10px] font-bold tracking-widest text-[var(--dim)] uppercase">Total Won</p>
            </div>
          </div>
          <p className="mono mt-2 text-center text-[11px] text-[var(--dim)]">
            {completed === 0
              ? "No finished duels yet — record, win rate, and total won start with your first result. (1 void duel on file, fully refunded.)"
              : "From your finished duels only — voids never count."}
          </p>
          {/* Hex badges */}
          <div className="mt-4 flex flex-wrap justify-center gap-2.5" role="list" aria-label="Badges">
            {badges.map((b) => (
              <div key={b.name} role="listitem" className="flex w-[68px] flex-col items-center" aria-label={b.earned ? `Badge earned: ${b.name}` : `Badge locked: ${b.name} — ${b.req}`}>
                <span
                  className="hex-badge grid h-12 w-12 place-items-center"
                  style={{
                    background: b.earned ? "linear-gradient(150deg,#d9ff5c,#8fbf14)" : "var(--surface3)",
                    color: b.earned ? "#0a0f00" : "var(--faint)",
                  }}
                >
                  <Icon name={b.earned ? "medal" : "lock"} size={20} />
                </span>
                <p className="mt-1.5 text-center text-[10px] leading-tight font-bold break-words">{b.name}</p>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={onChallenge}
            className="mt-5 w-full rounded-full py-4 font-display text-base font-black tracking-wide uppercase"
            style={{ background: "var(--teal)", color: "#03211c", boxShadow: "0 0 26px rgba(0,229,199,0.35)" }}
            aria-label="Challenge a rival — go to the Battle tab"
          >
            Challenge Me
          </button>
        </div>
      </div>
    </section>
  );
}

// ---------- ML signals ----------

function SignalsSection({
  signals,
  setFeedback,
  refresh,
}: {
  signals: State["signals"];
  setFeedback: (s: string) => void;
  refresh: () => void;
}) {
  // Signals are BTC/USD only in this edition (server enforces it too);
  // prototype signals for other symbols stay on the board as legacy.
  const symbol = "BTC";
  const [signal, setSignal] = useState<
    "STRONG BUY" | "BUY" | "HOLD" | "SELL" | "STRONG SELL"
  >("BUY");
  const [confidence, setConfidence] = useState(70);
  const [note, setNote] = useState("");

  const addMut = useMutation({
    mutationFn: () =>
      api.addSignal({ symbol, signal, confidence, note }),
    onSuccess: (r) => {
      setFeedback(r.message);
      setNote("");
      refresh();
    },
  });
  const deleteMut = useMutation({
    mutationFn: (id: number) => api.deleteSignal({ id }),
    onSuccess: (r) => {
      setFeedback(r.message);
      refresh();
    },
  });

  const onAdd = (e: FormEvent) => {
    e.preventDefault();
    addMut.mutate();
  };

  const color = (s: string) =>
    s.includes("BUY")
      ? "var(--gain)"
      : s.includes("SELL")
        ? "var(--loss)"
        : "var(--dim)";

  return (
    <section className="mt-8">
      <SectionTitle num="03" right="VisualML · BTC/USD only">Signal board</SectionTitle>
      {signals.length === 0 ? (
        <p className={`${cardCls} p-4 text-sm text-[var(--dim)]`}>
          No signals on the board. Add one below.
        </p>
      ) : (
        <div className="space-y-2">
          {signals.map((s) => (
            <div
              key={s.id}
              className={`flex items-center gap-3 ${cardCls} px-4 py-3`}
            >
              <span className="mono w-20 font-semibold">
                {s.symbol.toUpperCase() === "BTC" ? "BTC/USD" : s.symbol}
                {s.symbol.toUpperCase() !== "BTC" ? (
                  <span className="block text-[10px] font-normal text-[var(--faint)]">legacy</span>
                ) : null}
              </span>
              <span
                className="mono w-28 text-sm font-semibold"
                style={{ color: color(s.signal) }}
              >
                {s.signal}
              </span>
              <div className="h-3 flex-1 overflow-hidden rounded-sm bg-[var(--surface2)]">
                <div
                  className="bar-anim h-full"
                  style={{
                    width: `${s.confidence}%`,
                    background: color(s.signal),
                  }}
                />
              </div>
              <span className="mono w-10 text-right text-sm">
                {s.confidence}%
              </span>
              <button
                type="button"
                aria-label={`Remove ${s.symbol} signal`}
                className="px-1 text-[var(--dim)]"
                onClick={() => deleteMut.mutate(s.id)}
              >
                <Icon name="x" size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
      <form
        onSubmit={onAdd}
        className={`mt-4 ${cardCls} p-4`}
      >
        <p className="font-display font-bold">Call a signal — BTC/USD</p>
        <p className="mono mt-1 text-xs text-[var(--dim)]">
          New signals are BTC/USD only in this edition. Prototype signals for other symbols remain on the board above, marked legacy.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <span className={labelCls} id="signal-pair-label">Pair</span>
            <div
              role="img"
              aria-labelledby="signal-pair-label"
              aria-label="Pair: BTC/USD — the only pair for new signals in this edition"
              className="flex items-center gap-2 rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface2)] px-3 py-2.5"
            >
              <Icon name="bitcoin" size={18} className="shrink-0 text-[var(--gold)]" />
              <span className="font-display text-sm font-extrabold">BTC/USD</span>
              <span className="mono ml-auto text-[10px] font-bold tracking-wide text-[var(--accent)] uppercase">only pair</span>
            </div>
          </div>
          <div>
            <label htmlFor="signal-type" className={labelCls}>
              Signal
            </label>
            <select
              id="signal-type"
              className={inputCls}
              value={signal}
              onChange={(e) =>
                setSignal(
                  e.target.value as
                    | "STRONG BUY"
                    | "BUY"
                    | "HOLD"
                    | "SELL"
                    | "STRONG SELL",
                )
              }
            >
              <option>STRONG BUY</option>
              <option>BUY</option>
              <option>HOLD</option>
              <option>SELL</option>
              <option>STRONG SELL</option>
            </select>
          </div>
          <div>
            <label htmlFor="signal-confidence" className={labelCls}>
              Confidence: {confidence}%
            </label>
            <input
              id="signal-confidence"
              type="range"
              min={0}
              max={100}
              value={confidence}
              onChange={(e) => setConfidence(Number(e.target.value))}
              className="mt-2 w-full accent-[var(--accent)]"
            />
          </div>
          <div>
            <label htmlFor="signal-note" className={labelCls}>
              Note (optional)
            </label>
            <input
              id="signal-note"
              className={inputCls}
              placeholder="Breakout setup"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
        <button
          type="submit"
          className={`${primaryBtn} mt-3`}
          disabled={addMut.isPending}
        >
          Post signal
        </button>
      </form>
    </section>
  );
}

// ---------- every screen in the game ----------

function PhoneMock({ title, status, children }: { title: string; status: string; children: ReactNode }) {
  return (
    <div className="w-[240px] shrink-0 snap-center">
      <div className="mx-auto w-full max-w-[230px] rounded-[var(--radius)] border-2 border-[var(--border)] bg-[var(--surface)] p-2">
        <div className="rounded-[20px] bg-[var(--surface2)] px-3 pt-2 pb-3">
          <div className="mx-auto mb-2 h-1.5 w-10 rounded-full bg-[var(--border)]" />
          {children}
        </div>
      </div>
      <p className="mt-2 text-center font-display text-sm font-bold">{title}</p>
      <p className="text-center text-xs text-[var(--dim)]">{status}</p>
    </div>
  );
}

const mockBar = (w: string, c = "var(--accent)") => <div className="h-2 rounded-full" style={{ width: w, background: c }} />;
const mockLine = (w: string) => <div className="h-2 rounded bg-[var(--border)]" style={{ width: w }} />;

function ScreensGallery() {
  return (
    <section className="mt-8">
      <SectionTitle num="04" right="the full game, screen by screen">Every screen in the game</SectionTitle>
      <p className="mb-4 text-sm text-[var(--dim)]">This is the complete screen map for the Paper Trading League, built out to the deploy line and stopping there. In this app the live screens ARE the tabs — League HQ, Battle, Trading Room, Standings, Profile — and this gallery is the designed look of each one, including the splash/sign-in that ships with the mobile build. Swipe sideways through the phones. Nothing deploys until you say deploy.</p>
      <div className="flex snap-x snap-mandatory gap-4 overflow-x-auto pb-2">
        <PhoneMock title="1 · Splash & sign-in" status="Preview — sign-in ships with the mobile build; the 500-coin starter grant is live here">
          <span className="flex justify-center"><Icon name="swords" size={30} className="text-[var(--accent)]" /></span>
          <p className="font-display mt-1 text-center text-sm font-black">PAPER TRADING LEAGUE</p>
          <p className="mono text-center text-[10px] text-[var(--dim)]">DUEL · TRADE BTC/USD · WIN COINS</p>
          <div className="mt-3 space-y-1.5">{mockLine("100%")}{mockLine("70%")}</div>
          <div className="mt-3 rounded-full bg-[var(--accent)] py-1.5 text-center text-xs font-bold text-[var(--accent-ink)]">Sign in with Google</div>
          <p className="mono mt-2 text-center text-[10px] text-[var(--dim)]">+500 starter coins</p>
        </PhoneMock>
        <PhoneMock title="2 · League HQ" status="Live — the Home tab: season banner, player card, featured rooms, quests">
          <div className="rounded-[var(--radius)] bg-[var(--surface)] p-2">
            <p className="mono text-[9px] font-bold text-[var(--accent)]">SEASON 1 · LIVE</p>
            <p className="font-display text-xs font-black">Friday-night arena</p>
          </div>
          <div className="mt-2 flex items-center justify-between"><span className="font-display text-xs font-bold">Kass · Lv 1</span><span className="mono text-[10px]">500 coins</span></div>
          <div className="mt-2">{mockBar("45%")}</div>
          <div className="mt-3 grid grid-cols-2 gap-1.5">
            <div className="rounded-[var(--radius)] bg-[var(--surface)] p-1.5 text-center text-xs">Nova's Room</div>
            <div className="rounded-[var(--radius)] bg-[var(--surface)] p-1.5 text-center text-xs">BearTrap's Room</div>
            <div className="rounded-[var(--radius)] bg-[var(--surface)] p-1.5 text-center text-xs">KasKing's Room</div>
            <div className="rounded-[var(--radius)] bg-[var(--surface)] p-1.5 text-center text-xs">SteadyEddie's</div>
          </div>
          <div className="mt-3 rounded-full bg-[var(--accent)] py-1.5 text-center text-xs font-bold text-[var(--accent-ink)]">Enter a duel</div>
        </PhoneMock>
        <PhoneMock title="3 · Open a room" status="Live — Battle tab: rules card, wager escrows on create, bot matches on accept">
          <p className="font-display text-xs font-bold">CHALLENGE NOVA · BTC/USD</p>
          <div className="mt-2 space-y-1.5">{mockLine("80%")}{mockLine("60%")}</div>
          <div className="mt-2 flex gap-1.5">
            <span className="rounded-full bg-[var(--surface)] px-2 py-1 text-[10px] font-bold">50 coins</span>
            <span className="rounded-full bg-[var(--accent)] px-2 py-1 text-[10px] font-bold text-[var(--accent-ink)]">100 coins</span>
            <span className="rounded-full bg-[var(--surface)] px-2 py-1 text-[10px] font-bold">250 coins</span>
          </div>
          <div className="mt-2 flex gap-1.5">
            <span className="rounded-full bg-[var(--accent)] px-2 py-1 text-[10px] font-bold text-[var(--accent-ink)]">30 min</span>
            <span className="rounded-full bg-[var(--surface)] px-2 py-1 text-[10px] font-bold">4 hours</span>
            <span className="rounded-full bg-[var(--surface)] px-2 py-1 text-[10px] font-bold">24 hours</span>
          </div>
          <div className="mt-3 rounded-full bg-[var(--accent)] py-1.5 text-center text-xs font-bold text-[var(--accent-ink)]">Escrow &amp; open room</div>
        </PhoneMock>
        <PhoneMock title="4 · Live room" status="Live — the Battle tab VS screen: score build-up, both escrows, pot">
          <div className="flex items-center justify-between text-center">
            <div><p className="font-display text-xs font-extrabold">K</p><p className="mono text-[10px] font-bold">YOU 62.4</p></div>
            <p className="font-display text-sm font-black">VS</p>
            <div><p className="font-display text-xs font-extrabold">NV</p><p className="mono text-[10px] font-bold">NOVA ?</p></div>
          </div>
          <div className="mt-2 space-y-1.5">{mockBar("62%")}{mockBar("48%", "var(--text)")}</div>
          <p className="mono mt-2 text-center text-[10px]">Pot 200 coins · 30 min · BTC/USD</p>
          <div className="mt-2 rounded-full bg-[var(--accent)] py-1.5 text-center text-xs font-bold text-[var(--accent-ink)]">Auto-score finish</div>
        </PhoneMock>
        <PhoneMock title="5 · Trading room" status="Live — the Trade tab: live Coinbase BTC/USD price, your book, trade ticket">
          <p className="font-display text-xs font-bold">BTC/USD · LIVE $76,000</p>
          <div className="mt-2 flex gap-1.5">
            <span className="flex-1 rounded-full bg-[var(--accent)] py-1 text-center text-[10px] font-bold text-[var(--accent-ink)]">BUY / LONG</span>
            <span className="flex-1 rounded-full bg-[var(--surface)] py-1 text-center text-[10px] font-bold">SELL</span>
          </div>
          <div className="mt-2 space-y-1.5">{mockLine("100%")}{mockLine("100%")}{mockLine("55%")}</div>
          <div className="mt-3 rounded-full bg-[var(--accent)] py-1.5 text-center text-xs font-bold text-[var(--accent-ink)]">Execute buy</div>
          <p className="mono mt-2 text-center text-[10px] text-[var(--dim)]">Counts toward your duel score</p>
        </PhoneMock>
        <PhoneMock title="6 · Season charts" status="Live — League tab charts: book mix, balance line, duel record">
          <p className="mono text-[10px]">YOUR BOOK</p>
          <p className="font-display text-base font-extrabold">$50,880</p>
          <div className="mt-2 flex h-3 overflow-hidden rounded-full"><div className="bg-[var(--accent)]" style={{ width: "65%" }} /><div className="bg-[var(--text)]" style={{ width: "26%" }} /><div style={{ width: "9%", background: "var(--gold)" }} /></div>
          <div className="mt-2 space-y-1">{mockLine("90%")}{mockLine("75%")}{mockLine("60%")}</div>
          <svg viewBox="0 0 100 24" className="mt-2 w-full" style={{ height: 28 }} aria-hidden><polyline points="0,20 25,16 50,17 75,8 100,5" fill="none" stroke="var(--accent)" strokeWidth="2" /></svg>
        </PhoneMock>
        <PhoneMock title="7 · Score reveal" status="Live — shown on every Battle finish; the score lab is on the League tab">
          <span className="flex justify-center"><Icon name="trophy" size={26} className="text-[var(--gold)]" /></span>
          <p className="font-display mt-1 text-center text-xs font-extrabold">VICTORY — +200 coins</p>
          <div className="mt-2 space-y-1.5">
            <div className="flex items-center gap-1"><span className="mono w-3 text-[10px] font-bold">R</span><div className="flex-1">{mockBar("80%")}</div></div>
            <div className="flex items-center gap-1"><span className="mono w-3 text-[10px] font-bold">K</span><div className="flex-1">{mockBar("65%", "var(--text)")}</div></div>
            <div className="flex items-center gap-1"><span className="mono w-3 text-[10px] font-bold">C</span><div className="flex-1">{mockBar("70%", "var(--gold)")}</div></div>
            <div className="flex items-center gap-1"><span className="mono w-3 text-[10px] font-bold">A</span><div className="flex-1">{mockBar("50%", "var(--accent)")}</div></div>
          </div>
          <p className="mono mt-2 text-center text-[10px]">MMR 1000 → 1025 (+25)</p>
        </PhoneMock>
        <PhoneMock title="8 · Standings" status="Live — the League tab: podium, your live row vs the bot league, head-to-head">
          <div className="space-y-1.5">
            {["1 · Nova · 1240", "2 · BearTrap · 1185", "3 · KasKing · 1090", "4 · You · 1000", "5 · PixelPete · 960"].map((t, i) => (
              <div key={t} className={`rounded-[var(--radius)] px-2 py-1 text-[11px] font-semibold ${i === 3 ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "bg-[var(--surface)]"}`}>{t}</div>
            ))}
          </div>
          <p className="mono mt-2 text-center text-[10px] text-[var(--dim)]">Weekly pool $2,450 · resets Monday</p>
        </PhoneMock>
        <PhoneMock title="9 · Coin wallet" status="Live — Profile tab: gold balance card + full ledger history">
          <p className="mono text-[10px]">COIN WALLET</p>
          <p className="font-display text-base font-extrabold">500 coins</p>
          <div className="mt-2 space-y-1.5">
            <div className="flex justify-between text-[11px]"><span>Starter grant</span><span className="mono font-bold">+500</span></div>
            <div className="flex justify-between text-[11px]"><span>Duel entry vs Nova</span><span className="mono font-bold">−100</span></div>
            <div className="flex justify-between text-[11px]"><span>Duel win — pot</span><span className="mono font-bold">+200</span></div>
          </div>
          <div className="mt-3 rounded-full bg-[var(--surface)] py-1.5 text-center text-xs font-bold">Every move is a ledger row</div>
        </PhoneMock>
        <PhoneMock title="10 · Player card" status="Live — the Profile tab: identity, tier, trophy shelf, badges, build plan">
          <div className="flex items-center gap-2"><span className="font-display grid h-9 w-9 place-items-center rounded-full bg-[var(--accent)] text-sm font-extrabold text-[var(--accent-ink)]" aria-hidden>K</span><div>{mockLine("70%")}<p className="mono mt-1 text-[10px]">MMR 1000 · 0W–0L</p></div></div>
          <div className="mt-3 grid grid-cols-3 gap-1 text-center">
            <div className="rounded-[var(--radius)] bg-[var(--surface)] p-1"><p className="mono text-[10px] font-bold">500</p><p className="text-[9px]">coins</p></div>
            <div className="rounded-[var(--radius)] bg-[var(--surface)] p-1"><p className="mono text-[10px] font-bold">Lv 1</p><p className="text-[9px]">level</p></div>
            <div className="rounded-[var(--radius)] bg-[var(--surface)] p-1"><p className="mono text-[10px] font-bold">BTC</p><p className="text-[9px]">market</p></div>
          </div>
          <div className="mt-2 flex justify-center gap-2 text-[var(--gold)]"><Icon name="trophy" size={16} /><Icon name="medal" size={16} /><Icon name="lock" size={16} /></div>
        </PhoneMock>
      </div>
    </section>
  );
}

// ---------- build plan ----------

function BuildPlanSection({
  milestones,
  refresh,
}: {
  milestones: State["milestones"];
  refresh: () => void;
}) {
  const toggleMut = useMutation({
    mutationFn: (args: { id: number; done: boolean }) =>
      api.toggleMilestone(args),
    onSuccess: () => refresh(),
  });

  if (milestones.length === 0) return null;

  return (
    <section className="mt-8">
      <SectionTitle right="verified status shown per week">
        8-week build order
      </SectionTitle>
      <p className="mb-3 text-sm text-[var(--dim)]">
        The badge on each week is what's actually built and verified in this app — the same
        status the Home build chip and the deploy-line screen show. The checkbox is your own
        tracker; the badge is the verified state, and deploy steps are never badged ready.
      </p>
      <div className={`overflow-hidden ${cardCls}`} style={{ borderRadius: "var(--radius)" }}>
        {milestones.map((m, i) => {
          const tone = statusTone(m.status);
          return (
            <label
              key={m.id}
              className={`flex cursor-pointer items-start gap-3 bg-[var(--surface)] px-4 py-3 ${i > 0 ? "border-t border-[var(--border)]" : ""}`}
            >
              <input
                type="checkbox"
                checked={m.done}
                onChange={(e) =>
                  toggleMut.mutate({ id: m.id, done: e.target.checked })
                }
                className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--accent)]"
                aria-label={`Week ${m.week}: ${m.label}`}
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span
                    className={`font-display font-bold ${m.done ? "text-[var(--dim)] line-through" : ""}`}
                  >
                    Week {m.week} — {m.label}
                  </span>
                  <span
                    className="mono rounded-full px-2 py-0.5 text-[10px] font-bold uppercase"
                    style={{
                      background:
                        tone === "ready"
                          ? "var(--accent)"
                          : tone === "partial"
                            ? "var(--text)"
                            : "var(--surface2)",
                      color: tone === "deploy" ? "var(--dim)" : "black",
                    }}
                  >
                    {statusPill(m.status)}
                  </span>
                </span>
                <span className="block text-sm text-[var(--dim)]">
                  {m.detail}
                </span>
                {m.status_note ? (
                  <span className="mt-0.5 block text-xs text-[var(--dim)]">{m.status_note}</span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
    </section>
  );
}

// ---------- week 8: the deploy line ----------

function DeployLineSection({
  milestones,
}: {
  milestones: State["milestones"];
}) {
  const appReadyCount = milestones.filter(
    (m) => m.status === "ready" || m.status === "app-scope",
  ).length;
  const waiting: string[] = [
    "Nothing on prices — live BTC/USD quotes run on the free Coinbase public API (no key, no cost), so the blueprint's paid Polygon.io feed is no longer required",
    "The literal mobile app (Expo) + API (NestJS/Supabase) — separate repos in the blueprint's Next Move, outside this dashboard edition",
    "TestFlight beta (Week 7) and store submission (Week 8) — these ARE the deploy step: developer accounts, EAS submit, store listings",
  ];
  return (
    <section className="mt-8">
      <SectionTitle right="week 8 · built to the line, not past it">
        The deploy line
      </SectionTitle>
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
        <p className="font-display flex items-center gap-2 text-xl font-extrabold"><Icon name="shield" size={22} className="text-[var(--accent)]" /> Stopped at the deploy line</p>
        <p className="mt-1 text-sm text-[var(--dim)]">
          {appReadyCount} of the {milestones.length} weeks are built and verified in this
          app; what remains is deploy itself. Nothing deploys, submits, or goes to a store
          until Kass says deploy.
        </p>
        <div className={`mt-4 overflow-hidden ${cardCls}`} style={{ borderRadius: "var(--radius)" }}>
          {milestones.map((m, i) => {
            const tone = statusTone(m.status);
            return (
              <div
                key={m.id}
                className={`bg-[var(--surface2)] px-3.5 py-3 ${i > 0 ? "border-t border-[var(--border)]" : ""}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="font-display text-sm font-bold">
                    Week {m.week} — {m.label}
                  </p>
                  <span
                    className="mono shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase"
                    style={{
                      background:
                        tone === "ready"
                          ? "var(--accent)"
                          : tone === "partial"
                            ? "var(--text)"
                            : "var(--surface)",
                      color: tone === "deploy" ? "var(--dim)" : "black",
                      border: tone === "deploy" ? "1px solid var(--border)" : undefined,
                    }}
                  >
                    {statusPill(m.status)}
                  </span>
                </div>
                {m.status_note ? (
                  <p className="mt-1 text-xs text-[var(--dim)]">{m.status_note}</p>
                ) : null}
              </div>
            );
          })}
        </div>
        <p className="mt-4 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-[var(--dim)] uppercase">
          <Icon name="clock" size={13} /> Waiting on deploy / keys
        </p>
        <ul className="mt-2 space-y-2">
          {waiting.map((t) => (
            <li key={t} className="flex gap-2 text-sm">
              <Icon name="check" size={15} className="mt-0.5 shrink-0 text-[var(--text)]" />
              <span>{t}</span>
            </li>
          ))}
        </ul>
        <p className="mono mt-4 rounded-[var(--radius)] bg-[var(--surface2)] px-3 py-2 text-xs">
          When you're ready: say "deploy" and the next moves are (1) gasisit-api +
          gasisit-mobile repos per the blueprint, (2) EAS/TestFlight, then store
          submission — in that order, each verified as it lands. Prices need nothing:
          the free Coinbase feed is already live.
        </p>
      </div>
    </section>
  );
}

// ---------- blueprint reference ----------

function BlueprintSection() {
  const rows: Array<[string, string]> = [
    [
      "Stack",
      "Expo (React Native) + NestJS + Supabase Postgres + Redis/Socket.io · Market data: mock first, Polygon.io later",
    ],
    [
      "Wallet rules",
      "Coins are integers · every change is one atomic transaction with a ledger row · client_txn_id blocks double-spend on retries",
    ],
    [
      "Anti-abuse (day 1)",
      "24h rematch cooldown · shared-device check voids the duel · under 3 trades = void (50% pot burned, 50% refunded) · 5 duels/hr, 60 trades/hr rate limits",
    ],
    [
      "Legal posture",
      "No real money — coins have no cash value · educational trading simulator · age 17+ for the simulated-gambling descriptor · 0% rake until legal review",
    ],
    [
      "Definition of MVP",
      "A stranger downloads the app, signs up, duels a friend, and wins or loses coins with zero bugs. Everything else is V1.1.",
    ],
  ];
  return (
    <section className="mt-8">
      <SectionTitle num="06" right="Production Blueprint V3">The blueprint</SectionTitle>
      <div className={`overflow-hidden ${cardCls}`} style={{ borderRadius: "var(--radius)" }}>
        {rows.map(([k, v], i) => (
          <div
            key={k}
            className={`grid gap-1 bg-[var(--surface)] px-4 py-3 ${i > 0 ? "border-t border-[var(--border)]" : ""}`}
          >
            <p className="text-xs font-semibold tracking-wide text-[var(--dim)] uppercase">
              {k}
            </p>
            <p className="text-sm">{v}</p>
          </div>
        ))}
      </div>
      <p className="mono mt-3 text-xs text-[var(--dim)]">
        Source: G-Asisit Production Blueprint V3 + Streamlit prototype
        (app.py) in your project files, and the Paper Trading League design in your Drive
        (Mac Projects → Trading-League-Game). Prices can be refreshed live from
        the free Coinbase public API (BTC/USD spot — the only market in this edition; no key,
        no account, no cost) or entered by hand; the blueprint's named
        provider, Polygon.io, is no longer required. Built to the deploy line and stopping
        there: no store submission, no deployment, until you say deploy.
        The remaining literal Week 7/8 work (Expo app, EAS/TestFlight,
        store listings) lives in separate mobile/API repos outside this
        dashboard.
      </p>
    </section>
  );
}
