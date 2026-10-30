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
    { key: "K", label: "Risk-adjusted", raw: k, weight: 0.25 },
    { key: "C", label: "Consistency", raw: c, weight: 0.15 },
    { key: "A", label: "Activity", raw: a, weight: 0.1 },
    { key: "B", label: "Win bonus", raw: b, weight: 0.1 },
  ];
  const total = parts.reduce((sum, p) => sum + p.raw * p.weight, 0);
  return { parts, total, kPenalized };
}

// ---------- shared bits ----------

function SectionTitle({
  children,
  right,
}: {
  children: string;
  right?: string;
}) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-2">
      <h2 className="font-display text-lg font-bold tracking-tight text-[var(--text)]">
        {children}
      </h2>
      {right ? (
        <span className="mono text-xs text-[var(--dim)]">{right}</span>
      ) : null}
    </div>
  );
}

const inputCls =
  "w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-[var(--text)] placeholder:text-[var(--dim)] focus:outline-2 focus:outline-[var(--accent)]";
const labelCls =
  "mb-1 block text-xs font-semibold tracking-wide text-[var(--dim)] uppercase";
const primaryBtn =
  "rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2.5 font-display text-sm font-bold text-black disabled:opacity-40";
const ghostBtn =
  "rounded-[var(--radius)] border border-[var(--border)] px-3 py-2 text-sm font-semibold text-[var(--text)] disabled:opacity-40";

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
  | "check";

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
function AvatarDisc({
  initials,
  size = 44,
  accent = false,
  fontSize = 13,
}: {
  initials: string;
  size?: number;
  accent?: boolean;
  fontSize?: number;
}) {
  return (
    <span
      aria-hidden
      className="font-display grid shrink-0 place-items-center rounded-full font-extrabold"
      style={{
        width: size,
        height: size,
        fontSize,
        background: accent ? "var(--accent)" : "var(--surface3)",
        color: accent ? "var(--accent-ink)" : "var(--text)",
        boxShadow: "inset 0 0 0 1px var(--border-strong)",
      }}
    >
      {initials}
    </span>
  );
}

// ---------- main app ----------

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

  const state = useQuery({
    queryKey: ["state"],
    queryFn: () => api.getState({}),
    // Near-realtime feel (Week 4 equivalent): the board refreshes itself
    // every 15 seconds so a live duel screen stays current without a
    // manual reload. True Socket.io rooms are the mobile app's job.
    refetchInterval: 15000,
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
          <p className="mono text-sm text-[var(--dim)]">Loading terminal…</p>
        </main>
      </div>
    );
  }

  if (state.error || !state.data) {
    return (
      <div className="min-h-screen bg-[var(--bg)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <main className="px-4 py-16 text-center">
          <p className="text-[var(--red)]">Couldn't load the dashboard.</p>
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
  const level = Math.max(1, Math.floor((data.wallet.mmr - 1000) / 100) + 1);
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

  return (
    <div className="min-h-screen bg-[var(--surface2)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      {/* Phone column: full-bleed on a phone; on wider screens it sits
          centered at phone width like the app it previews. */}
      <div className="relative mx-auto flex min-h-screen w-full max-w-[430px] flex-col bg-[var(--bg)] shadow-2xl sm:border-x sm:border-[var(--border)]">
        {/* ===== APP BAR ===== */}
        <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur">
          <div className="flex h-14 items-center gap-2.5 px-4">
            <AvatarDisc initials="K" size={38} accent fontSize={15} />
            <div className="min-w-0 flex-1">
              <p className="font-display truncate text-[15px] leading-tight font-extrabold tracking-tight">
                G-Asisit
              </p>
              <p className="mono truncate text-[11px] leading-tight text-[var(--dim)]">
                Level {level} · MMR {data.wallet.mmr} · {duelWins}W–{duelLosses}L
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
              {liveDuelCount} duel{liveDuelCount > 1 ? "s" : ""} waiting — tap to open Battle
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

          {/* ===== HOME TAB ===== */}
          {tab === "home" ? (
            <>
              <p className="text-sm text-[var(--dim)]">Hey Kass</p>
              <h1 className="font-display mt-0.5 text-[26px] leading-tight font-extrabold tracking-tight">
                Ready to duel?
              </h1>

              <div className="elev mt-4 rounded-3xl border border-[var(--border-strong)] bg-[var(--surface)] p-5">
                <p className="text-xs font-semibold tracking-wide text-[var(--dim)] uppercase">
                  Portfolio value
                </p>
                <p className="mono mt-1 text-[34px] leading-tight font-semibold break-all">
                  {fmtUsd(totalValue)}
                </p>
                <p
                  className="mono mt-1 text-sm font-semibold"
                  style={{ color: unrealized >= 0 ? "var(--accent)" : "var(--red)" }}
                >
                  {unrealized >= 0 ? "+" : "−"} {fmtUsd(Math.abs(unrealized))} (
                  {unrealizedPct >= 0 ? "+" : ""}
                  {unrealizedPct.toFixed(1)}%) unrealized
                </p>
                <div className="mt-4 grid grid-cols-4 gap-2">
                  <button
                    type="button"
                    onClick={() => go("battle")}
                    className="flex flex-col items-center gap-1.5 rounded-2xl bg-[var(--surface2)] py-3 text-[11px] font-bold"
                    aria-label="Quick action: go to Battle tab to duel"
                  >
                    <Icon name="swords" size={21} className="text-[var(--accent)]" />Duel
                  </button>
                  <button
                    type="button"
                    onClick={() => go("trade")}
                    className="flex flex-col items-center gap-1.5 rounded-2xl bg-[var(--surface2)] py-3 text-[11px] font-bold"
                    aria-label="Quick action: go to Trade tab"
                  >
                    <Icon name="chart" size={21} className="text-[var(--accent)]" />Trade
                  </button>
                  <button
                    type="button"
                    onClick={() => liveMut.mutate()}
                    disabled={liveMut.isPending}
                    className="flex flex-col items-center gap-1.5 rounded-2xl bg-[var(--surface2)] py-3 text-[11px] font-bold disabled:opacity-40"
                    aria-label="Quick action: refresh the live BTC/USD price"
                  >
                    <Icon name="refresh" size={21} className="text-[var(--accent)]" />
                    {liveMut.isPending ? "Fetching" : "BTC price"}
                  </button>
                  <button
                    type="button"
                    onClick={() => go("league")}
                    className="flex flex-col items-center gap-1.5 rounded-2xl bg-[var(--surface2)] py-3 text-[11px] font-bold"
                    aria-label="Quick action: go to League tab"
                  >
                    <Icon name="trophy" size={21} className="text-[var(--accent)]" />League
                  </button>
                </div>
                <p className="mono mt-3 flex items-center gap-1.5 text-[11px] text-[var(--dim)]">
                  <Icon name="bitcoin" size={13} />
                  Market: BTC/USD only in this edition — more pairs arrive later.
                </p>
              </div>

              {totalWeeks > 0 ? (
              <button
                type="button"
                onClick={() => go("more")}
                className="mt-3 flex w-full items-center gap-3 rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-4 text-left"
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

              {isEmpty ? (
                <div className="mt-4 rounded-3xl border border-[var(--accent)] bg-[var(--surface)] p-4">
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

              <RivalsArena
                mmr={data.wallet.mmr}
                wins={duelWins}
                losses={duelLosses}
                onChallenge={challengeRival}
                onStartDuel={startDuelFlow}
              />

              {data.walletTxns.length > 0 ? (
                <section className="mt-8">
                  <SectionTitle right="coin ledger">Recent activity</SectionTitle>
                  <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
                    {data.walletTxns.slice(0, 5).map((t, i) => (
                      <div
                        key={t.id}
                        className={`flex items-center justify-between gap-3 bg-[var(--surface)] px-4 py-3 ${i > 0 ? "border-t border-[var(--border)]" : ""}`}
                      >
                        <span className="min-w-0 flex-1 truncate text-sm">{t.label}</span>
                        {t.amount === 0 ? (
                          <span className="mono shrink-0 text-xs font-semibold text-[var(--dim)]">
                            bot side
                          </span>
                        ) : (
                          <span
                            className="mono shrink-0 text-sm font-bold"
                            style={{ color: t.amount >= 0 ? "var(--accent)" : "var(--red)" }}
                          >
                            {t.amount >= 0 ? "+" : ""}
                            {t.amount} coins
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
            </>
          ) : null}

          {/* ===== BATTLE TAB ===== */}
          {tab === "battle" ? (
            <>
              <BattleScreen
                duels={data.duels}
                trades={data.trades.filter((t) => t.symbol.toUpperCase() === "BTC").length}
                positions={data.positions}
                setFeedback={setFeedback}
                refresh={refresh}
                onStartDuel={startDuelFlow}
              />
              <DuelsSection
                duels={data.duels}
                balance={data.wallet.balance}
                txns={data.walletTxns}
                setFeedback={setFeedback}
                refresh={refresh}
                challengeReq={challengeReq}
              />
            </>
          ) : null}

          {/* ===== TRADE TAB ===== */}
          {tab === "trade" ? (
            <PortfolioSection
              positions={data.positions}
              trades={data.trades}
              setFeedback={setFeedback}
              refresh={refresh}
            />
          ) : null}

          {/* ===== LEAGUE TAB ===== */}
          {tab === "league" ? (
            <>
              <LeagueSection wins={duelWins} losses={duelLosses} mmr={data.wallet.mmr} duels={data.duels} />
              <GameCharts
                positions={data.positions}
                txns={data.walletTxns}
                wins={duelWins}
                losses={duelLosses}
              />
              <ScoreCalculator trades={data.trades.filter((t) => t.symbol.toUpperCase() === "BTC").length} />
            </>
          ) : null}

          {/* ===== PROFILE / MORE TAB ===== */}
          {tab === "more" ? (
            <>
              <section>
                <div className="flex items-center gap-3 rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-5">
                  <AvatarDisc initials="K" size={60} accent fontSize={24} />
                  <div className="min-w-0">
                    <p className="font-display text-xl font-extrabold">Level {level} Trader</p>
                    <p className="mono mt-0.5 text-xs text-[var(--dim)]">
                      MMR {data.wallet.mmr} · Record {duelWins}W – {duelLosses}L ·{" "}
                      {data.wallet.balance.toLocaleString()} coins
                    </p>
                    <p className="mono mt-0.5 text-xs text-[var(--dim)]">
                      Prototype league rank #7 of 124 · pool $2,450
                    </p>
                  </div>
                </div>
              </section>
              <SignalsSection signals={data.signals} setFeedback={setFeedback} refresh={refresh} />
              <ScreensGallery />
              <BuildPlanSection milestones={data.milestones} refresh={refresh} />
              <DeployLineSection milestones={data.milestones} />
              <BlueprintSection />
            </>
          ) : null}
        </main>

        {/* ===== BOTTOM TAB BAR ===== */}
        <nav
          aria-label="App tabs"
          className="elev-pop fixed bottom-0 left-1/2 z-30 w-full max-w-[430px] -translate-x-1/2 border-t border-[var(--border-strong)] bg-[#10130b]/97 backdrop-blur"
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

type TabKey = "home" | "battle" | "trade" | "league" | "more";

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

// ---------- arena rivals (bot opponents) ----------

const RIVALS: Array<{ name: string; initials: string; style: string; mmr: number; winRate: number; tagline: string }> = [
  { name: "Nova", initials: "NV", style: "Momentum chaser", mmr: 1240, winRate: 58, tagline: "Buys BTC breakouts, never looks back." },
  { name: "BearTrap", initials: "BT", style: "Contrarian", mmr: 1185, winRate: 54, tagline: "Fades the crowd on every pump." },
  { name: "KasKing", initials: "KK", style: "BTC range trader", mmr: 1090, winRate: 51, tagline: "Farms the BTC range, session after session." },
  { name: "SteadyEddie", initials: "SE", style: "Low-risk grinder", mmr: 1035, winRate: 49, tagline: "Small wins, tiny drawdowns." },
  { name: "PixelPete", initials: "PP", style: "Chart-pattern sniper", mmr: 960, winRate: 44, tagline: "Sees triangles in his sleep." },
  { name: "HodlQueen", initials: "HQ", style: "Diamond hands", mmr: 905, winRate: 42, tagline: "Never sold. Ever. That's the strategy." },
];

function RivalsArena({ mmr, wins, losses, onChallenge, onStartDuel }: {
  mmr: number;
  wins: number;
  losses: number;
  onChallenge: (name: string) => void;
  onStartDuel: () => void;
}) {
  const level = Math.max(1, Math.floor((mmr - 1000) / 100) + 1);
  const xpPct = clamp(((mmr - 1000) % 100 + 100) % 100, 0, 100);
  return (
    <section className="mt-8">
      <SectionTitle right="all rivals are bots">Arena — choose your fight</SectionTitle>
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="flex items-center gap-3">
          <AvatarDisc initials="K" size={46} accent fontSize={16} />
          <div className="min-w-0 flex-1">
            <p className="font-display font-extrabold">You — Level {level} Trader</p>
            <p className="mono text-xs text-[var(--dim)]">
              MMR {mmr} · Record {wins}W – {losses}L
            </p>
          </div>
        </div>
        <div className="mt-3">
          <div className="flex justify-between text-xs font-semibold text-[var(--dim)]">
            <span>XP to level {level + 1}</span>
            <span>{xpPct}/100</span>
          </div>
          <div className="mt-1 h-3 overflow-hidden rounded-full bg-[var(--surface2)]">
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-all"
              style={{ width: `${Math.max(xpPct, 4)}%` }}
            />
          </div>
          <p className="mono mt-1 text-xs text-[var(--dim)]">
            Win a duel: +25 MMR · Lose: −15 MMR · 100 MMR = 1 level
          </p>
        </div>
        <button type="button" className={`${primaryBtn} mt-3 flex w-full items-center justify-center gap-2`} onClick={onStartDuel}>
          <Icon name="swords" size={16} strokeWidth={2} /> Start a duel
        </button>
      </div>
      <div className="mt-3 overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
        {RIVALS.map((r, i) => (
          <div
            key={r.name}
            className={`flex items-center gap-3 bg-[var(--surface)] p-3.5 ${i > 0 ? "border-t border-[var(--border)]" : ""}`}
          >
            <AvatarDisc initials={r.initials} size={46} fontSize={14} />
            <div className="min-w-0 flex-1">
              <p className="font-display truncate font-extrabold">
                {r.name}
                <span className="mono ml-2 rounded-full bg-[var(--surface2)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--dim)] uppercase">
                  bot
                </span>
              </p>
              <p className="truncate text-xs text-[var(--dim)]">
                {r.style} · {r.tagline}
              </p>
              <p className="mono mt-0.5 text-[11px] text-[var(--dim)]">
                MMR {r.mmr} · Win rate {r.winRate}%
              </p>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--surface2)]">
                <div className="h-full bg-[var(--teal)]" style={{ width: `${r.winRate}%` }} />
              </div>
            </div>
            <button
              type="button"
              className={`${primaryBtn} shrink-0 px-3.5`}
              onClick={() => onChallenge(r.name)}
              aria-label={`Challenge ${r.name} (bot rival) — opens the duel creator with ${r.name} filled in`}
            >
              Fight
            </button>
          </div>
        ))}
      </div>
      <p className="mono mt-2 text-xs text-[var(--dim)]">
        Every rival is a bot opponent for the game loop. “Fight” opens the duel creator in the
        Battle tab with that bot filled in — your wager escrows on create, and the bot's matched
        escrow is recorded when it accepts.
      </p>
    </section>
  );
}

// ---------- live battle screen ----------

function BattleScreen({ duels, trades, positions, setFeedback, refresh, onStartDuel }: {
  duels: State["duels"];
  trades: number;
  positions: State["positions"];
  setFeedback: (s: string) => void;
  refresh: () => void;
  onStartDuel: () => void;
}) {
  const featured = duels.find((d) => d.status === "active") ?? duels.find((d) => d.status === "open") ?? duels[0];
  // Duels are scored on BTC/USD only — legacy holdings never count.
  const btcPositions = positions.filter((p) => p.symbol.toUpperCase() === "BTC");
  const cost = btcPositions.reduce((s, p) => s + p.qty * p.avg_cost, 0);
  const value = btcPositions.reduce((s, p) => s + p.qty * p.current_price, 0);
  const retPct = cost > 0 ? ((value - cost) / cost) * 100 : 0;
  const winPos = btcPositions.filter((p) => p.current_price > p.avg_cost).length;
  const preview = computeScore({ returnsPct: retPct, sharpe: 1, winRate: btcPositions.length ? (winPos / btcPositions.length) * 100 : 50, trades, winner: false });

  return (
    <section>
      <SectionTitle right="live duel view · refreshes every 15s">Battle screen</SectionTitle>
      {!featured ? (
        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 text-center">
          <Icon name="swords" size={36} className="mx-auto text-[var(--dim)]" />
          <p className="font-display mt-2 font-bold">No battle yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-[var(--dim)]">Challenge a rival in the Duels section and your live battle will appear here — score race, pot, and one-tap auto-score finish.</p>
          <button type="button" className={`${primaryBtn} mt-3`} onClick={onStartDuel}>Create your first duel</button>
        </div>
      ) : (
        <div className="elev-pop overflow-hidden rounded-[var(--radius)] border border-[var(--accent-dim)] bg-[var(--surface)]">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 p-4 sm:gap-4 sm:p-5">
            <div className="min-w-0 text-center">
              <span className="flex justify-center"><AvatarDisc initials="K" size={52} accent fontSize={18} /></span>
              <p className="font-display mt-1 truncate font-extrabold">YOU</p>
              <p className="mono text-xs text-[var(--dim)]">{trades} trades · {retPct >= 0 ? "+" : ""}{retPct.toFixed(1)}% P/L</p>
              <p className="mono font-display mt-1 text-3xl font-extrabold text-[var(--accent)] sm:text-4xl">{featured.your_score != null ? featured.your_score.toFixed(1) : preview.total.toFixed(1)}</p>
              <p className="mono text-[11px] text-[var(--dim)]">{featured.your_score != null ? "final score" : "live projected score"}</p>
            </div>
            <div className="text-center">
              <p className="font-display text-2xl font-extrabold italic sm:text-3xl">VS</p>
              <p className="mono mt-1 rounded-full bg-[var(--surface2)] px-2 py-1 text-[11px] font-semibold uppercase">{featured.status}</p>
              <p className="mono mt-2 text-xs">Pot<br /><span className="text-base font-bold">{featured.wager + featured.opponent_escrow} coins</span></p>
              <p className="mono mt-1 flex items-center justify-center gap-1 text-[11px] text-[var(--dim)]"><Icon name="clock" size={12} /> {featured.duration_label}</p>
              <p className="mono mt-1 text-[11px] font-semibold tracking-wide text-[var(--accent)] uppercase">BTC/USD duel</p>
            </div>
            <div className="min-w-0 text-center">
              <span className="flex justify-center"><AvatarDisc initials={RIVALS.find((r) => r.name === featured.opponent)?.initials ?? "BOT"} size={52} fontSize={15} /></span>
              <p className="font-display mt-1 truncate font-extrabold">{featured.opponent.toUpperCase()}</p>
              <p className="mono text-xs text-[var(--dim)]">bot rival</p>
              <p className="mono font-display mt-1 text-3xl font-extrabold sm:text-4xl" style={{ color: "var(--teal)" }}>{featured.opp_score != null ? featured.opp_score.toFixed(1) : "?"}</p>
              <p className="mono text-[11px] text-[var(--dim)]">{featured.opp_score != null ? "final score" : "revealed at the finish"}</p>
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
            <p className="mb-1 text-xs font-semibold tracking-wide text-[var(--dim)] uppercase">Your score build-up (blueprint §6)</p>
            <div className="space-y-1.5">
              {preview.parts.map((p) => (
                <div key={p.key} className="flex items-center gap-2">
                  <span className="mono w-4 text-xs font-bold">{p.key}</span>
                  <div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--surface2)]">
                    <div className="h-full bg-[var(--accent)]" style={{ width: `${clamp(p.raw, 0, 100)}%` }} />
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
              <p className="mono mt-3 text-sm font-semibold" style={{ color: featured.winner === "you" ? "var(--accent)" : "var(--red)" }}>
                {featured.winner === "you" ? `Victory — you took the ${featured.wager * 2}-coin pot.` : `Defeat — ${featured.opponent} took the pot. Rematch from the Duels section.`}
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
  const colors = ["var(--accent)", "var(--teal)", "var(--gold)", "#f97316", "#38bdf8", "#94a3b8"];
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
      <SectionTitle right="your real numbers, drawn simple">Charts</SectionTitle>
      <div className="grid gap-4">
        <div className="min-w-0 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="font-display flex items-center gap-2 font-bold"><Icon name="layers" size={17} className="text-[var(--accent)]" /> Portfolio mix</p>
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
                <div className="h-full bg-[var(--accent)]" style={{ width: `${(wins / totalDuels) * 100}%` }} />
                <div className="h-full bg-[var(--red)]" style={{ width: `${(losses / totalDuels) * 100}%` }} />
              </div>
              <p className="mono mt-1 text-xs text-[var(--dim)]">{wins} wins · {losses} losses · {Math.round((wins / totalDuels) * 100)}% win rate</p>
            </>
          )}
        </div>
        <div className="min-w-0 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
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

// ---------- league / leaderboard ----------

function LeagueSection({ wins, losses, mmr, duels }: { wins: number; losses: number; mmr: number; duels: State["duels"] }) {
  const rows = [
    ...RIVALS.map((r) => ({ name: r.name, initials: r.initials, mmr: r.mmr, w: Math.round(r.winRate / 4), l: Math.round((100 - r.winRate) / 4), you: false })),
    { name: "You", initials: "K", mmr, w: wins, l: losses, you: true },
  ].sort((a, b) => b.mmr - a.mmr);
  const completed = duels.filter((d) => d.status === "completed").length;
  return (
    <section>
      <SectionTitle right="weekly league · prize pool $2,450 (prototype)">League leaderboard</SectionTitle>
      <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
        {rows.map((r, i) => (
          <div key={r.name} className={`flex items-center gap-3 px-4 py-2.5 ${i > 0 ? "border-t border-[var(--border)]" : ""} ${r.you ? "bg-[var(--surface2)]" : "bg-[var(--surface)]"}`}>
            <span className="mono w-6 text-sm font-bold text-[var(--dim)]">#{i + 1}</span>
            <AvatarDisc initials={r.initials} size={30} fontSize={10} accent={r.you} />
            <span className="min-w-0 flex-1 truncate font-display font-bold">{r.name}{r.you ? " — that's you" : ""}</span>
            <span className="mono text-sm">{r.w}W–{r.l}L</span>
            <span className="mono w-20 text-right text-sm font-semibold">MMR {r.mmr}</span>
          </div>
        ))}
      </div>
      <p className="mono mt-2 text-xs text-[var(--dim)]">Your row is live from your real duels ({completed} completed). Rival rows are the game's bot league — in the shipped app these become real players. Tournament layer from the prototype: weekly league, rank #7 of 124 at snapshot time.</p>
    </section>
  );
}

// ---------- every screen in the game ----------

function PhoneMock({ title, status, children }: { title: string; status: string; children: ReactNode }) {
  return (
    <div className="w-[240px] shrink-0 snap-center">
      <div className="mx-auto w-full max-w-[230px] rounded-[26px] border-2 border-[var(--border)] bg-[var(--surface)] p-2 shadow-sm">
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
      <SectionTitle right="the full game, screen by screen">Every screen in the game</SectionTitle>
      <p className="mb-4 text-sm text-[var(--dim)]">This is the complete screen map for G-Asisit, built out to the deploy line and stopping there. In this app the live screens ARE the tabs — Home, Battle, Trade, League, Profile — and this gallery is the designed look of each one, including the splash/sign-in that ships with the mobile build. Swipe sideways through the phones. Nothing deploys until you say deploy.</p>
      <div className="flex snap-x snap-mandatory gap-4 overflow-x-auto pb-2">
        <PhoneMock title="1 · Splash & sign-in" status="Preview — sign-in ships with the mobile build; the 500-coin starter grant is live here">
          <span className="flex justify-center"><Icon name="swords" size={30} className="text-[var(--accent)]" /></span>
          <p className="font-display mt-1 text-center text-sm font-extrabold">G-ASISIT</p>
          <p className="mono text-center text-[10px] text-[var(--dim)]">DUEL · TRADE BTC/USD · WIN COINS</p>
          <div className="mt-3 space-y-1.5">{mockLine("100%")}{mockLine("70%")}</div>
          <div className="mt-3 rounded-full bg-[var(--accent)] py-1.5 text-center text-xs font-bold text-black">Sign in with Google</div>
          <p className="mono mt-2 text-center text-[10px] text-[var(--dim)]">+500 starter coins</p>
        </PhoneMock>
        <PhoneMock title="2 · Arena lobby" status="Live — the Home tab: rivals, level & XP">
          <div className="flex items-center justify-between"><span className="font-display text-xs font-bold">K · Lv 1</span><span className="mono text-[10px]">500 coins</span></div>
          <div className="mt-2">{mockBar("45%")}</div>
          <div className="mt-3 grid grid-cols-2 gap-1.5">
            <div className="rounded-lg bg-[var(--surface)] p-1.5 text-center text-xs">Nova</div>
            <div className="rounded-lg bg-[var(--surface)] p-1.5 text-center text-xs">BearTrap</div>
            <div className="rounded-lg bg-[var(--surface)] p-1.5 text-center text-xs">KasKing</div>
            <div className="rounded-lg bg-[var(--surface)] p-1.5 text-center text-xs">SteadyEddie</div>
          </div>
          <div className="mt-3 rounded-full bg-[var(--accent)] py-1.5 text-center text-xs font-bold text-black">Find a duel</div>
        </PhoneMock>
        <PhoneMock title="3 · Create a duel" status="Live — Battle tab: wager escrows on create, bot matches on accept">
          <p className="font-display text-xs font-bold">CHALLENGE NOVA · BTC/USD</p>
          <div className="mt-2 space-y-1.5">{mockLine("80%")}{mockLine("60%")}</div>
          <div className="mt-2 flex gap-1.5">
            <span className="rounded-full bg-[var(--surface)] px-2 py-1 text-[10px] font-bold">50 coins</span>
            <span className="rounded-full bg-[var(--accent)] px-2 py-1 text-[10px] font-bold text-black">100 coins</span>
            <span className="rounded-full bg-[var(--surface)] px-2 py-1 text-[10px] font-bold">250 coins</span>
          </div>
          <div className="mt-2 flex gap-1.5">
            <span className="rounded-full bg-[var(--accent)] px-2 py-1 text-[10px] font-bold text-black">30 min</span>
            <span className="rounded-full bg-[var(--surface)] px-2 py-1 text-[10px] font-bold">4 hours</span>
            <span className="rounded-full bg-[var(--surface)] px-2 py-1 text-[10px] font-bold">24 hours</span>
          </div>
          <div className="mt-3 rounded-full bg-[var(--accent)] py-1.5 text-center text-xs font-bold text-black">Escrow &amp; send challenge</div>
        </PhoneMock>
        <PhoneMock title="4 · Live battle" status="Live — the Battle tab VS screen, with both escrows shown">
          <div className="flex items-center justify-between text-center">
            <div><p className="font-display text-xs font-extrabold">K</p><p className="mono text-[10px] font-bold">YOU 62.4</p></div>
            <p className="font-display text-sm font-extrabold italic">VS</p>
            <div><p className="font-display text-xs font-extrabold">NV</p><p className="mono text-[10px] font-bold">NOVA ?</p></div>
          </div>
          <div className="mt-2 space-y-1.5">{mockBar("62%")}{mockBar("48%", "var(--teal)")}</div>
          <p className="mono mt-2 text-center text-[10px]">Pot 200 coins · 30 min · BTC/USD</p>
          <div className="mt-2 rounded-full bg-[var(--accent)] py-1.5 text-center text-xs font-bold text-black">Auto-score finish</div>
        </PhoneMock>
        <PhoneMock title="5 · Trade ticket" status="Live — the Trade tab: BTC/USD paper trades, weighted avg cost">
          <p className="font-display text-xs font-bold">BTC/USD · BUY / SELL</p>
          <div className="mt-2 flex gap-1.5">
            <span className="flex-1 rounded-full bg-[var(--accent)] py-1 text-center text-[10px] font-bold text-black">BUY</span>
            <span className="flex-1 rounded-full bg-[var(--surface)] py-1 text-center text-[10px] font-bold">SELL</span>
          </div>
          <div className="mt-2 space-y-1.5">{mockLine("100%")}{mockLine("100%")}{mockLine("55%")}</div>
          <div className="mt-3 rounded-full bg-[var(--accent)] py-1.5 text-center text-xs font-bold text-black">Record trade</div>
          <p className="mono mt-2 text-center text-[10px] text-[var(--dim)]">Counts toward your duel score</p>
        </PhoneMock>
        <PhoneMock title="6 · Portfolio & charts" status="Live — League tab charts: mix bar, balance line">
          <p className="mono text-[10px]">PORTFOLIO</p>
          <p className="font-display text-base font-extrabold">$50,880</p>
          <div className="mt-2 flex h-3 overflow-hidden rounded-full"><div className="bg-[var(--accent)]" style={{ width: "65%" }} /><div className="bg-[var(--teal)]" style={{ width: "26%" }} /><div style={{ width: "9%", background: "#eab308" }} /></div>
          <div className="mt-2 space-y-1">{mockLine("90%")}{mockLine("75%")}{mockLine("60%")}</div>
          <svg viewBox="0 0 100 24" className="mt-2 w-full" style={{ height: 28 }} aria-hidden><polyline points="0,20 25,16 50,17 75,8 100,5" fill="none" stroke="var(--accent)" strokeWidth="2" /></svg>
        </PhoneMock>
        <PhoneMock title="7 · Score reveal" status="Live — shown on every Battle finish; the score lab is on the League tab">
          <span className="flex justify-center"><Icon name="trophy" size={26} className="text-[var(--gold)]" /></span>
          <p className="font-display mt-1 text-center text-xs font-extrabold">VICTORY — +200 coins</p>
          <div className="mt-2 space-y-1.5">
            <div className="flex items-center gap-1"><span className="mono w-3 text-[10px] font-bold">R</span><div className="flex-1">{mockBar("80%")}</div></div>
            <div className="flex items-center gap-1"><span className="mono w-3 text-[10px] font-bold">K</span><div className="flex-1">{mockBar("65%", "var(--teal)")}</div></div>
            <div className="flex items-center gap-1"><span className="mono w-3 text-[10px] font-bold">C</span><div className="flex-1">{mockBar("70%", "#eab308")}</div></div>
            <div className="flex items-center gap-1"><span className="mono w-3 text-[10px] font-bold">A</span><div className="flex-1">{mockBar("50%", "#f97316")}</div></div>
          </div>
          <p className="mono mt-2 text-center text-[10px]">MMR 1000 → 1025 (+25)</p>
        </PhoneMock>
        <PhoneMock title="8 · Leaderboard" status="Live — the League tab: your live row vs the bot league">
          <div className="space-y-1.5">
            {["1 · Nova · 1240", "2 · BearTrap · 1185", "3 · KasKing · 1090", "4 · You · 1000", "5 · PixelPete · 960"].map((t, i) => (
              <div key={t} className={`rounded-lg px-2 py-1 text-[11px] font-semibold ${i === 3 ? "bg-[var(--accent)] text-black" : "bg-[var(--surface)]"}`}>{t}</div>
            ))}
          </div>
          <p className="mono mt-2 text-center text-[10px] text-[var(--dim)]">Weekly pool $2,450 · resets Monday</p>
        </PhoneMock>
        <PhoneMock title="9 · Wallet & rewards" status="Live — Battle tab ledger + Home activity: integer coins">
          <p className="mono text-[10px]">COIN WALLET</p>
          <p className="font-display text-base font-extrabold">500 coins</p>
          <div className="mt-2 space-y-1.5">
            <div className="flex justify-between text-[11px]"><span>Starter grant</span><span className="mono font-bold">+500</span></div>
            <div className="flex justify-between text-[11px]"><span>Duel entry vs Nova</span><span className="mono font-bold">−100</span></div>
            <div className="flex justify-between text-[11px]"><span>Duel win — pot</span><span className="mono font-bold">+200</span></div>
          </div>
          <div className="mt-3 rounded-full bg-[var(--surface)] py-1.5 text-center text-xs font-bold">Daily reward · Day 3 streak</div>
        </PhoneMock>
        <PhoneMock title="10 · Profile" status="Live — the Profile tab: MMR, record, signals, build plan">
          <div className="flex items-center gap-2"><span className="font-display grid h-9 w-9 place-items-center rounded-full bg-[var(--accent)] text-sm font-extrabold text-black" aria-hidden>K</span><div>{mockLine("70%")}<p className="mono mt-1 text-[10px]">MMR 1000 · 0W–0L</p></div></div>
          <div className="mt-3 grid grid-cols-3 gap-1 text-center">
            <div className="rounded-lg bg-[var(--surface)] p-1"><p className="mono text-[10px] font-bold">500</p><p className="text-[9px]">coins</p></div>
            <div className="rounded-lg bg-[var(--surface)] p-1"><p className="mono text-[10px] font-bold">Lv 1</p><p className="text-[9px]">level</p></div>
            <div className="rounded-lg bg-[var(--surface)] p-1"><p className="mono text-[10px] font-bold">BTC</p><p className="text-[9px]">market</p></div>
          </div>
          <div className="mt-2 space-y-1">{mockLine("85%")}{mockLine("65%")}</div>
        </PhoneMock>
      </div>
    </section>
  );
}

// ---------- scoring calculator ----------

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
      <SectionTitle right="blueprint §6">Scoring engine</SectionTitle>
      <div className="grid gap-6 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
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
          <p className="mono font-display mt-1 text-5xl font-semibold text-[var(--accent)]">
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
                    className="h-full bg-[var(--accent)] transition-all"
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
            As written in V3, the win bonus B is worth +10 raw — at most 1
            point after its 0.10 weight. Worth a look when you re-tune the
            weights; the components are stored separately for exactly that.
          </p>
        </div>
      </div>
    </section>
  );
}

// ---------- portfolio + paper trading ----------

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

  return (
    <section>
      <SectionTitle right="BTC/USD only · more pairs later">
        Portfolio & paper trades
      </SectionTitle>

      <div className="elev mb-4 rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] p-4">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[var(--surface3)] text-[var(--gold)]" style={{ boxShadow: "inset 0 0 0 1px var(--border-strong)" }}>
            <Icon name="bitcoin" size={24} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-display text-lg leading-tight font-extrabold">
              BTC/USD <span className="mono ml-1 align-middle text-[10px] font-bold tracking-wide text-[var(--accent)] uppercase">sole market</span>
            </p>
            <p className="mono text-xs text-[var(--dim)]">
              Bitcoin / US Dollar — the only tradable pair in this edition. More pairs arrive in a later edition.
            </p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-[var(--border)] pt-3">
          <p className="mono min-w-0 flex-1 text-xs text-[var(--dim)]">
            Live BTC/USD spot from the CoinGecko public API (keyless) — not Polygon.io, which still needs your own API key. Hand entry below still works.
          </p>
          <button
            type="button"
            className={`${primaryBtn} inline-flex items-center gap-1.5`}
            disabled={livePriceMut.isPending}
            onClick={() => livePriceMut.mutate()}
          >
            <Icon name="refresh" size={15} strokeWidth={2} />
            {livePriceMut.isPending ? "Fetching quote…" : "Refresh BTC price"}
          </button>
        </div>
      </div>

      {sorted.length === 0 ? (
        <p className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 text-sm text-[var(--dim)]">
          No open positions. Log your first paper trade below — positions use
          weighted-average cost, per blueprint §5.
        </p>
      ) : (
        <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
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
                    style={{ color: pl >= 0 ? "var(--accent)" : "var(--red)" }}
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

      <form
        onSubmit={onTrade}
        className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4"
      >
        <p className="font-display font-bold">Trade ticket — BTC/USD</p>
        <p className="mono mt-1 text-xs text-[var(--dim)]">
          BTC/USD is the only pair on the ticket in this edition. More pairs arrive later.
        </p>
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
            <label htmlFor="trade-side" className={labelCls}>
              Side
            </label>
            <div className="grid grid-cols-2 gap-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface2)] p-1" role="group" aria-label="Trade side">
              <button
                type="button"
                aria-pressed={side === "buy"}
                className={`rounded-lg py-1.5 text-sm font-bold ${side === "buy" ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "text-[var(--dim)]"}`}
                onClick={() => setSide("buy")}
              >
                Buy
              </button>
              <button
                type="button"
                aria-pressed={side === "sell"}
                className={`rounded-lg py-1.5 text-sm font-bold ${side === "sell" ? "bg-[var(--red)] text-white" : "text-[var(--dim)]"}`}
                onClick={() => setSide("sell")}
              >
                Sell
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
          className={`${primaryBtn} mt-3 w-full`}
          disabled={tradeMut.isPending}
        >
          {side === "buy" ? "Record BTC/USD buy" : "Record BTC/USD sell"}
        </button>
      </form>

      {trades.length > 0 ? (
        <div className="mt-4">
          <p className="mb-2 text-xs font-semibold tracking-wide text-[var(--dim)] uppercase">
            Recent trades
          </p>
          <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
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
                        t.side === "buy" ? "var(--accent)" : "var(--red)",
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

// ---------- duels + wallet ledger ----------

function DuelsSection({
  duels,
  balance,
  txns,
  setFeedback,
  refresh,
  challengeReq,
}: {
  duels: State["duels"];
  balance: number;
  txns: State["walletTxns"];
  setFeedback: (s: string) => void;
  refresh: () => void;
  challengeReq: { name: string; nonce: number } | null;
}) {
  const [opponent, setOpponent] = useState("");
  // Arena "Fight" buttons land here with the rival prefilled.
  useEffect(() => {
    if (challengeReq) setOpponent(challengeReq.name);
  }, [challengeReq]);
  const [wager, setWager] = useState("100");
  const [duration, setDuration] = useState("30 min");
  const [scores, setScores] = useState<
    Record<number, { you: string; opp: string; winner: "you" | "opponent" }>
  >({});
  const [adjAmount, setAdjAmount] = useState("");
  const [adjLabel, setAdjLabel] = useState("");

  const wrap = (fn: () => Promise<{ ok: boolean; message: string }>) => ({
    mutationFn: fn,
    onSuccess: (r: { ok: boolean; message: string }) => {
      setFeedback(r.message);
      refresh();
    },
    onError: () => setFeedback("That didn't go through — try again."),
  });

  const createMut = useMutation(
    wrap(() =>
      api.createDuel({
        opponent,
        wager: Number(wager),
        durationLabel: duration,
      }),
    ),
  );
  const adjMut = useMutation(
    wrap(() => api.adjustWallet({ amount: Number(adjAmount), label: adjLabel })),
  );

  const onCreate = (e: FormEvent) => {
    e.preventDefault();
    if (!opponent.trim() || !(Number(wager) > 0)) {
      setFeedback("Name an opponent and a wager above zero.");
      return;
    }
    createMut.mutate(undefined, {
      onSuccess: (r) => {
        if (r.ok) setOpponent("");
      },
    });
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

  const onAdjust = (e: FormEvent) => {
    e.preventDefault();
    const amt = Number(adjAmount);
    if (!Number.isInteger(amt) || amt === 0 || !adjLabel.trim()) {
      setFeedback("Enter a whole-coin amount (can be negative) and a label.");
      return;
    }
    adjMut.mutate(undefined, {
      onSuccess: (r) => {
        if (r.ok) {
          setAdjAmount("");
          setAdjLabel("");
        }
      },
    });
  };

  const statusColor = (s: string) =>
    s === "active"
      ? "var(--accent)"
      : s === "completed"
        ? "var(--dim)"
        : s === "void"
          ? "var(--red)"
          : "var(--teal)";

  return (
    <section className="mt-8">
      <SectionTitle right="prototype league: rank #7 of 124 · pool $2,450">
        Duels & tournaments
      </SectionTitle>

      <form
        id="create-duel"
        onSubmit={onCreate}
        className="scroll-mt-20 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4"
      >
        <p className="font-display font-bold">Start a 1v1 duel — BTC/USD</p>
        <p className="mono mt-1 text-xs text-[var(--dim)]">
          Every duel in this edition is traded on BTC/USD only — your score comes from your BTC position and BTC trades. Your wager is escrowed from your wallet on create (balance:{" "}
          {balance.toLocaleString()} coins). Rivals here are bots: when a
          bot accepts, its matched escrow is recorded on the duel and in
          the coin ledger, and the pot becomes a real 2× your wager. No
          human invite link exists in this single-user edition. Winner
          takes the pot; voiding refunds you. Anti-abuse (blueprint): max
          5 duels/hour, and a 24h rematch cooldown after a finished duel
          vs the same rival.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="duel-opponent" className={labelCls}>
              Opponent
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
            <label htmlFor="duel-wager" className={labelCls}>
              Wager (coins)
            </label>
            <input
              id="duel-wager"
              inputMode="numeric"
              className={inputCls}
              value={wager}
              onChange={(e) => setWager(e.target.value)}
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
          <div className="flex items-end">
            <button
              type="submit"
              className={`${primaryBtn} w-full`}
              disabled={createMut.isPending}
            >
              Create duel
            </button>
          </div>
        </div>
      </form>

      {duels.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--dim)]">
          No duels yet. The weekly league from the prototype is the tournament
          layer — duels are the core loop to ship first (blueprint §4).
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
                className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4"
              >
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
                    {d.wager + d.opponent_escrow}
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
                      <span style={{ color: "var(--accent)" }}>
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

      <div className="mt-4 grid gap-4">
        <form
          onSubmit={onAdjust}
          className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4"
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

        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="font-display font-bold">Coin ledger</p>
          {txns.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--dim)]">
              No transactions yet.
            </p>
          ) : (
            <div className="mt-2 space-y-1.5">
              {txns.slice(0, 8).map((t) => (
                <div
                  key={t.id}
                  className="flex items-baseline justify-between gap-2"
                >
                  <span className="truncate text-sm">{t.label}</span>
                  {t.amount === 0 ? (
                    <span className="mono shrink-0 text-xs font-semibold text-[var(--dim)]">
                      bot side
                    </span>
                  ) : (
                    <span
                      className="mono text-sm font-semibold"
                      style={{
                        color: t.amount >= 0 ? "var(--accent)" : "var(--red)",
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
      ? "var(--accent)"
      : s.includes("SELL")
        ? "var(--red)"
        : "var(--dim)";

  return (
    <section className="mt-8">
      <SectionTitle right="VisualML · BTC/USD only">ML signals</SectionTitle>
      {signals.length === 0 ? (
        <p className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 text-sm text-[var(--dim)]">
          No signals on the board. Add one below.
        </p>
      ) : (
        <div className="space-y-2">
          {signals.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3"
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
                  className="h-full"
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
        className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4"
      >
        <p className="font-display font-bold">Add a signal — BTC/USD</p>
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
          Add signal
        </button>
      </form>
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
      <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
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
                            ? "var(--teal)"
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
    "Polygon.io quotes — the blueprint's named provider needs your own Polygon account + API key; until then the price feed is CoinGecko, labeled as such",
    "The literal mobile app (Expo) + API (NestJS/Supabase) — separate repos in the blueprint's Next Move, outside this dashboard edition",
    "TestFlight beta (Week 7) and store submission (Week 8) — these ARE the deploy step: developer accounts, EAS submit, store listings",
  ];
  return (
    <section className="mt-8">
      <SectionTitle right="week 8 · built to the line, not past it">
        The deploy line
      </SectionTitle>
      <div className="rounded-[var(--radius)] border-2 border-[var(--accent)] bg-[var(--surface)] p-4">
        <p className="font-display flex items-center gap-2 text-xl font-extrabold"><Icon name="shield" size={22} className="text-[var(--accent)]" /> Stopped at the deploy line</p>
        <p className="mt-1 text-sm text-[var(--dim)]">
          {appReadyCount} of the {milestones.length} weeks are built and verified in this
          app; what remains is deploy itself. Nothing deploys, submits, or goes to a store
          until Kass says deploy.
        </p>
        <div className="mt-4 overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
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
                            ? "var(--teal)"
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
              <Icon name="check" size={15} className="mt-0.5 shrink-0 text-[var(--teal)]" />
              <span>{t}</span>
            </li>
          ))}
        </ul>
        <p className="mono mt-4 rounded-[var(--radius)] bg-[var(--surface2)] px-3 py-2 text-xs">
          When you're ready: say "deploy" and the next moves are (1) your Polygon.io key for the
          named price feed, (2) gasisit-api + gasisit-mobile repos per the blueprint, (3)
          EAS/TestFlight, then store submission — in that order, each verified as it lands.
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
      <SectionTitle right="Production Blueprint V3">The blueprint</SectionTitle>
      <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
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
        (app.py) in your project files. Prices can be refreshed live from
        the CoinGecko public API (BTC/USD spot — the only market in this edition) or entered by hand;
        Polygon.io — the blueprint's named provider — still needs a
        Polygon account/API key. Built to the deploy line and stopping
        there: no store submission, no deployment, until you say deploy.
        The remaining literal Week 7/8 work (Expo app, EAS/TestFlight,
        store listings) lives in separate mobile/API repos outside this
        dashboard.
      </p>
    </section>
  );
}
