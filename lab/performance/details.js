/* Browser: window.PerformanceDetails. CommonJS: require("./details.js").
 * Dates are inclusive UTC epoch milliseconds. Ratios are decimals. Undefined metrics are null.
 * benchmark and correlationMatrix require identical interval endpoints, frequency and periodsPerYear.
 * benchmark uses evidence.returnCurrency for a currency-based index. Both series must use the
 * same clock: observed timestamps (the default) or explicitly declared date labels.
 * The matrix requires identical display currencies. Counts can differ between matrix cells.
 * strategyGroups and correlationMatrix accept {ids, portfolio}. IDs set the display order.
 * tails accepts PerformanceMetrics.analyze(series, opts).returns.values and a per-period target.
 * trades uses dated closes. evidenceCoverage describes supplied evidence at its stated scope.
 * attribution uses declared funded NAV histories or dated paper P&L fractions of original capital.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(() => require("./metrics.js"));
  } else {
    root.PerformanceDetails = factory(() => root.PerformanceMetrics);
  }
})(typeof window === "undefined" ? globalThis : window, function (getMetrics) {
  "use strict";

  const finite = Number.isFinite;
  const text = value => typeof value === "string" && value.trim().length > 0;
  const placeholders = new Set(["unknown", "unspecified", "not recorded", "not available", "unreported", "n/a"]);
  const suppliedText = value => text(value) && !placeholders.has(value.trim().toLowerCase());
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const numberOrNull = value => finite(value) ? value : null;
  const ratio = (a, b) => finite(a) && finite(b) && b !== 0 ? numberOrNull(a / b) : null;

  function bounds(opts) {
    const { start, end } = opts;
    if ((start != null && !finite(start)) || (end != null && !finite(end))) return null;
    if (start != null && end != null && end < start) return null;
    return { start: start ?? -Infinity, end: end ?? Infinity };
  }

  // The terminal mark belongs to the history. A later positive mark cannot restart it.
  function equityHorizon(series, cutoff) {
    const { times, equity } = series || {};
    if (!Array.isArray(times) || !Array.isArray(equity) ||
        !times.length || times.length !== equity.length) return null;
    for (let i = 0; i < times.length; i++) {
      if (!finite(times[i]) || (i && times[i] <= times[i - 1])) return null;
      if (times[i] > cutoff) return { start: times[0], end: cutoff };
      if (!finite(equity[i]) || (i === 0 && equity[i] <= 0)) return null;
      if (equity[i] <= 0 || i === times.length - 1) return { start: times[0], end: times[i] };
    }
  }

  function interpolate(a, b, weight) {
    if (a === b || weight === 0) return a;
    if (weight === 1) return b;
    return finite(b - a) ? a + (b - a) * weight : a * (1 - weight) + b * weight;
  }

  // Equal widths. A value on an interior edge enters the bin to its right.
  function histogram(rows, low, high) {
    if (low === high) return [{ lower: low, upper: high, count: rows.length }];
    const n = Math.min(20, Math.ceil(Math.sqrt(rows.length)));
    const bins = Array.from({ length: n }, (_, i) => ({
      lower: interpolate(low, high, i / n), upper: interpolate(low, high, (i + 1) / n), count: 0
    }));
    for (const { pnl } of rows) {
      const bin = bins.find(item => pnl < item.upper) || bins[n - 1];
      bin.count++;
    }
    return bins;
  }

  const datedTrade = row => row != null && finite(row.time) && finite(row.pnl);

  function tradeBucket() {
    return { count: 0, wins: 0, losses: 0, flat: 0, avgWin: 0, avgLoss: 0, pnl: 0, correction: 0,
      grossProfit: 0, grossLoss: 0, largestWinner: null, largestLoser: null };
  }

  // Neumaier compensation retains small cash amounts when large trades offset.
  function additionRoundoff(sum, term, next) {
    if (!finite(next)) return 0;
    return Math.abs(sum) >= Math.abs(term) ? (sum - next) + term : (term - next) + sum;
  }

  function recordPnl(bucket, pnl) {
    bucket.count++;
    const next = bucket.pnl + pnl;
    bucket.correction += additionRoundoff(bucket.pnl, pnl, next);
    bucket.pnl = next;
    if (pnl > 0) {
      bucket.avgWin += (pnl - bucket.avgWin) / ++bucket.wins;
      bucket.grossProfit += pnl;
      bucket.largestWinner = Math.max(bucket.largestWinner ?? pnl, pnl);
    } else if (pnl < 0) {
      bucket.avgLoss += (pnl - bucket.avgLoss) / ++bucket.losses;
      bucket.grossLoss += pnl;
      bucket.largestLoser = Math.min(bucket.largestLoser ?? pnl, pnl);
    } else bucket.flat++;
  }

  function meanPnl(bucket) {
    const net = bucket.pnl + bucket.correction;
    if (finite(net)) return net / bucket.count;
    return bucket.avgWin * (bucket.wins / bucket.count) + bucket.avgLoss * (bucket.losses / bucket.count);
  }

  function totalPnl(bucket) {
    const net = bucket.pnl + bucket.correction;
    return finite(net) ? net : numberOrNull(meanPnl(bucket) * bucket.count);
  }

  function measuredTrades(bucket = tradeBucket()) {
    const { count, wins, losses, flat, avgWin, avgLoss, largestWinner, largestLoser } = bucket;
    const weight = Math.max(wins, losses, 1);
    const expectancy = count ? numberOrNull(meanPnl(bucket)) : null;
    return {
      count, wins, losses, flat, winRate: ratio(wins, count), expectancy,
      netPnl: totalPnl(bucket),
      grossProfit: numberOrNull(bucket.grossProfit), grossLoss: numberOrNull(bucket.grossLoss),
      profitFactor: ratio(avgWin * (wins / weight), -avgLoss * (losses / weight)),
      avgWin: wins ? avgWin : null, avgLoss: losses ? avgLoss : null, largestWinner, largestLoser,
      // Divide by the group mean first so an overflowing subtotal does not erase its share.
      largestWinnerShare: wins ? ratio(largestWinner / avgWin, wins) : null,
      largestLoserShare: losses ? ratio(largestLoser / avgLoss, losses) : null,
    };
  }

  function tradeBreakdown(total, sides) {
    const all = measuredTrades(total), long = measuredTrades(sides.get("long")), short = measuredTrades(sides.get("short"));
    return { all, long, short, unclassifiedCount: all.count - long.count - short.count };
  }

  /** Use realized P&L at each close in [start, end], in original P&L units.
   *  A flat trade ends both streaks. Equal timestamps retain source order.
   *  The count is the number of usable rows. Source summaries have their own scope. */
  function trades(series, opts = {}) {
    const partial = series?.evidence?.tradeCoverage === "partial";
    const result = {
      count: 0, wins: 0, losses: 0, flat: 0, winRate: null, profitFactor: null,
      expectancy: null, avgWin: null, avgLoss: null, payoff: null, best: null, worst: null,
      winStreak: partial ? null : 0, lossStreak: partial ? null : 0, meanHoldingHours: null, bySide: {}, bins: [],
      breakdown: null, outcomes: []
    };
    if (!Array.isArray(series?.trades)) return { ...result, reason: "Dated realized trades are unavailable." };
    const range = bounds(opts);
    const horizon = range && equityHorizon(series, range.end);
    if (!range || !horizon) return { ...result, reason: "The date range or equity marks are invalid." };
    const start = Math.max(range.start, horizon.start);
    const end = Math.min(range.end, horizon.end);
    const rows = series.trades.filter(row => row && finite(row.time) && row.time >= start && row.time <= end && finite(row.pnl));
    const sides = new Map(), total = tradeBucket();
    if (!rows.length) return { ...result, breakdown: tradeBreakdown(total, sides), reason: "No dated realized trades closed in this range." };
    rows.sort((a, b) => a.time - b.time);

    result.best = result.worst = rows[0].pnl;
    let winRun = 0, lossRun = 0, holdingMean = 0, holdingCount = 0;
    for (const row of rows) {
      const { pnl, holdingHours } = row;
      const side = text(row.side) ? row.side.trim().toLowerCase() : "unknown";
      result.outcomes.push({ time: row.time, pnl, side, holdingHours: finite(holdingHours) && holdingHours >= 0 ? holdingHours : null });
      if (!sides.has(side)) sides.set(side, tradeBucket());
      recordPnl(total, pnl);
      recordPnl(sides.get(side), pnl);
      result.best = Math.max(result.best, pnl);
      result.worst = Math.min(result.worst, pnl);
      if (!partial) {
        winRun = pnl > 0 ? winRun + 1 : 0;
        lossRun = pnl < 0 ? lossRun + 1 : 0;
        result.winStreak = Math.max(result.winStreak, winRun);
        result.lossStreak = Math.max(result.lossStreak, lossRun);
      }
      if (finite(holdingHours) && holdingHours >= 0) holdingMean += (holdingHours - holdingMean) / ++holdingCount;
    }
    result.bySide = Object.fromEntries(Array.from(sides, ([side, bucket]) => {
      const { count, wins, losses, flat } = bucket;
      return [side, { count, wins, losses, flat, winRate: wins / count, pnl: totalPnl(bucket) }];
    }));
    const { count, wins, losses, flat, avgWin, avgLoss } = total;
    Object.assign(result, { count, wins, losses, flat, winRate: wins / count, expectancy: meanPnl(total),
      avgWin: wins ? avgWin : null, avgLoss: losses ? avgLoss : null });
    result.breakdown = tradeBreakdown(total, sides);
    result.profitFactor = result.breakdown.all.profitFactor;
    result.payoff = result.avgLoss === null ? null : ratio(result.avgWin, -result.avgLoss);
    result.meanHoldingHours = holdingCount ? holdingMean : null;
    result.bins = histogram(rows, result.worst, result.best);
    if (partial) result.reason = "The ledger is partial. Statistics use the supplied closes. Streaks require the full sequence.";
    return result;
  }

  /** Descriptive population moments (minimum 3/4 observations), with excess over 3.
   *  Percentiles interpolate at (n - 1) * p. Tail ratio is |Q95| / |Q05|.
   *  Omega divides total gains above a per-period target by total shortfall below it. */
  function tails(values, periodTarget = 0) {
    const result = { skewness: null, excessKurtosis: null, omega: null, tailRatio: null, median: null };
    if (!Array.isArray(values)) return result;
    const sorted = values.filter(finite).sort((a, b) => a - b);
    const n = sorted.length;
    if (!n) return result;
    function quantile(p) {
      const rank = (n - 1) * p;
      return interpolate(sorted[Math.floor(rank)], sorted[Math.ceil(rank)], rank % 1);
    }
    result.median = quantile(0.5);
    result.tailRatio = ratio(Math.abs(quantile(0.95)), Math.abs(quantile(0.05)));
    const scale = Math.max(Math.abs(sorted[0]), Math.abs(sorted[n - 1])) || 1;
    if (finite(periodTarget)) {
      const omegaScale = Math.max(scale, Math.abs(periodTarget));
      let gains = 0, shortfall = 0;
      for (const value of sorted) {
        const excess = value / omegaScale - periodTarget / omegaScale;
        gains += Math.max(0, excess);
        shortfall += Math.max(0, -excess);
      }
      result.omega = ratio(gains, shortfall);
    }
    if (sorted[0] === sorted[n - 1] || n < 3) return result;
    const midpoint = interpolate(sorted[0], sorted[n - 1], 0.5);
    const spread = Math.max(sorted[n - 1] - midpoint, midpoint - sorted[0]);
    const mean = sorted.reduce((sum, x) => sum + (x - midpoint) / spread, 0) / n;
    let m2 = 0, m3 = 0, m4 = 0;
    for (const value of sorted) {
      const delta = (value - midpoint) / spread - mean;
      m2 += delta ** 2;
      m3 += delta ** 3;
      m4 += delta ** 4;
    }
    const variance = m2 / n;
    result.skewness = ratio(m3 / n, variance ** 1.5);
    if (n >= 4 && variance > 0) result.excessKurtosis = numberOrNull((m4 / n) / variance ** 2 - 3);
    return result;
  }

  function correlationMemberIds(portfolio) {
    if (Array.isArray(portfolio.holdings)) {
      return portfolio.holdings.filter(h => h && finite(h.weight) && h.weight !== 0).map(h => h.id);
    }
    const declaration = portfolio.evidence?.attribution;
    return declaration?.basis === "funded_equity" && Array.isArray(declaration.members)
      ? declaration.members : [];
  }

  /** Gain-to-pain uses finite signed period returns. Log growth uses the actual
   *  equity endpoints, so a missing intermediate return cannot reduce the horizon. */
  function returnMeasures(analysis) {
    const values = analysis.returns.values;
    let scale = 0, validReturns = 0;
    for (const value of values) {
      if (!finite(value)) continue;
      scale = Math.max(scale, Math.abs(value));
      validReturns++;
    }
    let sum = 0, correction = 0, pain = 0;
    if (scale > 0) {
      for (const value of values) {
        if (!finite(value)) continue;
        const term = value / scale, next = sum + term;
        correction += additionRoundoff(sum, term, next);
        sum = next;
        if (term < 0) pain -= term;
      }
    }
    const { startEquity: open, endEquity: end } = analysis.summary;
    let cumulativeLogReturn = null;
    if (finite(open) && open > 0 && finite(end) && end > 0) {
      const change = (end - open) / open;
      cumulativeLogReturn = Math.abs(change) < 0.5 ? Math.log1p(change) : Math.log(end) - Math.log(open);
    }
    return { gainToPain: ratio(sum + correction, pain), cumulativeLogReturn, validReturns };
  }

  const utcDay = 86_400_000;
  const monthNumber = date => date.getUTCFullYear() * 12 + date.getUTCMonth();

  function nextMonth(date) {
    const next = new Date(date.getTime());
    next.setUTCHours(0, 0, 0, 0);
    next.setUTCMonth(next.getUTCMonth() + 1, 1);
    return next.getTime();
  }

  // The report accepts weekends and at most one possible weekday holiday
  // after a trading close. A seven-day market must reach the final UTC day.
  function nearMonthEnd(date, sevenDay = false) {
    const remaining = nextMonth(date) / utcDay - 1 - Math.floor(date.getTime() / utcDay);
    if (!remaining || sevenDay) return remaining === 0;
    if (remaining > 3) return false;
    let weekdays = 0;
    for (let d = 1; d <= remaining; d++) {
      const weekday = (date.getUTCDay() + d) % 7;
      if (weekday > 0 && weekday < 6) weekdays++;
    }
    return weekdays <= 1;
  }

  // For each scheduled month, record its preceding expected session. A long
  // exchange closure can connect two observed months that are far apart.
  function precedingSessions(series) {
    if (!Array.isArray(series.sessionDates)) return null;
    const result = new Map();
    let previous = -Infinity, lastMonth;
    for (const iso of series.sessionDates) {
      const month = Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;
      if (month !== lastMonth) result.set(month, previous);
      previous = Date.parse(iso);
      lastMonth = month;
    }
    return result;
  }

  /** Subtract actual marks at the calendar return's boundaries. Division by
   *  (1 + return) cannot recover opening capital after a total loss. */
  function monthlyAmounts(series, analysis) {
    const unitized = /\b(?:uniti[sz]ed|per[ -](?:unit|share))\b/i.test(series.accounting || "");
    const unit = series.currency === "INDEX" ? "index points"
      : unitized ? series.currency + " per unit" : series.currency;
    if (analysis.months.every(row => Object.hasOwn(row, "amount"))) {
      return { unit, months: analysis.months.map(row => ({ ...row })) };
    }
    const { times, equity } = analysis, sessions = precedingSessions(series);
    let priorTime = analysis.meta.baselineTime, priorEquity = analysis.summary.startEquity;
    let i = times[0] === priorTime ? 1 : 0;
    const months = analysis.months.map(row => {
      const first = i, stop = nextMonth(new Date(times[i]));
      while (i < times.length && times[i] < stop) i++;
      const key = row.year * 12 + row.month - 1, prior = new Date(priorTime);
      const priorMonth = monthNumber(prior);
      const canCarry = sessions ? sessions.has(key) && priorTime >= sessions.get(key)
        : priorMonth === key - 1 && nearMonthEnd(prior, analysis.meta.calendar === "seven-day");
      const open = priorMonth === key || canCarry ? priorEquity : equity[first];
      priorTime = times[i - 1];
      priorEquity = equity[i - 1];
      return { ...row, amount: finite(row.return) ? numberOrNull(priorEquity - open) : null };
    });
    return { unit, months };
  }

  /** Equal-weight means of complete calendar periods from an unfiltered history. */
  function calendarAverages(history) {
    function average(periods) {
      const count = periods.length;
      if (!count) return { count: 0, return: null, amount: null };
      const mean = key => periods.every(p => finite(p[key]))
        ? numberOrNull(periods.reduce((sum, p) => sum + p[key] / count, 0)) : null;
      return { count, return: mean("return"), amount: mean("amount") };
    }
    const byMonth = Array.from({ length: 12 }, () => []);
    for (const period of history.months) {
      if (period.coverage === "full" && finite(period.return)) byMonth[period.month - 1].push(period);
    }
    return { months: byMonth.map(average), year: average(history.years.filter(p => p.complete && finite(p.return))) };
  }

  /** Count positive, flat and losing historical windows at the declared closes.
   *  Pass analyze(series, { months, ...bounds }) for the same month count. */
  function profitableWindows(analysis, months) {
    const { rolling, returns, meta } = analysis;
    const result = { months, profitable: 0, flat: 0, losing: 0, eligible: 0, gapped: 0,
      excluded: rolling.times.length, rate: null, reason: null };
    if (meta.frequency === "annual" && months % 12 !== 0) {
      result.reason = "Annual closes provide only whole-year windows.";
      return result;
    }
    let lastMissing = -Infinity;
    for (let i = 0; i < rolling.times.length; i++) {
      const end = rolling.times[i], open = rolling.openingTimes[i], value = rolling.return[i];
      if (!finite(returns.values[i])) lastMissing = end;
      if (!finite(open)) continue;
      if (lastMissing > open) {
        result.gapped++;
        continue;
      }
      if (!finite(value)) continue;
      if (meta.frequency === "monthly") {
        const opening = new Date(open), closing = new Date(end);
        // Match monthly observation days or two conventional month ends
        // (e.g. August/February). A funding or partial close can be weeks off.
        if (monthNumber(closing) - monthNumber(opening) !== months) continue;
        if (opening.getUTCDate() !== closing.getUTCDate() && !(nearMonthEnd(opening) && nearMonthEnd(closing))) continue;
      }
      result.eligible++;
      if (value > 0) result.profitable++;
      else if (value === 0) result.flat++;
      else result.losing++;
    }
    result.excluded -= result.eligible;
    result.rate = ratio(result.profitable, result.eligible);
    if (!result.eligible) result.reason = "No full window has both a usable opening and continuous sampled returns.";
    return result;
  }

  // An explicit selection keeps its order. Short holdings qualify. A zero weight does not.
  function selectedStrategies(seriesArray, opts) {
    const entries = Array.isArray(seriesArray) ? seriesArray : [];
    const strategies = new Map(entries.filter(s => s?.kind === "strategy" && text(s.id)).map(s => [s.id, s]));
    const held = opts.portfolio == null ? null : new Set(correlationMemberIds(opts.portfolio));
    const ids = opts.ids == null ? (held || strategies.keys()) : new Set(opts.ids);
    return Array.from(ids).filter(id => strategies.has(id) && (!held || held.has(id))).map(id => strategies.get(id));
  }

  /** Group selected strategies by their declared family. Preserve source or selection order. */
  function strategyGroups(seriesArray, opts = {}) {
    const groups = new Map();
    for (const series of selectedStrategies(seriesArray, opts)) {
      const family = text(series.family) ? series.family.trim() : "Unspecified";
      if (!groups.has(family)) groups.set(family, []);
      groups.get(family).push(series.id);
    }
    return Array.from(groups, ([family, ids]) => ({ family, ids }));
  }

  function benchmarkCurrency(series) {
    const currency = series.currency, declared = series.evidence?.returnCurrency;
    if (!suppliedText(currency)) return null;
    if (declared === undefined) return currency;
    if (!suppliedText(declared) || declared === "INDEX") return null;
    return currency === "INDEX" || declared === currency ? declared : null;
  }

  function incompatible(a, b, benchmarkReturns = false) {
    if (!a || !b) return "Two dated equity series are required.";
    if (benchmarkReturns) {
      const currency = benchmarkCurrency(a);
      if (!currency || currency !== benchmarkCurrency(b)) {
        return "The series require the same declared return currency. No conversion was supplied.";
      }
      const { markTimeBasis: leftClock = "observed_timestamp" } = a.evidence || {};
      const { markTimeBasis: rightClock = "observed_timestamp" } = b.evidence || {};
      if (leftClock !== rightClock || !["observed_timestamp", "date_label"].includes(leftClock)) {
        return "Benchmark intervals require the same clock on both sides: observed timestamps or declared date labels.";
      }
    } else if (!suppliedText(a.currency) || a.currency !== b.currency) {
      return "The series require the same declared currency. No conversion was supplied.";
    }
    if (a.frequency !== b.frequency || a.periodsPerYear !== b.periodsPerYear) {
      return "The series require the same sampling frequency and periods per year.";
    }
    return null;
  }

  function readAnalysis(series, opts) {
    const metrics = getMetrics();
    if (!metrics?.analyze) return { reason: "The shared performance metrics module is unavailable." };
    try {
      return { analysis: metrics.analyze(series, opts) };
    } catch (err) {
      if (err instanceof RangeError || err instanceof TypeError) return { reason: err.message };
      throw err;
    }
  }

  // A missing return still advances the opening mark for the next sampled interval.
  function intervals(analysis) {
    const { times, values } = analysis.returns;
    const rows = [];
    let start = analysis.meta.baselineTime;
    for (let i = 0; i < times.length; i++) {
      const end = times[i];
      if (finite(values[i]) && finite(start) && start < end) rows.push({ start, end, value: values[i] });
      start = end;
    }
    return rows;
  }

  function sample(series, opts) {
    const { analysis, reason } = readAnalysis(series, opts);
    return { rows: analysis ? intervals(analysis) : [], reason,
      start: analysis?.meta.baselineTime, end: analysis?.times.at(-1), gaps: analysis?.meta.gaps.length || 0 };
  }

  function common(left, right, visit) {
    let i = 0, j = 0;
    while (i < left.length && j < right.length) {
      const a = left[i], b = right[j];
      if (a.end === b.end && a.start === b.start) visit(a, b);
      if (a.end <= b.end) i++;
      if (b.end <= a.end) j++;
    }
  }

  // Center the sums as each pair arrives. xx and yy are sums of squared deviations.
  const moments = () => ({ n: 0, meanX: 0, meanY: 0, xx: 0, xy: 0, yy: 0 });

  function observe(s, x, y) {
    const dx = x - s.meanX, dy = y - s.meanY;
    s.n++;
    s.meanX += dx / s.n;
    s.meanY += dy / s.n;
    s.xx += dx * (x - s.meanX);
    s.xy += dx * (y - s.meanY);
    s.yy += dy * (y - s.meanY);
  }

  function deviation(sumSquares, mean, n) {
    if (n < 2) return null;
    const sd = Math.sqrt(Math.max(0, sumSquares) / (n - 1));
    return sd <= 8 * Number.EPSILON * Math.max(1, Math.abs(mean)) ? 0 : numberOrNull(sd);
  }

  function correlation(s) {
    if (!(deviation(s.xx, s.meanX, s.n) > 0 && deviation(s.yy, s.meanY, s.n) > 0)) return null;
    const r = s.xy / Math.sqrt(s.xx) / Math.sqrt(s.yy);
    return finite(r) ? Math.max(-1, Math.min(1, r)) : null;
  }

  function slope(s) {
    if (!(deviation(s.yy, s.meanY, s.n) > 0)) return null;
    return deviation(s.xx, s.meanX, s.n) === 0 ? 0 : ratio(s.xy, s.yy);
  }

  function combined(a, b) {
    const n = a.n + b.n, weight = b.n / n, cross = a.n * weight;
    const dx = b.meanX - a.meanX, dy = b.meanY - a.meanY;
    return {
      n, meanX: a.meanX + dx * weight, meanY: a.meanY + dy * weight,
      xx: a.xx + b.xx + dx * dx * cross, xy: a.xy + b.xy + dx * dy * cross,
      yy: a.yy + b.yy + dy * dy * cross
    };
  }

  // A trailing window spans at most two blocks of 'width' consecutive matched intervals.
  // Each observation enters one forward and one backward scan. No unstable variance subtraction.
  function rollingCorrelation(pairs, width) {
    const rolling = { times: [], correlation: [] };
    let prefix = moments(), suffix = [];
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[i];
      if (i && p.start !== pairs[i - 1].end) {
        prefix = moments();
        suffix = [];
      }
      if (prefix.n === width) {
        const previous = moments();
        suffix = [];
        for (let j = i - 1; j >= i - width; j--) {
          observe(previous, pairs[j].x, pairs[j].y);
          suffix.push({ ...previous });
        }
        prefix = moments();
      }
      observe(prefix, p.x, p.y);
      const preceding = suffix[width - prefix.n - 1];
      let value = null;
      if (prefix.n === width) value = correlation(prefix);
      else if (preceding) value = correlation(combined(preceding, prefix));
      rolling.times.push(p.end);
      rolling.correlation.push(value);
    }
    return rolling;
  }

  /** Compare only complete, equal endpoint pairs from the two sampled streams.
   *  Bounds select return closes. coverage.start includes the first actual opening mark.
   *  Fractions divide paired intervals by each side's usable intervals in the selection.
   *  Alpha is the arithmetic annual excess-return intercept. riskFree is an effective annual decimal.
   *  Tracking error is the sample deviation of active returns times sqrt(periodsPerYear).
   *  The information ratio divides annual mean active return by tracking error.
   *  rollingWindow counts consecutive pairs, defaulting to half a year of observations
   *  or round(periodsPerYear * opts.months / 12) when months is supplied. Minimum two. */
  function benchmark(series, other, opts = {}) {
    const coverage = { start: null, end: null, segments: 0, seriesCount: 0, benchmarkCount: 0,
      seriesFraction: null, benchmarkFraction: null };
    const out = { coverage, count: 0, correlation: null, beta: null, alpha: null, trackingError: null,
      informationRatio: null, upCapture: null, downCapture: null, rolling: { times: [], correlation: [] } };
    const mismatch = incompatible(series, other, true);
    if (mismatch) return { ...out, reason: mismatch };
    const periods = series.periodsPerYear;
    const width = opts.rollingWindow ?? Math.max(2, Math.round(periods * (opts.months ?? 6) / 12));
    if (!Number.isSafeInteger(width) || width < 2) return { ...out, reason: "The rolling window needs at least two whole intervals." };
    const left = sample(series, opts), right = series === other ? left : sample(other, opts);
    if (left.reason || right.reason) return { ...out, reason: left.reason || right.reason };
    const pairs = [], stats = moments();
    let upX = 0, upY = 0, downX = 0, downY = 0, activeMean = 0, activeSquares = 0;
    common(left.rows, right.rows, (a, b) => {
      const x = a.value, y = b.value;
      pairs.push({ start: a.start, end: a.end, x, y });
      if (coverage.end !== a.start) coverage.segments++;
      coverage.start ??= a.start;
      coverage.end = a.end;
      observe(stats, x, y);
      const active = x - y, delta = active - activeMean;
      activeMean += delta / stats.n;
      activeSquares += delta * (active - activeMean);
      if (y > 0) { upX += x; upY += y; }
      if (y < 0) { downX += x; downY += y; }
    });
    out.count = stats.n;
    coverage.seriesCount = left.rows.length;
    coverage.benchmarkCount = right.rows.length;
    coverage.seriesFraction = ratio(stats.n, coverage.seriesCount);
    coverage.benchmarkFraction = ratio(stats.n, coverage.benchmarkCount);
    if (!stats.n) return { ...out, reason: "No usable returns share both opening and closing marks." };
    // Capture is the ratio of arithmetic means conditional on the sign of the reference return.
    out.upCapture = ratio(upX, upY);
    out.downCapture = ratio(downX, downY);
    out.rolling = rollingCorrelation(pairs, width);
    if (stats.n < 2) return { ...out, reason: "Covariance and tracking error require two matched intervals." };
    out.correlation = correlation(stats);
    out.beta = slope(stats);
    const cash = Math.expm1(Math.log1p(opts.riskFree ?? 0) / periods);
    if (out.beta !== null) out.alpha = numberOrNull(((stats.meanX - cash) - out.beta * (stats.meanY - cash)) * periods);
    const activeSD = deviation(activeSquares, activeMean, stats.n);
    if (activeSD !== null) out.trackingError = numberOrNull(activeSD * Math.sqrt(periods));
    out.informationRatio = ratio(activeMean * periods, out.trackingError);
    if (out.correlation === null) out.reason = "Correlation requires variation in both matched return series.";
    return out;
  }

  function missingCorrelation(left, right, a, b, stats) {
    const inputs = a.id === b.id ? [[a, left]] : [[a, left], [b, right]];
    const missing = inputs.filter(([, s]) => s.end == null).map(([s]) => s.name);
    if (missing.length) return `No equity marks in the selected dates for ${missing.join(" and ")}.`;
    const empty = inputs.filter(([, s]) => !s.rows.length).map(([s]) => s.name);
    if (empty.length) return `No usable sampled return in the selected dates for ${empty.join(" and ")}.`;
    if (!stats.n) {
      if (Math.min(left.end, right.end) <= Math.max(left.start, right.start)) return "The observed return intervals do not overlap.";
      return "No usable pair has the same opening and closing timestamps.";
    }
    if (stats.n === 1) return "Only one interval matched. Correlation needs at least two shared intervals.";
    const flat = [];
    if (deviation(stats.xx, stats.meanX, stats.n) === 0) flat.push(a.name);
    if (a.id !== b.id && deviation(stats.yy, stats.meanY, stats.n) === 0) flat.push(b.name);
    if (flat.length) return `Constant sampled returns for ${flat.join(" and ")} over the matched intervals.`;
    return "The matched returns exceed the numeric range for correlation.";
  }

  /** Each cell counts exact matched intervals. Request diagnostics for bounds, spans and a
   *  display reason. The bounds describe the outer matched marks, including the opening mark. */
  function correlationMatrix(seriesArray, opts = {}) {
    const selected = selectedStrategies(seriesArray, opts);
    const samples = selected.map(s => sample(s, opts));
    const values = selected.map(() => Array(selected.length).fill(null));
    const counts = selected.map(() => Array(selected.length).fill(0));
    const diagnostics = opts.diagnostics ? selected.map(() => Array(selected.length)) : null;
    for (let i = 0; i < selected.length; i++) {
      for (let j = i; j < selected.length; j++) {
        const a = selected[i], b = selected[j], left = samples[i], right = samples[j];
        const mismatch = incompatible(a, b);
        const problem = mismatch || left.reason || right.reason;
        const stats = moments();
        let start = null, end = null, segments = 0;
        if (!problem) common(left.rows, right.rows, (x, y) => {
          observe(stats, x.value, y.value);
          if (end !== x.start) segments++;
          start ??= x.start;
          end = x.end;
        });
        let r = correlation(stats);
        if (i === j && r !== null) r = 1;
        counts[i][j] = counts[j][i] = stats.n;
        values[i][j] = values[j][i] = r;
        if (diagnostics) {
          const reason = problem || (r === null ? missingCorrelation(left, right, a, b, stats) : null);
          const notes = [];
          if (mismatch) {
            const basis = s => `${s.name} uses ${s.currency || "unspecified units"}, ${s.frequency}, ${s.periodsPerYear} periods per year.`;
            notes.push(basis(a), basis(b));
          }
          if (!problem && (left.gaps || right.gaps)) notes.push("The sampler excluded gaps in the selected dates.");
          if (segments > 1) notes.push(`The matches form ${segments} separate spans.`);
          if (stats.n && (left.rows.length !== stats.n || right.rows.length !== stats.n)) {
            const usable = (n, name) => `${n} usable return${n === 1 ? "" : "s"} for ${name}`;
            notes.push(`The range has ${usable(left.rows.length, a.name)} and ${usable(right.rows.length, b.name)}.`);
          }
          if (r !== null && stats.n === 2) notes.push("With only two shared intervals, the magnitude is always 1.");
          diagnostics[i][j] = diagnostics[j][i] = { start, end, segments, reason, note: notes.join(" ") };
        }
      }
    }
    const result = { ids: selected.map(s => s.id), names: selected.map(s => s.name), values, counts };
    if (diagnostics) result.diagnostics = diagnostics;
    return result;
  }

  function fundedMembers(portfolio, allSeries) {
    const evidence = portfolio?.evidence?.attribution;
    if (portfolio?.kind !== "portfolio" || evidence?.basis !== "funded_equity") {
      return { reason: "The portfolio needs a funded_equity or paper_additive attribution declaration." };
    }
    const ids = evidence.members;
    if (!Array.isArray(ids) || !ids.length || !ids.every(text) || new Set(ids).size !== ids.length) {
      return { reason: "Funded members must be a nonempty list of unique strategy IDs." };
    }
    const selected = new Map(ids.map(id => [id, null]));
    for (const series of allSeries || []) {
      if (!selected.has(series?.id)) continue;
      if (series.kind !== "strategy" || selected.get(series.id)) return { reason: "Each funded ID must identify exactly one strategy." };
      const reason = incompatible(portfolio, series);
      if (reason) return { reason };
      selected.set(series.id, series);
    }
    if (Array.from(selected.values()).includes(null)) return { reason: "A named funded strategy is missing." };
    return { members: Array.from(selected.values()) };
  }

  function openingIndex(series, time) {
    const { times, equity } = series;
    if (!Array.isArray(times) || !Array.isArray(equity) || times.length !== equity.length || !(equity[0] > 0)) return -1;
    let i = 0;
    while (i < times.length && times[i] < time) {
      if (!finite(equity[i]) || equity[i] <= 0) return -1;
      i++;
    }
    return times[i] === time ? i : -1;
  }

  function reconcile(members, offsets, times, equity) {
    for (let i = 0; i < times.length; i++) {
      let sum = 0, gross = 0;
      for (let j = 0; j < members.length; j++) {
        const member = members[j], k = offsets[j] + i, value = member.equity[k];
        if (member.times[k] !== times[i] || !finite(value) || (value <= 0 && i < times.length - 1)) {
          return "Each funded sleeve needs a usable equity mark at every portfolio mark in the range.";
        }
        sum += value;
        gross += Math.abs(value);
      }
      if (!finite(sum) || !finite(gross) || Math.abs(sum - equity[i]) > 1e-10 * Math.max(gross, Math.abs(equity[i]))) {
        return "Funded sleeve equity does not sum to portfolio equity at mark " + times[i] + ".";
      }
    }
    return null;
  }

  function contribution(open, close, portfolioOpen) {
    const delta = close - open;
    return numberOrNull(finite(delta) ? delta / portfolioOpen : close / portfolioOpen - open / portfolioOpen);
  }

  function sumRange(values, first = 0, end = values.length) {
    let sum = 0, correction = 0;
    for (let i = first; i < end; i++) {
      const next = sum + values[i];
      correction += additionRoundoff(sum, values[i], next);
      sum = next;
    }
    return sum + correction;
  }

  const matchesPaper = (actual, expected, tolerance = 1e-10) =>
    finite(actual) && finite(expected) && Math.abs(actual - expected) <= tolerance;
  const paperUnits = new Set(["fraction of opening paper index", "fraction of the opening paper index"]);

  // Column i belongs to the change from raw mark i to i + 1, including the first close.
  function reconcilePaper(portfolio) {
    const { paperContributions: panel, attribution: declaration } = portfolio.evidence;
    if (!object(panel) || !object(panel.byMember) || !Array.isArray(panel.dates)) {
      return { reason: "Daily paper P&L needs dated contribution columns for each member." };
    }
    if (!paperUnits.has(panel.unit) || (declaration.unit != null && !paperUnits.has(declaration.unit))) {
      return { reason: "Daily paper P&L must use fractions of the original opening paper index." };
    }
    const { dates, byMember } = panel, { times, equity } = portfolio;
    const ids = Object.keys(byMember);
    if (!ids.length || !ids.every(text) || !ids.every(id => Array.isArray(byMember[id]) && byMember[id].length === dates.length)) {
      return { reason: "Every paper member needs one contribution for each dated close." };
    }
    const declared = declaration.members;
    if (declared != null && (!object(declared) || Object.keys(declared).length !== ids.length ||
        !ids.every(id => Object.hasOwn(declared, id)))) {
      return { reason: "The declared paper members and the daily contribution columns must match." };
    }
    if (!Array.isArray(times) || !Array.isArray(equity) || !dates.length || dates.length + 1 !== times.length ||
        equity.length !== times.length) {
      return { reason: "Daily paper P&L needs one opening equity mark followed by one dated close per contribution." };
    }
    if ((declaration.start != null && declaration.start !== dates[0]) ||
        (declaration.end != null && declaration.end !== dates.at(-1))) {
      return { reason: "The declared attribution dates must match the full range of daily paper P&L." };
    }
    for (let i = 0; i < dates.length; i++) {
      const time = times[i + 1];
      if (!Number.isSafeInteger(time) || Math.abs(time) > 8.64e15 || !(time > times[i]) ||
          dates[i] !== new Date(time).toISOString().slice(0, 10) || (i && dates[i] <= dates[i - 1])) {
        return { reason: "Daily paper P&L dates must match the ordered UTC close dates of the portfolio." };
      }
      const parts = ids.map(id => byMember[id][i]);
      if (!parts.every(finite)) return { reason: `A paper member has missing or invalid P&L on ${dates[i]}.` };
      const change = contribution(equity[i], equity[i + 1], equity[0]);
      if (!finite(equity[i]) || !finite(equity[i + 1]) || equity[i] <= 0 || !matchesPaper(sumRange(parts), change)) {
        return { reason: `Daily paper P&L does not reconcile to portfolio equity on ${dates[i]}.` };
      }
    }
    const totals = ids.map(id => sumRange(byMember[id]));
    if (!matchesPaper(sumRange(totals), contribution(equity[0], equity.at(-1), equity[0]))) {
      return { reason: "The full range of daily paper P&L does not reconcile to the change in portfolio equity." };
    }
    for (let i = 0; i < ids.length; i++) {
      const reported = declared?.[ids[i]]?.returnContribution;
      if (reported != null && !matchesPaper(totals[i], reported)) {
        return { reason: `Daily paper P&L does not reconcile to the full-range contribution for ${ids[i]}.` };
      }
    }
    return { ids, byMember };
  }

  /** Convert already-sized original-capital fractions to the actual selected opening equity.
   *  Each sampled risk observation uses its own opening equity and the same endpoints
   *  as the book return. A skipped return interval still advances the sampler's opening mark. */
  function paperAttribution(portfolio, allSeries, opts) {
    const unavailable = reason => ({ rows: [], reason });
    const source = reconcilePaper(portfolio);
    if (source.reason) return unavailable(source.reason);
    const { analysis, reason } = readAnalysis(portfolio, opts);
    if (reason || !analysis.times.length) return unavailable(reason || "No portfolio equity marks fall in the selected range.");

    const { times, equity } = portfolio, { ids, byMember } = source;
    const index = new Map(times.map((t, i) => [t, i]));
    const first = index.get(analysis.meta.baselineTime), last = index.get(analysis.times.at(-1));
    if (first === last) return unavailable("The selected range contains no closing paper P&L observation.");
    const names = new Map((allSeries || []).filter(s => s?.kind === "strategy").map(s => [s.id, s.name]));
    const openingFraction = equity[first] / equity[0];
    const rows = ids.map(id => ({
      id, name: names.get(id) || id,
      returnContribution: ratio(sumRange(byMember[id], first, last), openingFraction), riskShare: null
    }));
    if (rows.some(r => r.returnContribution === null) ||
        !matchesPaper(sumRange(rows.map(r => r.returnContribution)), analysis.summary.totalReturn)) {
      return unavailable("Paper P&L does not reconcile to the portfolio return from the selected opening equity.");
    }

    const stats = ids.map(() => moments()), sampled = intervals(analysis);
    const result = { rows, openingTime: times[first], closingTime: times[last],
      portfolioReturn: analysis.summary.totalReturn, riskIntervals: sampled.length };
    for (const r of sampled) {
      const a = index.get(r.start), b = index.get(r.end);
      const parts = ids.map(id => ratio(sumRange(byMember[id], a, b), equity[a] / equity[0]));
      if (parts.includes(null) || !matchesPaper(sumRange(parts), r.value)) {
        return { ...result, reason: "Member P&L does not reconcile to a sampled portfolio return at its opening equity." };
      }
      parts.forEach((value, i) => observe(stats[i], value, r.value));
    }
    const shares = stats.map(slope);
    if (shares.includes(null)) {
      return { ...result, reason: "At least two usable intervals and variation in portfolio returns are required." };
    }
    if (!matchesPaper(sumRange(shares), 1, 1e-8)) {
      return { ...result, reason: "The measured shares do not reconcile to portfolio variance." };
    }
    rows.forEach((r, i) => { r.riskShare = shares[i]; });
    return result;
  }

  /** A funded sleeve contributes its change in NAV divided by opening portfolio NAV.
   *  Risk share is the slope of its period contributions against the portfolio returns.
   *  Check every raw mark from the actual opening mark through the selected close.
   *  The reconciliation tolerance is 1e-10 times the larger of gross sleeve NAV and absolute book NAV. */
  function attribution(portfolio, allSeries, opts = {}) {
    if (portfolio?.kind === "portfolio" && portfolio.evidence?.attribution?.basis === "paper_additive") {
      return paperAttribution(portfolio, allSeries, opts);
    }
    const unavailable = reason => ({ rows: [], reason });
    const selection = fundedMembers(portfolio, allSeries);
    if (selection.reason) return unavailable(selection.reason);
    const { members } = selection;
    const { analysis, reason } = readAnalysis(portfolio, opts);
    if (reason || !analysis.times.length) return unavailable(reason || "No portfolio equity marks fall in the selected range.");
    const opening = analysis.meta.baselineTime;
    const hiddenOpening = opening !== analysis.times[0];
    const times = hiddenOpening ? [opening, ...analysis.times] : analysis.times;
    const equity = hiddenOpening ? [analysis.summary.startEquity, ...analysis.equity] : analysis.equity;
    const offsets = members.map(member => openingIndex(member, opening));
    if (offsets.includes(-1)) return unavailable("All funded sleeves need the same usable opening mark as the portfolio.");
    const difference = reconcile(members, offsets, times, equity);
    if (difference) return unavailable(difference);

    // Index the raw grid once. Only the shared sampler chooses which intervals qualify for risk.
    const index = new Map(times.map((time, i) => [time, i]));
    const sampled = intervals(analysis).map(r => ({ first: index.get(r.start), last: index.get(r.end), value: r.value }));
    const rows = members.map((member, j) => {
      const offset = offsets[j], nav = member.equity, stats = moments();
      for (const r of sampled) {
        const part = contribution(nav[offset + r.first], nav[offset + r.last], equity[r.first]);
        if (part === null) break;
        observe(stats, part, r.value);
      }
      return {
        id: member.id, name: member.name,
        returnContribution: contribution(nav[offset], nav[offset + times.length - 1], equity[0]),
        riskShare: stats.n === sampled.length ? slope(stats) : null
      };
    });
    if (rows.some(r => r.riskShare === null)) {
      return { rows, reason: "Risk shares need at least two usable contributions and measurable variation in portfolio returns." };
    }
    return { rows };
  }

  // Family names match the local evidence manifest. A source record describes one test.
  const researchFamilies = [
    ["winner_removal", "Winner removal", "Replay with identified winning trades removed"],
    ["random_removal", "Random trade removal", "Removal fraction, random seed and replay result"],
    ["shuffle", "Order shuffle", "Reordering rule, random seed and path result"],
    ["monte_carlo", "Monte Carlo", "Sampling method, trial count, seed and simulated results"],
    ["parameter_neighbors", "Nearby parameters", "Baseline parameters and tested neighboring values"],
    ["signal_cadence", "Signal frequency", "Baseline and alternate signal intervals"],
    ["price_perturbation", "Execution price changes", "Price perturbation rule and execution replay"],
    ["costs", "Cost stress", "Alternate execution costs and the net result of the replay"],
    ["other_markets", "Other markets", "Named test markets, same trading rules and results"],
    ["chronology", "Out-of-sample tests", "Training dates, later test dates and test results"]
  ];

  function row(id, label, scope, checks) {
    const missing = checks.filter(([, present]) => !present).map(([requirement]) => requirement);
    return { id, label, scope, available: !missing.length, requirements: checks.map(([s]) => s), missing };
  }

  function familyRecords(results, family) {
    if (Array.isArray(results)) return results.filter(record => record?.family === family);
    const container = object(results) ? results[family] : null;
    const records = container?.results ?? container;
    return (Array.isArray(records) ? records : [records])
      .filter(record => object(record) && (record.family == null || record.family === family));
  }

  function containsValue(value, accepts) {
    if (accepts(value)) return true;
    return (object(value) || Array.isArray(value)) && Object.values(value).some(v => containsValue(v, accepts));
  }

  function familyCoverage(results, family, label, method) {
    const records = familyRecords(results, family);
    function inspect(record) {
      const completed = suppliedText(record.status) && !["not_run", "not_available", "blocked", "pending", "running"].includes(record.status);
      const outcomes = [record.metrics, record.metric_deltas, record.result, record.outcomes, record.remaining];
      const settings = object(record.settings) && containsValue(record.settings,
        v => finite(v) || suppliedText(v) || typeof v === "boolean");
      const entry = row("research." + family, label, "source", [
        [method, settings],
        ["Completed source test", completed],
        ["Source data and cost model", suppliedText(record.source_data) && suppliedText(record.cost_model)],
        ["Seed or deterministic test declaration", Number.isSafeInteger(record.seed) || suppliedText(record.seed)],
        ["Measured test result", containsValue(outcomes, finite)]
      ]);
      entry.family = family;
      if (text(record.reason)) entry.reason = record.reason;
      return entry;
    }
    // Keep the best documented single run. Never combine partial records into evidence of one test.
    if (!records.length) return inspect({});
    return records.map(inspect).reduce((best, next) => next.missing.length < best.missing.length ? next : best);
  }

  /** Return source coverage, independent of the selected date range. 'available' means
   *  that the named inputs exist. A failed research test can have a complete record. */
  function evidenceCoverage(series = {}) {
    const costs = series.costs || {};
    const capacity = series.evidence?.capacity || {};
    const summary = series.tradeSummary || {};
    const commissions = ["commission", "commissions", "commission_total"];
    const slippage = ["slippage", "slippage_total"];
    const costFields = ["total", "reportedCost", "fees", "spread", "borrow", "financing", "funding", ...commissions, ...slippage];
    const currency = capacity.currency ?? series.currency;
    function costRow(id, label, fields, requirement) {
      return row(id, label, "source", [
        [requirement, fields.some(key => finite(costs[key]))],
        ["Cost units", suppliedText(costs.unit ?? costs.currency ?? series.currency)],
        ["Cost source", suppliedText(costs.source ?? series.source)]
      ]);
    }
    const entries = [
      row("trades", "Realized trades", "dated", [
        ["Close time and realized P&L for each trade", Array.isArray(series.trades) && series.trades.some(datedTrade)]
      ]),
      row("tradeSummary", "Trade summary", "source", [
        ["Source count of closed trades", [summary.count, summary.closedTrades].some(n => Number.isSafeInteger(n) && n >= 0)]
      ]),
      costRow("costs", "Reported costs", costFields, "Numeric cost total or component"),
      costRow("commission", "Reported commissions", commissions, "Commission amount from the fill ledger or source report"),
      costRow("slippage", "Reported slippage", slippage, "Slippage amount from the source execution comparison"),
      row("capacity", "Trading capacity", "source", [
        ["Tested capital and currency", finite(capacity.capital) && capacity.capital > 0 && suppliedText(currency) && currency !== "INDEX"],
        ["Dated order size source", suppliedText(capacity.ordersSource)],
        ["Point-in-time market volume source", suppliedText(capacity.volumeSource)],
        ["Maximum share of volume (0 to 1)", finite(capacity.maxParticipation) && capacity.maxParticipation > 0 && capacity.maxParticipation <= 1],
        ["Market impact model", suppliedText(capacity.impactModel)],
        ["Capacity test source", suppliedText(capacity.source)]
      ])
    ];
    return entries.concat(researchFamilies.map(args => familyCoverage(series.evidence?.results, ...args)));
  }

  return Object.freeze({ benchmark, trades, tails, correlationMatrix, strategyGroups, attribution, evidenceCoverage,
    returnMeasures, monthlyAmounts, calendarAverages, profitableWindows });
});
