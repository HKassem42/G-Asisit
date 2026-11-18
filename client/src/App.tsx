import { useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

type State = ApiResponse<typeof api, "getState">;
type Duel = State["duels"][number];

// ---------- formatting helpers ----------

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

// Candle timestamps are epoch seconds (Coinbase). Readouts speak
// Detroit time — Kass's timezone — with a 12-hour clock.
function fmtDetroitTime(epochSec: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Detroit",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(epochSec * 1000));
}

// ---------- motion helpers (60fps / Bencho / Ripplix craft) ----------
// One spring family for the whole game: ease-out cubic for entrances,
// transform + opacity only, and every helper below collapses to an
// instant swap under prefers-reduced-motion.

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

// Animated number: rolls from its previous value to the new one
// (from 0 on first mount) over ~650ms with an ease-out cubic — the
// odometer treatment, used ONLY for hero / wallet numbers, never
// for dense rows (those must flash or swap, not count).
function useAnimatedNumber(value: number, duration = 650): number {
  const reduced = usePrefersReducedMotion();
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);
  useEffect(() => {
    if (reduced) {
      fromRef.current = value;
      setDisplay(value);
      return;
    }
    const from = fromRef.current;
    if (from === value) {
      setDisplay(value);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (value - from) * eased);
      if (t < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        fromRef.current = value;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, reduced, duration]);
  return display;
}

function AnimatedNumber({
  value,
  format,
  className,
}: {
  value: number;
  format: (n: number) => string;
  className?: string;
}) {
  const display = useAnimatedNumber(value);
  return (
    <span className={className} aria-label={format(value)}>
      <span aria-hidden>{format(display)}</span>
    </span>
  );
}

// Duel-score reveal: counts 0 → final score once, when it mounts.
function ScoreCountUp({ value }: { value: number }) {
  const display = useAnimatedNumber(value, 750);
  return (
    <span aria-label={value.toFixed(1)}>
      <span aria-hidden>{display.toFixed(1)}</span>
    </span>
  );
}

// Sliding-pill segmented control (Bencho / Ripplix pattern): one
// pill glides behind the labels — transform + width on a damped
// ease — instead of the active button snapping its colors.
function SlidingSegmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  pillFor,
  textFor,
  rounded = "rounded-full",
}: {
  options: Array<[T, string]>;
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
  pillFor: (v: T) => string;
  textFor: (v: T) => string;
  rounded?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);
  const activeIdx = options.findIndex(([v]) => v === value);

  useEffect(() => {
    const measure = () => {
      const btn = btnRefs.current[activeIdx];
      if (btn) setPill({ x: btn.offsetLeft, w: btn.offsetWidth });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [activeIdx, options.length]);

  return (
    <div
      ref={wrapRef}
      className={`relative flex items-center gap-1 bg-[var(--surface2)] p-1 ${rounded}`}
      role="group"
      aria-label={ariaLabel}
    >
      {pill ? (
        <span
          aria-hidden
          className={`absolute top-1 bottom-1 ${rounded}`}
          style={{
            left: 0,
            width: pill.w,
            transform: `translateX(${pill.x}px)`,
            background: pillFor(value),
            transition: reduced
              ? "none"
              : "transform 280ms cubic-bezier(0.32,0.72,0,1), width 280ms cubic-bezier(0.32,0.72,0,1), background-color 200ms ease",
          }}
        />
      ) : null}
      {options.map(([v, label], i) => (
        <button
          key={v}
          ref={(el) => {
            btnRefs.current[i] = el;
          }}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={`relative z-10 flex-1 py-2 text-[13px] font-black ${rounded}`}
          style={{
            color: value === v ? textFor(v) : "var(--dim)",
            transition: "color 160ms ease, transform 120ms ease-out",
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
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

// Badges are earned strictly from the player's real record; unearned
// badges render locked with the requirement named.
type Badge = { name: string; req: string; earned: boolean };

function badgesOf(s: {
  wins: number;
  completed: number;
  winRate: number;
  btcTrades: number;
  balance: number;
  mmr: number;
}): Badge[] {
  return [
    { name: "First Win", req: "Win a duel", earned: s.wins >= 1 },
    { name: "Sharpshooter", req: "60%+ win rate across 3+ finished duels", earned: s.completed >= 3 && s.winRate >= 60 },
    { name: "Active Trader", req: "Record 10 BTC/USD trades", earned: s.btcTrades >= 10 },
    { name: "Veteran", req: "Finish 5 duels", earned: s.completed >= 5 },
    { name: "Coin Baron", req: "Hold 1,000 coins", earned: s.balance >= 1000 },
    { name: "League Ready", req: "Reach 1100 MMR (Gold tier)", earned: s.mmr >= 1100 },
  ];
}

// ---------- shared bits ----------

// One section pattern app-wide: a small-caps title, at most one
// caption line, then the block's card. Sections own their top gap
// (mt-5 / mt-6 on the <section>) so blocks never flow into each other.
function SectionTitle({
  children,
  right,
}: {
  children: string;
  right?: string;
  num?: string;
}) {
  return (
    <div className="mb-3">
      <h2 className="font-display text-[13px] leading-none font-extrabold tracking-[0.16em] text-[var(--text)] uppercase">
        {children}
      </h2>
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

function TrophyShelf({ wins, badges }: { wins: number; badges: Badge[] }) {
  const shelf: Array<{ label: string; need: number }> = [
    { label: "First Cup", need: 1 },
    { label: "Triple Crown", need: 3 },
    { label: "High Five", need: 5 },
    { label: "Perfect Ten", need: 10 },
  ];
  return (
    <section className="mt-5">
      <SectionTitle right="earned from your record only">Trophy shelf & badges</SectionTitle>
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
    <section className="mt-5">
      <SectionTitle right="straight from your record">Activity</SectionTitle>
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
  // Chart scrubbing (60fps pattern): press / drag across the sparkline
  // and a crosshair snaps to the nearest candle; the readout chip is
  // clamped inside the chart at both edges; release restores live.
  const [scrubIdx, setScrubIdx] = useState<number | null>(null);
  const scrubbingRef = useRef(false);

  if (candles.length < 2) {
    return q.isPending ? (
      <div className="mt-4" role="status" aria-label="Loading live BTC chart">
        <div className="skeleton h-[74px] rounded-2xl" />
      </div>
    ) : (
      <p className="mono mt-4 text-[11px] text-[var(--dim)]">
        Live chart unavailable right now — your stored price still stands.
      </p>
    );
  }
  const closes = candles.map((c) => c.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const yOf = (v: number) => 30 - ((v - min) / Math.max(max - min, 1)) * 26;
  const pts = closes
    .map((v, i) => `${(i / (closes.length - 1)) * 100},${yOf(v)}`)
    .join(" ");
  const up = closes[closes.length - 1]! >= closes[0]!;
  const scrubCandle = scrubIdx != null ? candles[scrubIdx] : undefined;
  const headPrice = scrubCandle ? scrubCandle.close : closes[closes.length - 1]!;

  const idxFromEvent = (e: ReactPointerEvent<HTMLDivElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = clamp((e.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
    return Math.round(ratio * (candles.length - 1));
  };

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="mono min-w-0 text-[11px] font-bold tracking-widest text-[var(--dim)] uppercase">
          {scrubCandle ? `BTC/USD · ${fmtDetroitTime(scrubCandle.t)} ET` : "BTC/USD · 24H · Coinbase"}
        </p>
        <p className="mono shrink-0 text-sm font-bold whitespace-nowrap" style={{ color: up ? "var(--accent)" : "var(--red)" }}>
          ${fmtPrice(headPrice)}
        </p>
      </div>
      <div
        className="relative mt-1.5 touch-pan-y select-none"
        role="img"
        aria-label={`BTC/USD 24 hour line chart, last price ${fmtPrice(closes[closes.length - 1]!)} dollars. Press and drag to scrub the chart.`}
        onPointerDown={(e) => {
          scrubbingRef.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          setScrubIdx(idxFromEvent(e));
        }}
        onPointerMove={(e) => {
          if (scrubbingRef.current) setScrubIdx(idxFromEvent(e));
        }}
        onPointerUp={() => {
          scrubbingRef.current = false;
          setScrubIdx(null);
        }}
        onPointerCancel={() => {
          scrubbingRef.current = false;
          setScrubIdx(null);
        }}
      >
        <svg viewBox="0 0 100 34" className="w-full" style={{ height: 56 }} preserveAspectRatio="none" aria-hidden>
          <polyline points={pts} fill="none" stroke={up ? "var(--accent)" : "var(--red)"} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          {scrubIdx != null ? (
            <g>
              <line x1={(scrubIdx / (closes.length - 1)) * 100} x2={(scrubIdx / (closes.length - 1)) * 100} y1={1} y2={33} stroke="var(--text)" strokeWidth="1" vectorEffect="non-scaling-stroke" opacity="0.65" />
              <circle cx={(scrubIdx / (closes.length - 1)) * 100} cy={yOf(closes[scrubIdx]!)} r="2.6" fill="var(--bg)" stroke={up ? "var(--accent)" : "var(--red)"} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
            </g>
          ) : null}
        </svg>
        {scrubCandle ? (
          <span
            aria-hidden
            className="mono pointer-events-none absolute -top-1 z-10 -translate-x-1/2 rounded-full bg-[var(--text)] px-2.5 py-1 text-[10px] font-bold whitespace-nowrap text-[var(--ink)]"
            style={{
              left: `clamp(74px, ${(scrubIdx! / (closes.length - 1)) * 100}%, calc(100% - 74px))`,
              boxShadow: "var(--shadow-pop)",
            }}
          >
            {fmtDetroitTime(scrubCandle.t)} · ${fmtPrice(scrubCandle.close)}
          </span>
        ) : null}
      </div>
      <p className="mono mt-1 text-[10px] text-[var(--faint)]">Hold &amp; drag the chart to scrub</p>
    </div>
  );
}

// ---------- Home hero: YOUR COINS curve (replaces the BTC sparkline) ----------
// The hero charts the player's own money, not the market: total coins
// over the last 24H, rebuilt from the player's real record only.
// Free coins step at wallet-ledger events (starter grant, duel
// escrows/payouts, coin buys/sells); BTC quantity steps at trade
// events; between events the open BTC is marked at each real Coinbase
// candle close — the same candles the Trade chart uses. Before the
// player's first recorded event inside the window the curve simply
// starts at that event — no earlier history is drawn. The final point
// is the hero's live total (free + in-BTC at live spot), exactly.
function CoinSparkline({
  data,
  bankrollCoins,
}: {
  data: State;
  bankrollCoins: number;
}) {
  const q = useCandles("24H");
  const candles: Candle[] = q.data?.ok ? q.data.candles : [];
  const [scrubIdx, setScrubIdx] = useState<number | null>(null);
  const scrubbingRef = useRef(false);

  const btcPosition = data.positions.find(
    (p) => p.symbol.toUpperCase() === "BTC",
  );
  const qtyNow = btcPosition ? btcPosition.qty : 0;
  const freeNow = data.wallet.balance;

  const txnEvents = data.walletTxns
    .filter((t) => t.amount !== 0)
    .map((t) => ({ ms: new Date(t.created_at).getTime(), amount: t.amount }));
  const tradeEvents = data.trades
    .filter((t) => t.symbol.toUpperCase() === "BTC")
    .map((t) => ({
      ms: new Date(t.created_at).getTime(),
      dq: t.side === "buy" ? t.qty : -t.qty,
    }));
  const hasActivity =
    tradeEvents.length > 0 ||
    data.walletTxns.some((t) => t.amount !== 0 && t.type !== "starter_grant");

  // Balance / holdings at time x, walked backwards from the live state:
  // subtract every recorded step that happened after x.
  const freeAt = (xMs: number) =>
    freeNow - txnEvents.reduce((s, e) => (e.ms > xMs ? s + e.amount : s), 0);
  const qtyAt = (xMs: number) =>
    Math.max(
      0,
      qtyNow - tradeEvents.reduce((s, e) => (e.ms > xMs ? s + e.dq : s), 0),
    );

  type CoinPoint = { t: number; total: number };
  let points: CoinPoint[] = [];
  if (candles.length >= 2) {
    // One point per candle, valued at that candle's close (end of its
    // hour bucket): ledger/trade steps at their recorded times, open
    // BTC marked at the close.
    const raw: CoinPoint[] = candles.map((c) => {
      const xMs = (c.t + 3600) * 1000 - 1;
      return { t: c.t, total: freeAt(xMs) + qtyAt(xMs) * c.close };
    });
    const allMs = [
      ...txnEvents.map((e) => e.ms),
      ...tradeEvents.map((e) => e.ms),
    ];
    const firstEver = allMs.length ? Math.min(...allMs) : null;
    const windowStartMs = candles[0]!.t * 1000;
    if (firstEver != null && firstEver > windowStartMs) {
      const kept = raw.filter(
        (p) => (p.t + 3600) * 1000 - 1 >= firstEver,
      );
      const bucket =
        candles.find(
          (c) => firstEver >= c.t * 1000 && firstEver < (c.t + 3600) * 1000,
        ) ?? candles[candles.length - 1]!;
      points = [
        {
          t: Math.floor(firstEver / 1000),
          total: freeAt(firstEver) + qtyAt(firstEver) * bucket.close,
        },
        ...kept,
      ];
    } else {
      points = raw;
    }
    // Final point = the hero's live total, exactly.
    if (points.length > 0) {
      const lastPt = points[points.length - 1]!;
      points[points.length - 1] = { t: lastPt.t, total: bankrollCoins };
    }
  }

  // A player with no activity yet holds a flat line at their total —
  // true at every hour of the window, so it needs no market data.
  if (points.length < 2 && !hasActivity && qtyNow === 0) {
    const nowSec = Math.floor(Date.now() / 1000);
    points = Array.from({ length: 24 }, (_, i) => ({
      t: nowSec - (23 - i) * 3600,
      total: bankrollCoins,
    }));
  }

  if (points.length < 2) {
    return q.isPending ? (
      <div className="mt-4" role="status" aria-label="Loading your coin history">
        <div className="skeleton h-[74px] rounded-2xl" />
      </div>
    ) : (
      <p className="mono mt-4 text-[11px] text-[var(--dim)]">
        Coin history unavailable right now — your total above is current.
      </p>
    );
  }

  const totals = points.map((p) => p.total);
  const min = Math.min(...totals);
  const max = Math.max(...totals);
  const span = max - min;
  const yOf = (v: number) =>
    span === 0 ? 17 : 30 - ((v - min) / span) * 26;
  const pts = totals
    .map((v, i) => `${(i / (totals.length - 1)) * 100},${yOf(v)}`)
    .join(" ");
  const firstTotal = totals[0]!;
  const lastTotal = totals[totals.length - 1]!;
  const change = lastTotal - firstTotal;
  const pct = firstTotal > 0 ? (change / firstTotal) * 100 : null;
  const changeText = `${change > 0 ? "+" : change < 0 ? "−" : ""}${Math.abs(Math.round(change)).toLocaleString()} coins${
    pct != null
      ? ` (${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct).toFixed(1)}%)`
      : ""
  }`;
  const lineColor = change < 0 ? "var(--red)" : "var(--accent)";
  const scrubPoint = scrubIdx != null ? points[scrubIdx] : undefined;

  const idxFromEvent = (e: ReactPointerEvent<HTMLDivElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = clamp((e.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
    return Math.round(ratio * (points.length - 1));
  };

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="mono min-w-0 text-[11px] font-bold tracking-widest text-[var(--dim)] uppercase">
          {scrubPoint ? `Your coins · ${fmtDetroitTime(scrubPoint.t)} ET` : "Your coins · 24H"}
        </p>
        <p className="mono shrink-0 text-sm font-bold whitespace-nowrap" style={{ color: lineColor }}>
          {scrubPoint
            ? `${Math.round(scrubPoint.total).toLocaleString()} coins`
            : changeText}
        </p>
      </div>
      <div
        className="relative mt-1.5 touch-pan-y select-none"
        role="img"
        aria-label={`Your total coins over the last 24 hours: started at ${Math.round(firstTotal).toLocaleString()} coins, now ${Math.round(lastTotal).toLocaleString()} coins (${changeText}). Press and drag to scrub the chart.`}
        onPointerDown={(e) => {
          scrubbingRef.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          setScrubIdx(idxFromEvent(e));
        }}
        onPointerMove={(e) => {
          if (scrubbingRef.current) setScrubIdx(idxFromEvent(e));
        }}
        onPointerUp={() => {
          scrubbingRef.current = false;
          setScrubIdx(null);
        }}
        onPointerCancel={() => {
          scrubbingRef.current = false;
          setScrubIdx(null);
        }}
      >
        <svg viewBox="0 0 100 34" className="w-full" style={{ height: 56 }} preserveAspectRatio="none" aria-hidden>
          <polyline points={pts} fill="none" stroke={lineColor} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          {scrubIdx != null && scrubPoint ? (
            <g>
              <line x1={(scrubIdx / (points.length - 1)) * 100} x2={(scrubIdx / (points.length - 1)) * 100} y1={1} y2={33} stroke="var(--text)" strokeWidth="1" vectorEffect="non-scaling-stroke" opacity="0.65" />
              <circle cx={(scrubIdx / (points.length - 1)) * 100} cy={yOf(scrubPoint.total)} r="2.6" fill="var(--bg)" stroke={lineColor} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
            </g>
          ) : null}
        </svg>
        {scrubPoint ? (
          <span
            aria-hidden
            className="mono pointer-events-none absolute -top-1 z-10 -translate-x-1/2 rounded-full bg-[var(--text)] px-2.5 py-1 text-[10px] font-bold whitespace-nowrap text-[var(--ink)]"
            style={{
              left: `clamp(80px, ${(scrubIdx! / (points.length - 1)) * 100}%, calc(100% - 80px))`,
              boxShadow: "var(--shadow-pop)",
            }}
          >
            {fmtDetroitTime(scrubPoint.t)} · {Math.round(scrubPoint.total).toLocaleString()} coins
          </span>
        ) : null}
      </div>
      {hasActivity ? (
        <p className="mono mt-1 text-[10px] text-[var(--faint)]">Hold &amp; drag to scrub your coins</p>
      ) : (
        <p className="mono mt-1 text-[10px] text-[var(--faint)]">Your coin history builds as you play.</p>
      )}
    </div>
  );
}

type ChartType = "candles" | "line" | "heikin";

function heikinAshi(src: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const close = (c.open + c.high + c.low + c.close) / 4;
    const prev = out[i - 1];
    const open = prev ? (prev.open + prev.close) / 2 : (c.open + c.close) / 2;
    out.push({
      t: c.t,
      open,
      close,
      high: Math.max(c.high, open, close),
      low: Math.min(c.low, open, close),
      volume: c.volume,
    });
  }
  return out;
}

function emaSeries(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = values.map(() => null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema = values[i]! * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function rsiSeries(closes: number[], period = 14): Array<number | null> {
  const out: Array<number | null> = closes.map(() => null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function macdSeries(closes: number[]) {
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  const macd: Array<number | null> = closes.map((_, i) =>
    fast[i] != null && slow[i] != null ? fast[i]! - slow[i]! : null,
  );
  const macdVals = macd.filter((v): v is number => v != null);
  const sigVals = emaSeries(macdVals, 9);
  const signal: Array<number | null> = closes.map(() => null);
  let j = 0;
  for (let i = 0; i < macd.length; i++) {
    if (macd[i] != null) {
      signal[i] = sigVals[j] ?? null;
      j++;
    }
  }
  const hist: Array<number | null> = closes.map((_, i) =>
    macd[i] != null && signal[i] != null ? macd[i]! - signal[i]! : null,
  );
  return { macd, signal, hist };
}

function lastNum(a: Array<number | null>): number | null {
  for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]!;
  return null;
}

// Market chart with a reserved right gutter: candles/line live ONLY in
// the plot area; the dashed last-price line runs across the plot and
// its price tag sits in the gutter, so the tag can never cover a candle.
function MarketChart({
  candles,
  chartType,
  showEma,
  showRsi,
  showMacd,
  onScrub,
}: {
  candles: Candle[];
  chartType: ChartType;
  showEma: boolean;
  showRsi: boolean;
  showMacd: boolean;
  onScrub?: (c: Candle | null) => void;
}) {
  // Scrubbing (Robinhood grammar via 60fps): finger tracks 1:1, the
  // crosshair snaps to the nearest candle, and the parent swaps its
  // big price readout in place until release restores the live price.
  const [scrubIdx, setScrubIdx] = useState<number | null>(null);
  const scrubbingRef = useRef(false);
  useEffect(() => {
    onScrub?.(scrubIdx != null ? (candles[scrubIdx] ?? null) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrubIdx]);
  const display = chartType === "heikin" ? heikinAshi(candles) : candles;
  const closes = display.map((c) => c.close);
  const ema = emaSeries(closes, 20);
  const rsi = rsiSeries(closes, 14);
  const macd = macdSeries(closes);
  const emaNow = lastNum(ema);
  const rsiNow = lastNum(rsi);
  const macdNow = lastNum(macd.macd);
  const lastClose = closes[closes.length - 1]!;

  const W = 360;
  const GUTTER = 62;
  const PLOT = W - GUTTER;
  const H = 190;
  const highs = display.map((c) => c.high);
  const lows = display.map((c) => c.low);
  if (showEma) ema.forEach((v) => { if (v != null) { highs.push(v); lows.push(v); } });
  const max = Math.max(...highs);
  const min = Math.min(...lows);
  const span = Math.max(max - min, 1);
  const y = (v: number) => 8 + ((max - v) / span) * (H - 24);
  const step = PLOT / display.length;
  const bw = Math.max(3, step * 0.55);
  const linePts = display
    .map((c, i) => `${(i * step + step / 2).toFixed(1)},${y(c.close).toFixed(1)}`)
    .join(" ");
  const emaPts = ema
    .map((v, i) => (v == null ? null : `${(i * step + step / 2).toFixed(1)},${y(v).toFixed(1)}`))
    .filter(Boolean)
    .join(" ");
  const typeLabel = chartType === "candles" ? "candlestick" : chartType === "line" ? "line" : "Heikin-Ashi";

  // RSI sub-panel geometry
  const RH = 54;
  const rsiY = (v: number) => 6 + ((100 - v) / 100) * (RH - 12);
  const rsiPts = rsi
    .map((v, i) => (v == null ? null : `${(i * step + step / 2).toFixed(1)},${rsiY(v).toFixed(1)}`))
    .filter(Boolean)
    .join(" ");
  // MACD sub-panel geometry
  const MH = 62;
  const allMacd = [...macd.macd, ...macd.signal, ...macd.hist].filter((v): v is number => v != null);
  const mMax = allMacd.length ? Math.max(...allMacd.map(Math.abs), 1) : 1;
  const macdY = (v: number) => MH / 2 - (v / mMax) * (MH / 2 - 5);
  const macdPts = macd.macd
    .map((v, i) => (v == null ? null : `${(i * step + step / 2).toFixed(1)},${macdY(v).toFixed(1)}`))
    .filter(Boolean)
    .join(" ");
  const sigPts = macd.signal
    .map((v, i) => (v == null ? null : `${(i * step + step / 2).toFixed(1)},${macdY(v).toFixed(1)}`))
    .filter(Boolean)
    .join(" ");

  const scrubCandle = scrubIdx != null ? display[scrubIdx] : undefined;
  const scrubX = scrubIdx != null ? scrubIdx * step + step / 2 : 0;

  const idxFromEvent = (e: ReactPointerEvent<HTMLDivElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    // The plot occupies the left PLOT/W of the svg; the gutter is inert.
    const plotWidth = (rect.width * PLOT) / W;
    const ratio = clamp((e.clientX - rect.left) / Math.max(plotWidth, 1), 0, 1);
    return clamp(Math.round(ratio * display.length - 0.5), 0, display.length - 1);
  };

  return (
    <div className="chart-enter">
      <div
        className="relative touch-pan-y select-none"
        onPointerDown={(e) => {
          scrubbingRef.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          setScrubIdx(idxFromEvent(e));
        }}
        onPointerMove={(e) => {
          if (scrubbingRef.current) setScrubIdx(idxFromEvent(e));
        }}
        onPointerUp={() => {
          scrubbingRef.current = false;
          setScrubIdx(null);
        }}
        onPointerCancel={() => {
          scrubbingRef.current = false;
          setScrubIdx(null);
        }}
      >
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`BTC/USD ${typeLabel} chart, high ${fmtPrice(max)}, low ${fmtPrice(min)}, last ${fmtPrice(lastClose)}${emaNow != null && showEma ? `, EMA 20 at ${fmtPrice(emaNow)}` : ""}. Press and drag to scrub.`}>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={PLOT} y1={H * f} y2={H * f} stroke="var(--border)" strokeWidth="0.6" strokeDasharray="3 4" />
        ))}
        {chartType === "line" ? (
          <polyline points={linePts} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
        ) : (
          display.map((c, i) => {
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
          })
        )}
        {showEma && emaPts ? (
          <polyline points={emaPts} fill="none" stroke="#38bdf8" strokeWidth="1.4" strokeLinejoin="round" opacity="0.9" />
        ) : null}
        {scrubCandle ? (
          <g aria-hidden>
            <line x1={scrubX} x2={scrubX} y1={4} y2={H - 4} stroke="var(--text)" strokeWidth="1" opacity="0.7" />
            <circle cx={scrubX} cy={y(scrubCandle.close)} r="4.5" fill="var(--bg)" stroke="var(--accent)" strokeWidth="2" />
          </g>
        ) : null}
        {/* Dashed last-price level across the plot, tag in the gutter */}
        <line x1={0} x2={W - 2} y1={y(lastClose)} y2={y(lastClose)} stroke="var(--accent)" strokeWidth="1" strokeDasharray="5 4" opacity="0.85" />
        <rect x={PLOT + 3} y={Math.max(0, Math.min(H - 18, y(lastClose) - 9))} width={GUTTER - 5} height={18} rx={5} fill="var(--accent)" />
        <text x={PLOT + 3 + (GUTTER - 5) / 2} y={Math.max(9, Math.min(H - 5, y(lastClose) + 3.5))} textAnchor="middle" fontSize="9.5" fontWeight="700" fill="var(--accent-ink)" fontFamily="var(--font-mono)">
          {fmtPrice(lastClose)}
        </text>
      </svg>
      {scrubCandle ? (
        <span
          aria-hidden
          className="mono pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-full bg-[var(--text)] px-2.5 py-1 text-[10px] font-bold whitespace-nowrap text-[var(--ink)]"
          style={{
            left: `clamp(78px, ${(scrubX / W) * 100}%, calc(100% - 78px))`,
            boxShadow: "var(--shadow-pop)",
          }}
        >
          {fmtDetroitTime(scrubCandle.t)} · ${fmtPrice(scrubCandle.close)}
        </span>
      ) : null}
      </div>
      <p className="mono mt-1 text-[10px] text-[var(--faint)]">Hold &amp; drag the chart to scrub · release to return to live</p>
      <div className="mono mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-[var(--dim)]">
        <span>Last <span className="font-bold text-[var(--text)]">${fmtPrice(lastClose)}</span> · dashed level line, tag in the side gutter</span>
        {showEma ? <span style={{ color: "#38bdf8" }}>— EMA 20 {emaNow != null ? `$${fmtPrice(emaNow)}` : "warming up"}</span> : null}
      </div>

      {showRsi ? (
        <div className="mt-3 rounded-2xl bg-[var(--surface2)] px-3 py-2">
          <div className="flex items-baseline justify-between">
            <p className="mono text-[10px] font-bold tracking-widest text-[var(--dim)] uppercase">RSI (14)</p>
            <p className="mono text-xs font-bold">{rsiNow != null ? rsiNow.toFixed(1) : "warming up"}</p>
          </div>
          <svg viewBox={`0 0 ${W} ${RH}`} className="mt-1 w-full" role="img" aria-label={`RSI 14 sub-panel, current value ${rsiNow != null ? rsiNow.toFixed(1) : "not enough candles yet"}`}>
            <line x1={0} x2={PLOT} y1={rsiY(70)} y2={rsiY(70)} stroke="var(--border)" strokeWidth="0.6" strokeDasharray="3 4" />
            <line x1={0} x2={PLOT} y1={rsiY(50)} y2={rsiY(50)} stroke="var(--border-strong)" strokeWidth="0.6" />
            <line x1={0} x2={PLOT} y1={rsiY(30)} y2={rsiY(30)} stroke="var(--border)" strokeWidth="0.6" strokeDasharray="3 4" />
            {rsiPts ? <polyline points={rsiPts} fill="none" stroke="#c084fc" strokeWidth="1.6" strokeLinejoin="round" /> : null}
            <text x={PLOT + 6} y={rsiY(70) + 3} fontSize="8.5" fill="var(--faint)" fontFamily="var(--font-mono)">70</text>
            <text x={PLOT + 6} y={rsiY(30) + 3} fontSize="8.5" fill="var(--faint)" fontFamily="var(--font-mono)">30</text>
          </svg>
        </div>
      ) : null}

      {showMacd ? (
        <div className="mt-2 rounded-2xl bg-[var(--surface2)] px-3 py-2">
          <div className="flex items-baseline justify-between">
            <p className="mono text-[10px] font-bold tracking-widest text-[var(--dim)] uppercase">MACD (12 · 26 · 9)</p>
            <p className="mono text-xs font-bold">{macdNow != null ? macdNow.toFixed(1) : "warming up"}</p>
          </div>
          <svg viewBox={`0 0 ${W} ${MH}`} className="mt-1 w-full" role="img" aria-label={`MACD sub-panel, current value ${macdNow != null ? macdNow.toFixed(1) : "not enough candles yet"}`}>
            <line x1={0} x2={PLOT} y1={MH / 2} y2={MH / 2} stroke="var(--border-strong)" strokeWidth="0.6" />
            {macd.hist.map((v, i) =>
              v == null ? null : (
                <rect key={i} x={i * step + step / 2 - bw / 2} y={Math.min(macdY(v), MH / 2)} width={bw} height={Math.max(Math.abs(macdY(v) - MH / 2), 0.8)} fill={v >= 0 ? "var(--accent)" : "var(--red)"} opacity="0.45" />
              ),
            )}
            {macdPts ? <polyline points={macdPts} fill="none" stroke="#38bdf8" strokeWidth="1.5" strokeLinejoin="round" /> : null}
            {sigPts ? <polyline points={sigPts} fill="none" stroke="#ffc93c" strokeWidth="1.2" strokeLinejoin="round" /> : null}
          </svg>
          <p className="mono text-[10px] text-[var(--dim)]"><span style={{ color: "#38bdf8" }}>— MACD</span> · <span style={{ color: "var(--gold)" }}>— Signal</span> · bars = histogram</p>
        </div>
      ) : null}
    </div>
  );
}

// ---------- pick a room (Battle) ----------
// ONE room picker for the whole tab: the standing 24/7 cups and the
// stakes ladder were two pickers for the same act, so they are one
// list now. Every room is a duel: wager the entry, the bot rival
// matches it, pot is the real 2× escrow. Enter sets the wager in
// the duel creator below (My duels) — name your rival there and open
// the room. In this edition a cup entry plays out as a duel room
// against the bot field; full multiplayer brackets ship with the
// multiplayer build.

function RoomPicker({ onPick }: { onPick: (wager: number) => void }) {
  const rooms: Array<{
    name: string;
    tag: string;
    wager: number;
    note: string;
    glow: string;
  }> = [
    {
      name: "Rookie Rumble",
      tag: "Cup · runs 24/7",
      wager: 50,
      note: "The new-player cup — learn the room, full scoring, small pot.",
      glow: "glow-teal",
    },
    {
      name: "BTC/USD Cup",
      tag: "Cup · new field hourly",
      wager: 100,
      note: "The league's headline cup — the standard room, standard stakes.",
      glow: "glow-violet",
    },
    {
      name: "High Roller Open",
      tag: "Cup · runs 24/7",
      wager: 250,
      note: "The deep end — biggest pot on the board this season.",
      glow: "glow-violet",
    },
  ];
  return (
    <section className="mt-5">
      <SectionTitle right="hosted by the bot rivals · winner takes the pot">Pick a room</SectionTitle>
      <div className="space-y-3">
        {rooms.map((r) => (
          <div key={r.name} className={`rounded-[var(--radius)] bg-[var(--surface)] p-4 ${r.glow}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-display flex items-center gap-2 text-lg leading-tight font-black">
                  <Icon name="trophy" size={18} className="shrink-0 text-[var(--gold)]" />
                  {r.name}
                </p>
                <p className="mono mt-1 flex items-center gap-1.5 text-[11px] font-bold tracking-wide text-[var(--accent)] uppercase">
                  <span className="live-dot h-1.5 w-1.5 rounded-full bg-[var(--accent)]" aria-hidden />
                  {r.tag}
                </p>
                <p className="mt-1 text-xs text-[var(--dim)]">{r.note}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="mono text-[10px] font-bold tracking-widest text-[var(--dim)] uppercase">Pot</p>
                <p className="mono font-display text-2xl leading-none font-black text-[var(--accent)]">
                  {r.wager * 2}
                </p>
                <p className="mono mt-0.5 text-[10px] text-[var(--dim)]">coins · wager {r.wager}</p>
              </div>
            </div>
            <button
              type="button"
              className="mt-3 w-full rounded-full border border-[var(--border-strong)] bg-[var(--surface2)] py-3 font-display text-sm font-black tracking-wide text-[var(--text)] uppercase"
              onClick={() => onPick(r.wager)}
              aria-label={`Enter ${r.name}: set the duel wager to ${r.wager} coins in the creator below`}
            >
              Enter — {r.wager} coins
            </button>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-[var(--dim)]">
        Entering sets your wager in the creator below — name your rival and open the room.
        Cup entries play out as duel rooms against the bot field in this edition.
      </p>
    </section>
  );
}



// ---------- featured rooms (the bot rivals, presented as duel rooms) ----------

function FeaturedRooms({ onChallenge }: { onChallenge: (name: string) => void }) {
  return (
    <section className="mt-5">
      <SectionTitle right="bot rooms · BTC/USD">Featured rooms</SectionTitle>
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

// ---------- player identity helpers ----------

// Avatar initials come from the player's stored handle — the same
// monogram treatment the app bar, player card, battle screen and
// standings all share.
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "K";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

const HOME_MARKETS = [
  "Detroit",
  "Chicago",
  "New York",
  "Los Angeles",
  "Houston",
  "London",
  "Tokyo",
  "Somewhere else",
];

// ---------- how the league works (3-card tour) ----------
// Shown as the last step of onboarding and replayable any time from
// Profile settings. Every claim in it is a rule the app actually
// enforces server-side (escrow, 2× pot, §6 weights, min-3-trades).

function HowItWorks({
  onDone,
  doneLabel,
}: {
  onDone: () => void;
  doneLabel: string;
}) {
  const [step, setStep] = useState(0);
  const steps: Array<{ icon: IconName; title: string; body: string }> = [
    {
      icon: "chart",
      title: "Trade BTC/USD",
      body: "One market, priced live from Coinbase around the clock. Coins are the only money: everyone starts with 500, you spend coins to buy BTC in Trade and the same coins escrow your duel wagers. Sell and the coins — plus or minus your P/L — land back in your wallet.",
    },
    {
      icon: "swords",
      title: "Duel for the pot",
      body: "Pick a room and escrow your wager; the bot rival matches it, so the pot is a real 2× your wager and the winner takes it. Scores are five parts: Returns 40 · Risk control 25 · Consistency 15 · Activity 10 · Winner bonus 10. A duel needs at least 3 trades on your record to score — under that it voids and refunds you.",
    },
    {
      icon: "trophy",
      title: "Climb the league",
      body: "Wins pay the pot plus +25 MMR; losses cost −15. Light up badges, fill the trophy shelf, and chase Nova at the top of the standings. Duel rooms and cups run 24/7 — the arena never closes.",
    },
  ];
  const s = steps[step]!;
  const last = step === steps.length - 1;
  return (
    <div>
      <div className="purple-card rounded-[var(--radius)] p-6 text-center">
        <span
          className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[var(--accent)] text-[var(--accent-ink)]"
          style={{ boxShadow: "0 0 26px rgba(198,241,53,0.35)" }}
          aria-hidden
        >
          <Icon name={s.icon} size={30} strokeWidth={2} />
        </span>
        <p className="font-display mt-4 text-[26px] leading-tight font-black">
          {s.title}
        </p>
        <p className="mx-auto mt-2 max-w-[320px] text-sm leading-relaxed text-[#d8cff7]">
          {s.body}
        </p>
      </div>
      <div className="mt-4 flex items-center justify-center gap-1.5" aria-hidden>
        {steps.map((x, i) => (
          <span
            key={x.title}
            className="h-2 rounded-full"
            style={{
              width: i === step ? 22 : 8,
              background: i === step ? "var(--accent)" : "var(--surface3)",
            }}
          />
        ))}
      </div>
      <p className="mono mt-2 text-center text-[11px] text-[var(--dim)]">
        Step {step + 1} of {steps.length} — how the league works
      </p>
      <div className="mt-4 flex gap-2">
        {step > 0 ? (
          <button
            type="button"
            className={`${ghostBtn} flex-1 py-3`}
            onClick={() => setStep(step - 1)}
          >
            Back
          </button>
        ) : null}
        {last ? (
          <button
            type="button"
            className="flex-1 rounded-full bg-[var(--accent)] py-3.5 font-display text-sm font-black tracking-wide text-[var(--accent-ink)] uppercase"
            onClick={onDone}
          >
            {doneLabel}
          </button>
        ) : (
          <button
            type="button"
            className="flex-1 rounded-full bg-[var(--accent)] py-3.5 font-display text-sm font-black tracking-wide text-[var(--accent-ink)] uppercase"
            onClick={() => setStep(step + 1)}
          >
            Next
          </button>
        )}
      </div>
    </div>
  );
}

// ---------- professional sign-in buttons ----------
// The store-build sign-in pattern (Google / Apple / email) in its real
// visual style. Honest scope, stated on screen: one-tap Google/Apple
// sign-in activates with the store build; in this edition every button
// continues into the same player-card setup — no OAuth flow is faked
// and no email is collected or claimed.
function AuthButtons({ onContinue }: { onContinue: () => void }) {
  return (
    <div>
      <div className="space-y-2.5">
        <button
          type="button"
          onClick={onContinue}
          className="flex w-full items-center justify-center gap-3 rounded-full bg-white py-3.5 font-display text-[15px] font-extrabold text-[#1f1f1f]"
          aria-label="Continue with Google — continues to player card setup in this edition"
        >
          <svg width="19" height="19" viewBox="0 0 48 48" aria-hidden>
            <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z" />
            <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
            <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
            <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z" />
          </svg>
          Continue with Google
        </button>
        <button
          type="button"
          onClick={onContinue}
          className="flex w-full items-center justify-center gap-3 rounded-full bg-black py-3.5 font-display text-[15px] font-extrabold text-white"
          style={{ boxShadow: "inset 0 0 0 1px var(--border-strong)" }}
          aria-label="Continue with Apple — continues to player card setup in this edition"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M17.05 12.54c-.03-2.89 2.36-4.27 2.47-4.34-1.35-1.97-3.44-2.24-4.18-2.27-1.78-.18-3.47 1.05-4.37 1.05-.9 0-2.29-1.02-3.77-1-1.94.03-3.72 1.13-4.72 2.86-2.01 3.49-.51 8.66 1.45 11.5.96 1.39 2.1 2.94 3.6 2.88 1.45-.06 2-.93 3.74-.93s2.24.93 3.77.9c1.56-.02 2.55-1.41 3.5-2.8 1.1-1.61 1.56-3.17 1.58-3.25-.03-.01-3.04-1.17-3.07-4.6zM14.16 4.06c.8-.97 1.34-2.31 1.19-3.65-1.15.05-2.55.77-3.38 1.73-.74.86-1.39 2.23-1.22 3.55 1.29.1 2.6-.65 3.41-1.63z" />
          </svg>
          Continue with Apple
        </button>
        <button
          type="button"
          onClick={onContinue}
          className="flex w-full items-center justify-center gap-3 rounded-full bg-[var(--surface3)] py-3.5 font-display text-[15px] font-extrabold text-[var(--text)]"
          style={{ boxShadow: "inset 0 0 0 1px var(--border-strong)" }}
          aria-label="Continue with email — continues to player card setup in this edition"
        >
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
            <path d="m4 7 8 6 8-6" />
          </svg>
          Continue with email
        </button>
      </div>
      <p className="mono mt-3 text-center text-[11px] leading-relaxed text-[var(--faint)]">
        One-tap Google &amp; Apple sign-in activates with the store build.
        In this edition these buttons take you straight to player-card
        setup — no email is collected here yet.
      </p>
    </div>
  );
}

// ---------- new-player flow: welcome → sign in / sign up → setup → tour ----------
// What a brand-new player sees on first open, before the tabs exist
// for them. The profile and the starter grant are real server state
// (completeOnboarding); the flow stays up until the stored profile
// says onboarding is done. A failed save keeps everything typed and
// shows the server's answer — nothing pretends to be saved.

function Onboarding({
  data,
  onSetupSaved,
  onFinish,
}: {
  data: State;
  onSetupSaved: (message: string) => void;
  onFinish: () => void;
}) {
  const [step, setStep] = useState<"welcome" | "signin" | "profile" | "tour">(
    "welcome",
  );
  const [handle, setHandle] = useState(data.profile?.handle ?? "");
  const [market, setMarket] = useState(data.profile?.home_market ?? "");
  const [error, setError] = useState("");

  // A truly fresh install has no rows at all: pull the prototype
  // snapshot in once, in the background, so setup lands on a real
  // league (starter wallet and player record).
  const isEmpty =
    data.positions.length === 0 &&
    data.signals.length === 0 &&
    data.milestones.length === 0;
  const importTried = useRef(false);
  useEffect(() => {
    if (isEmpty && !importTried.current) {
      importTried.current = true;
      api.importPrototype({}).catch(() => {
        /* the Home tab keeps its manual import card as the fallback */
      });
    }
  }, [isEmpty]);

  const completeMut = useMutation({
    mutationFn: (args: { handle: string; homeMarket: string }) =>
      api.completeOnboarding(args),
    onSuccess: (r) => {
      if (r.ok) {
        setError("");
        onSetupSaved(r.message);
        setStep("tour");
      } else {
        setError(r.message);
      }
    },
    onError: () =>
      setError(
        "Setup didn't save — check your connection and try again. Everything you typed is still here.",
      ),
  });

  const submitSetup = (e: FormEvent) => {
    e.preventDefault();
    if (handle.trim().length < 2) {
      setError("Pick a handle of at least 2 characters — it's the name on your player card and the standings.");
      return;
    }
    completeMut.mutate({ handle: handle.trim(), homeMarket: market });
  };

  const mmr = data.wallet.mmr;
  const previewInitials = initialsOf(handle.trim() || "You");

  return (
    <div className="min-h-screen bg-black text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <div className="relative mx-auto flex min-h-screen w-full max-w-[430px] flex-col bg-[var(--bg)] sm:border-x sm:border-[var(--border)]">
        <main className="w-full min-w-0 flex-1 px-4 pt-6 pb-10">
          {step === "welcome" ? (
            <div className="tab-enter">
              <div className="flex items-center gap-2">
                <span className="live-dot h-2.5 w-2.5 rounded-full bg-[var(--accent)]" aria-hidden />
                <p className="mono text-[11px] font-bold tracking-[0.18em] text-[var(--accent)] uppercase">
                  Season 1 · Live · 24/7 arena
                </p>
                <span className="mono ml-auto rounded-full bg-[var(--surface2)] px-2 py-0.5 text-[10px] font-bold tracking-wide text-[var(--dim)] uppercase">
                  BTC/USD only
                </span>
              </div>
              <span
                className="mt-8 grid h-20 w-20 place-items-center rounded-full bg-[var(--accent)] text-[var(--accent-ink)]"
                style={{ boxShadow: "0 0 34px rgba(198,241,53,0.4)" }}
                aria-hidden
              >
                <Icon name="swords" size={38} strokeWidth={2} />
              </span>
              <h1 className="font-display mt-5 text-[40px] leading-[0.95] font-black tracking-tight">
                Paper Trading
                <br />
                League
              </h1>
              <p className="mt-3 max-w-[330px] text-[15px] leading-relaxed text-[var(--dim)]">
                1v1 BTC/USD duels and tournaments, scored like a sports
                league. Real market prices, paper money — win coins,
                climb the board, take the trophies.
              </p>
              <div className="hero-wash mt-5 rounded-[var(--radius)] p-4">
                <BtcSparkline />
                <div className="mono mt-3 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-2xl bg-[var(--surface2)] px-1 py-2.5">
                    <p className="font-display text-[15px] font-black">BTC/USD</p>
                    <p className="mt-0.5 text-[9px] font-bold tracking-widest text-[var(--dim)] uppercase">the only market</p>
                  </div>
                  <div className="rounded-2xl bg-[var(--surface2)] px-1 py-2.5">
                    <p className="font-display text-[15px] font-black text-[var(--gold)]">500</p>
                    <p className="mt-0.5 text-[9px] font-bold tracking-widest text-[var(--dim)] uppercase">starter coins</p>
                  </div>
                  <div className="rounded-2xl bg-[var(--surface2)] px-1 py-2.5">
                    <p className="font-display text-[15px] font-black">24/7</p>
                    <p className="mt-0.5 text-[9px] font-bold tracking-widest text-[var(--dim)] uppercase">rooms &amp; cups</p>
                  </div>
                </div>
              </div>
              <div className="mt-6">
                <AuthButtons onContinue={() => setStep("profile")} />
              </div>
              <div className="mt-4 flex items-center gap-3" aria-hidden>
                <span className="h-px flex-1 bg-[var(--border)]" />
                <span className="mono text-[10px] font-bold tracking-widest text-[var(--faint)] uppercase">then build your player card</span>
                <span className="h-px flex-1 bg-[var(--border)]" />
              </div>
              <button
                type="button"
                className="mt-4 w-full rounded-full bg-[var(--accent)] py-4 font-display text-base font-black tracking-wide text-[var(--accent-ink)] uppercase"
                onClick={() => setStep("profile")}
              >
                Create my player card — claim 500 coins
              </button>
              <button
                type="button"
                className="mt-2.5 w-full py-2 text-center text-sm font-bold text-[var(--accent)]"
                onClick={() => setStep("signin")}
              >
                I already play — sign in
              </button>
              <p className="mono mt-4 text-center text-[11px] leading-relaxed text-[var(--faint)]">
                Paper trading only — coins have no cash value, wins pay
                coins and rank, never money. For players 17+.
              </p>
            </div>
          ) : null}

          {step === "signin" ? (
            <div className="tab-enter">
              <button
                type="button"
                className="mono text-xs font-bold text-[var(--dim)]"
                onClick={() => setStep("welcome")}
              >
                ← Back
              </button>
              <h1 className="font-display mt-4 text-[32px] leading-tight font-black">
                Welcome back
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-[var(--dim)]">
                This edition keeps your player card in the app on this
                device — no password to remember, nothing to reset.
                One-tap Google &amp; Apple sign-in activates with the
                store build. Enter the handle on your card and you're in.
              </p>
              <div className="mt-5">
                <AuthButtons onContinue={() => setStep("profile")} />
              </div>
              <form onSubmit={submitSetup} className="mt-5">
                <label htmlFor="signin-handle" className={labelCls}>
                  Your player handle
                </label>
                <input
                  id="signin-handle"
                  className={inputCls}
                  placeholder="e.g. Kass"
                  maxLength={20}
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  autoComplete="nickname"
                />
                {error ? (
                  <p role="alert" className="mono mt-3 rounded-2xl border border-[var(--red)] px-3 py-2.5 text-[13px] text-[var(--red)]">
                    {error}
                  </p>
                ) : null}
                <button
                  type="submit"
                  className="mt-4 w-full rounded-full bg-[var(--accent)] py-4 font-display text-base font-black tracking-wide text-[var(--accent-ink)] uppercase disabled:opacity-40"
                  disabled={completeMut.isPending}
                >
                  {completeMut.isPending ? "Signing in…" : "Sign in"}
                </button>
              </form>
              <button
                type="button"
                className="mt-4 w-full text-center text-sm font-bold text-[var(--accent)]"
                onClick={() => setStep("profile")}
              >
                New here? Create your player card instead
              </button>
            </div>
          ) : null}

          {step === "profile" ? (
            <div className="tab-enter">
              <button
                type="button"
                className="mono text-xs font-bold text-[var(--dim)]"
                onClick={() => setStep("welcome")}
              >
                ← Back
              </button>
              <p className="mono mt-4 text-[11px] font-bold tracking-[0.18em] text-[var(--accent)] uppercase">
                Step 2 of 3 · Player card
              </p>
              <h1 className="font-display mt-1.5 text-[32px] leading-tight font-black">
                Build your player card
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-[var(--dim)]">
                This is the identity the league sees — on the standings,
                in the duel room, on your trophy shelf.
              </p>

              {/* Live card preview — real MMR/level, handle as typed */}
              <div className="glow-teal mt-5 rounded-[var(--radius)] bg-[var(--surface)] p-5">
                <div className="flex items-center gap-3.5">
                  <AvatarDisc initials={previewInitials} size={58} accent fontSize={20} />
                  <div className="min-w-0 flex-1">
                    <p className="font-display break-words text-xl leading-tight font-black">
                      {handle.trim() || "Your handle"}
                    </p>
                    <p className="mono mt-0.5 text-[11px] text-[var(--dim)]">
                      {tierOf(mmr)} tier · Level {levelOf(mmr)} · MMR {mmr}
                      {market ? ` · ${market}` : ""}
                    </p>
                  </div>
                  <span className="mono flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--surface2)] px-3 py-1.5 text-sm font-bold" style={{ boxShadow: "inset 0 0 0 1px var(--border)" }}>
                    <Icon name="coin" size={15} className="text-[var(--gold)]" />
                    {data.wallet.balance.toLocaleString()}
                  </span>
                </div>
              </div>

              <form onSubmit={submitSetup} className="mt-5">
                <label htmlFor="setup-handle" className={labelCls}>
                  Player handle
                </label>
                <input
                  id="setup-handle"
                  className={inputCls}
                  placeholder="e.g. Kass"
                  maxLength={20}
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  autoComplete="nickname"
                />
                <p className="mt-1.5 text-xs text-[var(--faint)]">
                  2–20 characters — letters, numbers, spaces, dots, dashes.
                </p>
                <label htmlFor="setup-market" className={`${labelCls} mt-4`}>
                  Home market (optional)
                </label>
                <select
                  id="setup-market"
                  className={inputCls}
                  value={market}
                  onChange={(e) => setMarket(e.target.value)}
                >
                  <option value="">Pick your home market…</option>
                  {HOME_MARKETS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>

                <div className="gold-wash mt-5 rounded-[var(--radius)] p-4">
                  <p className="font-display flex items-center gap-2 font-extrabold">
                    <Icon name="coin" size={18} className="text-[var(--gold)]" />
                    500 starter coins — free on signup
                  </p>
                  <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
                    League rules: every new player starts
                    with 500 coins. Stake them on duel entries — win a
                    room and the 2× pot lands here. Coins are the
                    league's score-keeping currency; they have no cash
                    value.
                  </p>
                </div>

                {error ? (
                  <p role="alert" className="mono mt-4 rounded-2xl border border-[var(--red)] px-3 py-2.5 text-[13px] text-[var(--red)]">
                    {error}
                  </p>
                ) : null}
                <button
                  type="submit"
                  className="mt-4 w-full rounded-full bg-[var(--accent)] py-4 font-display text-base font-black tracking-wide text-[var(--accent-ink)] uppercase disabled:opacity-40"
                  disabled={completeMut.isPending}
                >
                  {completeMut.isPending
                    ? "Setting up…"
                    : "Claim starter coins & play"}
                </button>
              </form>
            </div>
          ) : null}

          {step === "tour" ? (
            <div className="tab-enter">
              <p className="mono text-[11px] font-bold tracking-[0.18em] text-[var(--accent)] uppercase">
                Step 3 of 3 · The quick tour
              </p>
              <h1 className="font-display mt-1.5 mb-4 text-[32px] leading-tight font-black">
                You're in{handle.trim() ? `, ${handle.trim()}` : ""}
              </h1>
              <HowItWorks onDone={onFinish} doneLabel="Enter League HQ" />
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}

// ---------- rookie checklist (Home, until the first loop is done) ----------
// The guided first session after landing on Home: every step is the
// player's real record, and the card removes itself once the loop —
// claim, trade, duel, finish — has actually been played.

function RookieChecklist({
  hasStarter,
  btcTrades,
  duelsCreated,
  duelsFinished,
  go,
  onClaim,
}: {
  hasStarter: boolean;
  btcTrades: number;
  duelsCreated: number;
  duelsFinished: number;
  go: (t: TabKey) => void;
  onClaim: () => void;
}) {
  const steps: Array<{
    label: string;
    detail: string;
    done: boolean;
    cta: string;
    action: () => void;
  }> = [
    {
      label: "Claim your 500 starter coins",
      detail: "Your entry money for duel rooms — free, once.",
      done: hasStarter,
      cta: "Claim",
      action: onClaim,
    },
    {
      label: `Record 3 BTC/USD trades (${Math.min(btcTrades, 3)}/3)`,
      detail: "Duels only score once 3 trades are on your record.",
      done: btcTrades >= 3,
      cta: "Trade",
      action: () => go("trade"),
    },
    {
      label: "Enter your first duel room",
      detail: "Pick a stakes tier, name a bot rival, escrow your wager.",
      done: duelsCreated > 0,
      cta: "Battle",
      action: () => go("battle"),
    },
    {
      label: "Finish a duel and get scored",
      detail: "Auto-score reads your real BTC book — highest score takes the pot.",
      done: duelsFinished > 0,
      cta: "Battle",
      action: () => go("battle"),
    },
  ];
  if (steps.every((s) => s.done)) return null;
  const doneCount = steps.filter((s) => s.done).length;
  return (
    <section className="mt-4">
      <div className={`${cardCls} elev p-4`} style={{ borderColor: "var(--gold-deep)" }}>
        <p className="font-display flex items-center gap-2 font-extrabold">
          <Icon name="flame" size={18} className="text-[var(--gold)]" />
          Rookie checklist
          <span className="mono ml-auto text-xs font-bold text-[var(--dim)]">
            {doneCount}/{steps.length}
          </span>
        </p>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--surface2)]">
          <div
            className="bar-anim h-full rounded-full"
            style={{ width: `${(doneCount / steps.length) * 100}%`, background: "var(--gold)" }}
          />
        </div>
        <div className="mt-3 space-y-2">
          {steps.map((s) => (
            <div key={s.label} className="flex items-center gap-3">
              <span
                className="grid h-7 w-7 shrink-0 place-items-center rounded-full"
                style={{
                  background: s.done ? "var(--gold)" : "var(--surface2)",
                  color: s.done ? "var(--accent-ink)" : "var(--faint)",
                  boxShadow: "inset 0 0 0 1px var(--border)",
                }}
                aria-hidden
              >
                <Icon name={s.done ? "check" : "lock"} size={13} strokeWidth={2.4} />
              </span>
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-bold ${s.done ? "text-[var(--dim)] line-through" : ""}`}>
                  {s.label}
                </p>
                <p className="break-words text-xs text-[var(--dim)]">{s.detail}</p>
              </div>
              {!s.done ? (
                <button
                  type="button"
                  className="shrink-0 rounded-full bg-[var(--accent)] px-3.5 py-2 font-display text-xs font-black tracking-wide text-[var(--accent-ink)] uppercase"
                  onClick={s.action}
                  aria-label={`${s.cta}: ${s.label}`}
                >
                  {s.cta}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------- player settings (Profile) ----------
// The stored player card, editable after setup, plus the welcome-tour
// replay. A rejected save keeps the typed values and surfaces the
// server's answer in the app feedback line.

function SettingsSection({
  profile,
  setFeedback,
  refresh,
  onReplayTour,
}: {
  profile: State["profile"];
  setFeedback: (s: string) => void;
  refresh: () => void;
  onReplayTour: () => void;
}) {
  const [handle, setHandle] = useState(profile?.handle ?? "");
  const [market, setMarket] = useState(profile?.home_market ?? "");
  // If the stored profile changes underneath (e.g. setup finished in
  // another view), adopt it only while the form is untouched.
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty && profile) {
      setHandle(profile.handle);
      setMarket(profile.home_market);
    }
  }, [profile, dirty]);

  const saveMut = useMutation({
    mutationFn: (args: { handle: string; homeMarket: string }) =>
      api.updateProfile(args),
    onSuccess: (r) => {
      setFeedback(r.message);
      if (r.ok) {
        setDirty(false);
        refresh();
      }
    },
    onError: () =>
      setFeedback("Player card didn't save — your typed values are still in the form; try again."),
  });

  const onSave = (e: FormEvent) => {
    e.preventDefault();
    if (handle.trim().length < 2) {
      setFeedback("Handle needs at least 2 characters.");
      return;
    }
    saveMut.mutate({ handle: handle.trim(), homeMarket: market });
  };

  return (
    <section className="mt-5">
      <SectionTitle right="stored on your player card">Player settings</SectionTitle>
      <form onSubmit={onSave} className={`${cardCls} p-4`}>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="settings-handle" className={labelCls}>
              Player handle
            </label>
            <input
              id="settings-handle"
              className={inputCls}
              maxLength={20}
              value={handle}
              onChange={(e) => {
                setHandle(e.target.value);
                setDirty(true);
              }}
              autoComplete="nickname"
            />
          </div>
          <div>
            <label htmlFor="settings-market" className={labelCls}>
              Home market
            </label>
            <select
              id="settings-market"
              className={inputCls}
              value={market}
              onChange={(e) => {
                setMarket(e.target.value);
                setDirty(true);
              }}
            >
              <option value="">Not set</option>
              {HOME_MARKETS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="mt-2 text-xs text-[var(--dim)]">
          Signed in as {profile?.handle ? profile.handle : "—"} · this edition keeps your
          player card in the app on this device; Google sign-in ships with the mobile build.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="submit"
            className={primaryBtn}
            disabled={saveMut.isPending || !dirty}
          >
            {saveMut.isPending ? "Saving…" : "Save player card"}
          </button>
          <button type="button" className={ghostBtn} onClick={onReplayTour}>
            Replay the welcome tour
          </button>
        </div>
      </form>
    </section>
  );
}

// ---------- main app ----------

type TabKey = "home" | "battle" | "trade" | "league" | "more";

export function App() {
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<string>("");
  // Spring-in toast for success confirmations (trades, duel finishes);
  // errors keep using the persistent feedback line above the tabs.
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const showToast = (message: string) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), message });
    toastTimer.current = window.setTimeout(() => setToast(null), 4200);
  };
  // The app bar condenses (shorter, blurred) once the player scrolls.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  // Mobile-app shell: exactly one tab screen is shown at a time, like
  // a phone app — no long dashboard scroll.
  const [tab, setTab] = useState<TabKey>("home");
  const [challengeReq, setChallengeReq] = useState<{
    name: string;
    nonce: number;
  } | null>(null);
  const [wagerReq, setWagerReq] = useState<{ wager: number; nonce: number } | null>(null);
  // New-player flow: shown until the stored profile says onboarding
  // is done. flowDone dismisses it the moment the tour's last button
  // is tapped (the refetch then confirms from the record).
  const [flowDone, setFlowDone] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  // Whether the stored profile was already onboarded when this
  // session first loaded — snapshotted once, so finishing setup
  // mid-flow doesn't yank the player out before the tour step.
  const startedOnboarded = useRef<boolean | null>(null);

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

  const importMut = useMutation({
    mutationFn: () => api.importPrototype({}),
    onSuccess: (r) => {
      setFeedback(r.message);
      refresh();
    },
  });

  if (state.isPending) {
    // Skeleton at the Home layout's exact dimensions — no blank flash,
    // no layout jump when the real state lands.
    return (
      <div className="min-h-screen bg-[var(--bg)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <main className="mx-auto w-full max-w-[430px] px-4 pt-4" role="status" aria-label="Loading the league">
          <div className="flex items-center gap-2.5">
            <div className="skeleton h-[38px] w-[38px] rounded-full" />
            <div className="flex-1">
              <div className="skeleton h-3.5 w-32 rounded-full" />
              <div className="skeleton mt-1.5 h-3 w-24 rounded-full" />
            </div>
            <div className="skeleton h-8 w-20 rounded-full" />
          </div>
          <div className="skeleton mt-4 h-56 rounded-[var(--radius)]" />
          <div className="skeleton mt-4 h-24 rounded-[var(--radius)]" />
          <div className="skeleton mt-4 h-40 rounded-[var(--radius)]" />
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

  // The player's identity comes from the stored player card; until
  // setup completes, the new-player flow owns the screen.
  const displayName = data.profile?.handle?.trim() ? data.profile.handle : "Kass";
  const myInitials = initialsOf(displayName);
  if (startedOnboarded.current === null) {
    startedOnboarded.current = data.profile?.onboarded ?? false;
  }
  const onboarded = startedOnboarded.current || flowDone;

  if (!onboarded) {
    return (
      <Onboarding
        data={data}
        onSetupSaved={(msg) => {
          setFeedback(msg);
          refresh();
        }}
        onFinish={() => setFlowDone(true)}
      />
    );
  }

  // One-money bankroll (coins only): free coins in the wallet plus the
  // current coin value of the open BTC position. 1 coin of position
  // value = qty x BTC price in dollars, numerically — the BTC market
  // price itself stays in dollars (market data), everything the
  // player OWNS is counted in coins.
  const btcPosition = data.positions.find(
    (p) => p.symbol.toUpperCase() === "BTC",
  );
  const inBtcCoins = btcPosition
    ? btcPosition.qty * btcPosition.current_price
    : 0;
  const coinsIn = btcPosition ? btcPosition.qty * btcPosition.avg_cost : 0;
  const posPlCoins = inBtcCoins - coinsIn;
  const posPlPct = coinsIn > 0 ? (posPlCoins / coinsIn) * 100 : 0;
  const bankrollCoins = data.wallet.balance + inBtcCoins;
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
  // The rookie loop is done when every checklist step is earned;
  // Home then swaps the checklist for the Featured Rooms block, so
  // the screen always carries exactly one of the two.
  const hasStarterGrant = data.walletTxns.some(
    (t) => t.type === "starter_grant",
  );
  const rookieDone =
    hasStarterGrant &&
    btcTrades >= 3 &&
    data.duels.length > 0 &&
    completedDuels > 0;
  const badges = badgesOf({
    wins: duelWins,
    completed: completedDuels,
    winRate,
    btcTrades,
    balance: data.wallet.balance,
    mmr: data.wallet.mmr,
  });

  return (
    <div className="min-h-screen bg-black text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      {/* Phone column: full-bleed on a phone; on wider screens it sits
          centered at phone width like the app it previews. */}
      <div className="relative mx-auto flex min-h-screen w-full max-w-[430px] flex-col bg-[var(--bg)] sm:border-x sm:border-[var(--border)]">
        {/* ===== APP BAR — condenses with a blur backdrop on scroll ===== */}
        <header
          className="sticky top-0 z-30 border-b border-[var(--border)]"
          style={{
            background: scrolled ? "rgba(5,5,7,0.82)" : "var(--bg)",
            backdropFilter: scrolled ? "blur(14px)" : "none",
            WebkitBackdropFilter: scrolled ? "blur(14px)" : "none",
            transition: "background-color 220ms ease",
          }}
        >
          <div
            className="flex items-center gap-2.5 px-4"
            style={{ height: scrolled ? 46 : 56, transition: "height 220ms cubic-bezier(0.32,0.72,0,1)" }}
          >
            <span style={{ transform: scrolled ? "scale(0.88)" : "scale(1)", transition: "transform 220ms cubic-bezier(0.32,0.72,0,1)" }}>
              <AvatarDisc initials={myInitials} size={38} accent fontSize={15} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-display break-words text-[15px] leading-tight font-extrabold tracking-tight">
                {displayName}
              </p>
              <p className="mono break-words text-[11px] leading-tight text-[var(--dim)]">
                {tier} · Level {level} · MMR {data.wallet.mmr}
              </p>
            </div>
            <span className="mono flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--surface2)] px-3 py-1.5 text-sm font-bold" style={{ boxShadow: "inset 0 0 0 1px var(--border)" }}>
              <Icon name="coin" size={15} className="text-[var(--gold)]" />
              <AnimatedNumber value={data.wallet.balance} format={(n) => Math.round(n).toLocaleString()} />
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

          <div key={tab} className="tab-enter stagger-in">
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
                  Your bankroll
                </p>
                <h1 className="mono mt-1 text-[42px] leading-none font-bold tracking-tight">
                  <AnimatedNumber value={Math.round(bankrollCoins)} format={(n) => Math.round(n).toLocaleString()} /> <span className="text-[22px] text-[var(--gold)]">coins</span>
                </h1>
                <p className="mono mt-2 text-[13px] font-semibold text-[var(--dim)]">
                  {data.wallet.balance.toLocaleString()} free · {Math.round(inBtcCoins).toLocaleString()} in BTC · started at 500
                </p>
                {btcPosition ? (
                  <p
                    className="mono mt-1 text-[13px] font-semibold"
                    style={{ color: posPlCoins >= 0 ? "var(--gain)" : "var(--loss)" }}
                  >
                    {posPlCoins >= 0 ? "+" : "−"}{Math.abs(Math.round(posPlCoins)).toLocaleString()} coins ({posPlPct >= 0 ? "+" : ""}{posPlPct.toFixed(1)}%) on your BTC position
                  </p>
                ) : (
                  <p className="mono mt-1 text-[13px] font-semibold text-[var(--dim)]">
                    No BTC position yet — spend coins in Trade to open one
                  </p>
                )}
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
                <CoinSparkline data={data} bankrollCoins={bankrollCoins} />
              </div>

              {rookieDone ? (
                <FeaturedRooms onChallenge={challengeRival} />
              ) : (
                <RookieChecklist
                  hasStarter={hasStarterGrant}
                  btcTrades={btcTrades}
                  duelsCreated={data.duels.length}
                  duelsFinished={completedDuels}
                  go={go}
                  onClaim={() =>
                    api
                      .completeOnboarding({
                        handle: displayName,
                        homeMarket: data.profile?.home_market ?? "",
                      })
                      .then((r) => {
                        setFeedback(r.message);
                        refresh();
                      })
                  }
                />
              )}

              {isEmpty ? (
                <div className="mt-4 rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--surface)] p-4">
                  <p className="font-display font-bold">Set up the league</p>
                  <p className="mt-1 text-sm text-[var(--dim)]">
                    Load the league's starting state — the 500-coin starter
                    wallet and your player record. Your book starts clean:
                    500 coins, 0 BTC, and you open your first position by
                    spending coins in Trade.
                  </p>
                  <button
                    type="button"
                    className={`${primaryBtn} mt-3 w-full`}
                    disabled={importMut.isPending}
                    onClick={() => importMut.mutate()}
                  >
                    {importMut.isPending ? "Setting up…" : "Set up the league"}
                  </button>
                </div>
              ) : null}

              <ActivityFeed data={data} />
            </>
          ) : null}

          {/* ===== BATTLE TAB — TOURNAMENT LOBBY + LIVE ROOM ===== */}
          {tab === "battle" ? (
            <>
              <BattleScreen
                duels={data.duels}
                trades={btcTrades}
                positions={data.positions}
                setFeedback={setFeedback}
                showToast={showToast}
                refresh={refresh}
                youInitials={myInitials}
              />
              <RoomPicker onPick={pickTier} />
              <DuelsSection
                duels={data.duels}
                balance={data.wallet.balance}
                setFeedback={setFeedback}
                showToast={showToast}
                refresh={refresh}
                challengeReq={challengeReq}
                wagerReq={wagerReq}
              />
              <HowDuelsWork />
            </>
          ) : null}

          {/* ===== TRADE TAB — TRADING ROOM ===== */}
          {tab === "trade" ? (
            <PortfolioSection
              positions={data.positions}
              trades={data.trades}
              balance={data.wallet.balance}
              setFeedback={setFeedback}
              showToast={showToast}
              refresh={refresh}
            />
          ) : null}

          {/* ===== LEAGUE TAB — STANDINGS ===== */}
          {tab === "league" ? (
            <>
              <LeagueSection wins={duelWins} losses={duelLosses} mmr={data.wallet.mmr} duels={data.duels} winRate={winRate} btcTrades={btcTrades} youInitials={myInitials} />
              <TrophyShelf wins={duelWins} badges={badges} />
              <GameCharts
                positions={data.positions}
                txns={data.walletTxns}
                wins={duelWins}
                losses={duelLosses}
              />
            </>
          ) : null}

          {/* ===== PROFILE TAB — PLAYER CARD, SETTINGS, WALLET ===== */}
          {tab === "more" ? (
            <>
              <PlayerCard
                name={displayName}
                initials={myInitials}
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
              <SettingsSection
                profile={data.profile}
                setFeedback={setFeedback}
                refresh={refresh}
                onReplayTour={() => setTourOpen(true)}
              />
              <WalletSection txns={data.walletTxns} />
            </>
          ) : null}
          </div>
        </main>

        {/* ===== WELCOME-TOUR REPLAY OVERLAY ===== */}
        {tourOpen ? (
          <div className="absolute inset-0 z-40 overflow-y-auto bg-[var(--bg)] px-4 pt-6 pb-10">
            <HowItWorks onDone={() => setTourOpen(false)} doneLabel="Back to the game" />
          </div>
        ) : null}

        {/* ===== SUCCESS TOAST — spring-in, auto-dismiss, errors never land here ===== */}
        {toast ? (
          <div
            key={toast.id}
            role="status"
            className="toast-in fixed bottom-24 left-1/2 z-50 flex w-[min(398px,calc(100vw-32px))] items-center gap-2.5 rounded-full bg-[var(--surface3)] py-3 pr-5 pl-3"
            style={{ boxShadow: "0 0 0 1px var(--border-strong), var(--shadow-pop)" }}
          >
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-[var(--accent-ink)]" aria-hidden>
              <Icon name="check" size={15} strokeWidth={2.6} />
            </span>
            <p className="min-w-0 flex-1 text-sm leading-snug font-semibold break-words">{toast.message}</p>
            <button
              type="button"
              className="shrink-0 rounded-full p-1 text-[var(--dim)]"
              onClick={() => setToast(null)}
              aria-label="Dismiss notification"
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        ) : null}

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

// ---------- how duels work (Battle, collapsible) ----------
// The old full rules card, shrunk to a one-line strip: tap to open
// the scoring weights (the exact blueprint §6 weights the server
// scores with), the escrow/pot math, and the house rules. The score
// formula line folded in here is the one useful line from the old
// Score Lab, which no longer sits on the player surface.

function HowDuelsWork() {
  const [open, setOpen] = useState(false);
  const weights = [
    { key: "R", label: "Returns", w: 40 },
    { key: "K", label: "Risk control", w: 25 },
    { key: "C", label: "Consistency", w: 15 },
    { key: "A", label: "Activity", w: 10 },
    { key: "B", label: "Badge bonus", w: 10 },
  ];
  return (
    <section className="mt-5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`${cardCls} flex w-full items-center gap-2 px-4 py-3.5 text-left`}
      >
        <Icon name="shield" size={18} className="shrink-0 text-[var(--accent)]" />
        <span className="font-display text-sm font-extrabold">How duels work</span>
        <span className="mono ml-auto text-[11px] text-[var(--dim)]">scoring · escrow · pot</span>
        <span
          className="shrink-0 text-[var(--dim)] transition-transform"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
          aria-hidden
        >
          <Icon name="chevron" size={15} />
        </span>
      </button>
      {open ? (
        <div className={`${cardCls} mt-2 p-4`}>
          <p className="text-sm text-[var(--dim)]">
            Your score comes from your real BTC/USD book — five components, weighted.
            Nothing else counts.
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
              </div>
            ))}
          </div>
          <p className="mono mt-3 text-[11px] leading-relaxed text-[var(--dim)]">
            Score = 0.40·R + 0.25·K + 0.15·C + 0.10·A + 0.10·B — the exact
            weights the server scores live duels with.
          </p>
          <ul className="mono mt-2 space-y-1 text-[11px] leading-relaxed text-[var(--dim)]">
            <li>· Escrow: your wager leaves your wallet when you create the room; the bot rival matches it on accept. Pot = 2× wager, winner takes all.</li>
            <li>· A duel needs at least 3 trades on your record to auto-score — under 3, it voids and your wager is refunded. Risk control (K) is halved under 3 trades.</li>
            <li>· House rules: max 5 duels and 60 trades per hour, and a 24h rematch cooldown against the same rival after a finished duel.</li>
          </ul>
        </div>
      ) : null}
    </section>
  );
}



// ---------- live battle room (VS screen) ----------

function BattleScreen({ duels, trades, positions, setFeedback, showToast, refresh, youInitials }: {
  duels: State["duels"];
  trades: number;
  positions: State["positions"];
  setFeedback: (s: string) => void;
  showToast: (s: string) => void;
  refresh: () => void;
  youInitials: string;
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
      <SectionTitle right="refreshes every 15s">Live room</SectionTitle>
      {!featured ? (
        <div className={`${cardCls} flex items-center gap-3 px-4 py-3.5`}>
          <Icon name="swords" size={20} className="shrink-0 text-[var(--dim)]" />
          <p className="text-sm text-[var(--dim)]">
            <span className="font-display font-bold text-[var(--text)]">No duel live.</span>{" "}
            Pick a room below — when a duel is open or live, it takes over this spot.
          </p>
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
            <div key={featured.id} className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-4">
              <div className="vs-you min-w-0 text-center">
                <span className="flex justify-center"><AvatarDisc initials={youInitials} size={56} accent fontSize={19} /></span>
                <p className="font-display mt-1 break-words font-black">YOU</p>
                <p className="mono text-xs text-[var(--dim)]">{trades} trades · {retPct >= 0 ? "+" : ""}{retPct.toFixed(1)}% P/L</p>
                <p className="mono font-display mt-1 text-4xl font-black text-[var(--accent)]"><ScoreCountUp value={featured.your_score != null ? featured.your_score : preview.total} /></p>
                <p className="mono text-[11px] text-[var(--dim)]">{featured.your_score != null ? "final score" : "live projected score"}</p>
              </div>
              <div className="vs-pop text-center">
                <p className="font-display text-3xl font-black sm:text-4xl">VS</p>
              </div>
              <div className="vs-opp min-w-0 text-center">
                <span className="flex justify-center"><AvatarDisc initials={RIVALS.find((r) => r.name === featured.opponent)?.initials ?? "BOT"} size={56} fontSize={16} /></span>
                <p className="font-display mt-1 break-words font-black">{featured.opponent.toUpperCase()}</p>
                <p className="mono text-xs text-[var(--dim)]">bot rival</p>
                <p className="mono font-display mt-1 text-4xl font-black" style={{ color: "var(--red)" }}>{featured.opp_score != null ? <ScoreCountUp value={featured.opp_score} /> : "?"}</p>
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
              <p className="mono mt-3 text-xs text-[var(--dim)]">Your {featured.wager} coins are escrowed. When {featured.opponent} (bot rival) accepts, it matches {featured.wager} coins on the game side — never from your wallet — and the battle goes live.</p>
            ) : null}
            {featured.status === "open" || featured.status === "active" ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {featured.status === "open" ? (
                  <button type="button" className={primaryBtn} onClick={() => api.startDuel({ id: featured.id }).then((r) => { setFeedback(r.message); refresh(); })}>{featured.opponent} (bot) accepts &amp; matches escrow</button>
                ) : null}
                <button type="button" className={`${primaryBtn} inline-flex items-center gap-1.5`} onClick={() => api.autoCompleteDuel({ id: featured.id }).then((r) => { if (r.ok) showToast(r.message); else setFeedback(r.message); refresh(); })}><Icon name="bolt" size={15} strokeWidth={2} /> Auto-score &amp; finish</button>
                <button type="button" className={ghostBtn} onClick={() => api.voidDuel({ id: featured.id }).then((r) => { setFeedback(r.message); refresh(); })}>Void (refund)</button>
              </div>
            ) : featured.status === "completed" ? (
              <p className="mono mt-3 text-sm font-semibold" style={{ color: featured.winner === "you" ? "var(--gold)" : "var(--red)" }}>
                {featured.winner === "you" ? `Victory — you took the ${featured.wager * 2}-coin pot.` : `Defeat — ${featured.opponent} took the pot. Rematch from the rooms below.`}
              </p>
            ) : (
              <p className="mono mt-3 text-sm text-[var(--dim)]">This duel was voided and the wager refunded.</p>
            )}
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
    <section className="mt-5">
      <SectionTitle right="your real numbers, drawn simple">Season stats</SectionTitle>
      <div className="grid gap-4">
        <div className={`min-w-0 ${cardCls} p-4`}>
          <p className="font-display flex items-center gap-2 font-bold"><Icon name="layers" size={17} className="text-[var(--accent)]" /> Bankroll mix — in coins</p>
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
                    <span className="mono">{Math.round(p.qty * p.current_price).toLocaleString()} coins · {total > 0 ? ((p.qty * p.current_price / total) * 100).toFixed(0) : 0}%</span>
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

function LeagueSection({ wins, losses, mmr, duels, winRate, btcTrades, youInitials }: {
  wins: number;
  losses: number;
  mmr: number;
  duels: State["duels"];
  winRate: number;
  btcTrades: number;
  youInitials: string;
}) {
  const rows = [
    ...RIVALS.map((r) => ({ name: r.name, initials: r.initials, mmr: r.mmr, w: Math.round(r.winRate / 4), l: Math.round((100 - r.winRate) / 4), winRate: r.winRate, you: false })),
    { name: "You", initials: youInitials, mmr, w: wins, l: losses, winRate, you: true },
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
        You're #{yourRank} of {rows.length} in this room. Your row is live from your real duels ({completed} completed). Rival rows are the game's bot league cards — in the shipped app these become real players.
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
                key={`${r.name}-${compareName === r.name}`}
                type="button"
                aria-pressed={compareName === r.name}
                onClick={() => setCompareName(r.name)}
                className={`rounded-full px-3 py-1.5 text-xs font-bold ${compareName === r.name ? "chip-pop" : ""}`}
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

// ---------- trading room: coin trading, market chart, position ----------
// One-money system: coins are the only money. Buys spend whole coins
// from the wallet at the live Coinbase price; sells close a coin-value
// slice of the position and credit coins back. The old prototype
// "Your book" table (manual price edits, legacy ETH/KAS rows) is gone
// for good — the purple position card below is THE position display.

function PortfolioSection({
  positions,
  trades,
  balance,
  setFeedback,
  showToast,
  refresh,
}: {
  positions: State["positions"];
  trades: State["trades"];
  balance: number;
  setFeedback: (s: string) => void;
  showToast: (s: string) => void;
  refresh: () => void;
}) {
  // While the chart is being scrubbed, the big price readout shows
  // the scrubbed candle in place; on release it restores to live.
  const [scrubCandle, setScrubCandle] = useState<Candle | null>(null);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [coinPick, setCoinPick] = useState<number>(50);
  const [customCoins, setCustomCoins] = useState("");
  const [range, setRange] = useState<CandleRange>("24H");
  const [chartType, setChartType] = useState<ChartType>("candles");
  const [showEma, setShowEma] = useState(true);
  const [showRsi, setShowRsi] = useState(true);
  const [showMacd, setShowMacd] = useState(true);
  const candlesQ = useCandles(range);
  const candles: Candle[] = candlesQ.data?.ok ? candlesQ.data.candles : [];

  const btcPos = positions.find((p) => p.symbol.toUpperCase() === "BTC");
  const lastC = candles[candles.length - 1];
  const livePrice = lastC?.close ?? btcPos?.current_price;
  const posValueCoins = btcPos && livePrice ? btcPos.qty * livePrice : 0;
  const posCoinsIn = btcPos ? btcPos.qty * btcPos.avg_cost : 0;
  const posPl = posValueCoins - posCoinsIn;
  const posPlPct = posCoinsIn > 0 ? (posPl / posCoinsIn) * 100 : 0;

  const customNum = Number(customCoins);
  const coinAmount = customCoins.trim() !== "" && Number.isFinite(customNum) && customNum > 0
    ? Math.floor(customNum)
    : coinPick;
  const maxBuy = balance;
  const maxSell = Math.floor(posValueCoins);
  const effectiveCoins = side === "buy"
    ? Math.min(coinAmount, Math.max(maxBuy, 0))
    : Math.min(coinAmount, Math.max(maxSell, 0));
  const estBtc = livePrice && effectiveCoins > 0 ? effectiveCoins / livePrice : 0;

  const buyMut = useMutation({
    mutationFn: (coins: number) => api.buyBtcWithCoins({ coins }),
    onSuccess: (r) => {
      // Success confirms with a spring-in toast (Details.so pattern);
      // failures stay on the persistent feedback line, never a toast.
      if (r.ok) {
        showToast(r.message);
        setCustomCoins("");
      } else {
        setFeedback(r.message);
      }
      refresh();
    },
    onError: () => setFeedback("Buy didn't go through — no coins were spent. Try again."),
  });
  const sellMut = useMutation({
    mutationFn: (args: { coins?: number; closeAll: boolean }) => api.sellBtcForCoins(args),
    onSuccess: (r) => {
      if (r.ok) {
        showToast(r.message);
        setCustomCoins("");
      } else {
        setFeedback(r.message);
      }
      refresh();
    },
    onError: () => setFeedback("Sell didn't go through — your position is unchanged. Try again."),
  });
  const livePriceMut = useMutation({
    mutationFn: () => api.refreshPrices({}),
    onSuccess: (r) => {
      setFeedback(r.message);
      if (r.ok) refresh();
    },
    onError: () =>
      setFeedback("Live price refresh failed — prices left unchanged (last known price stands)."),
  });

  const onExecute = () => {
    if (side === "buy") {
      if (!(coinAmount > 0)) { setFeedback("Pick how many coins to spend — tap a chip or type an amount."); return; }
      if (coinAmount > balance) { setFeedback(`You only have ${balance} free coins — coins in BTC or escrowed in a duel can't be spent twice.`); return; }
      buyMut.mutate(coinAmount);
    } else {
      if (!btcPos) { setFeedback("No BTC position to sell yet — buy with coins first."); return; }
      if (!(coinAmount > 0)) { setFeedback("Pick how many coins' worth of BTC to sell."); return; }
      if (coinAmount > posValueCoins + 1e-9) { setFeedback(`Your BTC position is only worth ${maxSell} coins right now — pick less, or Close all.`); return; }
      sellMut.mutate({ coins: coinAmount, closeAll: false });
    }
  };

  const firstC = candles[0];
  const chg = firstC && lastC && firstC.open > 0 ? ((lastC.close - firstC.open) / firstC.open) * 100 : null;
  const hi = candles.length ? Math.max(...candles.map((c) => c.high)) : null;
  const lo = candles.length ? Math.min(...candles.map((c) => c.low)) : null;
  const vol = candles.length ? candles.reduce((s, c) => s + c.volume, 0) : null;
  const scrollToTicket = (s: "buy" | "sell") => {
    setSide(s);
    document.getElementById("trade-ticket")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const chips = [10, 25, 50, 100];

  return (
    <section>
      <SectionTitle right="BTC/USD only · live from Coinbase">
        Chart
      </SectionTitle>

      <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 elev">
        <div className="flex items-center gap-2">
          <p className="font-display text-base font-black">BTC · Crypto</p>
          <span className="mono rounded-full bg-[var(--accent)] px-2 py-0.5 text-[10px] font-bold tracking-wide text-[var(--accent-ink)] uppercase">sole market</span>
          <span className="ml-auto flex items-center gap-1.5">
            <span className="live-dot h-2 w-2 rounded-full bg-[var(--accent)]" aria-hidden />
            <span className="mono text-[10px] font-bold tracking-widest text-[var(--accent)] uppercase">Live</span>
          </span>
        </div>
        <p className="mono mt-2 text-[46px] leading-none font-bold tracking-tight" aria-live="off">
          {scrubCandle ? `$${fmtPrice(scrubCandle.close)}` : livePrice ? `$${fmtPrice(livePrice)}` : "—"}
        </p>
        <p className="mono mt-1.5 text-sm font-semibold" style={{ color: chg != null && chg < 0 ? "var(--red)" : "var(--accent)" }}>
          {scrubCandle ? (
            <>Scrubbing · {fmtDetroitTime(scrubCandle.t)} ET</>
          ) : (
            <>
              {chg != null ? `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}% · ${range}` : "—"}
              <span className="ml-2 text-[11px] font-normal text-[var(--dim)]">Coinbase · free public API</span>
            </>
          )}
        </p>

        {/* Chart-type switch — sliding pill (Bencho) */}
        <div className="mt-3">
          <SlidingSegmented<ChartType>
            options={[["candles", "Candles"], ["line", "Line"], ["heikin", "Heikin-Ashi"]]}
            value={chartType}
            onChange={setChartType}
            ariaLabel="Chart type"
            pillFor={() => "var(--accent)"}
            textFor={() => "var(--accent-ink)"}
          />
        </div>
        {/* Indicator toggles — exactly 3, all from the real candles */}
        <div className="mt-2 flex items-center gap-1.5" role="group" aria-label="Chart indicators">
          <span className="mono mr-0.5 text-[10px] font-bold tracking-widest text-[var(--dim)] uppercase">Indicators</span>
          {([
            ["EMA 20", showEma, setShowEma],
            ["RSI", showRsi, setShowRsi],
            ["MACD", showMacd, setShowMacd],
          ] as Array<[string, boolean, (v: boolean) => void]>).map(([label, on, set]) => (
            <button
              key={`${label}-${on}`}
              type="button"
              aria-pressed={on}
              aria-label={`Toggle ${label} indicator`}
              onClick={() => set(!on)}
              className={`rounded-full px-3 py-1.5 text-xs font-bold ${on ? "chip-pop" : ""}`}
              style={on ? { background: "var(--surface3)", color: "var(--text)", boxShadow: "inset 0 0 0 1px var(--accent)" } : { background: "var(--surface2)", color: "var(--faint)", boxShadow: "inset 0 0 0 1px var(--border)" }}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mt-3">
          {candles.length >= 2 ? (
            <MarketChart candles={candles} chartType={chartType} showEma={showEma} showRsi={showRsi} showMacd={showMacd} onScrub={setScrubCandle} />
          ) : candlesQ.isPending ? (
            <div role="status" aria-label="Loading real BTC candles from Coinbase">
              <div className="skeleton h-[190px] rounded-2xl" />
              <div className="mt-2 flex gap-2">
                <div className="skeleton h-[54px] flex-1 rounded-2xl" />
                <div className="skeleton h-[54px] flex-1 rounded-2xl" />
              </div>
            </div>
          ) : (
            <p className="rounded-2xl bg-[var(--surface2)] px-4 py-6 text-center text-sm text-[var(--dim)]">
              {`${candlesQ.data?.message ?? "Chart unavailable."} Showing your stored price above.`}
            </p>
          )}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <span className="flex shrink-0 items-center gap-1.5 px-1 text-xs font-bold text-[var(--dim)]">
            <span className="live-dot h-1.5 w-1.5 rounded-full bg-[var(--accent)]" aria-hidden /> Live
          </span>
          <div className="min-w-0 flex-1">
            <SlidingSegmented<CandleRange>
              options={[["24H", "24H"], ["7D", "7D"], ["1M", "1M"]]}
              value={range}
              onChange={setRange}
              ariaLabel="Chart range"
              pillFor={() => "var(--accent)"}
              textFor={() => "var(--accent-ink)"}
            />
          </div>
          <button
            type="button"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--surface2)] text-[var(--dim)] disabled:opacity-40"
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
          <button type="button" onClick={() => scrollToTicket("sell")} className="rounded-full bg-[var(--surface3)] py-4 font-display text-base font-black tracking-wide text-[var(--red)]" aria-label="Sell BTC for coins — jumps to the coin trade panel with Sell selected">
            Sell
          </button>
          <button type="button" onClick={() => scrollToTicket("buy")} className="rounded-full bg-[var(--accent)] py-4 font-display text-base font-black tracking-wide text-[var(--accent-ink)]" aria-label="Buy BTC with coins — jumps to the coin trade panel with Buy selected">
            Buy
          </button>
        </div>

      </div>

      {/* Position card — IN COINS (the only position display) */}
      <div className="mt-5">
        <SectionTitle right="counted in coins">Your position</SectionTitle>
        {btcPos ? (
          <div className="purple-card rounded-[var(--radius)] p-5">
            <p className="font-display text-sm font-black tracking-wide">Your Position — in coins</p>
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-4">
              <div className="min-w-0">
                <p className="mono text-[20px] leading-none font-bold">{Math.round(posCoinsIn).toLocaleString()}</p>
                <p className="mt-1 text-xs text-[#c9bdf5]">Coins in</p>
              </div>
              <div className="min-w-0">
                <p className="mono text-[20px] leading-none font-bold">{Math.round(posValueCoins).toLocaleString()}</p>
                <p className="mt-1 text-xs text-[#c9bdf5]">Current value (coins)</p>
              </div>
              <div className="min-w-0">
                <p className="mono text-[20px] leading-none font-bold" style={{ color: posPl >= 0 ? "var(--accent)" : "var(--red)" }}>
                  {posPl >= 0 ? "+" : "−"}{Math.abs(Math.round(posPl)).toLocaleString()}
                </p>
                <p className="mt-1 text-xs text-[#c9bdf5]">P/L (coins)</p>
              </div>
              <div className="min-w-0">
                <p className="mono text-[20px] leading-none font-bold" style={{ color: posPl >= 0 ? "var(--accent)" : "var(--red)" }}>
                  {posPlPct >= 0 ? "+" : ""}{posPlPct.toFixed(2)}%
                </p>
                <p className="mt-1 text-xs text-[#c9bdf5]">P/L %</p>
              </div>
            </div>
            <div className="mt-4 space-y-2 border-t border-white/15 pt-3 text-sm">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[#c9bdf5]">You hold</span>
                <span className="mono font-bold">{fmtQty(btcPos.qty)} BTC</span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[#c9bdf5]">Average entry</span>
                <span className="mono font-bold">${fmtPrice(btcPos.avg_cost)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[#c9bdf5]">Free coins</span>
                <span className="mono font-bold">{balance.toLocaleString()} coins</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-[var(--radius)] bg-[var(--surface2)] px-4 py-4">
            <p className="font-display text-sm font-black">No BTC position yet — 0 coins in BTC</p>
            <p className="mt-1 text-sm text-[var(--dim)]">
              Your bankroll is {balance.toLocaleString()} free coins. Spend coins below to open
              your first position at the live price — selling credits coins straight back.
            </p>
          </div>
        )}
      </div>

      {/* Coin trade panel — spend coins to buy, sell back into coins */}
      <div className="mt-5">
        <SectionTitle right="one wallet for trades and duel wagers">Trade ticket</SectionTitle>
      </div>
      <div id="trade-ticket" className={`elev scroll-mt-20 ${cardCls} p-4`}>
        <p className="font-display flex items-center gap-2 font-extrabold">
          <Icon name="bolt" size={18} className="text-[var(--accent)]" /> Trade with coins — BTC/USD
        </p>
        <p className="mono mt-1 text-xs leading-relaxed text-[var(--dim)]">
          One wallet for everything: coins buy BTC here and escrow your duel
          wagers in Battle. Coins sitting in BTC aren't free to wager until
          you sell. Every trade feeds your duel score.
        </p>
        <div className="mt-3">
          <SlidingSegmented<"buy" | "sell">
            options={[["buy", "BUY WITH COINS"], ["sell", "SELL FOR COINS"]]}
            value={side}
            onChange={setSide}
            ariaLabel="Trade side"
            pillFor={(v) => (v === "buy" ? "var(--accent)" : "var(--red)")}
            textFor={(v) => (v === "buy" ? "var(--accent-ink)" : "#ffffff")}
            rounded="rounded-[var(--radius)]"
          />
        </div>

        <p className="mono mt-3 text-xs text-[var(--dim)]">
          {side === "buy"
            ? `Free coins: ${balance.toLocaleString()} — pick how many to spend`
            : `Position value: ${Math.round(posValueCoins).toLocaleString()} coins — pick how many coins' worth to sell`}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2" role="group" aria-label="Coin amount quick picks">
          {chips.map((amt) => {
            const selected = customCoins.trim() === "" && coinPick === amt;
            return (
              <button
                key={`${amt}-${selected}`}
                type="button"
                aria-pressed={selected}
                onClick={() => { setCoinPick(amt); setCustomCoins(""); }}
                className={`rounded-full px-4 py-2 font-display text-sm font-extrabold ${selected ? "chip-pop" : ""}`}
                style={selected
                  ? { background: "var(--accent)", color: "var(--accent-ink)" }
                  : { background: "var(--surface2)", color: "var(--text)", boxShadow: "inset 0 0 0 1px var(--border)" }}
              >
                {amt}
              </button>
            );
          })}
          <button
            type="button"
            aria-label={side === "buy" ? "Max: spend all free coins" : "Max: sell the whole position value"}
            onClick={() => {
              if (side === "buy") { setCustomCoins(balance > 0 ? String(balance) : ""); }
              else if (maxSell > 0) { setCustomCoins(String(maxSell)); }
            }}
            className="rounded-full px-4 py-2 font-display text-sm font-extrabold"
            style={{ background: "var(--surface2)", color: "var(--gold)", boxShadow: "inset 0 0 0 1px var(--border)" }}
          >
            Max
          </button>
          <label className="sr-only" htmlFor="trade-coins-custom">Custom coin amount</label>
          <input
            id="trade-coins-custom"
            inputMode="numeric"
            className="mono w-28 rounded-full border border-[var(--border)] bg-[var(--surface2)] px-3 py-2"
            placeholder="Coins"
            value={customCoins}
            onChange={(e) => setCustomCoins(e.target.value)}
          />
        </div>
        <p className="mono mt-2.5 text-xs text-[var(--dim)]" aria-live="polite">
          {livePrice
            ? side === "buy"
              ? `${coinAmount.toLocaleString()} coins ≈ ${estBtc.toFixed(6)} BTC at $${fmtPrice(livePrice)}`
              : `${coinAmount.toLocaleString()} coins' worth ≈ ${estBtc.toFixed(6)} BTC at $${fmtPrice(livePrice)}`
            : "Live price needed to preview — it loads with the chart."}
        </p>
        <button
          type="button"
          className="mt-3 w-full rounded-[var(--radius)] py-3.5 font-display text-base font-black tracking-wide disabled:opacity-40"
          style={side === "buy" ? { background: "var(--accent)", color: "var(--accent-ink)" } : { background: "var(--red)", color: "#fff" }}
          disabled={buyMut.isPending || sellMut.isPending || (side === "buy" ? balance <= 0 : !btcPos)}
          onClick={onExecute}
        >
          {side === "buy" ? `BUY BTC — SPEND ${coinAmount.toLocaleString()} COINS` : `SELL — GET ${coinAmount.toLocaleString()} COINS`}
        </button>
        {side === "sell" && btcPos ? (
          <button
            type="button"
            className="mt-2 w-full rounded-[var(--radius)] border border-[var(--red)] py-3 font-display text-sm font-black tracking-wide text-[var(--red)] disabled:opacity-40"
            disabled={sellMut.isPending}
            onClick={() => sellMut.mutate({ closeAll: true })}
            aria-label="Close all: sell the entire BTC position for its current coin value"
          >
            Close all — sell everything ({Math.round(posValueCoins).toLocaleString()} coins)
          </button>
        ) : null}
        {side === "buy" && balance <= 0 ? (
          <p className="mono mt-2 text-xs text-[var(--dim)]">No free coins right now — sell BTC or win a duel to refill the wallet.</p>
        ) : null}
      </div>

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
                  <span className="font-semibold" style={{ color: t.side === "buy" ? "var(--gain)" : "var(--loss)" }}>
                    {t.side.toUpperCase()}
                  </span>{" "}
                  {fmtQty(t.qty)} BTC/USD @ ${fmtPrice(t.price)}
                  <span className="text-[var(--dim)]"> · {Math.round(t.qty * t.price).toLocaleString()} coins</span>
                  {t.note ? <span className="text-[var(--dim)]"> · {t.note}</span> : null}
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
  showToast,
  refresh,
  challengeReq,
  wagerReq,
}: {
  duels: State["duels"];
  balance: number;
  setFeedback: (s: string) => void;
  showToast: (s: string) => void;
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
      if (r.ok) {
        showToast(r.message);
        setOpponent("");
      } else {
        setFeedback(r.message);
      }
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
    <section className="mt-5">
      <SectionTitle right="create a room, manage your duels">
        My duels
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
            {[50, 100, 250].map((amt) => {
              const selected = wager === String(amt);
              return (
                <button
                  key={`${amt}-${selected}`}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setWager(String(amt))}
                  className={`rounded-full px-4 py-2 font-display text-sm font-extrabold ${selected ? "chip-pop" : ""}`}
                  style={
                    selected
                      ? { background: "var(--accent)", color: "var(--accent-ink)" }
                      : { background: "var(--surface2)", color: "var(--text)", boxShadow: "inset 0 0 0 1px var(--border)" }
                  }
                >
                  {amt}
                </button>
              );
            })}
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
                style={
                  d.status === "completed"
                    ? { borderColor: d.winner === "you" ? "var(--gold-deep)" : "rgba(255,82,82,0.45)" }
                    : undefined
                }
              >
                <span
                  aria-hidden
                  className="absolute top-0 bottom-0 left-0 w-[6px]"
                  style={{
                    background:
                      d.status === "completed"
                        ? d.winner === "you"
                          ? "var(--gold)"
                          : "var(--red)"
                        : "var(--accent)",
                    opacity: d.status === "void" ? 0.25 : 1,
                  }}
                />
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
                    Final score{" "}
                    {d.your_score != null ? <ScoreCountUp value={d.your_score} /> : "—"} –{" "}
                    {d.opp_score != null ? <ScoreCountUp value={d.opp_score} /> : "—"} ·{" "}
                    {d.winner === "you" ? (
                      <span className="font-bold" style={{ color: "var(--gold)" }}>
                        VICTORY — you took the pot
                      </span>
                    ) : (
                      <span className="font-bold" style={{ color: "var(--red)" }}>
                        DEFEAT — {d.opponent} took the pot
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
                          if (r.ok) showToast(r.message);
                          else setFeedback(r.message);
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

// ---------- wallet: the coin ledger (Profile) ----------
// Ledger/history only: the balance itself lives in the app bar and
// the Home hero, so it is not repeated here, and the owner-only
// Adjust wallet form is not part of the player view (the action
// stays available server-side).

function WalletSection({
  txns,
}: {
  txns: State["walletTxns"];
}) {
  return (
    <section className="mt-5">
      <SectionTitle right="every coin move is a ledger row">Wallet history</SectionTitle>
      <div className={`${cardCls} p-4`}>
        <p className="font-display flex items-center gap-2 font-bold">
          <Icon name="wallet" size={17} className="text-[var(--gold)]" /> Coin ledger
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
    </section>
  );
}

// ---------- the collectible player card ----------

function PlayerCard({
  name,
  initials,
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
  name: string;
  initials: string;
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
            <AvatarDisc initials={initials} size={104} accent fontSize={40} />
            <span className="mono absolute -right-2 -bottom-1 grid h-8 w-8 place-items-center rounded-full bg-[var(--accent)] text-[13px] font-black text-[var(--accent-ink)]" style={{ boxShadow: "0 0 14px rgba(198,241,53,0.5)" }} aria-label={`Level ${level}`}>
              {level}
            </span>
          </div>
          <p className="font-display mt-3 text-center text-[30px] leading-none font-black">
            {name}
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

