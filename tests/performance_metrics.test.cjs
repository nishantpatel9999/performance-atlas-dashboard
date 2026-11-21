'use strict';

const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const modulePath = path.resolve(__dirname, '../lab/performance/metrics.js');
const DAY = 86_400_000;
const HOUR = DAY / 24;
const utc = (date) => Date.parse(date.length === 10 ? date + 'T00:00:00Z' : date);
const startDay = utc('2024-01-01');

function series(times, equity, frequency = 'daily', periodsPerYear = 365) {
  return { id: 'fixture', name: 'Fixture', kind: 'strategy', currency: 'USD',
    times, equity, frequency, periodsPerYear };
}

function analyze(input, options) {
  return require(modulePath).analyze(input, options);
}

function close(actual, expected, tolerance = 1e-11) {
  assert.ok(Number.isFinite(actual), 'Expected a finite number, received ' + actual);
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    'Expected ' + actual + ' to equal ' + expected);
}

function nearArray(actual, expected) {
  assert.equal(actual.length, expected.length);
  expected.forEach((value, index) => {
    if (value === null) assert.equal(actual[index], null);
    else close(actual[index], value);
  });
}

function fromReturns(rates, periodsPerYear = 365) {
  const equity = [100];
  for (const rate of rates) equity.push(equity.at(-1) * (1 + rate));
  return series(equity.map((_, i) => startDay + i * DAY), equity, 'daily', periodsPerYear);
}

test('exports analyze in CommonJS and a browser without a module loader', () => {
  assert.ok(existsSync(modulePath), 'The standalone metrics module must exist');
  const context = { window: {} };
  vm.runInNewContext(readFileSync(modulePath, 'utf8'), context);
  const data = fromReturns([0.1, -0.2]);
  const result = context.window.PerformanceMetrics.analyze(data);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), JSON.parse(JSON.stringify(analyze(data))));
});

const intradayTimes = [
  '2024-01-02T09:00:00Z', '2024-01-02T12:00:00Z', '2024-01-02T15:00:00Z',
  '2024-01-02T16:00:00Z', '2024-01-03T10:00:00Z', '2024-01-03T12:00:00Z',
  '2024-01-03T16:00:00Z', '2024-01-04T16:00:00Z',
].map(utc);
const intraday = series(intradayTimes, [100, 120, 90, 110, 125, 100, 125, 112.5]);

test('retains original equity, intraday losses, the opening mark and underwater durations', () => {
  const r = analyze(intraday);
  assert.deepEqual(r.times, intradayTimes);
  assert.deepEqual(r.equity, intraday.equity);
  const path = [0, 0, -0.25, -1 / 12, 0, -0.2, 0, -0.1];
  nearArray(r.drawdown, path);
  nearArray(r.maxDrawdownPath, [0, 0, -0.25, -0.25, -0.25, -0.25, -0.25, -0.25]);
  close(r.summary.maxDrawdown, -0.25);
  close(r.summary.ulcer, Math.sqrt(path.reduce((sum, d) => sum + d * d, 0) / path.length));
  close(r.summary.drawdownDays, 1);
  assert.equal(r.episodes.length, 3);
  const [first, second, last] = r.episodes;
  assert.deepEqual([first.peak, first.trough, first.recovery], [intradayTimes[1], intradayTimes[2], intradayTimes[4]]);
  close(first.depth, -0.25);
  close(first.days, 22 / 24);
  assert.deepEqual([second.peak, second.trough, second.recovery], [intradayTimes[4], intradayTimes[5], intradayTimes[6]]);
  assert.deepEqual([last.peak, last.trough, last.recovery], [intradayTimes[6], intradayTimes[7], null]);
  assert.deepEqual(r.returns.times, [intradayTimes[3], intradayTimes[6], intradayTimes[7]]);
  nearArray(r.returns.values, [0.1, 125 / 110 - 1, -0.1]);
  close(r.years[0].maxDrawdown, -0.25);
});

test('an inclusive cut uses the preceding actual mark and exposes only selected dates', () => {
  const options = { start: intradayTimes[2], end: intradayTimes[4] };
  const r = analyze(intraday, options);
  assert.deepEqual(r.times, intradayTimes.slice(2, 5));
  assert.equal(r.meta.baselineTime, intradayTimes[1]);
  assert.equal(r.summary.startEquity, 120);
  assert.equal(r.summary.endEquity, 125);
  close(r.summary.totalReturn, 125 / 120 - 1);
  nearArray(r.drawdown, [-0.25, -1 / 12, 0]);
  nearArray(r.returns.values, [-1 / 12, 125 / 110 - 1]);
  assert.deepEqual(r.returns.times, [intradayTimes[3], intradayTimes[4]]);
  close(r.months[0].return, 125 / 120 - 1);
  const singleton = analyze(intraday, { start: intradayTimes[2], end: intradayTimes[2] });
  nearArray(singleton.returns.values, [-0.25]);
  const prefix = series(intradayTimes.slice(0, 5), intraday.equity.slice(0, 5));
  assert.deepEqual(r, analyze(prefix, options));
});

test('sampling uses the final observed UTC mark in each Monday week, month and year', () => {
  const dates = ['2023-12-29', '2024-01-02', '2024-01-05', '2024-01-07',
    '2024-01-08', '2024-01-31', '2024-02-29', '2024-12-31', '2025-01-02'].map(utc);
  const equity = [100, 110, 80, 90, 120, 110, 99, 121, 120];
  const w = analyze(series(dates.slice(0, 5), equity.slice(0, 5), 'weekly', 52));
  assert.deepEqual(w.returns.times, [dates[3], dates[4]]);
  nearArray(w.returns.values, [-0.1, 1 / 3]);
  const m = analyze(series(dates.slice(0, 7), equity.slice(0, 7), 'monthly', 12));
  assert.deepEqual(m.returns.times, [dates[5], dates[6]]);
  nearArray(m.returns.values, [0.1, -0.1]);
  close(m.summary.maxDrawdown, 80 / 110 - 1);
  const y = analyze(series(dates, equity, 'annual', 1));
  assert.deepEqual(y.returns.times, [dates[7], dates[8]]);
  nearArray(y.returns.values, [0.21, 120 / 121 - 1]);
  assert.deepEqual(y.rolling.times, y.returns.times);
});

test('ratios use sample volatility, annual effective rates and all observations for downside', () => {
  const rates = [-0.1, 0.2, -0.2, 0.1];
  const r = analyze(fromReturns(rates, 4), { riskFree: 1.02 ** 4 - 1, target: 1.03 ** 4 - 1 });
  const sd = Math.sqrt(0.1 / 3);
  const lower = Math.sqrt((0.13 ** 2 + 0.23 ** 2) / 4);
  close(r.summary.volatility, 2 * sd);
  close(r.summary.downside, 2 * lower);
  close(r.summary.sharpe, -0.02 * 2 / sd);
  close(r.summary.sortino, -0.03 * 2 / lower);
  close(r.summary.var95, -0.185);
  close(r.summary.cvar95, -0.2);
  close(r.summary.best, 0.2);
  close(r.summary.worst, -0.2);
  close(r.summary.positiveRate, 0.5);
  close(r.summary.totalReturn, 0.9 * 1.2 * 0.8 * 1.1 - 1);
  close(r.summary.cagr, (1 + r.summary.totalReturn) ** (365.25 / 4) - 1);
  close(r.summary.calmar, r.summary.cagr / 0.2);
  assert.equal(r.bins.reduce((n, b) => n + b.count, 0), rates.length);
  assert.ok(r.bins.every((b) => b.lower <= b.upper && Number.isInteger(b.count)));
});

test('zero and effectively zero denominators and insufficient samples produce explicit nulls', () => {
  const flat = analyze(fromReturns([0, 0, 0]));
  for (const key of ['sharpe', 'sortino', 'calmar']) {
    assert.equal(flat.summary[key], null);
    assert.ok(flat.meta.unavailable.includes(key));
  }
  for (const key of ['volatility', 'downside', 'ulcer', 'drawdownDays', 'cagr', 'positiveRate']) {
    assert.equal(flat.summary[key], 0);
  }
  assert.deepEqual(flat.bins.map((bin) => bin.count), [3]);
  assert.equal(analyze(fromReturns([0.1, 0.1, 0.1, 0.1])).summary.sharpe, null);
  const one = analyze(fromReturns([-0.1]));
  assert.equal(one.summary.volatility, null);
  assert.equal(one.summary.sortino, null);
  close(one.summary.downside, 0.1 * Math.sqrt(365));
  const tiny = analyze(fromReturns([1e-7, 1.0001e-7, 0.9999e-7]));
  assert.ok(Number.isFinite(tiny.summary.sharpe));
});

test('CAGR measures elapsed time and ignores the declared ratio frequency', () => {
  const dates = ['2023-06-30T12:00:00Z', '2024-06-30T18:00:00Z'].map(utc);
  const r = analyze(series(dates, [80, 100], 'annual', 1));
  close(r.summary.cagr, 1.25 ** (365.25 / 366.25) - 1);
  assert.equal(r.summary.meanYearReturn, null);
});

test('keeps the first nonpositive mark, discards later marks and preserves terminal debt', () => {
  for (const terminal of [0, -20]) {
    const dates = ['2024-01-31', '2024-02-01', '2024-02-15', '2024-02-28', '2024-02-29', '2024-03-01', '2024-03-02'].map(utc);
    const r = analyze(series(dates, [100, 200, 110, 60, 50, terminal, 999]), { months: 1 });
    assert.deepEqual(r.times, dates.slice(0, 6));
    assert.equal(r.summary.endEquity, terminal);
    close(r.summary.totalReturn, terminal / 100 - 1);
    close(r.summary.maxDrawdown, terminal / 200 - 1);
    close(r.rolling.maxDrawdown.at(-1), terminal / 200 - 1);
    close(r.returns.values.at(-1), terminal / 50 - 1);
    assert.equal(r.summary.cagr, terminal === 0 ? -1 : null);
    assert.equal(r.episodes.at(-1).recovery, null);
    assert.equal(r.meta.exhaustedAt, dates[5]);
    const after = analyze(series(dates, [100, 200, 110, 60, 50, terminal, 999]), { start: dates[6] });
    assert.deepEqual(after.times, []);
    assert.equal(after.meta.exhaustedAt, dates[5]);
  }
});

test('clamps calendar months, warms the full window and removes expired peaks', () => {
  const dates = ['2024-01-31', '2024-02-27', '2024-02-29', '2024-03-01',
    '2024-03-15', '2024-03-31', '2024-04-01', '2024-04-30'].map(utc);
  const equity = [200, 180, 120, 80, 100, 90, 108, 95];
  const r = analyze(series(dates, equity), { months: 1 });
  assert.deepEqual(r.rolling.times, dates.slice(1));
  for (const key of ['maxDrawdown', 'sharpe', 'sortino', 'calmar', 'volatility', 'return']) {
    assert.equal(r.rolling[key][1], null, key + ' needs a full month at February 29');
  }
  close(r.rolling.maxDrawdown[4], 80 / 120 - 1);
  close(r.rolling.return[4], 90 / 120 - 1);
  close(r.rolling.maxDrawdown[5], -0.1);
  close(r.rolling.maxDrawdown[6], 95 / 108 - 1);
  close(r.summary.maxDrawdown, -0.6);
});

test('rolling return uses a fresh as-of opening value and excludes a stale boundary', () => {
  const dates = ['2023-12-31', '2024-01-05', '2024-01-30', '2024-01-31',
    '2024-02-02', '2024-03-02', '2024-03-15'].map(utc);
  const data = series(dates, [100, 104, 110, 105, 112, 106, 113], 'daily', 252);
  const r = analyze(data, { months: 1 });
  // January 2 lies in a data gap. February 2 is an observed boundary.
  assert.equal(r.rolling.return[r.rolling.times.indexOf(dates[4])], null);
  close(r.rolling.return[r.rolling.times.indexOf(dates[5])], 106 / 112 - 1);
  assert.equal(r.rolling.return.at(-1), null);
  const weekend = analyze(series(['2024-01-01', '2024-02-02', '2024-02-05', '2024-03-03'].map(utc),
    [120, 100, 95, 99], 'daily', 252), { months: 1 });
  close(weekend.rolling.return.at(-1), -0.01);
  close(weekend.rolling.maxDrawdown.at(-1), 0);
});

test('gaps stay missing in the return series, histogram, calendar rows and coverage', () => {
  const dates = ['2023-01-02', '2023-01-03', '2023-01-10', '2023-01-11', '2024-02-01'].map(utc);
  const r = analyze(series(dates, [100, 110, 121, 133.1, 266.2]));
  assert.deepEqual(r.returns.times, dates.slice(1));
  nearArray(r.returns.values, [0.1, null, 0.1, null]);
  assert.deepEqual(r.meta.gaps.map((g) => [g.from, g.to]), [[dates[1], dates[2]], [dates[3], dates[4]]]);
  assert.equal(r.bins.reduce((n, b) => n + b.count, 0), 2);
  close(r.summary.totalReturn, 1.662);
  assert.deepEqual(r.months.map((m) => [m.year, m.month]), [[2023, 1], [2024, 2]]);
  assert.equal(r.months[1].return, null);
  assert.equal(r.years[1].return, null);
  assert.equal(r.summary.meanYearDrawdown, null);
  for (const [freq, ppy, span] of [
    ['weekly', 52, ['2024-01-05', '2024-01-26']],
    ['monthly', 12, ['2024-01-31', '2024-03-28']],
    ['annual', 1, ['2021-12-31', '2023-12-29']],
  ]) {
    const missing = analyze(series(span.map(utc), [100, 130], freq, ppy));
    nearArray(missing.returns.values, [null]);
    assert.equal(missing.meta.gaps.length, 1);
  }
});

test('daily cadence distinguishes a seven-day market from a possible trading holiday', () => {
  const times = ['2024-08-30', '2024-09-03', '2024-09-04'].map(utc);
  const equity = [100, 95, 114];
  nearArray(analyze(series(times, equity, 'daily', 252)).returns.values, [-0.05, 0.2]);
  nearArray(analyze(series(times, equity, 'daily', 365)).returns.values, [null, 0.2]);
});

test('calendar-year averages use covered years and include the prior closing mark in year drawdown', () => {
  const times = [], equity = [];
  for (let t = utc('2020-12-31'); t <= utc('2023-03-01'); t += DAY) {
    const date = new Date(t), weekday = date.getUTCDay(), year = date.getUTCFullYear();
    if (!weekday || weekday === 6 || t === utc('2021-01-01') || t === utc('2021-12-31')) continue;
    times.push(t);
    if (year === 2020) equity.push(100);
    if (year === 2021) equity.push(t === utc('2021-01-04') ? 80 : 110);
    if (year === 2022) equity.push(t === utc('2022-01-03') ? 99 : 121);
    if (year === 2023) equity.push(130);
  }
  const data = series(times, equity, 'daily', 252);
  const r = analyze(data);
  assert.deepEqual(r.years.map((y) => [y.year, y.complete]), [[2021, true], [2022, true], [2023, false]]);
  nearArray(r.years.map((y) => y.return), [0.1, 0.1, 130 / 121 - 1]);
  nearArray(r.years.map((y) => y.maxDrawdown), [-0.2, -0.1, 0]);
  close(r.summary.meanYearReturn, 0.1);
  close(r.summary.meanYearDrawdown, -0.15);
  const cut = analyze(data, { start: utc('2021-04-01'), end: utc('2022-12-15') });
  assert.deepEqual(cut.years.map((y) => y.complete), [false, false]);
  assert.equal(cut.summary.meanYearReturn, null);
  const gap = times.indexOf(utc('2022-05-02'));
  const broken = analyze(series(times.slice(0, gap).concat(times.slice(gap + 9)),
    equity.slice(0, gap).concat(equity.slice(gap + 9)), 'daily', 252));
  assert.equal(broken.years.find((y) => y.year === 2022).complete, false);
});

test('annual-only marks give annual returns without manufacturing December returns', () => {
  const r = analyze(series(['2021-12-31', '2022-12-30', '2023-12-29'].map(utc), [100, 80, 100], 'annual', 1));
  nearArray(r.years.map((y) => y.return), [-0.2, 0.25]);
  assert.deepEqual(r.years.map((y) => y.complete), [true, true]);
  assert.ok(r.months.every((m) => m.return === null));
});

test('single marks and empty selections preserve the result shape', () => {
  const only = analyze(series([startDay], [7]));
  assert.equal(only.summary.totalReturn, 0);
  assert.equal(only.summary.cagr, null);
  nearArray(only.drawdown, [0]);
  assert.deepEqual(only.returns.values, []);
  for (const r of [analyze(series([], [])), analyze(intraday, { start: intradayTimes.at(-1) + 1 })]) {
    for (const key of ['times', 'equity', 'drawdown', 'maxDrawdownPath', 'years', 'months', 'episodes', 'bins']) {
      assert.deepEqual(r[key], []);
    }
    assert.ok(Object.values(r.summary).every((value) => value === null));
    assert.ok(Object.values(r.rolling).every((value) => Array.isArray(value) && !value.length));
  }
});

test('rejects malformed marks, cadence and options without changing the input', () => {
  const clean = fromReturns([0.1, -0.1]);
  Object.freeze(clean.times);
  Object.freeze(clean.equity);
  Object.freeze(clean);
  analyze(clean);
  for (const edit of [
    { times: [startDay] }, { times: [startDay, startDay, startDay + DAY] },
    { times: [startDay, startDay - DAY, startDay + DAY] }, { times: [NaN, 1, 2] },
    { equity: [0, 10, 20] }, { equity: [100, Infinity, 20] },
    { periodsPerYear: 0 }, { frequency: 'hourly' },
  ]) assert.throws(() => analyze({ ...clean, ...edit }));
  for (const opts of [{ start: 2, end: 1 }, { end: NaN }, { months: 0 }, { months: 1.5 },
    { riskFree: -1.01 }, { target: Infinity }]) assert.throws(() => analyze(clean, opts));
});

test('rolling drawdown and ratios agree with direct window scans at every observed close', () => {
  const times = [], equity = [], closes = [], rates = [];
  let state = 3871, lastClose = 100;
  function random() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  }
  for (let day = 0; day < 140; day++) {
    const closeTime = utc('2023-12-15') + day * DAY + 16 * HOUR;
    const rate = (random() - 0.49) / 15;
    const base = lastClose;
    lastClose *= 1 + rate;
    times.push(closeTime - 5 * HOUR, closeTime - HOUR, closeTime);
    equity.push(base, base * (0.75 + random() / 2), lastClose);
    closes.push(closeTime);
    rates.push(rate);
  }
  const r = analyze(series(times, equity), { months: 2 });
  assert.deepEqual(r.rolling.times, closes);
  for (let i = 0; i < closes.length; i++) {
    const end = new Date(closes[i]), month = end.getUTCMonth() - 2, year = end.getUTCFullYear();
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const cutoff = Date.UTC(year, month, Math.min(last, end.getUTCDate()), 16);
    if (cutoff < times[0]) {
      assert.equal(r.rolling.maxDrawdown[i], null);
      continue;
    }
    let peak = 0, worst = 0;
    for (let j = 0; j < (i + 1) * 3; j++) {
      if (times[j] < cutoff) continue;
      peak = Math.max(peak, equity[j]);
      worst = Math.min(worst, equity[j] / peak - 1);
    }
    const j = closes.indexOf(cutoff), sample = rates.slice(j + 1, i + 1);
    const mean = sample.reduce((sum, n) => sum + n, 0) / sample.length;
    const sd = Math.sqrt(sample.reduce((sum, n) => sum + (n - mean) ** 2, 0) / (sample.length - 1));
    const downside = Math.sqrt(sample.reduce((sum, n) => sum + Math.min(0, n) ** 2, 0) / sample.length);
    close(r.rolling.maxDrawdown[i], worst);
    close(r.rolling.return[i], equity[i * 3 + 2] / equity[j * 3 + 2] - 1);
    close(r.rolling.volatility[i], sd * Math.sqrt(365));
    close(r.rolling.sharpe[i], mean * Math.sqrt(365) / sd);
    close(r.rolling.sortino[i], mean * Math.sqrt(365) / downside);
    const annual = (equity[i * 3 + 2] / equity[j * 3 + 2]) ** (365.25 / (i - j)) - 1;
    close(r.rolling.calmar[i], annual / -worst);
  }
});

test('handles 135,000 intraday marks with one rolling point per observed day', () => {
  const times = [], equity = [];
  for (let day = 0; day < 375; day++) {
    for (let minute = 0; minute < 360; minute++) {
      times.push(startDay + day * DAY + minute * 60_000);
      equity.push(minute === 180 ? 75 : 100);
    }
  }
  const r = analyze(series(times, equity));
  assert.equal(r.times.length, 135_000);
  assert.equal(r.rolling.times.length, 375);
  assert.equal(r.rolling.maxDrawdown[180], null);
  close(r.rolling.maxDrawdown.at(-1), -0.25);
  close(r.summary.maxDrawdown, -0.25);
  assert.equal(r.episodes.length, 375);
});

function withCalendar(dates, equity, sessionDates, periodsPerYear = 252) {
  return { ...series(dates.map(utc), equity, 'daily', periodsPerYear), sessionDates };
}

test('the exchange calendar accepts prior funding and extended closures and detects one missing session', () => {
  const sessions = ['2024-01-07', '2024-01-08', '2024-01-09', '2024-01-10',
    '2024-01-11', '2024-02-04', '2024-02-05'];
  const dates = ['2023-12-20', ...sessions.filter((s) => s !== '2024-01-09')];
  const r = analyze(withCalendar(dates, [100, 110, 99, 101, 111.1, 100, 102], sessions));
  nearArray(r.returns.values, [0.1, -0.1, null, 0.1, 100 / 111.1 - 1, 0.02]);
  assert.deepEqual(r.meta.gaps.map((g) => [g.from, g.to, g.missingSessions]),
    [[utc('2024-01-08'), utc('2024-01-10'), 1]]);
  assert.equal(r.meta.possibleHolidayIntervals, 0);
  assert.equal(r.meta.calendar, 'sessionDates');
  assert.equal(r.meta.validReturns, 5);
});

test('a seven-day session calendar overrides a trading-day annualization factor', () => {
  const sessions = ['2024-05-03', '2024-05-04', '2024-05-05', '2024-05-06', '2024-05-07'];
  const r = analyze(withCalendar([sessions[0], sessions[3], sessions[4]], [100, 98, 99], sessions, 252));
  nearArray(r.returns.values, [null, 99 / 98 - 1]);
  assert.equal(r.meta.gaps[0].missingSessions, 2);
});

test('daily cutoff valuation uses the latest expected session through the cutoff, including long closures', () => {
  const sessions = ['2024-01-02', '2024-02-02', '2024-02-20', '2024-02-21',
    '2024-03-12', '2024-03-13', '2024-03-22'];
  const dates = sessions.filter((s) => s !== '2024-02-21');
  const r = analyze(withCalendar(dates, [100, 120, 100, 90, 98, 92], sessions), { months: 1 });
  const at = (d) => r.rolling.times.indexOf(utc(d));
  close(r.rolling.return[at('2024-03-12')], 90 / 120 - 1);
  assert.equal(r.rolling.openingTimes[at('2024-03-12')], utc('2024-02-02'));
  close(r.rolling.maxDrawdown[at('2024-03-12')], -0.1);
  assert.equal(r.rolling.sharpe[at('2024-03-12')], null);
  assert.equal(r.rolling.return[at('2024-03-22')], null);
  assert.equal(r.rolling.openingTimes[at('2024-03-22')], null);
});

test('full years use the first and last exchange sessions, including a closing holiday and Sunday close', () => {
  const sessions = ['2022-12-22', '2023-01-08', '2023-06-15', '2023-12-24',
    '2024-01-07', '2024-06-16', '2024-12-22', '2024-12-29', '2025-01-05'];
  const r = analyze(withCalendar(['2023-01-01', ...sessions.slice(1, 7)], [100, 80, 90, 110, 121, 115, 150], sessions));
  assert.deepEqual(r.years.map((y) => [y.year, y.complete]), [[2023, true], [2024, false]]);
  close(r.summary.meanYearReturn, 0.1);
  close(r.summary.meanYearDrawdown, -0.2);
  const funded = analyze(withCalendar(['2022-12-29', ...sessions.slice(1, 4)], [100, 80, 90, 110], sessions));
  assert.equal(funded.years[0].complete, true);
  close(funded.years[0].return, 0.1);
  const missingFirst = analyze(withCalendar(sessions.slice(2, 4), [90, 110], sessions));
  assert.equal(missingFirst.years[0].complete, false);
  const missingMiddle = analyze(withCalendar([sessions[0], sessions[1], sessions[3]], [100, 80, 110], sessions));
  assert.equal(missingMiddle.years[0].complete, false);
});

test('rejects duplicate, unsorted, malformed and impossible ISO session dates', () => {
  for (const invalid of [null, '2024-02-29', ['2024-01-01', '2024-01-01'],
    ['2024-02-02', '2024-02-01'], ['2024-02-30'], ['2023-02-29'], ['2024-2-09'], [20240209]]) {
    assert.throws(() => analyze({ ...fromReturns([0.1]), sessionDates: invalid }), /sessionDates/);
  }
});

test('six monthly buckets use the actual August close for leap and non-leap February', () => {
  for (const [august, september, october, november, december, january, february] of [
    ['2023-08-31', '2023-09-29', '2023-10-31', '2023-11-30', '2023-12-29', '2024-01-31', '2024-02-29'],
    ['2024-08-30', '2024-09-30', '2024-10-31', '2024-11-29', '2024-12-31', '2025-01-31', '2025-02-28'],
  ]) {
    const dates = [august, september, october, november, december, january, february].map(utc);
    const r = analyze(series(dates, [100, 80, 120, 108, 115, 110, 125], 'monthly', 12));
    assert.ok(r.rolling.return.slice(0, -1).every((v) => v === null));
    assert.equal(r.rolling.openingTimes.at(-1), dates[0]);
    close(r.rolling.return.at(-1), 0.25);
    close(r.rolling.maxDrawdown.at(-1), -0.2);
    const growth = 1.25 ** (365.25 * DAY / (dates.at(-1) - dates[0])) - 1;
    close(r.rolling.calmar.at(-1), growth / 0.2);
    close(r.rolling.sharpe.at(-1), r.summary.sharpe);
  }
});

test('a monthly opening uses the last actual mark in the target month and keeps subsequent intraday losses', () => {
  const dates = ['2023-07-31', '2023-08-07', '2023-08-31', '2023-09-12', '2023-09-29',
    '2023-10-20', '2023-11-30', '2023-12-29', '2024-01-31', '2024-02-28', '2024-02-29', '2024-03-28'].map(utc);
  const values = [500, 300, 100, 70, 110, 112, 109, 111, 120, 119, 125, 200];
  const data = series(dates, values, 'monthly', 12);
  const cut = analyze(data, { end: dates[10] });
  close(cut.rolling.return.at(-1), 0.25);
  close(cut.rolling.maxDrawdown.at(-1), -0.3);
  assert.equal(cut.rolling.openingTimes.at(-1), dates[2]);
  assert.deepEqual(cut, analyze(series(dates.slice(0, 11), values.slice(0, 11), 'monthly', 12)));
  const absent = analyze(series([dates[0], ...dates.slice(3, 11)], [500, ...values.slice(3, 11)], 'monthly', 12));
  assert.equal(absent.rolling.return.at(-1), null);
  assert.equal(absent.rolling.calmar.at(-1), null);
});

test('weekly rolling return and Calmar include the opening weekly close five days before a cutoff', () => {
  const dates = ['2024-01-26', '2024-02-02', '2024-02-09', '2024-02-16',
    '2024-02-23', '2024-03-01'].map(utc);
  const r = analyze(series(dates, [100, 80, 110, 108, 105, 120], 'weekly', 52), { months: 1 });
  // March 1 minus one month is Thursday, February 1. The prior weekly close is Friday, January 26.
  assert.equal(r.rolling.openingTimes.at(-1), dates[0]);
  close(r.rolling.return.at(-1), 0.2);
  close(r.rolling.maxDrawdown.at(-1), -0.2);
  close(r.rolling.calmar.at(-1), (1.2 ** (365.25 / 35) - 1) / 0.2);
  close(r.rolling.sharpe.at(-1), r.summary.sharpe);
  const missing = analyze(series([dates[0], ...dates.slice(2)], [100, 110, 108, 105, 120], 'weekly', 52), { months: 1 });
  assert.equal(missing.rolling.return.at(-1), null);
});

test('a date cut inside the first or last session of an ordinary year stays partial', () => {
  const times = [], equity = [];
  for (let t = utc('2024-01-01'); t <= utc('2024-12-31'); t += DAY) {
    if ([0, 6].includes(new Date(t).getUTCDay())) continue;
    times.push(t);
    equity.push(times.length + 100);
  }
  const data = series(times, equity, 'daily', 252);
  assert.equal(analyze(data).years[0].complete, true);
  assert.equal(analyze(data, { start: utc('2024-01-03') }).years[0].complete, false);
  assert.equal(analyze(data, { end: utc('2024-12-30') }).years[0].complete, false);
});

test('cash drawdown and recovery factor use the largest loss in original equity units', () => {
  const dates = [0, 1, 2, 3, 4].map((d) => startDay + d * DAY);
  const data = series(dates, [100, 50, 1000, 800, 1100]);
  const r = analyze(data);
  close(r.summary.maxDrawdown, -0.5);
  assert.equal(r.summary.maxDrawdownAmount, 200);
  close(r.summary.recoveryFactor, 5);
  const cut = analyze(data, { start: dates[3], end: dates[3] });
  assert.equal(cut.summary.maxDrawdownAmount, 200);
  assert.equal(cut.summary.recoveryFactor, -1);
  const flat = analyze(fromReturns([0, 0]));
  assert.equal(flat.summary.maxDrawdownAmount, 0);
  assert.equal(flat.summary.recoveryFactor, null);
});

test('August close-to-close windows retain a short February and its last trading day', () => {
  for (const [february, august] of [['2021-02-26', '2021-08-31'], ['2024-02-29', '2024-08-30']]) {
    const year = february.slice(0, 4);
    const times = [february, year + '-03-31', year + '-04-30', year + '-05-28',
      year + '-06-28', year + '-07-30', august].map(utc);
    const r = analyze(series(times, [80, 60, 92, 80, 84, 88, 96], 'monthly', 12));
    assert.equal(r.rolling.openingTimes.at(-1), times[0]);
    close(r.rolling.return.at(-1), 0.2);
    close(r.rolling.maxDrawdown.at(-1), -0.25);
    close(r.rolling.calmar.at(-1), (1.2 ** (365.25 * DAY / (times.at(-1) - times[0])) - 1) / 0.25);
  }
});

test('month-end clamping can move the cutoff earlier on a shortened session', () => {
  const times = ['2024-02-28T20:00:00Z', '2024-02-29T16:00:00Z', '2024-02-29T18:00:00Z',
    '2024-02-29T20:00:00Z', '2024-03-01T20:00:00Z', '2024-03-29T20:00:00Z',
    '2024-03-30T20:00:00Z', '2024-03-31T16:00:00Z'].map(utc);
  const r = analyze(series(times, [100, 200, 50, 100, 90, 100, 99, 95]), { months: 1 });
  close(r.rolling.maxDrawdown.at(-2), -0.1);
  close(r.rolling.maxDrawdown.at(-1), -0.75);
  close(r.rolling.return.at(-1), 95 / 200 - 1);
});

test('off-session and intraday marks count for path risk and only session closes count for daily ratios', () => {
  const sessions = ['2024-01-07', '2024-01-09'];
  const dates = ['2024-01-06', '2024-01-07T12:00:00Z', '2024-01-07T16:00:00Z',
    '2024-01-08', '2024-01-09T16:00:00Z'];
  const r = analyze(withCalendar(dates, [100, 105, 110, 55, 121], sessions));
  assert.deepEqual(r.returns.times, [utc(dates[2]), utc(dates[4])]);
  nearArray(r.returns.values, [0.1, 0.1]);
  assert.equal(r.meta.offSessionMarks, 1);
  close(r.summary.maxDrawdown, -0.5);
  assert.equal(r.summary.maxDrawdownAmount, 55);
  assert.deepEqual(r.times, dates.map(utc));
  assert.throws(() => analyze({ ...series(dates.map(utc), r.equity, 'weekly', 52), sessionDates: sessions }), /sessionDates/);
});

test('a cutoff or exhaustion prevents reading any subsequent equity or source-horizon statistics', () => {
  const data = fromReturns([-0.1, 0.2, -0.1, 0.4]);
  Object.defineProperty(data.equity, 3, { get() { assert.fail('Read a future equity mark'); } });
  for (const name of ['costs', 'sourceMetrics', 'tradeSummary']) {
    Object.defineProperty(data, name, { get() { assert.fail('Read source-horizon ' + name); } });
  }
  assert.equal(analyze(data, { end: data.times[2] }).times.length, 3);
  data.equity[2] = -10;
  assert.equal(analyze(data).summary.endEquity, -10);
});
