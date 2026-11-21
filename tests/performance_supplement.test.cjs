"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { analyze } = require("../lab/performance/metrics.js");
const details = require("../lab/performance/details.js");
const utc = date => Date.parse(date + "T16:00:00Z");
const monthEnd = i => Date.UTC(2023, i + 1, 0, 16);

function series(times, equity, extra = {}) {
  return { id: "s", name: "Account", kind: "strategy", frequency: "monthly", periodsPerYear: 12,
    currency: "USD", times, equity, ...extra };
}

function near(actual, expected) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)),
    "Expected " + expected + ", received " + actual);
}

test("all, long and short use signed net trade outcomes and each column's own gross totals", () => {
  const ledger = [
    { time: 4, pnl: -6, side: "short" }, { time: 2, pnl: 8, side: " LONG " },
    { time: 3, pnl: 2, side: "long" }, { time: 3, pnl: -2, side: "long", holdingHours: 0 },
    { time: 5, pnl: 0, side: "Short" }, { time: 6, pnl: 4, side: "pair" },
    { time: 1, pnl: -999 }, { time: 7, pnl: 999 }, { time: 3, pnl: NaN },
  ];
  const s = series([0, 10], [100, 110], { trades: ledger, tradeSummary: { count: 400 } });
  const r = details.trades(s, { start: 2, end: 6 });
  assert.ok(r.breakdown, "Trades must expose measured side totals");
  const { all, long, short, unclassifiedCount } = r.breakdown;
  assert.deepEqual([all.count, all.wins, all.losses, all.flat], [6, 3, 2, 1]);
  assert.deepEqual([all.netPnl, all.grossProfit, all.grossLoss, all.largestWinner, all.largestLoser], [6, 14, -8, 8, -6]);
  near(all.profitFactor, 14 / 8);
  near(all.expectancy, 1);
  near(all.avgWin, 14 / 3);
  near(all.avgLoss, -4);
  near(all.largestWinnerShare, 8 / 14);
  near(all.largestLoserShare, 6 / 8);
  assert.deepEqual([long.count, long.netPnl, long.grossProfit, long.grossLoss, long.profitFactor], [3, 8, 10, -2, 5]);
  near(long.largestWinnerShare, 0.8);
  assert.deepEqual([short.wins, short.losses, short.flat, short.profitFactor, short.avgWin, short.largestWinnerShare], [0, 1, 1, 0, null, null]);
  assert.equal(unclassifiedCount, 1);
  assert.deepEqual(r.outcomes.map(x => [x.time, x.pnl]), [[2, 8], [3, 2], [3, -2], [4, -6], [5, 0], [6, 4]]);
  assert.equal(r.outcomes[2].holdingHours, 0);
  assert.equal(ledger[0].time, 4);
});

test("missing, empty, partial and exhausted ledgers retain separate meanings", () => {
  const s = series([0, 10, 20], [100, -5, 80], { tradeSummary: { closed: 100 } });
  assert.equal(details.trades(s).breakdown, null);
  const empty = details.trades({ ...s, trades: [] }).breakdown;
  assert.deepEqual([empty.all.count, empty.all.grossLoss, empty.all.profitFactor, empty.all.expectancy], [0, 0, null, null]);
  const r = details.trades({ ...s, evidence: { tradeCoverage: "partial" }, trades: [
    { time: 10, pnl: 0 }, { time: 12, pnl: 500, side: "short" },
  ] });
  assert.equal(r.outcomes.length, 1);
  assert.equal(r.breakdown.unclassifiedCount, 1);
  assert.deepEqual([r.breakdown.all.flat, r.breakdown.all.largestWinner, r.breakdown.all.largestLoser], [1, null, null]);
  assert.match(r.reason, /partial/i);
});

test("concentration stays defined when a winning subtotal exceeds the number range", () => {
  const s = series([0, 10], [100, 101], { trades: [
    { time: 1, side: "long", pnl: 1e308 }, { time: 2, side: "long", pnl: 1e308 }, { time: 3, pnl: -1e308 },
  ] });
  const { all } = details.trades(s).breakdown;
  assert.equal(all.grossProfit, null);
  near(all.profitFactor, 2);
  near(all.largestWinnerShare, 0.5);
  near(all.largestLoserShare, 1);
});

test("offsetting large trades preserve a small recorded net profit", () => {
  const s = series([0, 10], [100, 101], { trades: [2 ** 52, 0.25, -(2 ** 52)].map((pnl, i) =>
    ({ time: i + 1, pnl, side: "long" })) });
  const r = details.trades(s);
  assert.equal(r.breakdown.all.netPnl, 0.25);
  assert.equal(r.bySide.long.pnl, 0.25);
  near(r.expectancy, 0.25 / 3);
});

test("gain-to-pain uses signed arithmetic returns and log return uses actual endpoint equity", () => {
  const a = { returns: { values: [0.25, -0.125, null, -0.0625, 0] },
    summary: { startEquity: 100, endEquity: 125 } };
  const r = details.returnMeasures(a);
  near(r.gainToPain, (0.25 - 0.125 - 0.0625) / 0.1875);
  near(r.cumulativeLogReturn, Math.log(1.25));
  assert.equal(r.validReturns, 4);
  for (const endEquity of [0, -5, null]) {
    assert.equal(details.returnMeasures({ ...a, summary: { startEquity: 100, endEquity } }).cumulativeLogReturn, null);
  }
  const raw = values => details.returnMeasures({ ...a, returns: { values } }).gainToPain;
  assert.equal(raw([null, 0, 0.1]), null);
  assert.equal(raw([-0.2, -0.1, 0]), -1);
  assert.equal(raw([0.125, -0.125]), 0);
  near(raw([1e308, 1e308, -1e308]), 1);
  near(details.returnMeasures({ ...a, summary: { startEquity: 1e-300, endEquity: 1e300 } }).cumulativeLogReturn, 600 * Math.LN10);
});

test("monthly amounts use the same actual opening as the percent, including partial date selections", () => {
  const s = series(["2024-01-31", "2024-02-15", "2024-02-29", "2024-03-01", "2024-03-29"].map(utc),
    [100, 120, 150, 135, 162]);
  function amounts(opts) { return details.monthlyAmounts(s, analyze(s, opts)); }
  const full = amounts();
  assert.equal(full.unit, "USD");
  assert.deepEqual(full.months.map(m => [m.year, m.month, m.amount]), [[2024, 2, 50], [2024, 3, 12]]);
  const cut = amounts({ start: s.times[2], end: s.times[3] });
  assert.deepEqual(cut.months.map(m => m.amount), [30, -15]);
  near(cut.months[0].return, 0.25);
  near(cut.months[1].return, -0.1);
  assert.deepEqual(amounts({ start: s.times.at(-1) + 1 }).months, []);
});

test("monthly amounts distinguish index points and per-unit NAV from account P&L", () => {
  const s = series([0, 1000], [80, 88], { kind: "benchmark", currency: "INDEX" });
  const index = details.monthlyAmounts(s, analyze(s));
  assert.equal(index.unit, "index points");
  assert.equal(index.months[0].amount, 8);
  const unitized = { ...s, currency: "EUR", accounting: "Unitized NAV per share" };
  assert.equal(details.monthlyAmounts(unitized, analyze(unitized)).unit, "EUR per unit");
});

test("a stale monthly opening cannot fabricate P&L, including a terminal write-off", () => {
  const s = series(["2024-01-03", "2024-03-05", "2024-03-07"].map(utc), [100, 53, 0]);
  const a = details.monthlyAmounts(s, analyze(s));
  assert.deepEqual(a.months.map(m => [m.return, m.amount]), [[-1, -53]]);
  const sparse = series([monthEnd(0), monthEnd(12)], [100, 140], { frequency: "annual", periodsPerYear: 1 });
  assert.deepEqual(details.monthlyAmounts(sparse, analyze(sparse)).months.map(m => m.amount), [null]);
});

test("an exchange closure across a whole calendar month can preserve a funded opening", () => {
  const days = ["2024-01-03", "2024-03-05", "2024-03-07"];
  const s = series(days.map(utc), [100, 53, 0], { frequency: "daily", periodsPerYear: 252, sessionDates: days });
  const a = details.monthlyAmounts(s, analyze(s));
  assert.deepEqual(a.months.map(m => [m.return, m.amount]), [[-1, -100]]);
});

test("profitable 6, 12 and 18 month windows count each eligible close once and keep flats in the denominator", () => {
  const values = Array.from({ length: 25 }, (_, i) => 100 + ((i * i + 3 * i) % 7) * 5);
  const s = series(values.map((_, i) => monthEnd(i)), values);
  for (const months of [6, 12, 18]) {
    const r = details.profitableWindows(analyze(s, { months }), months);
    const diffs = values.slice(months).map((v, i) => v - values[i]);
    const positive = diffs.filter(v => v > 0).length, flat = diffs.filter(v => v === 0).length;
    assert.deepEqual([r.profitable, r.flat, r.eligible, r.excluded], [positive, flat, diffs.length, months - 1]);
    near(r.rate, positive / diffs.length);
  }
});

test("a gap disqualifies spanning windows but a window may open at the first mark after a gap", () => {
  const indices = Array.from({ length: 16 }, (_, i) => i).filter(i => i !== 4);
  const s = series(indices.map(monthEnd), indices.map(i => 100 + i));
  const a = analyze(s, { months: 6 });
  assert.ok(Number.isFinite(a.rolling.return[a.rolling.times.indexOf(monthEnd(6))]));
  const r = details.profitableWindows(a, 6);
  assert.deepEqual([r.profitable, r.eligible, r.rate], [5, 5, 1]);
  assert.equal(r.gapped, 4);
  const cut = analyze(s, { start: monthEnd(11), end: monthEnd(13), months: 6 });
  const short = details.profitableWindows(cut, 6);
  assert.deepEqual([short.eligible, short.rate], [0, null]);
  assert.match(short.reason, /window|history|coverage/i);
});

test("monthly cutoff inside an unfinished month does not turn a short span into six months", () => {
  const times = [0, 1, 2, 3, 4, 5].map(monthEnd).concat(utc("2023-07-03"));
  const s = series(times, times.map((_, i) => 100 + i));
  assert.equal(details.profitableWindows(analyze(s, { months: 6 }), 6).eligible, 0);
  const annual = series([monthEnd(11), monthEnd(23), monthEnd(35)], [100, 90, 120], { frequency: "annual", periodsPerYear: 1 });
  assert.equal(details.profitableWindows(analyze(annual, { months: 6 }), 6).rate, null);
  near(details.profitableWindows(analyze(annual, { months: 12 }), 12).rate, 0.5);
});

test("an early January funding mark and a late July close cannot measure a six-month holding period", () => {
  const times = [utc("2023-01-03"), ...[1, 2, 3, 4, 5, 6].map(monthEnd)];
  const s = series(times, times.map((_, i) => 100 + i));
  const r = details.profitableWindows(analyze(s, { months: 6 }), 6);
  assert.equal(r.rate, null);
  assert.equal(r.eligible, 0);
});

test("daily window coverage distinguishes a missing declared session from an exchange holiday", () => {
  const sessions = [], times = [], equity = [], omitted = utc("2024-04-10");
  for (let t = utc("2024-01-01"); t <= utc("2024-10-15"); t += 86_400_000) {
    sessions.push(new Date(t).toISOString().slice(0, 10));
    if (t !== omitted) {
      times.push(t);
      equity.push(100 + times.length);
    }
  }
  const evaluate = sessionDates => details.profitableWindows(analyze(series(times, equity,
    { frequency: "daily", periodsPerYear: 252, sessionDates }), { months: 6 }), 6);
  const gapped = evaluate(sessions);
  assert.deepEqual([gapped.profitable, gapped.eligible, gapped.rate], [5, 5, 1]);
  assert.equal(gapped.gapped, 101); // October 10 also lacks its required opening valuation.
  const covered = evaluate(sessions.filter(date => date !== "2024-04-10"));
  assert.equal(covered.gapped, 0);
  assert.equal(covered.eligible, 107); // July 1 through October 15, inclusive.
});
