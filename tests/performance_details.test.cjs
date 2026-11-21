const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const folder = path.resolve(__dirname, "../lab/performance");
const modulePath = path.join(folder, "details.js");
const day = i => Date.UTC(2024, 0, 1 + i, 16);
const month = i => Date.UTC(2024, i, 0, 16);

function curve(id, times, returns, extra = {}) {
  const equity = [128];
  for (const r of returns) equity.push(equity.at(-1) * (1 + r));
  assert.equal(times.length, equity.length);
  return {
    id, name: id.toUpperCase(), kind: "strategy", times, equity,
    frequency: "daily", periodsPerYear: 252, currency: "USD", ...extra
  };
}

function close(actual, expected) {
  assert.equal(typeof actual, "number");
  assert.ok(Math.abs(actual - expected) < 1e-10 * Math.max(1, Math.abs(expected)),
    `expected ${expected}, got ${actual}`);
}

test("exports the same callable API in Node and in a browser without a module loader", () => {
  assert.ok(fs.existsSync(modulePath), "The details module is available");
  const details = require(modulePath);
  const browser = vm.createContext({});
  vm.runInContext("globalThis.window = globalThis", browser);
  vm.runInContext(fs.readFileSync(modulePath, "utf8"), browser);
  for (const name of ["benchmark", "correlationMatrix", "strategyGroups", "attribution", "trades", "tails", "evidenceCoverage"]) {
    assert.equal(typeof details[name], "function");
    assert.equal(typeof browser.PerformanceDetails[name], "function");
  }
});

test("trade statistics use signed realized P&L and inclusive close times", () => {
  const series = curve("a", [0, 100], [0], {
    trades: [
      { time: 80, pnl: -4, side: "Short", holdingHours: 6 },
      { time: 20, pnl: 8, side: " LONG ", holdingHours: 0 },
      { time: 30, pnl: 4, side: "long", holdingHours: 3 },
      { time: 35, pnl: 0 }, { time: 40, pnl: -2, side: "short", holdingHours: -1 },
      { time: 85, pnl: 999 }, { time: 5, pnl: -999 }, { time: 55, pnl: null },
      { time: null, pnl: 100 }, { time: 50, pnl: "99" }
    ],
    tradeSummary: { count: 500, profitFactor: 20 }
  });
  const original = structuredClone(series);
  const r = require(modulePath).trades(series, { start: 20, end: 80 });
  assert.deepEqual([r.count, r.wins, r.losses, r.flat], [5, 2, 2, 1]);
  assert.deepEqual([r.avgWin, r.avgLoss, r.best, r.worst], [6, -3, 8, -4]);
  assert.deepEqual([r.winStreak, r.lossStreak, r.meanHoldingHours], [2, 2, 3]);
  close(r.winRate, 2 / 5);
  close(r.expectancy, 6 / 5);
  close(r.profitFactor, 2);
  close(r.payoff, 2);
  assert.equal(r.bySide.long.count, 2);
  assert.equal(r.bySide.long.pnl, 12);
  assert.equal(r.bySide.short.winRate, 0);
  assert.equal(r.bySide.unknown.flat, 1);
  assert.deepEqual(r.bins, [
    { lower: -4, upper: 0, count: 2 }, { lower: 0, upper: 4, count: 1 },
    { lower: 4, upper: 8, count: 2 }
  ]);
  assert.deepEqual(series, original);
});

test("ties retain source order, flats break streaks, and absent denominators give null", () => {
  const details = require(modulePath);
  const series = curve("a", [0, 100], [0], { trades: [
    { time: 5, pnl: 1 }, { time: 5, pnl: 0 }, { time: 5, pnl: 1 },
    { time: 6, pnl: 1, side: "__proto__" }
  ] });
  const r = details.trades(series);
  assert.equal(r.winStreak, 2);
  assert.equal(r.lossStreak, 0);
  assert.deepEqual([r.avgLoss, r.profitFactor, r.payoff, r.meanHoldingHours], [null, null, null, null]);
  assert.equal(r.bySide.__proto__.count, 1);
  const one = details.trades(series, { start: 6, end: 6 });
  assert.deepEqual(one.bins, [{ lower: 1, upper: 1, count: 1 }]);
  assert.equal(one.winRate, 1);
});

test("trade ranges stop at the first nonpositive mark, including the exit at that mark", () => {
  const series = curve("a", [0, 10, 20, 30], [0, 0, 0], {
    equity: [100, 120, -10, 500],
    trades: [-1, 10, 20, 21, 30].map(time => ({ time, pnl: time }))
  });
  assert.deepEqual(require(modulePath).trades(series).count, 2);
  const empty = require(modulePath).trades(series, { start: 21 });
  assert.equal(empty.count, 0);
  assert.equal(empty.expectancy, null);
  assert.ok(empty.reason);
});

test("reports a missing ledger and never substitutes a full-history trade summary", () => {
  const series = curve("a", [0, 10], [0], { tradeSummary: { count: 100, winRate: 0.4 } });
  const r = require(modulePath).trades(series, { end: 5 });
  assert.equal(r.count, 0);
  assert.deepEqual([r.winRate, r.best, r.worst, r.payoff], [null, null, null, null]);
  assert.deepEqual(r.bins, []);
  assert.match(r.reason, /dated/i);
});

test("monthly CAPM uses an effective annual cash rate and sample tracking error", () => {
  const dates = [0, 1, 2, 3, 4].map(month);
  const br = [1 / 8, -1 / 8, 1 / 4, -1 / 4];
  const meta = { frequency: "monthly", periodsPerYear: 12 };
  const a = curve("a", dates, br.map(r => 1 / 32 + r / 2), meta);
  const b = curve("b", dates, br, { ...meta, kind: "benchmark" });
  const r = require(modulePath).benchmark(a, b, { riskFree: 0.12, rollingWindow: 3 });
  assert.equal(r.count, 4);
  close(r.correlation, 1);
  close(r.beta, 0.5);
  close(r.alpha, 12 * (1 / 32 - 0.5 * (Math.pow(1.12, 1 / 12) - 1)));
  close(r.trackingError, Math.sqrt(5 / 32));
  close(r.informationRatio, (12 / 32) / Math.sqrt(5 / 32));
  close(r.upCapture, 2 / 3);
  close(r.downCapture, 1 / 3);
  assert.deepEqual(r.rolling.times, dates.slice(1));
  assert.deepEqual(r.rolling.correlation.slice(0, 2), [null, null]);
  r.rolling.correlation.slice(2).forEach(x => close(x, 1));
});

test("a shared close qualifies only when both previous actual closes also match", () => {
  const a = curve("a", [0, 1, 2, 3, 4, 5].map(day), [0.5, 0, -0.5, 0.125, -0.25]);
  const b = curve("b", [1, 3, 4, 5, 6].map(day), [1, -0.125, 0.25, 1]);
  const r = require(modulePath).benchmark(a, b);
  assert.equal(r.count, 2);
  close(r.correlation, -1);
  assert.deepEqual(r.coverage, {
    start: day(3), end: day(5), segments: 1, seriesCount: 5, benchmarkCount: 4,
    seriesFraction: 2 / 5, benchmarkFraction: 2 / 4
  });
  const cut = require(modulePath).benchmark(a, b, { start: day(5), end: day(5) });
  assert.equal(cut.count, 1);
  assert.deepEqual([cut.coverage.start, cut.coverage.end, cut.correlation], [day(4), day(5), null]);
});

test("rolling correlation restarts after a gap and uses only observations at or before the close", () => {
  const a = curve("a", [0, 1, 2, 3, 4, 5, 6].map(day), [0.1, -0.2, 0.3, -0.1, 0.25, -0.3]);
  const b = curve("b", [0, 1, 2, 4, 5, 6].map(day), [0.2, -0.4, 0.2, -0.2, 0.2]);
  const run = end => require(modulePath).benchmark(a, b, { rollingWindow: 2, end });
  const full = run(day(6));
  assert.equal(full.coverage.segments, 2);
  assert.deepEqual(full.rolling.times, [1, 2, 5, 6].map(day));
  assert.equal(full.rolling.correlation[0], null);
  close(full.rolling.correlation[1], 1);
  assert.equal(full.rolling.correlation[2], null);
  close(full.rolling.correlation[3], -1);
  assert.deepEqual(run(day(2)).rolling.correlation, full.rolling.correlation.slice(0, 2));
});

test("flat, missing, incompatible, and disjoint comparisons retain only defined quantities", () => {
  const { benchmark } = require(modulePath);
  const dates = [0, 1, 2, 3].map(day);
  const a = curve("a", dates, [0.25, 0.125, -0.25]);
  const flat = curve("flat", dates, [0, 0, 0]);
  const x = benchmark(a, flat);
  assert.equal(x.count, 3);
  assert.deepEqual([x.correlation, x.beta, x.alpha, x.upCapture, x.downCapture], Array(5).fill(null));
  assert.ok(x.trackingError > 0);
  assert.equal(benchmark(flat, a).beta, 0);
  const identical = benchmark(a, a);
  assert.equal(identical.trackingError, 0);
  assert.equal(identical.informationRatio, null);
  for (const other of [null, { ...a, frequency: "weekly", periodsPerYear: 52 },
    curve("later", [5, 6].map(day), [0])]) {
    const r = benchmark(a, other);
    assert.equal(r.count, 0);
    assert.deepEqual([r.coverage.start, r.coverage.end, r.correlation], [null, null, null]);
    assert.ok(r.reason);
  }
});

test("holding filters and family groups use strategy IDs and declared families", () => {
  const { correlationMatrix, strategyGroups } = require(modulePath);
  const dates = [0, 1, 2, 3].map(day);
  const a = curve("a", dates, [0.25, -0.125, 0.25], { family: "trend" });
  const b = curve("b", dates, [-0.125, 0.0625, -0.125], { family: "trend" });
  const c = curve("c", dates, [0, 0, 0]);
  const portfolio = { id: "p", kind: "portfolio", holdings: [
    { id: "a", weight: 0.8 }, { id: "b", weight: -0.2 }, { id: "c", weight: 0 },
    { id: "unknown", weight: 1 }
  ] };
  const all = [portfolio, a, c, { ...a, id: "ref", kind: "benchmark" }, b];
  const selected = { portfolio, ids: ["b", "c", "b", "p", "ref", "a"] };
  const matrix = correlationMatrix(all, selected);
  assert.deepEqual(matrix.ids, ["b", "a"]);
  assert.deepEqual(matrix.names, ["B", "A"]);
  assert.deepEqual(matrix.counts, [[3, 3], [3, 3]]);
  close(matrix.values[0][0], 1);
  close(matrix.values[0][1], -1);
  assert.equal(matrix.values[0][1], matrix.values[1][0]);
  assert.deepEqual(strategyGroups(all, selected), [{ family: "trend", ids: ["b", "a"] }]);
  assert.deepEqual(strategyGroups(all), [
    { family: "trend", ids: ["a", "b"] }, { family: "Unspecified", ids: ["c"] }
  ]);
  assert.deepEqual(correlationMatrix(all, { ids: [] }).ids, []);
  assert.deepEqual(correlationMatrix(all, { portfolio: { holdings: [] } }).ids, []);
});

test("each matrix cell has its own count and constant diagonals stay unavailable", () => {
  const { correlationMatrix } = require(modulePath);
  const a = curve("a", [0, 1, 2, 3].map(day), [0.1, -0.2, 0.3]);
  const b = curve("b", [0, 2, 3].map(day), [-0.1, 0.3]);
  const c = curve("c", [0, 1, 2].map(day), [0, 0]);
  const m = correlationMatrix([a, b, c]);
  assert.deepEqual(m.counts, [[3, 1, 2], [1, 2, 0], [2, 0, 2]]);
  assert.deepEqual(m.values, [[1, null, null], [null, 1, null], [null, null, null]]);
});

test("cost and capacity coverage requires explicit measured inputs and preserves source scope", () => {
  const { evidenceCoverage } = require(modulePath);
  const series = curve("a", [0, 100], [0.125], {
    source: "run 14", costModel: "Broker fee schedule",
    tradeSummary: { count: 17 }, evidence: { capacity: { capital: 1000000 } }
  });
  const lookup = s => Object.fromEntries(evidenceCoverage(s).map(row => [row.id, row]));
  let rows = lookup(series);
  assert.equal(rows.trades.available, false);
  assert.equal(rows.tradeSummary.available, true);
  assert.equal(rows.tradeSummary.scope, "source");
  assert.equal(rows.costs.available, false);
  assert.equal(rows.capacity.available, false);
  assert.ok(rows.capacity.missing.some(label => /volume/i.test(label)));
  assert.ok(rows.capacity.missing.some(label => /impact/i.test(label)));
  series.costs = { commission: 0, unit: "USD" };
  series.evidence.capacity = {
    capital: 1000000, maxParticipation: 0.01, ordersSource: "orders.csv",
    volumeSource: "prior daily volume", impactModel: "size vs filled price",
    source: "capacity test 14"
  };
  rows = lookup(series);
  assert.equal(rows.costs.available, true);
  assert.equal(rows.capacity.available, true);
  assert.equal(rows.capacity.scope, "source");
  assert.deepEqual(rows.capacity.missing, []);
  assert.equal(lookup({ ...series, costs: { commission: "unknown" } }).costs.available, false);
});

test("research coverage needs a dated or named source, settings, and a measured result", () => {
  const { evidenceCoverage } = require(modulePath);
  const record = { family: "costs", status: "run", seed: 0, source_data: "baseline.csv",
    cost_model: "commissions doubled", settings: { multiplier: 2 }, metrics: { netReturn: 0 } };
  const row = (results, family) => evidenceCoverage({ evidence: { results } })
    .find(item => item.family === family);
  assert.equal(row([record], "costs").available, true);
  assert.equal(row({ costs: { results: [record] } }, "costs").available, true);
  assert.equal(row([{ ...record, metrics: { netReturn: null } }], "costs").available, false);
  assert.equal(row([{ ...record, settings: {} }], "costs").available, false);
  assert.equal(row([record], "monte_carlo").available, false);
  const omitted = row([{ family: "shuffle", status: "not_run", reason: "Order log missing" }], "shuffle");
  assert.equal(omitted.available, false);
  assert.equal(omitted.reason, "Order log missing");
});

test("tails use population moments, linear percentiles and a per-period Omega target", () => {
  const { tails } = require(modulePath);
  const values = [0.5, -0.25, null, 0, "0.3", 0.25, -0.5, Infinity, NaN];
  const original = values.slice();
  const t = tails(values, 0.125);
  close(t.skewness, 0);
  close(t.excessKurtosis, -1.3);
  close(t.omega, 0.5 / 1.125);
  close(t.tailRatio, 1);
  close(t.median, 0);
  assert.deepEqual(values, original);
  const asymmetric = tails([-0.2, -0.1, 0.1, 0.5]);
  close(asymmetric.median, 0);
  close(asymmetric.tailRatio, 0.44 / 0.185);
  assert.ok(asymmetric.skewness > 0);
});

test("tails keep undefined values distinct from observed zeros", () => {
  const { tails } = require(modulePath);
  assert.deepEqual(tails([]), { skewness: null, excessKurtosis: null, omega: null, tailRatio: null, median: null });
  assert.deepEqual(tails([0, 0, 0, 0]), { skewness: null, excessKurtosis: null, omega: null, tailRatio: null, median: 0 });
  const two = tails([-0.25, -0.125]);
  assert.equal(two.omega, 0);
  assert.equal(two.skewness, null);
  assert.equal(two.excessKurtosis, null);
  assert.equal(tails([0.1, 0.25]).omega, null);
});

test("currency and declared sampling must match, including the annualization basis", () => {
  const { benchmark, correlationMatrix } = require(modulePath);
  const a = curve("a", [0, 1, 2, 3].map(day), [0.125, 0, -0.25]);
  for (const [changes, reason] of [
    [{ currency: "INDEX" }, /currency/i], [{ currency: "EUR" }, /currency/i],
    [{ currency: "" }, /currency/i], [{ periodsPerYear: 365 }, /sampling|periods/i]
  ]) {
    const b = { ...a, id: "b", ...changes };
    const result = benchmark(a, b);
    assert.equal(result.correlation, null);
    assert.equal(result.count, 0);
    assert.match(result.reason, reason);
    const matrix = correlationMatrix([a, b]);
    assert.equal(matrix.values[0][1], null);
    assert.equal(matrix.counts[0][1], 0);
  }
  const index = { ...a, currency: "INDEX" };
  close(benchmark(index, index).correlation, 1);
});

function funded() {
  const t = [day(0), day(1) - 3600000, day(1), day(2), day(3)];
  const a = curve("a", t, [0, 0, 0, 0], { equity: [60, 45, 70, 62, 73] });
  const b = { ...a, id: "b", name: "B", equity: [40, 50, 38, 41, 36] };
  const p = { ...a, id: "p", kind: "portfolio", equity: [100, 95, 108, 103, 109],
    holdings: [{ id: "a", weight: 0.01 }, { id: "b", weight: 0.99 }],
    evidence: { attribution: { basis: "funded_equity", members: ["a", "b"] } } };
  return { a, b, p };
}

test("funded attribution reconciles raw marks and computes risk from sampled portfolio intervals", () => {
  const { attribution } = require(modulePath);
  const { a, b, p } = funded();
  const { rows } = attribution(p, [p, b, a]);
  assert.deepEqual(rows.map(r => [r.id, r.name]), [["a", "A"], ["b", "B"]]);
  close(rows[0].returnContribution, 0.13);
  close(rows[1].returnContribution, -0.04);
  const x = [10 / 100, -8 / 108, 11 / 103];
  const y = [8 / 100, -5 / 108, 6 / 103];
  const mean = v => v.reduce((a, b) => a + b) / v.length;
  const mx = mean(x), my = mean(y);
  const riskA = x.reduce((sum, v, i) => sum + (v - mx) * (y[i] - my), 0) /
    y.reduce((sum, v) => sum + (v - my) ** 2, 0);
  close(rows[0].riskShare, riskA);
  close(rows[1].riskShare, 1 - riskA);
  assert.ok(rows[1].riskShare < 0);
  const cut = attribution(p, [a, b], { start: day(2), end: day(2) });
  close(cut.rows[0].returnContribution, -8 / 108);
  assert.equal(cut.rows[0].riskShare, null);
  assert.ok(cut.reason);
});

test("attribution requires an explicit funded basis, valid members, and exact marks", () => {
  const { attribution } = require(modulePath);
  const { p, a, b } = funded();
  const members = ids => ({ ...p, evidence: { attribution: { basis: "funded_equity", members: ids } } });
  for (const [book, all] of [
    [{ ...p, evidence: {} }, [a, b]], [{ ...p, kind: "strategy" }, [a, b]],
    [members(["a", "a"]), [a, b]], [members(["a", "absent"]), [a, b]],
    [p, [a, { ...b, kind: "benchmark" }]], [p, [a, { ...b, currency: "EUR" }]],
    [p, [a, { ...b, frequency: "weekly", periodsPerYear: 52 }]],
    [p, [a, { ...b, times: b.times.map((t, i) => i === 1 ? t + 1 : t) }]],
    [p, [a, { ...b, equity: [40, 51, 38, 41, 36] }]],
    [p, [a, { ...b, times: b.times.filter((_, i) => i !== 1), equity: [40, 38, 41, 36] }]],
    [p, [a, { ...b, times: [b.times[0], b.times[0] + 1, ...b.times.slice(1)], equity: [40, 40, ...b.equity.slice(1)] }]]
  ]) {
    const result = attribution(book, all);
    assert.deepEqual(result.rows, []);
    assert.ok(result.reason);
  }
  const futureMismatch = { ...b, equity: [40, 50, 38, 41, 999] };
  assert.equal(attribution(p, [a, futureMismatch], { end: day(2) }).rows.length, 2);
});

test("zero portfolio variance preserves reconciled return contributions", () => {
  const { attribution } = require(modulePath);
  const { p, a, b } = funded();
  const flat = { ...p, equity: p.times.map(() => 100) };
  const offset = { ...b, equity: a.equity.map(x => 100 - x) };
  const result = attribution(flat, [a, offset]);
  assert.deepEqual(result.rows.map(r => r.riskShare), [null, null]);
  close(result.rows[0].returnContribution, 0.13);
  close(result.rows[1].returnContribution, -0.13);
  assert.ok(result.reason);
});

test("date cuts use prior raw marks, and missing samples advance the next interval's opening", () => {
  const { benchmark } = require(modulePath);
  const raw = [day(0), day(1) - 3600000, day(1), day(2), day(5), day(6), day(7)];
  const a = curve("a", raw, [0.25, -0.25, 0.125, 0.5, -0.125, 0.25], { periodsPerYear: 365 });
  const b = { ...a, times: raw.map((t, i) => i === 1 ? t + 60000 : t) };
  const r = benchmark(a, b, { start: day(1), end: day(7), rollingWindow: 2 });
  assert.deepEqual(r.rolling.times, [2, 6, 7].map(day));
  assert.deepEqual(r.rolling.correlation.slice(0, 2), [null, null]);
  close(r.rolling.correlation.at(-1), 1);
  assert.equal(r.coverage.start, day(1));
  assert.equal(r.coverage.segments, 2);
  assert.equal(r.coverage.seriesCount, 4);
  const terminal = { ...a, equity: [...a.equity.slice(0, 5), -20, 999] };
  assert.equal(benchmark(terminal, b).coverage.end, day(6));
  assert.equal(benchmark(terminal, b, { start: day(7) }).count, 0);
});

test("rolling estimates agree with direct covariance across several full windows", () => {
  const n = 96, width = 9;
  const dates = Array.from({ length: n + 1 }, (_, i) => day(i));
  const x = dates.slice(1).map((_, i) => i > 40 && i < 64 ? 0 : ((i * 7) % 19 - 9) / 256);
  const y = dates.slice(1).map((_, i) => ((i * 5) % 13 - 6) / 128);
  const a = curve("a", dates, x), b = curve("b", dates, y);
  const r = require(modulePath).benchmark(a, b, { rollingWindow: width });
  assert.deepEqual(r.rolling.times, dates.slice(1));
  for (let i = 0; i < n; i++) {
    const actual = r.rolling.correlation[i];
    if (i < width - 1) { assert.equal(actual, null); continue; }
    const xx = x.slice(i + 1 - width, i + 1), yy = y.slice(i + 1 - width, i + 1);
    const mx = xx.reduce((sum, v) => sum + v, 0) / width;
    const my = yy.reduce((sum, v) => sum + v, 0) / width;
    const dx = xx.map(v => v - mx), dy = yy.map(v => v - my);
    const dot = (u, v) => u.reduce((sum, value, j) => sum + value * v[j], 0);
    if (dot(dx, dx) === 0) assert.equal(actual, null);
    else close(actual, dot(dx, dy) / Math.sqrt(dot(dx, dx) * dot(dy, dy)));
  }
});

test("a 52-strategy catalogue evaluates only the selected strategies, once each", () => {
  const metrics = require(path.join(folder, "metrics.js"));
  const calls = [];
  const browser = { window: { PerformanceMetrics: {
    analyze(s, opts) { calls.push(s.id); return metrics.analyze(s, opts); }
  } } };
  vm.runInNewContext(fs.readFileSync(modulePath, "utf8"), browser);
  const dates = [0, 1, 2, 3].map(day);
  const all = Array.from({ length: 52 }, (_, i) => curve("s" + i, dates, [0.125, -0.25, 0]));
  const ids = ["s51", "s17", "s29"];
  const result = browser.window.PerformanceDetails.correlationMatrix(all, { ids });
  assert.deepEqual(calls, ids);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), require(modulePath).correlationMatrix(all, { ids }));
});

test("coverage distinguishes recorded cost components, blocked tests, and source replay outcomes", () => {
  const { evidenceCoverage } = require(modulePath);
  const record = { family: "winner_removal", status: "computed_on_fixed_trade_list", seed: "deterministic",
    source_data: "ledger.csv", cost_model: "net fills", settings: { fraction: 0.05 },
    remaining: { net_pnl: 0, count: 9 } };
  const rows = evidenceCoverage({ source: "native ledger", currency: "USD",
    costs: { reportedCost: 14, commissions: 0 },
    evidence: { results: [record, { ...record, status: "blocked", family: "costs", metrics: { return: 0.1 } }] } });
  const get = id => rows.find(row => row.id === id);
  assert.equal(get("research.winner_removal").available, true);
  assert.equal(get("research.costs").available, false);
  assert.equal(get("commission").available, true);
  assert.equal(get("slippage").available, false);
  assert.equal(evidenceCoverage({ source: "native ledger", costs: { currency: "USD", reportedCost: 0 } })
    .find(r => r.id === "costs").available, true);
});

test("reported trade averages and side totals preserve small observed amounts", () => {
  const s = curve("a", [0, 10], [0], { trades: [
    { time: 1, pnl: 1e200, side: "long" }, { time: 2, pnl: -1e-200, side: "short" }
  ] });
  const r = require(modulePath).trades(s);
  assert.equal(r.avgLoss, -1e-200);
  assert.equal(r.bySide.short.pnl, -1e-200);
  assert.equal(r.profitFactor, null);
});

test("a source-declared partial ledger gives observed outcomes and withholds full-ledger streaks", () => {
  const s = curve("a", [0, 10], [0], { trades: [{ time: 1, pnl: 2 }, { time: 2, pnl: 3 }],
    tradeSummary: { closedTrades: 70 }, evidence: { tradeCoverage: "partial" } });
  const r = require(modulePath).trades(s);
  assert.equal(r.count, 2);
  assert.equal(r.expectancy, 2.5);
  assert.equal(r.winStreak, null);
  assert.equal(r.lossStreak, null);
  assert.match(r.reason, /partial/i);
});

test("a trade can close after the last selected equity mark without reading later valuations", () => {
  const s = curve("a", [0, 10, 20], [0, 0], { trades: [{ time: 15, pnl: 2 }] });
  Object.defineProperty(s.equity, 2, { get() { assert.fail("Read a valuation after the cutoff"); } });
  assert.equal(require(modulePath).trades(s, { end: 15 }).count, 1);
});

test("roundoff in a constant growth path does not create a regression exposure", () => {
  const { benchmark } = require(modulePath);
  const dates = [0, 1, 2, 3, 4, 5].map(day);
  const a = curve("a", dates, [0.1, 0.1, 0.1, 0.1, 0.1]);
  const b = curve("b", dates, [0.125, -0.03125, 0.25, -0.25, 0.0625]);
  const r = benchmark(a, b);
  assert.equal(r.correlation, null);
  assert.equal(r.beta, 0);
  close(r.alpha, 252 * 0.1);
});

test("a sleeve cannot resume attribution after a terminal mark", () => {
  const { p, a, b } = funded();
  const sleeve = { ...a, equity: [60, 0, 70, 62, 73] };
  const book = { ...p, equity: sleeve.equity.map((v, i) => v + b.equity[i]) };
  const result = require(modulePath).attribution(book, [sleeve, b], { start: day(2) });
  assert.deepEqual(result.rows, []);
  assert.ok(result.reason);
});

test("placeholders and incomplete records cannot establish cost, capacity or research coverage", () => {
  const { evidenceCoverage } = require(modulePath);
  const record = { family: "costs", status: "failed", seed: "deterministic", source_data: "ledger",
    cost_model: "doubled fees", settings: { multiplier: 2 }, metrics: { net: -1 } };
  const s = { currency: "USD", source: "unknown", costs: { total: 10 }, evidence: {
    capacity: { capital: 1000, ordersSource: "fills", volumeSource: "not recorded",
      maxParticipation: 0.1, impactModel: "impact.csv", source: "run" },
    results: [{ ...record, settings: { multiplier: null } }, { ...record, source_data: "unreported" }]
  } };
  const rows = Object.fromEntries(evidenceCoverage(s).map(r => [r.id, r]));
  for (const id of ["costs", "capacity", "research.costs"]) assert.equal(rows[id].available, false, id);
});

test("a supplied session calendar governs the actual returns used by both pair APIs", () => {
  const { benchmark, correlationMatrix } = require(modulePath);
  const calendar = ["2024-01-01", "2024-01-02", "2024-01-04", "2024-01-15", "2024-01-16"];
  const a = curve("a", [0, 1, 3, 14, 15].map(day), [0.125, -0.25, 0.0625, 0.25], { sessionDates: calendar });
  const b = { ...a, id: "b", sessionDates: [...calendar.slice(0, 3), "2024-01-10", ...calendar.slice(3)] };
  const r = benchmark(a, b);
  assert.equal(r.count, 3);
  assert.equal(r.coverage.segments, 2);
  assert.equal(r.coverage.seriesCount, 4);
  assert.equal(r.coverage.benchmarkCount, 3);
  assert.deepEqual(correlationMatrix([a, b]).counts, [[4, 3], [3, 3]]);
});
