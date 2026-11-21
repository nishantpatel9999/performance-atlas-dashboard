const test = require('node:test');
const assert = require('node:assert/strict');
const { benchmark, correlationMatrix } = require('../lab/performance/details.js');

const timestamps = ['2024-03-07T22:00Z', '2024-03-08T22:00Z', '2024-03-11T21:00Z', '2024-03-12T21:00Z'].map(
  Date.parse
);
function series(id, currency, equity, evidence = {}, times = timestamps) {
  return {
    id,
    name: id,
    kind: currency === 'INDEX' ? 'benchmark' : 'strategy',
    currency,
    frequency: 'daily',
    periodsPerYear: 252,
    times,
    equity,
    evidence
  };
}
const usd = series('account', 'USD', [200, 180, 198, 198], { markTimeBasis: 'observed_timestamp' });
const proxy = series('proxy', 'INDEX', [1000, 900, 990, 990], {
  returnCurrency: 'USD',
  markTimeBasis: 'observed_timestamp'
});

test('an explicitly USD-based price index and USD equity compare on the same observed intervals', () => {
  const b = benchmark(usd, proxy, { rollingWindow: 2 });
  assert.equal(b.count, 3);
  assert.equal(b.coverage.start, timestamps[0]);
  assert.equal(b.coverage.end, timestamps.at(-1));
  assert.ok(Math.abs(b.beta - 1) < 1e-12);
  assert.ok(Math.abs(b.correlation - 1) < 1e-12);
  assert.equal(b.trackingError, 0);
  assert.equal(benchmark(proxy, usd).count, 3);
  assert.equal(correlationMatrix([usd, { ...proxy, kind: 'strategy' }]).counts[0][1], 0);
});

test('cross-display comparison retains exact DST instants and both endpoints', () => {
  const delayed = [...timestamps];
  delayed[1] += 3_600_000;
  const b = benchmark(usd, { ...proxy, times: delayed });
  assert.equal(b.count, 1);
  assert.equal(b.coverage.start, timestamps[2]);
  assert.equal(b.coverage.end, timestamps[3]);
  const onlyLabels = { ...proxy, times: timestamps.map(t => Math.floor(t / 86_400_000) * 86_400_000) };
  assert.equal(benchmark(usd, onlyLabels).count, 0);
});

test('benchmark rejects unknown or conflicting economic currencies and incompatible periods', () => {
  for (const b of [
    { ...proxy, evidence: {} },
    { ...proxy, evidence: { returnCurrency: 'EUR' } },
    { ...proxy, currency: 'EUR' },
    { ...proxy, periodsPerYear: 365 },
    { ...proxy, frequency: 'weekly' },
    { ...proxy, evidence: { returnCurrency: 'unknown' } },
    { ...proxy, evidence: { returnCurrency: 'INDEX' } }
  ]) {
    const r = benchmark(usd, b);
    assert.equal(r.count, 0);
    assert.equal(r.correlation, null);
    assert.ok(r.reason);
  }
  const eur = { ...proxy, id: 'eur', evidence: { returnCurrency: 'EUR' } };
  assert.equal(benchmark(proxy, eur).count, 0);
  assert.equal(benchmark(proxy, { ...proxy, evidence: {} }).count, 0);
  assert.equal(benchmark(usd, { ...usd, evidence: { returnCurrency: 'EUR' } }).count, 0);
});

test('a recorded date label cannot establish a simultaneous close even at identical stored times', () => {
  for (const b of [usd, proxy]) {
    const labels = { ...b, id: 'paper', evidence: { ...b.evidence, markTimeBasis: 'date_label' } };
    for (const [left, right] of [
      [labels, b],
      [b, labels]
    ]) {
      const r = benchmark(left, right);
      assert.equal(r.count, 0);
      assert.equal(r.beta, null);
      assert.match(r.reason, /observed|timestamp|clock/i);
    }
  }
});

test('two paper books can compare returns measured on the same date-label clock', () => {
  const labels = timestamps.map(t => Math.floor(t / 86_400_000) * 86_400_000);
  const basis = { returnCurrency: 'USD', markTimeBasis: 'date_label' };
  const a = series('first', 'INDEX', [100, 90, 99, 99], basis, labels);
  const b = series('second', 'INDEX', [400, 360, 396, 396], basis, labels);
  const result = benchmark(a, b);
  assert.equal(result.count, 3);
  assert.ok(Math.abs(result.correlation - 1) < 1e-12);
  assert.equal(benchmark(a, { ...b, evidence: { ...basis, markTimeBasis: 'unknown' } }).count, 0);
});
