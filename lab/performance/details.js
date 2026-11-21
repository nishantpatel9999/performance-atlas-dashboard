/* Browser: window.PerformanceDetails. CommonJS: require("./details.js").
 * Dates are inclusive UTC epoch milliseconds. Ratios are decimals. Undefined metrics are null.
 * benchmark and correlationMatrix pair sampled returns only when both actual endpoints,
 * currency, frequency and periodsPerYear match. Counts can differ between matrix cells.
 * strategyGroups and correlationMatrix accept {ids, portfolio}. IDs set the display order.
 * tails accepts PerformanceMetrics.analyze(series, opts).returns.values and a per-period target.
 * trades uses dated closes. evidenceCoverage describes supplied evidence at its stated scope.
 * attribution requires the portfolio's declared funded members and their original NAV marks.
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
    return { count: 0, wins: 0, losses: 0, flat: 0, avgWin: 0, avgLoss: 0, pnl: 0 };
  }

  function recordPnl(bucket, pnl) {
    bucket.count++;
    bucket.pnl += pnl;
    if (pnl > 0) bucket.avgWin += (pnl - bucket.avgWin) / ++bucket.wins;
    else if (pnl < 0) bucket.avgLoss += (pnl - bucket.avgLoss) / ++bucket.losses;
    else bucket.flat++;
  }

  function meanPnl(bucket) {
    if (finite(bucket.pnl)) return bucket.pnl / bucket.count;
    return bucket.avgWin * (bucket.wins / bucket.count) + bucket.avgLoss * (bucket.losses / bucket.count);
  }

  /** Use realized P&L at each close in [start, end], in original P&L units.
   *  A flat trade ends both streaks. Equal timestamps retain source order.
   *  The count is the number of usable rows. Source summaries have their own scope. */
  function trades(series, opts = {}) {
    const partial = series?.evidence?.tradeCoverage === "partial";
    const result = {
      count: 0, wins: 0, losses: 0, flat: 0, winRate: null, profitFactor: null,
      expectancy: null, avgWin: null, avgLoss: null, payoff: null, best: null, worst: null,
      winStreak: partial ? null : 0, lossStreak: partial ? null : 0, meanHoldingHours: null, bySide: {}, bins: []
    };
    if (!Array.isArray(series?.trades)) return { ...result, reason: "Dated realized trades are unavailable." };
    const range = bounds(opts);
    const horizon = range && equityHorizon(series, range.end);
    if (!range || !horizon) return { ...result, reason: "The date range or equity marks are invalid." };
    const start = Math.max(range.start, horizon.start);
    const end = Math.min(range.end, horizon.end);
    const rows = series.trades.filter(row => row && finite(row.time) && row.time >= start && row.time <= end && finite(row.pnl));
    if (!rows.length) return { ...result, reason: "No dated realized trades closed in this range." };
    rows.sort((a, b) => a.time - b.time);

    result.best = result.worst = rows[0].pnl;
    const sides = new Map(), total = tradeBucket();
    let winRun = 0, lossRun = 0, holdingMean = 0, holdingCount = 0;
    for (const row of rows) {
      const { pnl, holdingHours } = row;
      const side = text(row.side) ? row.side.trim().toLowerCase() : "unknown";
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
      const { count, wins, losses, flat, pnl } = bucket;
      return [side, { count, wins, losses, flat, winRate: wins / count,
        pnl: finite(pnl) ? pnl : numberOrNull(meanPnl(bucket) * count) }];
    }));
    const { count, wins, losses, flat, avgWin, avgLoss } = total;
    Object.assign(result, { count, wins, losses, flat, winRate: wins / count, expectancy: meanPnl(total),
      avgWin: wins ? avgWin : null, avgLoss: losses ? avgLoss : null });
    const weight = Math.max(wins, losses, 1);
    result.profitFactor = ratio(avgWin * (wins / weight), -avgLoss * (losses / weight));
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

  // An explicit selection keeps its order. Short holdings qualify. A zero weight does not.
  function selectedStrategies(seriesArray, opts) {
    const entries = Array.isArray(seriesArray) ? seriesArray : [];
    const strategies = new Map(entries.filter(s => s?.kind === "strategy" && text(s.id)).map(s => [s.id, s]));
    const held = opts.portfolio == null ? null : new Set((opts.portfolio.holdings || [])
      .filter(h => h && finite(h.weight) && h.weight !== 0).map(h => h.id));
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

  function incompatible(a, b) {
    if (!a || !b) return "Two dated equity series are required.";
    if (!suppliedText(a.currency) || a.currency !== b.currency) {
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
    return { rows: analysis ? intervals(analysis) : [], reason };
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
    const mismatch = incompatible(series, other);
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

  /** Rows use the requested strategy IDs. Each cell has its own paired observation count. */
  function correlationMatrix(seriesArray, opts = {}) {
    const selected = selectedStrategies(seriesArray, opts);
    const samples = selected.map(s => sample(s, opts).rows);
    const values = selected.map(() => Array(selected.length).fill(null));
    const counts = selected.map(() => Array(selected.length).fill(0));
    for (let i = 0; i < selected.length; i++) {
      for (let j = i; j < selected.length; j++) {
        if (incompatible(selected[i], selected[j])) continue;
        const stats = moments();
        common(samples[i], samples[j], (a, b) => observe(stats, a.value, b.value));
        let r = correlation(stats);
        if (i === j && r !== null) r = 1;
        counts[i][j] = counts[j][i] = stats.n;
        values[i][j] = values[j][i] = r;
      }
    }
    return { ids: selected.map(s => s.id), names: selected.map(s => s.name), values, counts };
  }

  function fundedMembers(portfolio, allSeries) {
    const evidence = portfolio?.evidence?.attribution;
    if (portfolio?.kind !== "portfolio" || evidence?.basis !== "funded_equity") {
      return { reason: "The portfolio needs a funded_equity attribution declaration." };
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

  /** A funded sleeve contributes its change in NAV divided by opening portfolio NAV.
   *  Risk share is the slope of its period contributions against the portfolio returns.
   *  Check every raw mark from the actual opening mark through the selected close.
   *  The reconciliation tolerance is 1e-10 times the larger of gross sleeve NAV and absolute book NAV. */
  function attribution(portfolio, allSeries, opts = {}) {
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

  return Object.freeze({ benchmark, trades, tails, correlationMatrix, strategyGroups, attribution, evidenceCoverage });
});
