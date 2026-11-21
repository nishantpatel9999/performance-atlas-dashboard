const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../lab/performance/metrics.js');
const { monthlyAmounts } = require('../lab/performance/details.js');

const DAY = 86_400_000;
const utc = Date.parse;
function dates(first, last, predicate = () => true) {
  const times = [];
  for (let t = utc(first); t <= utc(last); t += DAY) if (predicate(t)) times.push(t);
  return times;
}
const weekday = t => ![0, 6].includes(new Date(t).getUTCDay());
const isoDay = t => new Date(t).toISOString().slice(0, 10);
function daily(times, equity, extra = {}) {
  return { frequency: 'daily', periodsPerYear: 365, currency: 'USD', times, equity, ...extra };
}
function near(actual, expected) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-11, `${actual} vs ${expected}`);
}

test('a prior close funds the new month, including its first loss, with exact partial boundaries', () => {
  const times = dates('2024-01-27', '2024-03-04');
  const equity = times.map(t =>
    t < utc('2024-01-31')
      ? 120
      : t === utc('2024-01-31')
        ? 100
        : t === utc('2024-02-01')
          ? 80
          : t <= utc('2024-02-29')
            ? 90
            : 99
  );
  const s = daily(times, equity);
  const a = analyze(s);
  assert.deepEqual(
    a.months.map(m => m.coverage),
    ['partial', 'full', 'partial']
  );
  assert.deepEqual(
    a.months.map(m => [m.openingTime, m.closingTime]),
    [
      [times[0], utc('2024-01-31')],
      [utc('2024-01-31'), utc('2024-02-29')],
      [utc('2024-02-29'), times.at(-1)]
    ]
  );
  near(a.months[1].return, -0.1);
  assert.deepEqual(
    monthlyAmounts(s, a).months.map(m => m.amount),
    [-20, -10, 9]
  );
  const cut = analyze(s, { start: utc('2024-02-01'), end: utc('2024-02-01') });
  assert.equal(cut.months[0].coverage, 'partial');
  assert.equal(cut.months[0].openingTime, utc('2024-01-31'));
  near(cut.months[0].return, -0.2);
  near(cut.summary.maxDrawdown, -0.2);
});

test('same UTC day funding and first realized loss retain their actual instants and capital', () => {
  const t = ['2024-02-01T21:59:59.999Z', '2024-02-01T22:00:00Z', '2024-02-02T22:00:00Z'].map(utc);
  const s = daily(t, [100, 90, 99]);
  const a = analyze(s);
  assert.deepEqual(a.returns.times, t.slice(1));
  near(a.returns.values[0], -0.1);
  near(a.returns.values[1], 0.1);
  near(a.summary.totalReturn, -0.01);
  near(a.summary.maxDrawdown, -0.1);
  near(a.summary.cagr, 0.99 ** ((365.25 * DAY) / (t[2] - t[0])) - 1);
  assert.deepEqual(
    [a.months[0].openingTime, a.months[0].closingTime, a.months[0].coverage],
    [t[0], t[2], 'partial']
  );
  assert.deepEqual([a.episodes[0].peak, a.episodes[0].trough], t.slice(0, 2));
});

test('a missing session prevents a full month even when the endpoint return is measurable', () => {
  const all = dates('2024-01-31', '2024-03-01');
  const times = all.filter(t => t !== utc('2024-02-12'));
  const a = analyze(
    daily(
      times,
      times.map((_, i) => 100 + i)
    )
  );
  assert.equal(a.months[0].coverage, 'gap');
  near(a.months[0].return, 0.28);
  assert.equal(a.months[0].openingTime, all[0]);
  assert.equal(a.months[0].closingTime, utc('2024-02-29'));
  assert.equal(a.months[1].coverage, 'partial');
  assert.equal(a.returns.values[a.returns.times.indexOf(utc('2024-02-13'))], null);
  const closed = analyze(
    daily(
      times,
      times.map((_, i) => 100 + i),
      { sessionDates: times.map(isoDay) }
    )
  );
  assert.equal(closed.months[0].coverage, 'full');
});

test('a confirmed gap on both sides of New Year removes the preceding year from full-year means', () => {
  const times = [...dates('2020-12-31', '2021-12-30', weekday), utc('2022-01-04')];
  const s = daily(
    times,
    times.map((_, i) => 100 + i),
    { periodsPerYear: 252 }
  );
  const a = analyze(s);
  assert.equal(a.years[0].complete, false);
  assert.equal(a.summary.meanYearReturn, null);
  assert.equal(a.summary.meanYearDrawdown, null);
  assert.deepEqual(
    a.months.slice(-2).map(m => m.coverage),
    ['gap', 'gap']
  );
  // An explicit closure of the old year protects its coverage from a January-only gap.
  const sessions = [...times.slice(0, -1), utc('2022-01-03'), times.at(-1)].map(isoDay);
  const declared = analyze({ ...s, sessionDates: sessions });
  assert.equal(declared.years[0].complete, true);
  assert.deepEqual(
    declared.months.slice(-2).map(m => m.coverage),
    ['full', 'gap']
  );
});

test('an exact intraday cut before a later mark on the last session stays partial', () => {
  const times = dates('2023-12-31', '2024-12-31').map(t => t + 16 * 3_600_000);
  const last = times.at(-1);
  times.splice(-1, 0, last - 3_600_000);
  const s = daily(
    times,
    times.map((_, i) => 100 + i)
  );
  const full = analyze(s);
  assert.equal(full.years[0].complete, true);
  assert.equal(full.months.at(-1).coverage, 'full');
  Object.defineProperty(s.equity, times.length - 1, {
    get() {
      assert.fail('Read an out-of-range equity mark');
    }
  });
  const cut = analyze(s, { end: last - 3_600_000 });
  assert.equal(cut.years[0].complete, false);
  assert.equal(cut.summary.meanYearReturn, null);
  assert.equal(cut.months.at(-1).coverage, 'partial');
  assert.equal(cut.months.at(-1).closingTime, last - 3_600_000);
});

test('a missing month supplies no anchor and a lone later mark earns no monthly return', () => {
  const s = daily(['2024-01-31', '2024-02-29', '2024-04-30'].map(utc), [100, 90, 120], {
    frequency: 'monthly',
    periodsPerYear: 12
  });
  const a = analyze(s);
  assert.deepEqual(
    a.months.map(m => m.month),
    [2, 4]
  );
  assert.deepEqual(
    a.months.map(m => m.coverage),
    ['full', 'gap']
  );
  assert.equal(a.months[1].return, null);
  assert.equal(a.months[1].openingTime, null);
  assert.equal(a.months[1].closingTime, utc('2024-04-30'));
  assert.equal(monthlyAmounts(s, a).months[1].amount, null);
});

test('a Saturday cutoff uses the Friday close on a trading calendar and Saturday on a seven-day calendar', () => {
  const all = dates('2024-04-25', '2024-06-04');
  const value = t =>
    t === utc('2024-05-03') ? 100 : t === utc('2024-05-04') ? 80 : t === utc('2024-06-04') ? 90 : 110;
  for (const [times, extra, opening, ret] of [
    [all, {}, '2024-05-04', 0.125],
    [
      all.filter(weekday),
      { periodsPerYear: 252, sessionDates: all.filter(weekday).map(isoDay) },
      '2024-05-03',
      -0.1
    ]
  ]) {
    const a = analyze(daily(times, times.map(value), extra), { months: 1 });
    assert.equal(a.rolling.openingTimes.at(-1), utc(opening));
    near(a.rolling.return.at(-1), ret);
    near(a.rolling.maxDrawdown.at(-1), 90 / 110 - 1);
    assert.equal(a.months.find(m => m.month === 5).coverage, 'full');
  }
});
