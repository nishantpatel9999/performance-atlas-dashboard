"""Deterministic synthetic marks and closed trades for the offline example."""

import math
import random
from dataclasses import dataclass, field
from datetime import date, timedelta

from .inputs import parse_time


SEED = 41729
START, END = date(2018, 12, 31), date(2025, 12, 31)
BENCHMARK = "market-index"


@dataclass
class Sleeve:
    id: str
    name: str
    asset: str
    family: str
    capital: float
    exposure: float
    horizon: int
    commission_bp: float
    slippage_bp: float
    equity: list = field(default_factory=list)
    trades: list = field(default_factory=list)
    units: float = 0.0
    entry_price: float = 0.0
    entry_cost: float = 0.0
    entry_bar: int = 0
    commissions: float = 0.0
    slippage: float = 0.0

    def charge(self, notional):
        commission = notional * self.commission_bp / 10000
        slip = notional * self.slippage_bp / 10000
        self.commissions += commission
        self.slippage += slip
        return commission + slip

    def close_mark(self, bar, times, previous_price, price, side, final):
        nav = self.equity[-1] + self.units * (price - previous_price)
        if self.units and (bar - self.entry_bar >= self.horizon or final):
            fee = self.charge(abs(self.units) * price)
            pnl = self.units * (price - self.entry_price) - self.entry_cost - fee
            self.trades.append({"time": times[bar], "pnl": round(pnl, 8),
                                "side": "long" if self.units > 0 else "short",
                                "holdingHours": (times[bar] - times[self.entry_bar]) / 3_600_000})
            nav -= fee
            self.units = 0.0
        if self.units == 0 and side and not final:
            self.entry_bar, self.entry_price = bar, price
            self.units = side * nav * self.exposure / price
            self.entry_cost = self.charge(abs(self.units) * price)
            nav -= self.entry_cost
        self.equity.append(nav)


def _summary(trades):
    wins = [t["pnl"] for t in trades if t["pnl"] > 0]
    losses = [t["pnl"] for t in trades if t["pnl"] < 0]
    return {"closedTrades": len(trades), "wins": len(wins), "losses": len(losses),
            "breakeven": len(trades) - len(wins) - len(losses), "grossProfit": round(sum(wins), 8),
            "grossLoss": round(-sum(losses), 8), "netPnl": round(sum(wins) + sum(losses), 8)}


def _costs(commissions, slippage):
    return {"currency": "USD", "commissions": round(commissions, 8), "slippage": round(slippage, 8),
            "total": round(commissions + slippage, 8)}


def demo_bundle():
    """Four independently funded sleeves, their actual combined book and a synthetic index."""
    sleeves = [
        Sleeve("equity-trend", "Equity Trend", "Equities", "Trend following", 350000, 0.85, 21, 0.8, 1.8),
        Sleeve("rates-duration", "Defensive Duration", "Fixed income", "Defensive allocation", 250000, 1.1, 15, 0.5, 1.0),
        Sleeve("commodity-reversion", "Commodity Reversion", "Commodities", "Mean reversion", 220000, 0.65, 6, 1.0, 2.5),
        Sleeve("currency-carry", "Currency Carry", "Currencies", "Carry", 180000, 0.8, 18, 0.7, 1.2),
    ]
    dates = [START + timedelta(days=i) for i in range((END - START).days + 1)
             if (START.weekday() + i) % 7 < 5]
    times = [parse_time(d.isoformat() + "T21:00:00Z") for d in dates]
    rng = random.Random(SEED)
    prices, trend = [100.0] * 4, [0.0] * 4
    benchmark_capital = 100.0
    benchmark_units = benchmark_capital / prices[0]
    benchmark = [benchmark_capital]
    gross_exposure, net_exposure = [0.0], [0.0]
    # These illustrative rates belong to the synthetic market. Each sleeve holds a
    # distinct instrument, so its standalone closing requirement is additive.
    margin_fractions = ((0.48, 0.58), (0.12, 0.15), (0.16, 0.19), (0.05, 0.07))
    symbols = ("DEMO-EQUITY", "DEMO-BOND", "DEMO-COMMODITY", "DEMO-FX")

    def margin_point(time, value):
        return {"time": time, "marginUsd": round(value, 2), "marginBasis": "schedule_estimate"}

    entry_thresholds = (0.0012, 0.0007, 0.007, 0.75)
    session_rows = [{"date": START.isoformat(), "active": 0, "overnight": 0,
                     "closeTime": times[0], "marginUsd": 0.0, "marginBasis": "schedule_estimate",
                     "intradayMargin": [margin_point(times[0], 0)], "activePositions": []}]
    for sleeve in sleeves:
        sleeve.equity.append(sleeve.capital)
    regime, remaining, last_commodity = 0, 225, 0.0
    for bar in range(1, len(times)):
        if remaining == 0:
            regime = (regime + 1) % 3
            remaining = rng.randint(*((180, 320), (30, 65), (80, 140))[regime])
        remaining -= 1
        drift = (0.00040, -0.00165, 0.00105)[regime]
        volatility = (0.008, 0.018, 0.011)[regime]
        market = drift + volatility * rng.gauss(0, 1)
        carry = math.sin(bar / 133) + 0.4
        bond = 0.00012 - 0.17 * market + rng.gauss(0, 0.0039)
        commodity = 0.00018 + 0.26 * market - 0.27 * last_commodity + rng.gauss(0, 0.008)
        fx = 0.00027 * carry + 0.14 * market + rng.gauss(0, 0.0045)
        moves = [market, bond, commodity, fx]
        last_commodity = commodity
        for i, move in enumerate(moves):
            trend[i] = 0.94 * trend[i] + 0.06 * move
        signals = (trend[0], 1 if trend[0] < 0 else trend[1] + 0.0003, -commodity, carry)
        opening_units = [s.units for s in sleeves]
        for i, sleeve in enumerate(sleeves):
            previous = prices[i]
            prices[i] *= 1 + moves[i]
            # A signal at this close sets the units for the next price change.
            signal = signals[i]
            side = 0 if abs(signal) < entry_thresholds[i] else (1 if signal > 0 else -1)
            sleeve.close_mark(bar, times, previous, prices[i], side, bar == len(times) - 1)
        benchmark.append(benchmark_units * prices[0])
        portfolio_nav = sum(s.equity[-1] for s in sleeves)
        notionals = [s.units * price for s, price in zip(sleeves, prices)]
        overnight = [s.units != 0 for s in sleeves]
        requirement = sum(abs(n) * rates[int(n < 0)] for n, rates in zip(notionals, margin_fractions))
        # The synthetic open repeats the previous close. At the pre-trade mark the
        # current prices are known and all sleeves still hold their opening quantities.
        pretrade = sum(abs(units * price) * rates[int(units < 0)]
                       for units, price, rates in zip(opening_units, prices, margin_fractions))
        close = times[bar]
        points = [margin_point(close - 390 * 60_000, session_rows[-1]["marginUsd"]),
                  margin_point(close - 1, pretrade), margin_point(close, requirement)]
        legs = [{"strategyId": s.id, "symbol": symbol, "heldDuring": True, "closeQty": s.units}
                for s, symbol, before in zip(sleeves, symbols, opening_units) if before or s.units]
        session_rows.append({"date": dates[bar].isoformat(), "closeTime": close, "active": len(legs),
                             "overnight": sum(overnight), "marginUsd": points[-1]["marginUsd"],
                             "marginBasis": "schedule_estimate", "intradayMargin": points, "activePositions": legs})
        gross_exposure.append(sum(abs(n) for n in notionals) / portfolio_nav)
        net_exposure.append(sum(notionals) / portfolio_nav)

    common = {"frequency": "daily", "periodsPerYear": 252, "times": times, "source": "Seeded synthetic market",
              "status": "Synthetic demonstration", "currency": "USD"}
    evidence = {"type": "synthetic", "seed": SEED,
                "method": "Simulated weekday closes across calm, stress and recovery regimes."}
    strategies = []
    for s in sleeves:
        strategies.append(dict(common, id=s.id, name=s.name, kind="strategy", equity=[round(v, 8) for v in s.equity],
                               assetClass=s.asset, family=s.family, accounting="Net marked equity in a funded sleeve",
                               benchmarkId=BENCHMARK, trades=s.trades, tradeSummary=_summary(s.trades),
                               costs=_costs(s.commissions, s.slippage),
                               costModel=f"Synthetic one-way charges of {s.commission_bp:g} bp commission and "
                                         f"{s.slippage_bp:g} bp slippage on traded notional.",
                               evidence=dict(evidence, holdingSessions=s.horizon),
                               notes=["Trade P&L includes entry and exit charges. The last session closes the position."]))
    nav = [sum(marks) for marks in zip(*(s["equity"] for s in strategies))]
    trades = sorted((t for s in sleeves for t in s.trades), key=lambda t: t["time"])
    book = dict(common, id="multi-asset", name="Multi-Asset Portfolio", kind="portfolio", equity=nav,
                assetClass="Multi-asset", family="Funded sleeves", benchmarkId=BENCHMARK,
                activity={"source": "Simulated positions at each weekday close. The model applies illustrative "
                          "long/short fractions to closing USD notional. Equities 48%/58%, fixed income 12%/15%, "
                          "commodities 16%/19%, currencies 5%/7%. Each sleeve holds a separate instrument. "
                          "Synthetic intraday marks use the previous close at 14:30 UTC and the current price "
                          "immediately before and after the 21:00 UTC rebalance.",
                          "rows": session_rows},
                accounting="Total net equity of four separately funded USD sleeves. Each sleeve retains its P&L.",
                costModel="Commissions and slippage from the four sleeve ledgers.",
                costs=_costs(sum(s.commissions for s in sleeves), sum(s.slippage for s in sleeves)),
                trades=trades, tradeSummary=_summary(trades),
                evidence=dict(evidence, holdingsBasis="Ending shares of net equity",
                              attribution={"basis": "funded_equity", "members": [s.id for s in sleeves]}),
                holdings=[{"id": s["id"], "weight": s["equity"][-1] / nav[-1]} for s in strategies],
                diagnostics=[{"name": "Gross exposure", "unit": "%", "times": times, "values": gross_exposure,
                              "description": "Absolute marked notional of all positions divided by net portfolio equity after close trades."},
                             {"name": "Net exposure", "unit": "%", "times": times, "values": net_exposure,
                              "description": "Signed marked notional of all positions divided by net portfolio equity after close trades."}])
    reference = dict(common, id=BENCHMARK, name="Synthetic Equity Benchmark", kind="benchmark", currency="USD",
                     equity=[round(v, 8) for v in benchmark], assetClass="Equities",
                     accounting="USD 100 buy-and-hold investment in the synthetic equity price path.",
                     evidence=dict(evidence, method="Value the initial USD 100 holding at each subsequent equity close."))
    return {"version": 1, "title": "Multi-asset research", "description": "Synthetic cross-asset demonstration. "
            "All prices, trades and costs come from a seeded simulation.", "series": [book, *strategies, reference]}
