"""G-Asisit paper-trading prototype (Streamlit).

PAPER ONLY — no real money, no live orders, no API keys. Live prices come
from yfinance; Kaspa (KAS) is generally not listed on Yahoo, so it falls
back to a manual price override in the sidebar.

Layout (4 tabs, per the original mock):
  Tournaments — live README-section-6 score + "paper league of one" note
  Portfolio   — live positions/equity + buy/sell paper-trade form + ledger
  ML Signals  — honest MA-crossover momentum signals (labeled as such)
  Mining      — Project-Mine placeholder (separate project, static figures)

Run:  pip install -r requirements.txt && streamlit run app.py
"""

import os
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import plotly.express as px
import streamlit as st
import yfinance as yf
from sqlalchemy import (Column, DateTime, Float, Integer, String, create_engine,
                        func)
from sqlalchemy.orm import declarative_base, sessionmaker

from scoring import calculate_score, open_positions

# ---------------------------------------------------------------- config
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "trades.db")
START_CASH = 50_000.0
SYMBOLS = ["BTC", "ETH", "KAS"]
YF_MAP = {"BTC": "BTC-USD", "ETH": "ETH-USD", "KAS": "KAS-USD"}
SEED_POSITIONS = {"BTC": 0.52, "ETH": 5.2, "KAS": 12450.0}  # from the old mock
# KAS-USD actually exists on Yahoo (verified 2026-10-19: ~$0.0358, NOT the
# $0.33 from the old mock era). This fallback only matters if Yahoo fails.
KAS_FALLBACK_PRICE = 0.0358

st.set_page_config(
    page_title="G-Asisit — Paper Trading", layout="wide",
    initial_sidebar_state="expanded",
)

# ---------------------------------------------------------------- database
Base = declarative_base()


class Trade(Base):
    __tablename__ = "trades"
    id = Column(Integer, primary_key=True)
    symbol = Column(String(8), nullable=False)
    side = Column(String(4), nullable=False)  # buy | sell (long-only)
    qty = Column(Float, nullable=False)
    price = Column(Float, nullable=False)
    is_seed = Column(Integer, default=0)
    # naive UTC — SQLite has no timezone-aware DATETIME support
    executed_at = Column(DateTime,
                         default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))


class Meta(Base):
    __tablename__ = "meta"
    key = Column(String(32), primary_key=True)
    value = Column(String(64))


engine = create_engine(f"sqlite:///{DB_PATH}", future=True)
Base.metadata.create_all(engine)
Session = sessionmaker(bind=engine, future=True)


def get_meta(key, default=None):
    with Session() as s:
        row = s.get(Meta, key)
        return row.value if row else default


def set_meta(key, value):
    with Session() as s:
        row = s.get(Meta, key)
        if row:
            row.value = str(value)
        else:
            s.add(Meta(key=key, value=str(value)))
        s.commit()


def get_cash():
    v = get_meta("cash")
    return float(v) if v is not None else START_CASH


def set_cash(v):
    set_meta("cash", f"{float(v):.2f}")


def all_trades():
    with Session() as s:
        rows = s.query(Trade).order_by(Trade.id).all()
        return [{"id": t.id, "symbol": t.symbol, "side": t.side,
                 "qty": t.qty, "price": t.price, "is_seed": t.is_seed,
                 "executed_at": t.executed_at} for t in rows]


# ---------------------------------------------------------------- prices
@st.cache_data(ttl=120)
def fetch_price(yf_symbol):
    """Latest price from yfinance, or None if unavailable."""
    try:
        hist = yf.Ticker(yf_symbol).history(period="1d", interval="1m")
        if hist is None or hist.empty:
            return None
        return float(hist["Close"].iloc[-1])
    except Exception:
        return None


@st.cache_data(ttl=600)
def fetch_daily(yf_symbol, period="3mo"):
    """Daily bars for MA signals / prev-close P/L, or None if unavailable."""
    try:
        hist = yf.Ticker(yf_symbol).history(period=period, interval="1d")
        if hist is None or hist.empty:
            return None
        return hist
    except Exception:
        return None


def get_prices(kas_override):
    """{symbol: (price, source_label)} — KAS falls back to manual override."""
    out = {}
    for sym in SYMBOLS:
        px = fetch_price(YF_MAP[sym])
        if px is not None:
            out[sym] = (px, "yfinance live")
        elif sym == "KAS":
            out[sym] = (float(kas_override), "manual override")
        else:
            out[sym] = (None, "unavailable")
    return out


# ---------------------------------------------------------------- seeding
def ensure_seeded(prices):
    """First run: seed the mock's starting positions; buys deduct from cash."""
    if get_meta("seeded") == "1":
        return True
    missing = [s for s in SEED_POSITIONS if prices[s][0] is None]
    if missing:
        st.error(f"Can't seed the paper ledger — no price for {', '.join(missing)}. "
                 "Check your connection and reload.")
        return False
    with Session() as s:
        seed_cost = 0.0
        for sym, qty in SEED_POSITIONS.items():
            live_px, _ = prices[sym]
            s.add(Trade(symbol=sym, side="buy", qty=qty, price=live_px, is_seed=1))
            seed_cost += qty * live_px
        # Seed positions are granted (the starting paper portfolio); cash
        # starts at the full START_CASH. Scoring baseline = total value.
        s.add(Meta(key="cash", value=f"{START_CASH:.2f}"))
        s.add(Meta(key="start_cash", value=f"{START_CASH + seed_cost:.2f}"))
        s.add(Meta(key="seeded", value="1"))
        s.commit()
    return True


def execute_trade(symbol, side, qty, price):
    """Validate + record a paper trade. Long-only. Returns (ok, message)."""
    if qty <= 0:
        return False, "Quantity must be positive."
    if price is None or price <= 0:
        return False, "No live price available — can't execute."
    positions = open_positions(all_trades())
    held = positions.get(symbol, {"qty": 0.0})["qty"]
    cash = get_cash()
    if side == "buy":
        cost = qty * price
        if cost > cash + 1e-9:
            return False, f"Insufficient paper cash (${cash:,.2f} < ${cost:,.2f})."
        with Session() as s:
            s.add(Trade(symbol=symbol, side="buy", qty=qty, price=price))
            s.commit()
        set_cash(cash - cost)
        return True, f"Bought {qty:g} {symbol} @ ${price:,.4g} (paper)."
    else:  # sell
        if qty > held + 1e-9:
            return False, f"Insufficient {symbol} (holding {held:g}). No shorting in the prototype."
        with Session() as s:
            s.add(Trade(symbol=symbol, side="sell", qty=qty, price=price))
            s.commit()
        set_cash(cash + qty * price)
        return True, f"Sold {qty:g} {symbol} @ ${price:,.4g} (paper)."


# ---------------------------------------------------------------- signals
def ma_signal(daily):
    """Simple MA-crossover momentum signal. Returns dict or None.

    Honest heuristic — NOT a trained ML model. Signal is BUY when the
    20-day MA sits above the 50-day MA (golden cross posture), SELL when
    below, HOLD when they're within 0.5%. Confidence scales with the
    crossover strength, capped 5-95.
    """
    if daily is None or len(daily) < 50:
        return None
    close = daily["Close"]
    ma20 = float(close.rolling(20).mean().iloc[-1])
    ma50 = float(close.rolling(50).mean().iloc[-1])
    if ma50 <= 0:
        return None
    diff_pct = (ma20 - ma50) / ma50 * 100.0
    if diff_pct > 0.5:
        signal = "BUY"
    elif diff_pct < -0.5:
        signal = "SELL"
    else:
        signal = "HOLD"
    confidence = round(float(np.clip(abs(diff_pct) * 15.0, 5.0, 95.0)), 1)
    return {"signal": signal, "confidence": confidence, "ma20": ma20,
            "ma50": ma50, "last": float(close.iloc[-1]),
            "diff_pct": round(diff_pct, 2)}


# ---------------------------------------------------------------- sidebar
st.sidebar.title("📝 Paper trading")
st.sidebar.caption("Virtual cash only — no real money moves here.")
kas_override = st.sidebar.number_input(
    "KAS manual price (USD) — used when Yahoo has no KAS-USD quote",
    min_value=0.0001, value=KAS_FALLBACK_PRICE, step=0.01, format="%.4f",
)
if st.sidebar.button("🔄 Refresh prices"):
    st.cache_data.clear()
    st.rerun()
st.sidebar.divider()
if st.sidebar.button("🗑️ Reset paper ledger", help="Wipes all trades and re-seeds the starting portfolio."):
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    st.cache_data.clear()
    st.rerun()
st.sidebar.caption("Prices: yfinance (2-min cache). Ledger: local trades.db (gitignored).")

# ---------------------------------------------------------------- data load
prices = get_prices(kas_override)
if not ensure_seeded(prices):
    st.stop()

trades = all_trades()
positions = open_positions(trades)
cash = get_cash()
start_cash = float(get_meta("start_cash", START_CASH))

equity_rows = []
day_pl_total, day_pl_note = 0.0, []
for sym, pos in positions.items():
    live_px, src = prices[sym]
    if live_px is None:
        continue
    value = pos["qty"] * live_px
    upl = (live_px - pos["avg_cost"]) * pos["qty"]
    # day P/L vs previous daily close
    dpl = None
    daily = fetch_daily(YF_MAP[sym])
    if daily is not None and len(daily) >= 2:
        prev_close = float(daily["Close"].iloc[-2])
        dpl = (live_px - prev_close) * pos["qty"]
        day_pl_total += dpl
    else:
        day_pl_note.append(sym)
    equity_rows.append({
        "Symbol": sym, "Qty": pos["qty"], "Avg cost": pos["avg_cost"],
        "Live": live_px, "Source": src, "Value $": value, "Unrealized P/L $": upl,
        "Day P/L $": dpl,
    })

pos_value = sum(r["Value $"] for r in equity_rows)
end_pv = cash + pos_value
score = calculate_score(trades, start_cash, end_pv)

# ---------------------------------------------------------------- header
st.title("🚀 G-Asisit — Paper Trading Prototype")
m1, m2, m3, m4 = st.columns(4)
m1.metric("Total equity", f"${end_pv:,.2f}")
m2.metric("Paper cash", f"${cash:,.2f}")
day_pl_str = f"${day_pl_total:,.2f}" + ("*" if day_pl_note else "")
m3.metric("Day P/L", day_pl_str,
          help="*Excludes " + ", ".join(day_pl_note) if day_pl_note else None)
m4.metric("Live score", f"{score['score']:.1f} / 100")

tab1, tab2, tab3, tab4 = st.tabs(
    ["🏆 Tournaments", "📊 Portfolio", "📈 ML Signals", "⛏️ Mining"]
)

# ---------------------------------------------------------------- tournaments
with tab1:
    st.header("Trading League — paper league of one")
    st.metric("Your live score", f"{score['score']:.1f} / 100",
              help="README §6: 0.40·R + 0.25·K + 0.15·C + 0.10·A + 0.10·B")
    comp = pd.DataFrame([
        {"Component": "R — Returns", "Weight": "40%",
         "Value": f"{score['R']:.1f}",
         "What": f"Portfolio {score['return_pct']:+.2f}% (clipped ±50%, →0-100)"},
        {"Component": "K — Risk-adjusted", "Weight": "25%",
         "Value": f"{score['K']:.1f}",
         "What": f"Sharpe-ish {score['sharpe']:.3f} on {score['round_trips']} round-trips"
                 + (" (halved: <3 trades)" if score["trades"] < 3 else "")},
        {"Component": "C — Consistency", "Weight": "15%",
         "Value": f"{score['C']:.1f}",
         "What": f"Winning round-trips share ({score['round_trips']} closed)"},
        {"Component": "A — Activity", "Weight": "10%",
         "Value": f"{score['A']:.1f}",
         "What": f"{score['trades']} trades (caps at 10)"},
        {"Component": "B — Bonus", "Weight": "10%",
         "Value": f"{score['B']:.1f}",
         "What": "0 — no duel opponent in solo paper trading"},
    ])
    st.dataframe(comp, use_container_width=True, hide_index=True)
    st.info("📝 Paper league of one: there are no opponents yet, so the duel "
            "bonus (B) is 0 by design. Duels ship with the mobile app — this "
            "tab is where your live score will rank you.")

# ---------------------------------------------------------------- portfolio
with tab2:
    st.header("Your Portfolio")
    if equity_rows:
        df = pd.DataFrame(equity_rows)
        st.dataframe(
            df.style.format({
                "Qty": "{:,.4g}", "Avg cost": "${:,.4g}", "Live": "${:,.4g}",
                "Value $": "${:,.2f}", "Unrealized P/L $": "${:,.2f}",
                "Day P/L $": lambda v: "n/a" if v is None or (isinstance(v, float) and np.isnan(v)) else f"${v:,.2f}",
            }),
            use_container_width=True, hide_index=True,
        )
    else:
        st.write("No open positions — you're all cash.")

    st.subheader("Place a paper trade")
    with st.form("trade_form", clear_on_submit=True):
        c1, c2, c3 = st.columns(3)
        symbol = c1.selectbox("Symbol", SYMBOLS)
        side = c2.selectbox("Side", ["buy", "sell"])
        qty = c3.number_input("Quantity", min_value=0.0, step=0.1, format="%.4f")
        submitted = st.form_submit_button("Execute at live price", use_container_width=True)
    if submitted:
        live_px, src = prices[symbol]
        ok, msg = execute_trade(symbol, side, qty, live_px)
        if ok:
            st.success(msg + f" Price source: {src}.")
            st.rerun()
        else:
            st.error(msg)

    st.subheader("Trade ledger")
    if trades:
        ledger = pd.DataFrame([
            {"#": t["id"], "Time": t["executed_at"], "Symbol": t["symbol"],
             "Side": t["side"].upper(), "Qty": t["qty"], "Price": t["price"],
             "Seed": "yes" if t["is_seed"] else ""}
            for t in reversed(trades)
        ])
        st.dataframe(ledger, use_container_width=True, hide_index=True)
    else:
        st.write("No trades yet.")

# ---------------------------------------------------------------- signals
with tab3:
    st.header("Momentum signals")
    st.caption("Simple 20-day / 50-day moving-average crossover heuristic computed "
               "from yfinance daily bars — **not a trained ML model**. For research "
               "and entertainment only; not financial advice.")
    sig_rows, chart_sym = [], None
    for sym in SYMBOLS:
        s = ma_signal(fetch_daily(YF_MAP[sym]))
        if s is None:
            sig_rows.append({"Symbol": sym, "Signal": "NO DATA",
                             "Confidence": "—", "MA20": "—", "MA50": "—",
                             "Last": "—"})
        else:
            sig_rows.append({"Symbol": sym, "Signal": s["signal"],
                             "Confidence": s["confidence"], "MA20": round(s["ma20"], 4),
                             "MA50": round(s["ma50"], 4), "Last": round(s["last"], 4)})
    st.dataframe(pd.DataFrame(sig_rows), use_container_width=True, hide_index=True)
    chart_opts = [s for s in SYMBOLS
                  if ma_signal(fetch_daily(YF_MAP[s])) is not None]
    if chart_opts:
        chart_sym = st.selectbox("Chart", chart_opts)
        daily = fetch_daily(YF_MAP[chart_sym])
        cdf = pd.DataFrame({"Close": daily["Close"],
                            "MA20": daily["Close"].rolling(20).mean(),
                            "MA50": daily["Close"].rolling(50).mean()}).dropna()
        fig = px.line(cdf, y=["Close", "MA20", "MA50"],
                      title=f"{chart_sym} — close vs moving averages")
        st.plotly_chart(fig, use_container_width=True)

# ---------------------------------------------------------------- mining
with tab4:
    st.header("⛏️ Project-Mine")
    st.caption("Separate project — figures below are the original mock's "
               "placeholder targets, not live mining stats. Nothing here "
               "starts or connects to any miner.")
    c1, c2 = st.columns(2)
    c1.metric("Target hashrate", "245 MH/s")
    c2.metric("Target daily earnings", "142 KAS ($4.75)")

st.caption("G-Asisit paper-trading prototype · prices via yfinance · paper money only")
