const test = require("node:test");
const assert = require("node:assert/strict");
const { correlationMatrix, benchmark } = require("../lab/performance/details.js");

const day = 86400000;
function series(id, days, returns, extra = {}) {
  const equity = [128];
  for (const rate of returns) equity.push(equity.at(-1) * (1 + rate));
  return { id, name: id, kind: "strategy", currency: "USD", frequency: "daily",
    periodsPerYear: 365, times: days.map(d => d * day), equity, ...extra };
}

const a = series("First", [0, 1, 2, 3, 4], [0.125, -0.125, 0.25, -0.25]);
function pair(b, opts = {}) {
  const m = correlationMatrix([a, b], { diagnostics: true, ...opts });
  return { count: m.counts[0][1], value: m.values[0][1], ...m.diagnostics[0][1] };
}

test("pair diagnostics separate incompatible units, empty windows, endpoint mismatch and constant returns", () => {
  for (const [b, expected, n] of [
    [{ ...a, id: "eu", currency: "EUR" }, /currency/i, 0],
    [{ ...a, id: "weekly", frequency: "weekly", periodsPerYear: 52 }, /sampling|frequency/i, 0],
    [series("Later", [6, 7, 8], [0.1, -0.2]), /overlap/i, 0],
    [series("Shift", [0.5, 1.5, 2.5], [0.25, -0.125]), /opening and closing/i, 0],
    [series("Short", [2, 3], [0.125]), /two shared/i, 1],
    [series("Flat", [0, 1, 2, 3, 4], [0, 0, 0, 0]), /Flat.*constant|constant.*Flat/i, 4]
  ]) {
    const r = pair(b);
    assert.equal(r.value, null);
    assert.equal(r.count, n);
    assert.match(r.reason, expected);
  }
  const outside = pair({ ...a, id: "copy" }, { start: 10 * day });
  assert.match(outside.reason, /no .*marks/i);
  assert.equal(outside.count, 0);
});

test("gaps, sparse pairs and valid pairs keep their own count and actual matched bounds", () => {
  const b = series("Peer", [0, 1, 3, 4], [-0.125, 0.875, 0.25]);
  const r = pair(b);
  assert.equal(r.count, 2);
  assert.ok(Math.abs(r.value + 1) < 1e-11);
  assert.equal(r.reason, null);
  assert.equal(r.start, 0);
  assert.equal(r.end, 4 * day);
  assert.equal(r.segments, 2);
  assert.match(r.note, /gap/i);
  assert.match(r.note, /two|2 shared/i);
  assert.match(r.note, /4 usable returns for First/);
  assert.match(r.note, /2 usable returns for Peer/);
  const cut = pair(b, { start: 3 * day, end: 4 * day });
  assert.equal(cut.count, 1);
  assert.equal(cut.start, 3 * day);
  assert.equal(cut.value, null);
  const onlyGap = pair(series("Gapped", [0, 4], [0.25]));
  assert.equal(onlyGap.count, 0);
  assert.match([onlyGap.reason, onlyGap.note].join(" "), /gap/i);
  const direct = benchmark(a, b);
  assert.equal(direct.count, r.count);
  assert.equal(direct.correlation, r.value);
});

test("zero correlation remains a measured result and retains the full sample size", () => {
  const x = series("x", [0, 1, 2, 3, 4], [0.125, -0.125, 0.125, -0.125]);
  const y = series("y", [0, 1, 2, 3, 4], [0.125, 0.125, -0.125, -0.125]);
  const m = correlationMatrix([x, y], { diagnostics: true });
  assert.ok(Number.isFinite(m.values[0][1]));
  assert.ok(Math.abs(m.values[0][1]) < 1e-12);
  assert.equal(m.counts[0][1], 4);
  assert.equal(m.diagnostics[0][1].reason, null);
  assert.equal(m.diagnostics[0][1].segments, 1);
});

test("membership uses nonzero holdings or a declared funded member list when holdings are absent", () => {
  const b = { ...a, id: "b" }, c = { ...a, id: "c" }, all = [a, b, c];
  const declared = { evidence: { attribution: { basis: "funded_equity", members: ["b", "First", "missing"] } } };
  assert.deepEqual(correlationMatrix(all, { portfolio: declared }).ids, ["b", "First"]);
  assert.deepEqual(correlationMatrix(all, { portfolio: { ...declared, holdings: [] } }).ids, []);
  assert.deepEqual(correlationMatrix(all, { portfolio: { ...declared, holdings: [
    { id: "c", weight: 0 }, { id: "b", weight: -0.1 }] } }).ids, ["b"]);
  assert.deepEqual(correlationMatrix(all, { portfolio: { evidence: { members: ["First"] } } }).ids, []);
  assert.deepEqual(Object.keys(correlationMatrix(all)).sort(), ["counts", "ids", "names", "values"]);
});
