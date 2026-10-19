"""G-Asisit scoring engine (Streamlit prototype).

Implements README section 6 "Scoring Engine" as a pure function so the
formula can be reused by the Streamlit UI, backtests, or the future
NestJS ScoringService.

Formula:
    Score = 0.40*R + 0.25*K + 0.15*C + 0.10*A + 0.10*B

Component semantics (prototype concretization of the README blueprint —
the README leaves K/C normalization implicit, so the choices below are
documented here rather than hidden):

- R (Returns, 0-100): return_pct = (end_pv - start_cash) / start_cash * 100,
  clipped to [-50, +50] ("cap at +/-50% to kill outliers"), then shifted to
  the 0-100 scale via R = clipped + 50. 0% return -> 50.
- K (Risk-adjusted, 0-100): Sharpe-ish = mean / stdev of per-trade returns.
  A per-trade return comes from closed round-trips: sells matched against
  buys FIFO, ret = (proceeds - cost) / cost. Normalized as
  K = clip(50 + 25 * sharpe, 0, 100), so a sharpe of 0 maps to a neutral 50
  and +/-2 maps to 0/100. With fewer than 2 closed round-trips the Sharpe
  is undefined -> sharpe = 0 -> K = 50 (neutral, neither rewarded nor
  punished). README "penalize if trades < 3": K is halved when the total
  trade count is below 3.
- C (Consistency, 0-100): winning round-trips / total round-trips * 100;
  0 when there are no closed round-trips yet.
- A (Activity, 0-100): min(trades / 10, 1) * 100 (README formula, literal).
- B (Bonus): +10 for a duel winner, 0 for the loser. In solo paper
  trading there is no opponent, so B = 0 (stated, not hidden).

`trades` is a list of dicts with keys:
    {"side": "buy" | "sell", "qty": float, "price": float}
Extra keys are ignored. Sells that exceed the held inventory only realize
returns on the matched portion; the unmatched remainder is ignored.

`open_positions(trades)` is a small companion helper for portfolio P/L:
returns {symbol: {"qty": float, "avg_cost": float}} for remaining FIFO lots.
"""

import math
from statistics import mean, stdev


def _clip(x, lo, hi):
    return max(lo, min(hi, x))


def _valid_trades(trades):
    """Keep only well-formed buy/sell trades with positive qty and price."""
    out = []
    for t in trades or []:
        try:
            side = str(t.get("side", "")).lower()
            qty = float(t.get("qty", 0) or 0)
            price = float(t.get("price", 0) or 0)
        except (TypeError, ValueError):
            continue
        if side in ("buy", "sell") and qty > 0 and price > 0:
            out.append({"symbol": t.get("symbol"), "side": side,
                        "qty": qty, "price": price})
    return out


def _fifo_lots(trades):
    """Remaining inventory lots per symbol after FIFO matching.

    Returns {symbol: [[qty, price], ...]}.
    """
    lots = {}
    for t in trades:
        sym = t.get("symbol")
        if sym is None:
            continue
        book = lots.setdefault(sym, [])
        if t["side"] == "buy":
            book.append([t["qty"], t["price"]])
        else:  # sell — consume oldest lots first
            need = t["qty"]
            while need > 1e-12 and book:
                lqty, _ = book[0]
                take = min(lqty, need)
                lqty -= take
                need -= take
                if lqty <= 1e-12:
                    book.pop(0)
                else:
                    book[0][0] = lqty
            # any sell quantity beyond inventory is ignored (no shorting)
    return lots


def open_positions(trades):
    """{symbol: {"qty": float, "avg_cost": float}} for currently held lots."""
    positions = {}
    for sym, book in _fifo_lots(_valid_trades(trades)).items():
        qty = sum(q for q, _ in book)
        if qty > 1e-12:
            cost = sum(q * p for q, p in book)
            positions[sym] = {"qty": qty, "avg_cost": cost / qty}
    return positions


def _round_trip_returns(trades):
    """Per-trade returns (fractions) from sells matched against buys FIFO."""
    lots = {}
    returns = []
    for t in _valid_trades(trades):
        sym = t.get("symbol")
        if t["side"] == "buy":
            lots.setdefault(sym, []).append([t["qty"], t["price"]])
            continue
        # sell
        book = lots.setdefault(sym, [])
        need, filled, cost = t["qty"], 0.0, 0.0
        while need > 1e-12 and book:
            lqty, lprice = book[0]
            take = min(lqty, need)
            cost += take * lprice
            filled += take
            lqty -= take
            need -= take
            if lqty <= 1e-12:
                book.pop(0)
            else:
                book[0][0] = lqty
        if filled > 1e-12 and cost > 0:
            returns.append((filled * t["price"] - cost) / cost)
    return returns


def calculate_score(trades, start_cash, end_pv):
    """Score a paper-trading run per the README section 6 formula.

    Returns a dict with the overall "score" (0-100) plus each component
    R/K/C/A/B on the 0-100 scale, so the UI can break the score out.
    """
    valid = _valid_trades(trades)
    n = len(valid)
    start_cash = float(start_cash or 0)
    end_pv = float(end_pv or 0)

    # R — Returns: percent return, clipped to [-50, +50], shifted to 0-100.
    ret_pct = ((end_pv - start_cash) / start_cash * 100.0) if start_cash > 0 else 0.0
    R = _clip(ret_pct, -50.0, 50.0) + 50.0

    # K — Risk-adjusted: Sharpe-ish on closed round-trip returns.
    rts = _round_trip_returns(valid)
    if len(rts) >= 2:
        sd = stdev(rts)
        sharpe = (mean(rts) / sd) if sd > 0 else 0.0
    else:
        sharpe = 0.0  # undefined with <2 round-trips -> neutral
    K = _clip(50.0 + 25.0 * sharpe, 0.0, 100.0)
    if n < 3:
        K *= 0.5  # README: penalize thin trade history

    # C — Consistency: share of winning round-trips.
    C = (sum(1 for r in rts if r > 0) / len(rts) * 100.0) if rts else 0.0

    # A — Activity: rewards trading up to 10 trades, then flat.
    A = min(n / 10.0, 1.0) * 100.0

    # B — Bonus: duel-only; 0 in solo paper trading (no opponent).
    B = 0.0

    score = 0.40 * R + 0.25 * K + 0.15 * C + 0.10 * A + 0.10 * B

    return {
        "score": round(score, 2),
        "R": round(R, 2),
        "K": round(K, 2),
        "C": round(C, 2),
        "A": round(A, 2),
        "B": round(B, 2),
        "trades": n,
        "round_trips": len(rts),
        "return_pct": round(ret_pct, 2),
        "sharpe": round(sharpe, 4),
        "note": "B=0: solo paper trading, no duel opponent",
    }
