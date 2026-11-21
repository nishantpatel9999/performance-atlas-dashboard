const test = require("node:test");
const assert = require("node:assert/strict");
const { attribution } = require("../lab/performance/details.js");

const start = Date.UTC(2024, 0, 1);
const day = 86400000;
const close = n => start + n * day - 1;
const near = (actual, expected) => {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-11,
    `expected ${expected}, received ${actual}`);
};

function book(opening = 100, currency = "INDEX") {
  return {
    id: "p", name: "Synthetic paper book", kind: "portfolio", currency,
    frequency: "daily", periodsPerYear: 365, times: [start, close(1), close(2), close(3)],
    equity: [1, 1.1, 1.05, 1.2].map(v => v * opening),
    holdings: [{ id: "a", weight: 0.99 }, { id: "b", weight: 0.01 }],
    evidence: {
      attribution: { basis: "paper_additive", unit: "fraction of the opening paper index",
        members: { a: { returnContribution: 0.18, meanRollingVarianceShare: 0.99 },
          b: { returnContribution: 0.02, meanRollingVarianceShare: 0.01 } } },
      paperContributions: { unit: "fraction of opening paper index",
        dates: ["2024-01-01", "2024-01-02", "2024-01-03"],
        byMember: { a: [0.12, -0.04, 0.10], b: [-0.02, -0.01, 0.05] } }
    }
  };
}

function varianceShare(parts, returns) {
  const mean = xs => xs.reduce((sum, x) => sum + x) / xs.length;
  const partMean = mean(parts), bookMean = mean(returns);
  return parts.reduce((sum, x, i) => sum + (x - partMean) * (returns[i] - bookMean), 0) /
    returns.reduce((sum, y) => sum + (y - bookMean) ** 2, 0);
}

test("paper P&L includes the first close, scales to either book unit, and uses selected opening equity", () => {
  for (const [opening, unit] of [[100, "INDEX"], [100000, "USD"]]) {
    const p = book(opening, unit);
    const names = [{ kind: "strategy", id: "a", name: "Alpha", equity: [9000, 1] }];
    const full = attribution(p, names);
    assert.deepEqual(full.rows.map(r => r.name), ["Alpha", "b"]);
    near(full.rows[0].returnContribution, 0.18);
    near(full.rows[1].returnContribution, 0.02);
    const x = [0.12, -0.04 / 1.1, 0.10 / 1.05];
    const y = [0.10, -0.05 / 1.1, 0.15 / 1.05];
    near(full.rows[0].riskShare, varianceShare(x, y));
    near(full.rows[1].riskShare, 1 - varianceShare(x, y));
    const cut = attribution(p, names, { start: start + day, end: close(3) });
    assert.equal(cut.openingTime, close(1));
    assert.equal(cut.closingTime, close(3));
    near(cut.portfolioReturn, 0.10 / 1.1);
    near(cut.rows[0].returnContribution, 0.06 / 1.1);
    near(cut.rows[1].returnContribution, 0.04 / 1.1);
    near(cut.rows[0].riskShare, varianceShare(x.slice(1), y.slice(1)));
    near(cut.rows[0].riskShare + cut.rows[1].riskShare, 1);
  }
});

test("one close, zero variance and opening-only selections preserve the available evidence", () => {
  const p = book();
  const first = attribution(p, [], { start, end: close(1) });
  near(first.rows[0].returnContribution, 0.12);
  near(first.rows[1].returnContribution, -0.02);
  assert.deepEqual(first.rows.map(r => r.riskShare), [null, null]);
  assert.match(first.reason, /interval|variation|variance/i);
  const onlyOpening = attribution(p, [], { start, end: start });
  assert.deepEqual(onlyOpening.rows, []);
  assert.match(onlyOpening.reason, /clos/i);
  const flat = book();
  flat.equity.fill(100);
  delete flat.evidence.attribution.members;
  flat.evidence.paperContributions.byMember = { a: [0.02, 0, -0.02], b: [-0.02, 0, 0.02] };
  const result = attribution(flat, []);
  assert.deepEqual(result.rows.map(r => r.riskShare), [null, null]);
  assert.deepEqual(result.rows.map(r => r.returnContribution), [0, 0]);
});

test("daily and whole-book reconciliation are independent, even for a filtered request", () => {
  const offset = book();
  offset.evidence.paperContributions.byMember.a = [0.13, -0.05, 0.10];
  const invalid = attribution(offset, [], { start: close(3), end: close(3) });
  assert.deepEqual(invalid.rows, []);
  assert.match(invalid.reason, /2024-01-01/);
  const drift = book();
  delete drift.evidence.attribution.members;
  drift.evidence.paperContributions.byMember.a = [0.12, -0.04, 0.10].map(n => n + 0.6e-10);
  const accumulated = attribution(drift, []);
  assert.deepEqual(accumulated.rows, []);
  assert.match(accumulated.reason, /full|whole/i);
  const localDrift = book();
  localDrift.evidence.paperContributions.byMember.a = [0.12 + 0.9e-10, -0.04 + 0.9e-10, 0.10 - 0.9e-10];
  const cut = attribution(localDrift, [], { end: close(2) });
  assert.deepEqual(cut.rows, []);
  assert.match(cut.reason, /selected opening equity/i);
});

test("missing, contradictory and misaligned paper records give a reason without a funded fallback", () => {
  const changes = [
    e => { delete e.paperContributions; },
    e => { e.paperContributions.unit = "USD"; },
    e => { e.attribution.unit = "percent"; },
    e => { e.attribution.end = "2024-02-01"; },
    e => { e.paperContributions.dates[1] = "2024-01-01"; },
    e => { e.paperContributions.dates.pop(); },
    e => { e.paperContributions.byMember.a.pop(); },
    e => { e.paperContributions.byMember.a[0] = null; },
    e => { e.paperContributions.byMember.a[0] = "0.12"; },
    e => { delete e.attribution.members.a; },
    e => { e.attribution.members.a.returnContribution = 0.20; },
    e => { delete e.attribution; },
  ];
  for (const change of changes) {
    const p = book();
    change(p.evidence);
    const result = attribution(p, []);
    assert.deepEqual(result.rows, []);
    assert.ok(result.reason);
  }
});

test("risk uses the shared sampler across a gap while selected P&L includes every recorded close", () => {
  const p = book();
  p.times[2] = close(5);
  p.times[3] = close(6);
  p.evidence.paperContributions.dates = ["2024-01-01", "2024-01-05", "2024-01-06"];
  const full = attribution(p, []);
  near(full.rows[0].returnContribution, 0.18);
  near(full.rows[0].riskShare, varianceShare([0.12, 0.10 / 1.05], [0.10, 0.15 / 1.05]));
  assert.equal(full.riskIntervals, 2);
});

test("a hedging member can have a negative variance share", () => {
  const p = book();
  delete p.evidence.attribution.members;
  p.evidence.paperContributions.byMember = { trend: [0.20, -0.10, 0.30], hedge: [-0.10, 0.05, -0.15] };
  const result = attribution(p, []);
  near(result.rows[0].riskShare, 2);
  near(result.rows[1].riskShare, -1);
  near(result.rows[1].returnContribution, -0.20);
});
