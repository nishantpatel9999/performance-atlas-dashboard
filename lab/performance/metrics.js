/* Standalone metrics for one dated series of net equity marks. */
(function () {
  'use strict';

  const DAY = 86_400_000;
  const YEAR = 365.25 * DAY;
  const MAX_TIME = 8_640_000_000_000_000;
  const EPSILON = 8 * Number.EPSILON;
  const frequencies = ['daily', 'weekly', 'monthly', 'annual'];
  const rollingKeys = ['maxDrawdown', 'sharpe', 'sortino', 'calmar', 'volatility', 'return'];
  const summaryKeys = [
    'totalReturn', 'cagr', 'meanYearReturn', 'meanYearDrawdown', 'maxDrawdown',
    'sharpe', 'sortino', 'calmar', 'volatility', 'downside', 'drawdownDays',
    'ulcer', 'var95', 'cvar95', 'best', 'worst', 'positiveRate', 'startEquity', 'endEquity',
    'maxDrawdownAmount', 'recoveryFactor',
  ];

  // Export the definitions so a report can show the same methods as the engine.
  const conventions = Object.freeze({
    selection: 'Bounds include both instants. The preceding actual mark supplies opening capital for a date cut. Displayed marks stay inside the selection. An opening mark alone earns no period return.',
    sampling: 'Use the last selected mark in each UTC day, Monday-to-Sunday week, month or year. The opening and final buckets can be partial. Return timestamps identify actual observations.',
    sessions: 'For daily sampling, sessionDates lists the expected UTC trading dates. The caller supplies the full calendar for the span. Only listed days produce daily closes. Funding can precede the first session. All supplied marks count for equity and drawdown. A missed scheduled session gives a null interval at the next close.',
    gaps: 'Without a supplied calendar, daily series with at least 360 periods/year require adjacent UTC dates. Other daily series allow weekends and one intervening weekday for a possible holiday. Coarser samples require adjacent calendar buckets. Summary ratios use finite intervals. The gaps list records omitted intervals.',
    calendar: 'Each month and year uses its own observed opening and closing equity. A prior period close can supply opening capital. A partial period with just one unanchored mark has a null return. Full-year means need both boundaries and uninterrupted coverage at the declared frequency. A supplied calendar sets the first and last sessions. Without one, seven-day markets require exact dates. The weekday rule permits one possible holiday. A year ending one weekday early needs subsequent observations through the boundary.',
    monthCoverage: 'Monthly openingTime and closingTime identify the actual marks. A lone unanchored close has a null openingTime. Coverage is full at both boundaries, partial at a cut or unobserved boundary, and gap when a missing interval affects the month. A gap can still have an observed endpoint return. Months without a return observation have no row.',
    rolling: 'Rolling values are as of each sampled close. Daily windows subtract whole UTC months and clamp the day, retaining the close time. Drawdown uses marks inside the inclusive calendar window. Return uses the last actual valuation at or before the cutoff. A supplied calendar permits a closure of any length if no intervening session was due. Without a calendar, the opening must be within one day (seven-day series) or four days and the bracketing interval must be admissible.',
    rollingCloses: 'Monthly windows open at the last observed close in the month N months earlier, including its actual date and time. Weekly windows open at the last weekly close at or before the clamped cutoff, in its week or the immediately preceding observed week. Both use every raw mark from that opening through the ending close for drawdown and Calmar. openingTimes identifies the actual return opening. Missing boundary buckets stay unavailable. Rolling ratios require complete, gap-free sampled intervals.',
    drawdown: 'Drawdown and episode depth are signed fractions of the running high. Durations are elapsed 24-hour days from the most recent peak to recovery or the last mark. Ulcer is the root mean square of drawdown at displayed marks.',
    recovery: 'Maximum drawdown amount is the largest peak-to-later-mark loss in original equity units. Recovery factor divides closing equity minus opening equity by that positive amount. A zero amount gives a null recovery factor.',
    growth: 'CAGR uses actual elapsed milliseconds and a 365.25-day year. Zero terminal equity gives -100% annual growth. Negative terminal equity has no real compound growth rate. The first nonpositive mark ends the series.',
    ratios: 'Annual effective risk-free and target rates compound down to one period. Sharpe uses excess mean return and sample deviation. Sortino uses mean return above target and root mean square shortfall over all sampled returns. Both ratios require two returns. Calmar divides elapsed-time CAGR by absolute maximum drawdown. A zero or numerically indistinguishable denominator gives null.',
    tails: 'Best, worst, positive rate and histogram use finite sampled returns. VaR95 is the signed linearly interpolated 5th percentile. CVaR95 is the mean of returns at or below it. Zero returns count in the positive-rate denominator.',
  });

  const finite = (value) => Number.isFinite(value) ? value : null;
  const dayOf = (time) => Math.floor(time / DAY);

  function timestamp(value, name) {
    if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_TIME) {
      throw new RangeError(name + ' must be a whole UTC epoch millisecond within the Date range');
    }
    return value;
  }

  function periodRate(rate, periods, name) {
    if (!Number.isFinite(rate) || rate < -1) throw new RangeError(name + ' must be finite and at least -1');
    return Math.expm1(Math.log1p(rate) / periods);
  }

  function sessionCalendar(dates, frequency) {
    if (dates === undefined) return null;
    if (frequency !== 'daily' || !Array.isArray(dates)) {
      throw new TypeError('sessionDates must be an array for a daily series');
    }
    const days = [], months = new Map(), years = new Map();
    function record(map, key, day) {
      const bounds = map.get(key);
      if (bounds) bounds.last = day;
      else map.set(key, { first: day, last: day });
    }
    for (const iso of dates) {
      if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso) || iso.startsWith('0000')) {
        throw new RangeError('sessionDates requires ISO YYYY-MM-DD dates');
      }
      const date = new Date(iso + 'T00:00:00Z'), day = dayOf(date.getTime());
      if (!Number.isFinite(day) || date.toISOString().slice(0, 10) !== iso) {
        throw new RangeError('Invalid date in sessionDates: ' + iso);
      }
      if (days.length && day <= days[days.length - 1]) throw new RangeError('sessionDates must strictly increase');
      days.push(day);
      record(months, monthNumber(date), day);
      record(years, date.getUTCFullYear(), day);
    }
    return { days, month: months, year: years };
  }

  // Count scheduled dates on [first, stop).
  function sessionCount(days, first, stop) {
    if (stop <= first) return 0;
    return lowerBound(days, stop, days.length) - lowerBound(days, first, days.length);
  }

  function settings(series, { start, end, months = 6, riskFree = 0, target = 0 } = {}) {
    const { frequency, periodsPerYear: periods, times, equity } = series;
    if (!Array.isArray(times) || !Array.isArray(equity) || times.length !== equity.length) {
      throw new TypeError('times and equity must be arrays of equal length');
    }
    if (!frequencies.includes(frequency)) throw new RangeError('Unknown sampling frequency');
    if (!Number.isFinite(periods) || periods <= 0) throw new RangeError('periodsPerYear must be finite and positive');
    if (!Number.isSafeInteger(months) || months <= 0) throw new RangeError('months must be a positive integer');
    start = start == null ? -Infinity : timestamp(start, 'start');
    end = end == null ? Infinity : timestamp(end, 'end');
    if (end < start) throw new RangeError('end precedes start');
    return {
      start, end, months, frequency, periods, scale: Math.sqrt(periods),
      sevenDay: frequency === 'daily' && periods >= 360, sessions: sessionCalendar(series.sessionDates, frequency),
      cash: periodRate(riskFree, periods, 'riskFree'), target: periodRate(target, periods, 'target'),
    };
  }

  function selection(series, cfg) {
    let first = 0, stop = 0, exhaustedAt = null, cutInsideDay = false;
    for (let i = 0; i < series.times.length; i++) {
      const t = timestamp(series.times[i], 'times[' + i + ']');
      if (i && t <= series.times[i - 1]) throw new RangeError('times must strictly increase');
      if (t > cfg.end) {
        cutInsideDay = stop > 0 && dayOf(series.times[stop - 1]) === dayOf(t);
        break;
      }
      const e = series.equity[i];
      if (!Number.isFinite(e)) throw new TypeError('equity[' + i + '] must be finite');
      if (i === 0 && e <= 0) throw new RangeError('Opening equity must be positive');
      stop = i + 1;
      if (t < cfg.start) first = stop;
      if (e <= 0) {
        exhaustedAt = t;
        break;
      }
    }
    const base = first > 0 && first < stop ? first - 1 : first;
    return {
      times: series.times.slice(base, stop), equity: series.equity.slice(base, stop),
      offset: first - base, sourceOpening: base === 0, exhaustedAt, cutInsideDay,
    };
  }

  // Preserve small price differences. Division first also handles, for example,
  // a move from +1e308 to -1e308 whose difference overflows.
  function change(open, end) {
    const delta = end - open;
    return Number.isFinite(delta) ? delta / open : end / open - 1;
  }

  function cagr(open, end, elapsed) {
    if (elapsed <= 0 || end < 0) return null;
    if (end === 0) return -1;
    const rate = change(open, end);
    const logGrowth = Number.isFinite(rate) && rate > -0.5
      ? Math.log1p(rate) : Math.log(end) - Math.log(open);
    return finite(Math.expm1(logGrowth * (YEAR / elapsed)));
  }

  function calmar(growth, depth) {
    return growth != null && depth < -EPSILON ? finite(growth / -depth) : null;
  }

  // Weekday count on [first, stop), including dates before the Unix epoch.
  function weekdays(first, stop) {
    const days = Math.max(0, stop - first);
    let count = 5 * Math.floor(days / 7);
    let weekday = ((first + 4) % 7 + 7) % 7;
    for (let i = 0; i < days % 7; i++) {
      if (weekday > 0 && weekday < 6) count++;
      weekday = (weekday + 1) % 7;
    }
    return count;
  }

  function monthNumber(date) {
    return date.getUTCFullYear() * 12 + date.getUTCMonth();
  }

  function periodKey(frequency, day, month) {
    switch (frequency) {
      case 'daily': return day;
      case 'weekly': return Math.floor((day + 3) / 7);
      case 'monthly': return month;
      case 'annual': return Math.floor(month / 12);
    }
  }

  // 0 = normal, 1 = possible market holiday, 2 = missing sampled interval.
  function interval(from, to, cfg) {
    const a = dayOf(from), b = dayOf(to);
    if (b <= a + 1) return 0;
    if (cfg.sessions) return sessionCount(cfg.sessions.days, a + 1, b) > 0 ? 2 : 0;
    if (cfg.frequency === 'daily') {
      return cfg.sevenDay ? 2 : Math.min(2, weekdays(a + 1, b));
    }
    const first = periodKey(cfg.frequency, a, monthNumber(new Date(from)));
    const last = periodKey(cfg.frequency, b, monthNumber(new Date(to)));
    return last - first > 1 ? 2 : 0;
  }

  function daysInMonth(year, month) {
    if (month === 1) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
    return [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month];
  }

  function monthsBefore(time, months) {
    const date = new Date(time);
    const serial = monthNumber(date) - months, year = Math.floor(serial / 12), month = serial - year * 12;
    const day = Math.min(date.getUTCDate(), daysInMonth(year, month));
    // setUTCFullYear also preserves the literal years 0 through 99.
    date.setUTCFullYear(year, month, day);
    return Number.isFinite(date.getTime()) ? date.getTime() : -Infinity;
  }

  function nearBoundary(time, unit, start, cfg, observedThrough) {
    const date = new Date(time), month = date.getUTCMonth(), year = date.getUTCFullYear();
    if (unit === 'year' && month !== (start ? 0 : 11)) return false;
    const day = date.getUTCDate(), epochDay = dayOf(time);
    const distance = start ? day - 1 : daysInMonth(year, month) - day;
    if (!distance || cfg.sevenDay) return distance === 0;
    if (start) return weekdays(epochDay - distance, epochDay) <= 1;
    const remaining = weekdays(epochDay + 1, epochDay + distance + 1);
    // Do not declare a December 30 selection complete with December 31 still due.
    return remaining === 0 || (remaining === 1 && dayOf(observedThrough) >= epochDay + distance);
  }

  // A gap crossing a boundary also affects the old period if a close was still due there.
  function gapAtPeriodEnd(time, unit, key, cfg) {
    const day = dayOf(time);
    if (cfg.sessions) return day < cfg.sessions[unit].get(key)?.last;
    const date = new Date(time), month = monthNumber(date);
    const endMonth = unit === 'month' ? date.getUTCMonth() : 11;
    date.setUTCMonth(endMonth, daysInMonth(date.getUTCFullYear(), endMonth));
    const end = dayOf(date.getTime());
    if (cfg.frequency === 'daily') return cfg.sevenDay ? day < end : weekdays(day + 1, end + 1) > 0;
    return periodKey(cfg.frequency, day, month) < periodKey(cfg.frequency, end, monthNumber(date));
  }

  function makeGroup(unit, key, i, priorKey, times, equity, cfg, sourceOpening) {
    const prior = i - 1;
    const schedule = cfg.sessions && cfg.sessions[unit].get(key);
    const priorDay = dayOf(times[prior]);
    let priorClose;
    if (cfg.sessions) {
      priorClose = schedule && priorKey < key
        && sessionCount(cfg.sessions.days, priorDay + 1, schedule.first) === 0;
    } else {
      priorClose = priorKey === key - 1 && nearBoundary(times[prior], unit, false, cfg, times[i]);
    }
    const open = priorKey === key || priorClose ? prior : i;
    const fundedAtStart = sourceOpening && open === 0 && (cfg.sessions
      ? schedule && dayOf(times[open]) <= schedule.first : nearBoundary(times[open], unit, true, cfg));
    return {
      key, open, last: open, high: equity[open], worst: 0, moments: null, gap: false,
      coveredStart: Boolean(priorClose || fundedAtStart), lastSession: null,
    };
  }

  function updateGroup(group, i, equity) {
    group.last = i;
    group.high = Math.max(group.high, equity[i]);
    if (group.high > 0) group.worst = Math.min(group.worst, change(group.high, equity[i]));
  }

  function periods(times, equity, cfg, sourceOpening) {
    const years = [], months = [], closes = [];
    let prevDay = dayOf(times[0]), prevMonth = monthNumber(new Date(times[0]));
    let prevYear = Math.floor(prevMonth / 12), lastKey, pending = -1;
    let yearGroup, monthGroup, onSession = true, offSessionMarks = 0;
    for (let i = 1; i < times.length; i++) {
      const day = dayOf(times[i]);
      const month = day === prevDay ? prevMonth : monthNumber(new Date(times[i]));
      const year = Math.floor(month / 12);
      const gap = day > prevDay + 1 && interval(times[i - 1], times[i], cfg) === 2;
      if (!yearGroup || yearGroup.key !== year) {
        if (gap && yearGroup && gapAtPeriodEnd(times[i - 1], 'year', prevYear, cfg)) yearGroup.gap = true;
        yearGroup = makeGroup('year', year, i, prevYear, times, equity, cfg, sourceOpening);
        years.push(yearGroup);
      }
      if (!monthGroup || monthGroup.key !== month) {
        if (gap && monthGroup && gapAtPeriodEnd(times[i - 1], 'month', prevMonth, cfg)) monthGroup.gap = true;
        monthGroup = makeGroup('month', month, i, prevMonth, times, equity, cfg, sourceOpening);
        months.push(monthGroup);
      }
      updateGroup(yearGroup, i, equity);
      updateGroup(monthGroup, i, equity);
      if (gap) yearGroup.gap = monthGroup.gap = true;
      if (cfg.sessions && (i === 1 || day !== prevDay)) {
        const days = cfg.sessions.days;
        onSession = days[lowerBound(days, day, days.length)] === day;
      }
      if (onSession) {
        const key = periodKey(cfg.frequency, day, month);
        if (pending >= 0 && key !== lastKey) closes.push(pending);
        pending = i;
        lastKey = key;
        yearGroup.lastSession = monthGroup.lastSession = day;
      } else {
        offSessionMarks++;
      }
      prevDay = day;
      prevMonth = month;
      prevYear = year;
    }
    if (pending >= 0) closes.push(pending);
    return { years, months, closes, offSessionMarks };
  }

  function moment(value, target) {
    return { n: 1, mean: value, ss: 0, shortfalls: Math.min(0, value - target) ** 2 };
  }

  // Parallel Welford combination avoids subtracting two nearly equal raw moments.
  function combineMoments(a, b) {
    if (!a || !b) return a || b;
    const n = a.n + b.n, delta = b.mean - a.mean;
    return {
      n, mean: a.mean + delta * (b.n / n),
      ss: a.ss + b.ss + delta ** 2 * (a.n / n) * b.n,
      shortfalls: a.shortfalls + b.shortfalls,
    };
  }

  function ratios(stats, cfg) {
    const result = { sharpe: null, sortino: null, volatility: null, downside: null };
    if (!stats) return result;
    const lower = Math.sqrt(stats.shortfalls / stats.n);
    result.downside = finite(lower * cfg.scale);
    if (stats.n < 2) return result;
    const sd = Math.sqrt(stats.ss / (stats.n - 1));
    const floor = EPSILON * Math.max(1, Math.abs(stats.mean));
    result.volatility = finite(sd * cfg.scale);
    if (Number.isFinite(sd) && sd > floor) result.sharpe = finite((stats.mean - cfg.cash) / sd * cfg.scale);
    if (Number.isFinite(lower) && lower > floor) result.sortino = finite((stats.mean - cfg.target) / lower * cfg.scale);
    return result;
  }

  function sampled(times, equity, groups, cfg, out) {
    const { closes, years } = groups, values = out.returns.values;
    const moments = [], missing = [0];
    let prev = 0, yearIndex = 0, all = null;
    for (const i of closes) {
      const from = times[prev], to = times[i];
      const status = interval(from, to, cfg);
      const value = status === 2 ? null : finite(change(equity[prev], equity[i]));
      const point = value == null ? null : moment(value, cfg.target);
      while (times[years[yearIndex].last] < to) yearIndex++;
      if (status === 2) {
        const gap = { from, to };
        if (cfg.sessions) gap.missingSessions = sessionCount(cfg.sessions.days, dayOf(from) + 1, dayOf(to));
        out.meta.gaps.push(gap);
      }
      if (status === 1) out.meta.possibleHolidayIntervals++;
      if (value == null) years[yearIndex].gap = true;
      years[yearIndex].moments = combineMoments(years[yearIndex].moments, point);
      all = combineMoments(all, point);
      out.returns.times.push(to);
      values.push(value);
      moments.push(point);
      missing.push(missing[missing.length - 1] + (value == null ? 1 : 0));
      prev = i;
    }
    out.meta.validReturns = all ? all.n : 0;
    return { all, moments, missing };
  }

  function drawdowns(times, equity, offset, out) {
    let peak = equity[0], peakTime = times[0], worst = 0, norm = 0, longest = 0, amount = 0;
    let active = null;
    function finish(recovery, end) {
      active.recovery = recovery;
      active.days = (end - active.peak) / DAY;
      active.depth = finite(active.depth);
      longest = Math.max(longest, active.days);
      out.episodes.push(active);
      active = null;
    }
    for (let i = offset; i < times.length; i++) {
      const value = equity[i], t = times[i];
      if (value >= peak) {
        if (active) finish(t, t);
        peak = value;
        peakTime = t;
      }
      const depth = change(peak, value);
      if (value < peak && (!active || depth < active.depth)) {
        if (!active) active = { peak: peakTime };
        active.trough = t;
        active.depth = depth;
      }
      worst = Math.min(worst, depth);
      amount = Math.max(amount, peak - value);
      norm = Math.hypot(norm, depth);
      out.drawdown.push(finite(depth));
      out.maxDrawdownPath.push(finite(worst));
    }
    if (active) finish(null, times[times.length - 1]);
    out.summary.maxDrawdown = finite(worst);
    out.summary.maxDrawdownAmount = finite(amount);
    out.summary.recoveryFactor = amount > 0 && Number.isFinite(amount)
      ? finite((equity[equity.length - 1] - equity[0]) / amount) : null;
    out.summary.drawdownDays = longest;
    out.summary.ulcer = finite(norm / Math.sqrt(times.length - offset));
  }

  function calendar(times, equity, groups, cfg, cutInsideDay, out) {
    let count = 0, meanReturn = 0, meanDepth = 0;
    const last = times.length - 1;
    function groupReturn(g) {
      return g.last > g.open ? finite(change(equity[g.open], equity[g.last])) : null;
    }
    function coverage(g, unit, value) {
      if (g.gap) return 'gap';
      if (value == null || !g.coveredStart || (g.last === last && cutInsideDay)) return 'partial';
      const end = cfg.sessions ? cfg.sessions[unit].get(g.key)?.last === g.lastSession
        : nearBoundary(times[g.last], unit, false, cfg, times[last]);
      return end ? 'full' : 'partial';
    }
    for (const g of groups.years) {
      const value = groupReturn(g), depth = g.last > g.open ? finite(g.worst) : null;
      const complete = depth != null && coverage(g, 'year', value) === 'full';
      out.years.push({ year: g.key, return: value, maxDrawdown: depth,
        sharpe: ratios(g.moments, cfg).sharpe, complete });
      if (complete) {
        count++;
        meanReturn += (value - meanReturn) / count;
        meanDepth += (depth - meanDepth) / count;
      }
    }
    for (const g of groups.months) {
      const year = Math.floor(g.key / 12), value = groupReturn(g);
      out.months.push({ year, month: g.key - year * 12 + 1, return: value,
        openingTime: g.open < g.last ? times[g.open] : null, closingTime: times[g.last],
        coverage: coverage(g, 'month', value) });
    }
    out.meta.completeYears = count;
    out.summary.meanYearReturn = count ? finite(meanReturn) : null;
    out.summary.meanYearDrawdown = count ? finite(meanDepth) : null;
  }

  // Each node covers a contiguous interval. Combine left before right. A query
  // reads O(log n) nodes even if a clamped cutoff moves backwards on a half-day.
  class RangeTree {
    constructor(length, leaf, combine) {
      this.combine = combine;
      this.size = 1;
      while (this.size < length) this.size *= 2;
      this.nodes = new Array(2 * this.size).fill(null);
      for (let i = 0; i < length; i++) this.nodes[this.size + i] = leaf(i);
      for (let i = this.size - 1; i > 0; i--) {
        this.nodes[i] = combine(this.nodes[2 * i], this.nodes[2 * i + 1]);
      }
    }

    query(first, stop) {
      let left = null, right = null;
      let a = this.size + first, b = this.size + stop;
      while (a < b) {
        if (a % 2) left = this.combine(left, this.nodes[a++]);
        if (b % 2) right = this.combine(this.nodes[--b], right);
        a = Math.floor(a / 2);
        b = Math.floor(b / 2);
      }
      return this.combine(left, right);
    }
  }

  function combinePaths(a, b) {
    if (!a || !b) return a || b;
    return {
      high: Math.max(a.high, b.high), low: Math.min(a.low, b.low),
      worst: Math.min(a.worst, b.worst, change(a.high, b.low)),
    };
  }

  function lowerBound(array, target, stop) {
    let first = 0;
    while (first < stop) {
      const mid = first + Math.floor((stop - first) / 2);
      if (array[mid] < target) first = mid + 1;
      else stop = mid;
    }
    return first;
  }

  function weeklyOpening(times, closes, closeTimes, k, cutoff) {
    const pos = lowerBound(closeTimes, cutoff, k + 1);
    if (closeTimes[pos] === cutoff) return closes[pos];
    const opening = pos === 0 ? 0 : closes[pos - 1];
    const week = (time) => Math.floor((dayOf(time) + 3) / 7);
    const target = week(cutoff), prior = week(times[opening]);
    if (prior === target) return opening;
    if (prior === target - 1 && pos <= k && week(closeTimes[pos]) === target) return opening;
    return null;
  }

  function windowBounds(times, closes, closeTimes, monthEnds, k, cfg) {
    const i = closes[k], end = times[i];
    if (monthEnds) {
      // The August closing valuation for a February window can fall on August 31.
      // The entire target month precedes the evaluation, including at partial closes.
      const opening = monthEnds.get(monthNumber(new Date(end)) - cfg.months);
      return opening === undefined ? null : { opening, first: opening };
    }
    const cutoff = monthsBefore(end, cfg.months);
    if (cutoff < times[0]) return null;
    if (cfg.frequency === 'weekly') {
      const opening = weeklyOpening(times, closes, closeTimes, k, cutoff);
      return opening == null ? null : { opening, first: opening };
    }
    const first = lowerBound(times, cutoff, i + 1);
    if (times[first] === cutoff) return { opening: first, first };
    const prior = times[first - 1];
    // An exchange closure can last weeks. Only the declared sessions due by
    // the cutoff affect its valuation. Missing later sessions affect ratios.
    const fresh = cfg.sessions
      ? sessionCount(cfg.sessions.days, dayOf(prior) + 1, dayOf(cutoff) + 1) === 0
      : cutoff - prior <= (cfg.sevenDay ? 1 : 4) * DAY && interval(prior, times[first], cfg) !== 2;
    return { opening: fresh ? first - 1 : null, first };
  }

  function rolling(times, equity, groups, samples, cfg, out) {
    const closes = groups.closes;
    const result = out.rolling;
    let monthEnds;
    if (cfg.frequency === 'monthly') {
      monthEnds = new Map([[monthNumber(new Date(times[0])), 0]]);
      for (const group of groups.months) monthEnds.set(group.key, group.last);
    }
    let paths, stats;
    for (let k = 0; k < closes.length; k++) {
      const i = closes[k], end = times[i];
      result.times.push(end);
      result.openingTimes.push(null);
      for (const key of rollingKeys) result[key].push(null);
      const bounds = windowBounds(times, closes, out.returns.times, monthEnds, k, cfg);
      if (!bounds) continue;
      if (!paths) {
        paths = new RangeTree(times.length, (j) => {
          // The sole nonpositive mark is terminal. Its signed depth must use
          // the high of the entire query, including when the terminal is debt.
          const value = equity[j];
          return value > 0 ? { high: value, low: value, worst: 0 } : null;
        }, combinePaths);
        stats = new RangeTree(closes.length, (j) => samples.moments[j], combineMoments);
      }
      const { first, opening } = bounds;
      const path = paths.query(first, i + 1);
      if (path && first < i) {
        result.maxDrawdown[k] = finite(equity[i] <= 0 ? change(path.high, equity[i]) : path.worst);
      }
      if (opening == null) continue;
      result.openingTimes[k] = times[opening];
      result.return[k] = finite(change(equity[opening], equity[i]));
      const growth = cagr(equity[opening], equity[i], end - times[opening]);
      result.calmar[k] = calmar(growth, result.maxDrawdown[k]);

      // A sampled interval belongs to the window only if its opening close
      // also belongs. The first interval opens at raw index zero.
      const begin = opening === 0 ? 0 : lowerBound(closes, opening, k + 1) + 1;
      if (begin > k || samples.missing[k + 1] !== samples.missing[begin]) continue;
      const r = ratios(stats.query(begin, k + 1), cfg);
      result.sharpe[k] = r.sharpe;
      result.sortino[k] = r.sortino;
      result.volatility[k] = r.volatility;
    }
  }

  function interpolate(a, b, weight) {
    if (weight === 0 || a === b) return a;
    if (weight === 1) return b;
    return a * (1 - weight) + b * weight;
  }

  function distribution(out) {
    const values = out.returns.values.filter(Number.isFinite).sort((a, b) => a - b);
    const n = values.length;
    if (!n) return;
    const lo = values[0], hi = values[n - 1], q = (n - 1) * 0.05;
    const threshold = interpolate(values[Math.floor(q)], values[Math.ceil(q)], q % 1);
    let tailCount = 0, tailMean = 0, positive = 0;
    const count = lo === hi ? 1 : Math.min(40, Math.ceil(Math.log2(n) + 1));
    for (let i = 0; i < count; i++) {
      out.bins.push({ lower: interpolate(lo, hi, i / count),
        upper: interpolate(lo, hi, (i + 1) / count), count: 0 });
    }
    // Values are sorted. Bins include their lower bound and the last includes its upper bound.
    let bin = 0;
    for (const value of values) {
      if (value > 0) positive++;
      if (value <= threshold) {
        tailCount++;
        tailMean += (value - tailMean) / tailCount;
      }
      while (bin + 1 < count && value >= out.bins[bin].upper) bin++;
      out.bins[bin].count++;
    }
    Object.assign(out.summary, { best: hi, worst: lo, var95: threshold, cvar95: finite(tailMean),
      positiveRate: positive / n });
  }

  function analyze(series, options) {
    const cfg = settings(series, options);
    const { times, equity, offset, sourceOpening, exhaustedAt, cutInsideDay } = selection(series, cfg);
    const last = times.length - 1;
    const summary = Object.fromEntries(summaryKeys.map((key) => [key, null]));
    const out = {
      times: offset ? times.slice(offset) : times, equity: offset ? equity.slice(offset) : equity,
      drawdown: [], maxDrawdownPath: [],
      rolling: Object.fromEntries(['times', 'openingTimes', ...rollingKeys].map((key) => [key, []])),
      returns: { times: [], values: [] }, summary, years: [], months: [], episodes: [], bins: [],
      meta: {
        frequency: cfg.frequency, periodsPerYear: cfg.periods, baselineTime: times[0] ?? null,
        exhaustedAt,
        calendar: cfg.sessions ? 'sessionDates' : cfg.sevenDay ? 'seven-day' : 'weekday convention',
        offSessionMarks: 0,
        validReturns: 0, gaps: [], possibleHolidayIntervals: 0, completeYears: 0, unavailable: [],
      },
    };
    if (last >= 0) {
      summary.startEquity = equity[0];
      summary.endEquity = equity[last];
      summary.totalReturn = finite(change(equity[0], equity[last]));
      summary.cagr = cagr(equity[0], equity[last], times[last] - times[0]);
      drawdowns(times, equity, offset, out);
      summary.calmar = calmar(summary.cagr, summary.maxDrawdown);
      const groups = periods(times, equity, cfg, sourceOpening);
      out.meta.offSessionMarks = groups.offSessionMarks;
      const samples = sampled(times, equity, groups, cfg, out);
      Object.assign(summary, ratios(samples.all, cfg));
      calendar(times, equity, groups, cfg, cutInsideDay, out);
      rolling(times, equity, groups, samples, cfg, out);
      distribution(out);
    }
    out.meta.unavailable = summaryKeys.filter((key) => summary[key] === null);
    return out;
  }

  const api = Object.freeze({ analyze, conventions });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PerformanceMetrics = api;
})();
