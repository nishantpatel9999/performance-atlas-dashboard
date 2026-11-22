/* One local report, one set of controls for every series. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const doc = JSON.parse($("report-data").textContent);
  const all = doc.series,
    byId = new Map(all.map((s) => [s.id, s]));
  const M = window.PerformanceMetrics,
    D = window.PerformanceDetails,
    C = window.PerformanceCharts;
  const DAY = 86400000;
  const icons = (name) =>
    `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const views = {
    overview: ["Overview", "grid"],
    drawdowns: ["Drawdowns", "drawdown"],
    rolling: ["Rolling metrics", "wave"],
    calendar: ["Calendar returns", "calendar"],
    trades: ["Trades and costs", "trades"],
    activity: ["Activity and margin", "layers"],
    explorer: ["Metric explorer", "strategy"],
    compare: ["Comparisons", "compare"],
    evidence: ["Evidence and methods", "book"],
  };
  const kinds = {
    portfolio: "Portfolio",
    strategy: "Strategy",
    benchmark: "Benchmark",
  };
  const sections = {
    portfolio: "portfolios",
    strategy: "strategies",
    benchmark: "benchmarks",
  };
  const first =
    all.find((s) => s.kind === "portfolio") ||
    all.find((s) => s.kind === "strategy") ||
    all[0];
  const state = {
    id: first.id,
    view: "overview",
    range: "All",
    from: null,
    to: null,
    months: 6,
    riskFree: 0,
    target: 0,
    units: "index",
    peer: null,
    matrixIds: null,
  };
  const lastByKind = new Map();
  const cache = new Map();
  let plots = [],
    resizeTimer = 0,
    lastWidth = 0;
  function escape(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }
  const decimal = (v, places = 2) =>
    Number.isFinite(v)
      ? v.toLocaleString("en-US", {
          minimumFractionDigits: places,
          maximumFractionDigits: places,
        })
      : "—";
  const pct = (v, places = 1, sign = false) =>
    Number.isFinite(v)
      ? (sign && v > 0 ? "+" : "") + decimal(100 * v, places) + "%"
      : "—";
  // A short sample can annualize to hundreds of digits. Keep it readable on a phone.
  const growthPct = value => Number.isFinite(value) && Math.abs(value) >= 1e10
    ? value.toLocaleString("en-US", { style: "percent", notation: "scientific", maximumFractionDigits: 2 })
    : pct(value, 2);
  const date = (t) =>
    Number.isFinite(t)
      ? new Intl.DateTimeFormat("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
          timeZone: "UTC",
        }).format(t)
      : "—";
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const count = (n) => decimal(n, 0);
  const periodUnit = (s) =>
    ({
      daily: "Daily",
      weekly: "Weekly",
      monthly: "Monthly",
      annual: "Annual",
    })[s.frequency] || "Observed";
  const noteUnit = (s) =>
    ({
      daily: "daily",
      weekly: "weekly",
      monthly: "monthly",
      annual: "annual",
    })[s.frequency] || "observed";
  const valClass = (v) =>
    Number.isFinite(v) ? (v < 0 ? "negative" : v > 0 ? "positive" : "") : "";
  const cur = (s, v, places = 0) =>
    Number.isFinite(v) ? decimal(v, places) + " " + s.currency : "—";
  function viewTitle() {
    return state.view === "overview"
      ? kinds[byId.get(state.id).kind] + " overview"
      : views[state.view][0];
  }
  function startOfPeriod(end, months) {
    const d = new Date(end),
      day = d.getUTCDate();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - months);
    const last = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
    ).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return +d;
  }
  function bounds(s) {
    const firstT = s.times[0],
      last = s.times.at(-1);
    let start = firstT,
      end = last;
    if (state.range === "Custom") {
      start = Math.max(firstT, state.from ?? firstT);
      end = Math.min(last, state.to ?? last);
    } else if (state.range === "YTD")
      start = Math.max(firstT, Date.UTC(new Date(last).getUTCFullYear(), 0, 1));
    else if (state.range !== "All")
      start = Math.max(
        firstT,
        startOfPeriod(last, 12 * parseInt(state.range, 10)),
      );
    return { start, end };
  }
  function options(s) {
    return {
      ...bounds(s),
      months: state.months,
      riskFree: state.riskFree,
      target: state.target,
    };
  }
  function analyze(s, opts = options(s)) {
    const key = JSON.stringify([
      s.id,
      opts.start,
      opts.end,
      opts.months,
      opts.riskFree,
      opts.target,
    ]);
    if (!cache.has(key)) {
      if (cache.size >= 10) cache.delete(cache.keys().next().value);
      cache.set(key, M.analyze(s, opts));
    }
    return cache.get(key);
  }
  function panel(title, sub, body, actions = "", cls = "") {
    return `<section class="panel ${cls}"><header class="panel-header"><div><h2>${escape(title)}</h2>${sub ? `<p class="panel-sub">${escape(sub)}</p>` : ""}</div>${actions ? `<div class="panel-tools">${actions}</div>` : ""}</header>${body}</section>`;
  }
  const linkView = (view, text) =>
    `<button type="button" data-jump="${view}" class="small-button">${escape(text)} ${icons("arrow")}</button>`;
  const empty = (title, reason) =>
    `<div class="empty"><div><strong>${escape(title)}</strong>${escape(reason)}</div></div>`;
  const chart = (id) => `<div class="chart" id="${id}"></div>`;
  const legend = (items) =>
    `<div class="chart-legend">${items.map(([label, color, dashed]) => `<span class="legend-item"><i class="legend-swatch" style="background:${dashed ? "repeating-linear-gradient(90deg," + color + " 0 4px,transparent 4px 6px)" : color}"></i>${escape(label)}</span>`).join("")}</div>`;
  const statList = (rows) =>
    `<dl class="metric-list">${rows.map(([k, v, title]) => `<div${title ? ` title="${escape(title)}"` : ""}><dt>${escape(k)}</dt><dd class="${v === "—" ? "missing" : ""}">${escape(v)}</dd></div>`).join("")}</dl>`;
  function table(headers, rows) {
    return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th scope="col">${escape(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  const sectionTitle = (name, note = "") =>
    `<div class="section-title"><h2>${escape(name)}</h2><span>${escape(note)}</span></div>`;
  const signedCell = (v) =>
    `<span class="${valClass(v)}">${pct(v, 1, true)}</span>`;
  function linePlot(id, series, opts) {
    plots.push(() => C.line($(id), series, opts));
  }
  function barPlot(id, data, opts) {
    plots.push(() => C.bars($(id), data, opts));
  }
  const chartColors = [
    "var(--brand)",
    "var(--gold)",
    "var(--loss)",
    "var(--activity)",
  ];
  function periodText(s) {
    return `${periodUnit(s)} closes · ${s.periodsPerYear} periods per year`;
  }
  function drawdowns(s, a, id, large) {
    linePlot(
      id,
      [
        {
          times: a.times,
          values: a.drawdown,
          label: "Underwater",
          color: "var(--loss)",
          area: "under",
        },
        {
          times: a.times,
          values: a.maxDrawdownPath,
          label: "Worst to date",
          color: "var(--gold)",
          dash: "5 4",
          width: 1.6,
        },
      ],
      {
        title: "Underwater drawdown and worst drawdown to date",
        format: (v) => pct(v, 0),
        detailFormat: pct,
        height: large ? 271 : 170,
        zero: true,
      },
    );
    return panel(
      "Drawdown history",
      "Loss from the running equity high.",
      legend([
        ["Underwater", "var(--loss)"],
        ["Worst to date", "var(--gold)", true],
      ]) + chart(id),
      large ? "" : linkView("drawdowns", "Explore"),
    );
  }
  function kpis(s, a) {
    const m = a.summary;
    const row = (key, label, value, desc, cls = "") =>
      `<div class="kpi" data-metric="${key}"><div class="kpi-label">${escape(label)}</div><div class="kpi-value ${cls}">${escape(value)}</div><div class="kpi-foot">${escape(desc)}</div></div>`;
    return `<section aria-label="Performance summary" class="kpi-strip">${row("cagr", "Annual growth (CAGR)", growthPct(m.cagr), "Annualized compound growth", valClass(m.cagr))}${row("maxDrawdown", "Maximum drawdown", pct(m.maxDrawdown, 2), "Worst peak-to-trough loss", m.maxDrawdown < 0 ? "negative" : "")}${row("sharpe", "Sharpe ratio", decimal(m.sharpe), "Excess return per unit of risk")}${row("totalReturn", "Total return", pct(m.totalReturn, 2, true), "Selected period", valClass(m.totalReturn))}</section>`;
  }
  const gapLimit = (s) =>
    (({ daily: 10, weekly: 21, monthly: 65, annual: 750 })[s.frequency] || 10) *
    DAY;
  function unitsSwitch() {
    return `<div class="segmented" role="group" aria-label="Equity scale">${[
      ["index", "Index"],
      ["source", "Source units"],
    ]
      .map(
        ([val, label]) =>
          `<button type="button" data-units="${val}" aria-pressed="${state.units === val}">${label}</button>`,
      )
      .join("")}</div>`;
  }
  function equityPanel(s, a) {
    const indexed = state.units === "index";
    const prior = a.meta.baselineTime < a.times[0];
    const times = prior ? [a.meta.baselineTime, ...a.times] : a.times;
    const equity = prior ? [a.summary.startEquity, ...a.equity] : a.equity;
    const vals = indexed
      ? equity.map((v) => (100 * v) / a.summary.startEquity)
      : equity;
    linePlot(
      "equity-chart",
      [
        {
          times,
          values: vals,
          label: indexed ? "Equity index" : s.currency,
          area: true,
        },
      ],
      {
        title: "Equity curve of " + s.name,
        format: (v) =>
          Math.abs(v) >= 1000
            ? Intl.NumberFormat("en", {
                notation: "compact",
                maximumFractionDigits: 1,
              }).format(v)
            : decimal(v, Math.abs(v) < 10 ? 1 : 0),
        detailFormat: (v) => decimal(v, 2),
        height: 224,
        gapLimit: gapLimit(s),
      },
    );
    return panel(
      "Equity curve",
      indexed
        ? "Growth of 100 from the opening equity mark."
        : "Equity at each supplied mark, in " + s.currency + ".",
      legend([[s.name, chartColors[0]]]) +
        chart("equity-chart") +
        `<div class="chart-meta"><span>${date(a.meta.baselineTime)}</span><span>${date(a.times.at(-1))}</span></div>`,
      unitsSwitch(),
    );
  }
  function annualPanel(a, compact = false) {
    const years = compact ? a.years.slice(-7) : a.years;
    const id = compact ? "annual-preview" : "annual-chart";
    barPlot(
      id,
      years.map((y) => ({
        label: String(y.year),
        short: String(y.year).slice(compact ? 2 : 0),
        value: y.return,
        color: y.return < 0 ? "var(--loss)" : "var(--gain)",
        detail: `${pct(y.return, 2, true)} · ${y.complete ? "Full year" : "Partial coverage"}`,
      })),
      {
        title: "Calendar year returns",
        height: compact ? 224 : 220,
        format: (v) => pct(v, 0),
        labelWidth: compact ? 25 : 45,
      },
    );
    return panel(
      "Annual returns",
      compact
        ? "Most recent calendar years."
        : "Return within each observed calendar year.",
      legend([
        ["Gain", "var(--gain)"],
        ["Loss", "var(--loss)"],
      ]) +
        chart(id) +
        (compact
          ? `<div class="chart-meta"><span>Includes partial years</span>${linkView("calendar", "Calendar")}</div>`
          : ""),
    );
  }
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const historyAverages = new WeakMap();
  function fullHistoryAverages(s) {
    if (!historyAverages.has(s)) {
      const full = analyze(s, { ...options(s), start: s.times[0], end: s.times.at(-1) });
      historyAverages.set(s, D.calendarAverages(full));
    }
    return historyAverages.get(s);
  }

  function heatCell(attribute, period, heading, description, scale, unit) {
    const coverage = period?.coverage;
    const sampleSize = period?.count;
    const info = attribute +
      (coverage ? ` data-coverage="${coverage}"` : "") +
      (Number.isInteger(sampleSize) ? ` data-count="${sampleSize}"` : "");
    const value = period?.return;
    if (!Number.isFinite(value)) {
      const title = escape(`${heading} · No measured return` + (description ? ` · ${description}` : ""));
      return `<td ${info} title="${title}" aria-label="${title}">—</td>`;
    }
    const magnitude = Math.abs(100 * value);
    const places = magnitude > 0 && magnitude < 0.005
      ? Math.min(12, -Math.floor(Math.log10(magnitude))) : 2;
    const label = pct(value, places, true);
    const amount = unit && Number.isFinite(period.amount) ? decimal(period.amount, 2) : null;
    const boundaries = Number.isFinite(period.openingTime) && Number.isFinite(period.closingTime)
      ? ` · ${iso(period.openingTime)} to ${iso(period.closingTime)}` : "";
    const title = escape(`${heading} · ${label}` + (amount === null ? "" : ` · ${amount} ${unit}`) +
      ` · ${description}${boundaries}`);
    const marker = coverage === "gap" ? "‡" : coverage === "partial" ? "†" : "";
    const color = value < 0 ? "var(--loss)" : "var(--gain)";
    const strength = value === 0 ? 0 : Math.round(10 + 34 * Math.sqrt(Math.min(1, Math.abs(value) / (scale || 1))));
    const amountAttr = amount === null ? "" : ` data-amount="${period.amount}"`;
    return `<td ${info} data-return="${value}"${amountAttr} data-tip="${title}" title="${title}" aria-label="${title}" tabindex="0" style="background:color-mix(in srgb, ${color} ${strength}%, var(--faint))"><span class="heat-value">${label}</span>${marker ? `<sup>${marker}</sup>` : ""}${amount === null ? "" : `<br><small>${amount}</small>`}</td>`;
  }

  function heatmap(s, a, compact = false, amounts = null) {
    const years = (compact ? a.years.slice(-4) : a.years.slice()).reverse();
    if (!years.length) return empty("No monthly returns", "Supply at least two dated equity marks.");
    const months = new Map((amounts?.months || a.months).map(m => [m.year * 12 + m.month, m]));
    const averages = fullHistoryAverages(s);
    const unit = amounts?.unit;
    const maxReturn = periods => periods.reduce((max, p) =>
      Number.isFinite(p.return) ? Math.max(max, Math.abs(p.return)) : max, 0);
    const monthScale = maxReturn(a.months), yearScale = maxReturn(a.years);
    const coverageText = (p, name) => p?.coverage === "gap" ? "Missing observations inside the period"
      : p?.coverage === "partial" ? `Partial ${name}` : p?.coverage === "full" ? `Full ${name}` : "";
    const rows = years.map(y => {
      const cells = monthNames.map((name, j) => {
        const month = j + 1, period = months.get(y.year * 12 + month);
        const key = `${y.year}-${String(month).padStart(2, "0")}`;
        return heatCell(`data-month="${key}"`, period, `${name} ${y.year}`,
          coverageText(period, "month"), monthScale, unit);
      });
      cells.push(heatCell(`data-year-return="${y.year}"`, y, `${y.year} year return`,
        coverageText(y, "year"), yearScale, unit));
      return `<tr><th scope="row">${y.year}</th>${cells.join("")}</tr>`;
    });
    function meanCell(attribute, period, name, scale, frequency) {
      const samples = `${period.count} complete ${frequency}${period.count === 1 ? "" : "s"} across the full history`;
      return heatCell(attribute, period, name + " average", samples, scale, unit);
    }
    const footer = averages.months.map((p, i) =>
      meanCell(`data-month-average="${i + 1}"`, p, monthNames[i], monthScale, "month"));
    footer.push(meanCell("data-year-average", averages.year, "Calendar-year", yearScale, "year"));
    const shownYears = new Set(years.map(y => y.year));
    const shown = years.concat(a.months.filter(m => shownYears.has(m.year)));
    const notes = [shown.some(m => m.coverage === "partial") ? "† Partial period" : "",
      shown.some(m => m.coverage === "gap") ? "‡ Missing observations" : ""].filter(Boolean).join(" · ");
    return `<div class="heat-wrap" role="region" aria-label="Monthly returns by year" tabindex="0"><table class="heat" data-monthly-returns aria-label="Monthly and yearly returns in percent"><thead><tr><th scope="col">Year</th>${monthNames.map(m => `<th scope="col">${m}</th>`).join("")}<th scope="col">Year return</th></tr></thead><tbody>${rows.join("")}</tbody><tfoot><tr><th scope="row">Average</th>${footer.join("")}</tr></tfoot></table></div><p class="heat-averages-note">Averages use complete months or years across the full history, including 0% returns.</p><div class="heat-scale"><span class="coverage-key">${notes}</span><span>Loss</span><i style="background:var(--loss)"></i><i style="background:var(--faint)"></i><i style="background:var(--gain)"></i><span>Gain</span></div>`;
  }
  function profile(a, s) {
    const m = a.summary,
      tails = D.tails(
        a.returns.values,
        Math.expm1(Math.log1p(state.target) / s.periodsPerYear),
      );
    const measures = D.returnMeasures(a);
    const gain =
      Number.isFinite(m.startEquity) && Number.isFinite(m.endEquity)
        ? m.endEquity - m.startEquity
        : null;
    return (
      sectionTitle("Performance statistics", periodText(s)) +
      `<div class="grid-three">` +
      panel(
        "Return and growth",
        "",
        statList([
          ["Total return", pct(m.totalReturn, 2)],
          [
            "Cumulative log return",
            decimal(measures.cumulativeLogReturn, 3),
            "ln(closing equity / opening equity). Both equity values must be positive.",
          ],
          ["Compound annual growth (CAGR)", growthPct(m.cagr)],
          ["Mean full-year return", pct(m.meanYearReturn, 2)],
          ["Change in equity", cur(s, gain, 2)],
          ["Opening equity", cur(s, m.startEquity, 2)],
          ["Closing equity", cur(s, m.endEquity, 2)],
        ]),
      ) +
      panel(
        "Risk-adjusted returns",
        "Gain-to-pain = sum of observed returns / absolute sum of negative returns.",
        statList([
          ["Sharpe ratio", decimal(m.sharpe)],
          ["Sortino ratio", decimal(m.sortino)],
          ["Calmar ratio", decimal(m.calmar)],
          ["Recovery factor", decimal(m.recoveryFactor)],
          ["Annual volatility", pct(m.volatility, 2)],
          ["Annual downside deviation", pct(m.downside, 2)],
          ["Omega ratio", decimal(tails.omega)],
          ["Gain-to-pain ratio", decimal(measures.gainToPain)],
        ]),
      ) +
      panel(
        "Distribution and tails",
        `${periodUnit(s)} return observations.`,
        statList([
          ["Historical VaR (5th percentile)", pct(m.var95, 2)],
          ["Expected shortfall (CVaR 5%)", pct(m.cvar95, 2)],
          ["Best / worst return", pct(m.best, 2) + " / " + pct(m.worst, 2)],
          ["Positive returns", pct(m.positiveRate, 1)],
          [
            "Skewness / excess kurtosis",
            decimal(tails.skewness) + " / " + decimal(tails.excessKurtosis),
          ],
          ["Tail ratio (95th / |5th|)", decimal(tails.tailRatio)],
        ]),
      ) +
      `</div>`
    );
  }
  function distribution(bins, id, formatter, negativeColors = false, options = {}) {
    barPlot(
      id,
      bins.map((b, i) => ({
        label: `${formatter(b.lower)} to ${formatter(b.upper)}`,
        short: formatter((b.lower + b.upper) / 2),
        value: b.count,
        detail: `${count(b.count)} observations`,
        color: negativeColors
          ? b.upper <= 0
            ? "var(--loss)"
            : "var(--gain)"
          : "var(--brand)",
      })),
      { title: "Distribution", height: 191, format: count, labelWidth: 63, ...options },
    );
    return chart(id);
  }
  function overview(s, a) {
    return (
      kpis(s, a) +
      `<div class="grid-hero">${equityPanel(s, a)}${annualPanel(a, true)}</div><div class="grid-two calendar-preview">${drawdowns(s, a, "dd-preview", false)}${panel("Monthly returns", "Monthly change in equity. Up to four recent years.", heatmap(s, a, true), linkView("calendar", "All months"))}</div>` +
      profile(a, s)
    );
  }

  function rollingControl() {
    return `<label class="settings-control">Window <select class="input-select" id="rolling-window">${[3, 6, 12, 18, 24, 36].map((n) => `<option value="${n}" ${n === state.months ? "selected" : ""}>${n} months</option>`).join("")}</select></label>`;
  }
  function rollingPanel(s, a, key, title, desc, id) {
    const isPct = ["maxDrawdown", "return", "volatility"].includes(key);
    const fmt = (v) => (isPct ? pct(v, 1) : decimal(v, 1));
    const underwater = key === "maxDrawdown";
    linePlot(
      id,
      [
        {
          times: a.rolling.times,
          values: a.rolling[key],
          label: title,
          color: underwater ? "var(--loss)" : "var(--brand)",
          area: underwater ? "under" : false,
        },
      ],
      {
        title,
        format: fmt,
        detailFormat: isPct ? (v) => pct(v, 2) : (v) => decimal(v, 2),
        height: 182,
        zero: underwater,
        gapLimit: gapLimit(s),
        empty: `A complete ${state.months}-month window and a defined denominator are required.`,
      },
    );
    return panel(title, desc, chart(id));
  }
  function drawdownView(s, a) {
    const m = a.summary;
    const episodes = [...a.episodes].sort((x, y) => x.depth - y.depth);
    const pageSize = 10;
    const episodeTable = (start) => table(
      ["Peak", "Trough", "Recovery", "Depth", "Days"],
      episodes.slice(start, start + pageSize).map((e) => [
        date(e.peak), date(e.trough),
        Number.isFinite(e.recovery) ? date(e.recovery) : "Open",
        signedCell(e.depth), count(e.days),
      ]),
    );
    let history = episodes.length ? episodeTable(0) : empty(
      "No drawdown episodes", "Selected marks show no decline from a previous high.",
    );
    if (episodes.length > pageSize) {
      const pageCount = (start) =>
        `${start + 1}–${Math.min(start + pageSize, episodes.length)} of ${count(episodes.length)} episodes`;
      history = `<div id="episode-rows">${history}</div><div class="score-nav"><span id="episode-count" aria-live="polite">${pageCount(0)}</span><div>
        <button type="button" class="small-button" id="episode-prev" aria-label="Previous episodes" disabled>Previous</button>
        <button type="button" class="small-button" id="episode-next" aria-label="Next episodes">Next</button></div></div>`;
      let start = 0;
      plots.push(() => {
        const prev = $("episode-prev"), next = $("episode-next");
        function show(offset) {
          start += offset;
          $("episode-rows").innerHTML = episodeTable(start);
          $("episode-count").textContent = pageCount(start);
          prev.disabled = start === 0;
          next.disabled = start + pageSize >= episodes.length;
        }
        prev.onclick = () => show(-pageSize);
        next.onclick = () => show(pageSize);
      });
    }
    return (
      kpis(s, a) +
      `<div class="grid-hero">${drawdowns(s, a, "dd-full", true)}${panel(
        "Drawdown statistics",
        "Measured at the supplied equity marks.",
        statList([
          ["Maximum drawdown", pct(m.maxDrawdown, 2)],
          ["Largest loss in source units", cur(s, m.maxDrawdownAmount, 2)],
          ["Mean full-year maximum", pct(m.meanYearDrawdown, 2)],
          [
            "Longest underwater span",
            Number.isFinite(m.drawdownDays)
              ? count(m.drawdownDays) + " days"
              : "—",
          ],
          ["Ulcer index", pct(m.ulcer, 2)],
          ["Drawdown episodes", count(a.episodes.length)],
        ]),
      )}</div>` +
      `<div class="toolbar">${rollingControl()}</div><div class="grid-two">${rollingPanel(s, a, "maxDrawdown", `Rolling ${state.months}-month drawdown`, "Worst peak-to-trough loss wholly inside each window.", "dd-window")}${panel(
        "Return distribution",
        `${periodUnit(s)} close-to-close returns.`,
        distribution(a.bins, "risk-distribution", (v) => pct(v, 1), true, { countScale: "auto" }),
      )}</div>` +
      panel(
        "Drawdown episodes",
        "Deepest first. Duration runs from the peak to recovery or the last selected mark.",
        history,
        "",
        "standalone",
      )
    );
  }
  function rollingView(s, a) {
    const opts = options(s);
    const rows = [6, 12, 18].map((months) => {
      const sampled =
        months === state.months ? a : analyze(s, { ...opts, months });
      const r = D.profitableWindows(sampled, months);
      const note =
        r.reason ||
        (r.gapped
          ? count(r.gapped) + " crossed a missing return interval."
          : "—");
      return [
        months + " months",
        count(r.profitable) + " / " + count(r.eligible),
        pct(r.rate, 1),
        count(r.excluded),
        escape(note),
      ];
    });
    const coverage = panel(
      "Profitable rolling windows",
      "Each eligible close supplies one overlapping historical window. Flat windows count in the denominator. Coverage requires continuous sampled returns. Monthly windows need matching observation days or two month-end closes.",
      table(
        [
          "Window",
          "Profitable / eligible",
          "Profitable share",
          "Excluded closes",
          "Coverage note",
        ],
        rows,
      ),
      "",
      "standalone",
    );
    return (
      coverage +
      `<div class="toolbar">${rollingControl()}<span>Each point uses a complete trailing window.</span></div><div class="grid-two">` +
      rollingPanel(
        s,
        a,
        "sharpe",
        "Rolling Sharpe ratio",
        `Excess return above ${pct(state.riskFree, 2)} annual cash, per unit of volatility.`,
        "rolling-sharpe",
      ) +
      rollingPanel(
        s,
        a,
        "sortino",
        "Rolling Sortino ratio",
        `Return above a ${pct(state.target, 2)} annual target, per unit of downside deviation.`,
        "rolling-sortino",
      ) +
      rollingPanel(
        s,
        a,
        "calmar",
        "Rolling Calmar ratio",
        "Annual compound growth divided by the size of the worst drawdown.",
        "rolling-calmar",
      ) +
      rollingPanel(
        s,
        a,
        "maxDrawdown",
        `Rolling ${state.months}-month drawdown`,
        "Both the peak and the later trough must be inside the window.",
        "rolling-dd",
      ) +
      rollingPanel(
        s,
        a,
        "volatility",
        "Rolling volatility",
        "Annualized dispersion of close-to-close returns.",
        "rolling-vol",
      ) +
      rollingPanel(
        s,
        a,
        "return",
        "Rolling return",
        "Growth from the opening equity mark to the window close.",
        "rolling-return",
      ) +
      "</div>"
    );
  }
  function calendarView(s, a) {
    const amounts = D.monthlyAmounts(s, a);
    const amountNote =
      s.currency === "INDEX" || amounts.unit !== s.currency
        ? "The second line shows the change in " + amounts.unit + "."
        : "The second line shows the change in " +
          amounts.unit +
          " equity. It measures P&L for a funded account without external cash flows.";
    const rows = [...a.years]
      .reverse()
      .map((y) => [
        String(y.year),
        y.coverage === "gap" ? "Missing observations" : y.complete ? "Full year" : "Partial",
        signedCell(y.return),
        signedCell(y.maxDrawdown),
        decimal(y.sharpe),
      ]);
    return (
      kpis(s, a) +
      `<div class="grid-hero">${annualPanel(a)}${panel(
        "Full-year averages",
        "Arithmetic averages across complete calendar years.",
        statList([
          ["Mean calendar-year return", pct(a.summary.meanYearReturn, 2)],
          ["Mean yearly maximum drawdown", pct(a.summary.meanYearDrawdown, 2)],
          ["Complete years", count(a.years.filter((y) => y.complete).length)],
          ["Full-period CAGR", growthPct(a.summary.cagr)],
        ]),
      )}</div>` +
      panel(
        "Monthly return heatmap",
        "Each cell shows the percentage return. Year return uses the opening and closing equity for the selected part of that year. " +
          amountNote +
          " A dash marks an unavailable value.",
        heatmap(s, a, false, amounts),
        "",
        "standalone",
      ) +
      panel(
        "Year-by-year performance",
        "Each row resets the drawdown high to that year’s opening equity.",
        table(
          ["Year", "Coverage", "Return", "Max drawdown", "Sharpe ratio"],
          rows,
        ),
        "",
        "standalone",
      )
    );
  }
  const niceKey = (k) =>
    String(k)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_-]/g, " ")
      .replace(/^./, (c) => c.toUpperCase());
  const sourceRecords = (obj, label, limit = Infinity) => {
    if (!obj || !Object.keys(obj).length)
      return empty(
        "No " + label.toLowerCase(),
        "The source did not supply these records.",
      );
    return `<dl class="metric-list source-records">${Object.entries(obj)
      .slice(0, limit)
      .map(([k, v]) => {
        let val =
          typeof v === "number" ? decimal(v, Number.isInteger(v) ? 0 : 4) : v;
        if (typeof v === "object" && v !== null) val = JSON.stringify(v);
        return `<div><dt>${escape(niceKey(k))}</dt><dd class="source-value">${escape(val ?? "—")}</dd></div>`;
      })
      .join("")}</dl>`;
  };
  function sourceDates(s) {
    const h = s.evidence?.sourceHorizon;
    if (!h || ![h.start, h.end].every(t => Number.isSafeInteger(t) && Math.abs(t) <= 8.64e15)
        || h.start > h.end) return null;
    return `${date(h.start)} – ${date(h.end)} UTC`;
  }
  function tradesView(s) {
    const range = bounds(s);
    const r = D.trades(s, range);
    const unit = s.currency === "INDEX" ? "index points" : s.currency;
    const amount = (v) =>
      Number.isFinite(v) ? decimal(v, 2) + " " + unit : "—";
    const hasLedger = Array.isArray(s.trades);
    const recorded = s.tradeSummary || {};
    const sourceCount = [recorded.closedTrades, recorded.count].find(
      n => Number.isSafeInteger(n) && n >= 0,
    );
    const datedCount = hasLedger ? s.trades.length : null;
    const countConflict = hasLedger && sourceCount !== undefined && datedCount > sourceCount;
    const partial = s.evidence?.tradeCoverage === "partial" ||
      (hasLedger && sourceCount !== undefined && datedCount < sourceCount);
    const uncertain = partial || countConflict;
    const unknownCount = !hasLedger || uncertain ||
      (!datedCount && s.evidence?.tradeCoverage !== "complete" && sourceCount !== 0);
    const selectedDates = `${date(range.start)} – ${date(range.end)} UTC`;
    const sourcePeriod = sourceDates(s);
    const fullHistory = "Full source history. " + (sourcePeriod ? sourcePeriod + ". " : "Source dates unspecified. ");
    const scope = [`Selected dates ${selectedDates}.`];
    if (partial) scope.push("Partial dated ledger.");
    if (hasLedger) {
      if (countConflict) scope.push(`Counts disagree. The ledger has ${count(datedCount)} dated closes. The summary lists ${count(sourceCount)} source closes.`);
      else if (sourceCount === undefined) scope.push(`${count(datedCount)} dated closes in the displayed history.`);
      else scope.push(`${count(datedCount)} of ${count(sourceCount)} source closes have dated rows in the displayed history.`);
      scope.push(`${count(r.count)} supplied closes in the selected dates.`);
    } else scope.push("The source supplied no dated trade ledger.");
    if (!r.count && unknownCount) scope.push("Trade count and P&L from dated rows are unknown for this selection.");
    else if (uncertain) scope.push("Statistics use the supplied closes. Streaks require the full sequence.");
    const scopeNote = `<p class="${uncertain || !hasLedger ? "notice" : "explain"}">${escape(scope.join(" "))}</p>`;
    const why =
      r.reason || "Supply dated net profit or loss for each closed trade.";
    const fields = [
      ["Closed trades", "count", count],
      ["Wins", "wins", count],
      ["Losses", "losses", count],
      ["Flats", "flat", count],
      ["Win rate", "winRate", pct],
      ["Net P&L", "netPnl", amount],
      ["Gross profit", "grossProfit", amount],
      ["Gross loss", "grossLoss", amount],
      ["Profit factor", "profitFactor", decimal],
      ["Expectancy per trade", "expectancy", amount],
      ["Average winner", "avgWin", amount],
      ["Average loser", "avgLoss", amount],
      ["Largest winner", "largestWinner", amount],
      ["Largest loser", "largestLoser", amount],
      ["Largest winner / gross profit", "largestWinnerShare", pct],
      ["Largest loss / gross loss", "largestLoserShare", pct],
    ];
    const unclassified = r.breakdown?.unclassifiedCount || 0;
    const hasSides = !r.count || unclassified !== r.count;
    const columnKeys = hasSides ? ["all", "long", "short"] : ["all"];
    const columns = r.breakdown ? columnKeys.map(key => r.breakdown[key]) : [];
    const tradeRows = fields.map(([label, key, format]) => [
      label,
      ...columns.map((column) => {
        const value = column[key],
          display = escape(format(value));
        return format === amount
          ? `<span class="${valClass(value)}">${display}</span>`
          : display;
      }),
    ]);
    const sideNote = unclassified
      ? ` All includes ${count(unclassified)} ${unclassified === 1 ? "trade" : "trades"} with another or missing side.` +
        (hasSides ? " The side columns count only classified trades." : " No long or short classifications are available.")
      : "";
    const summary = panel(
      "Closed trades by side",
      "Gross profit and gross loss sum the recorded winning and losing net trade outcomes in each column." +
        sideNote,
      r.breakdown
        ? table(hasSides ? ["Measure", "All", "Long", "Short"] : ["Measure", "All"], tradeRows)
        : empty("Trade ledger unavailable", why),
      "",
      "standalone",
    );
    const sizes = panel(
      "Trade outcomes",
      "Realized profit or loss per closed trade.",
      r.bins.length
        ? distribution(r.bins, "trade-hist", (v) => decimal(v, 0), true, { countScale: "auto" })
        : empty("Trade distribution unavailable", why),
    );
    const recent = r.outcomes.slice(-120);
    if (recent.length) {
      const bars = recent.map((trade, i) => {
        const number = r.count - recent.length + i + 1;
        return {
          label: "Trade " + number,
          short: String(number),
          value: trade.pnl,
          detail:
            "Trade " +
            number +
            " · " +
            new Date(trade.time).toISOString() +
            " · " +
            trade.side +
            " · " +
            amount(trade.pnl),
          color:
            trade.pnl > 0
              ? "var(--gain)"
              : trade.pnl < 0
                ? "var(--loss)"
                : "var(--muted)",
        };
      });
      barPlot("trade-chronology", bars, {
        title: "Net trade P&L in closing order",
        format: (v) => decimal(v, 0),
        height: 190,
      });
    }
    const chronology = panel(
      "Trade P&L in closing order",
      `Each bar is one closed trade in ${unit}.` +
        (recent.length < r.count
          ? ` Showing the latest ${count(recent.length)} of ${count(r.count)} selected trades.`
          : ""),
      recent.length
        ? chart("trade-chronology")
        : empty("Trade history unavailable", why),
    );
    const closed = r.outcomes.filter((t) => Number.isFinite(t.holdingHours));
    const holdingBins = [
      { label: "<1h", min: 0, max: 1 },
      { label: "1–8h", min: 1, max: 8 },
      { label: "8–24h", min: 8, max: 24 },
      { label: "1–7d", min: 24, max: 168 },
      { label: "7–30d", min: 168, max: 720 },
      { label: "30d+", min: 720, max: Infinity },
    ];
    if (closed.length)
      barPlot(
        "holding-time",
        holdingBins.map((b) => ({
          label: b.label,
          value: closed.filter(
            (t) => t.holdingHours >= b.min && t.holdingHours < b.max,
          ).length,
        })),
        { title: "Holding time distribution", height: 160, format: count },
      );
    const durations = panel(
      "Holding times",
      `${count(closed.length)} dated trades with a duration.`,
      closed.length
        ? chart("holding-time")
        : empty(
            "Holding times unavailable",
            "Supply holding hours for each trade.",
          ),
    );
    const costs = s.costs || {},
      ccy = costs.currency || costs.unit || s.currency;
    const monetaryCosts = new Set([
      "total",
      "reportedCost",
      "commission",
      "commissions",
      "commission_total",
      "fees",
      "slippage",
      "slippage_total",
      "spread",
      "borrow",
      "financing",
      "funding",
      "clearing",
      "exchangeFees",
      "taxes",
      "rollover",
    ]);
    const costRows = Object.entries(costs)
      .filter(([k, v]) => Number.isFinite(v))
      .map(([k, v]) => [
        niceKey(k),
        monetaryCosts.has(k) ? decimal(v, 2) + " " + ccy : decimal(v, 4),
      ]);
    const horizon = s.evidence?.sourceHorizon;
    const coversEquity = horizon
      ? horizon.start === s.times[0] && horizon.end === s.times.at(-1)
      : s.equity.at(-1) > 0;
    const net =
      Number.isFinite(costs.total) && ccy === s.currency && coversEquity
        ? s.equity.at(-1) - s.equity[0]
        : null;
    if (
      net !== null &&
      s.costModel &&
      /\bnet\b/i.test(s.accounting || "") &&
      s.currency !== "INDEX"
    ) {
      costRows.push(
        ["Net change in equity", cur(s, net, 2)],
        ["Before reported costs", cur(s, net + costs.total, 2)],
      );
    }
    const summaryAmounts = new Set([
      "avg_win", "avg_loss", "best_trade", "worst_trade", "expectancy_per_trade",
      "grossProfit", "grossLoss", "netPnl",
    ]);
    const summaryUnit = recorded.currency || recorded.unit || unit;
    const summaryValues = Object.fromEntries(Object.entries(recorded).map(([key, value]) => {
      if (Number.isFinite(value)) {
        if (key === "win_rate" && value >= 0 && value <= 1) value = pct(value);
        else if (summaryAmounts.has(key)) value = decimal(value, 2) + " " + summaryUnit;
      }
      return [key, value];
    }));
    const sourcePanels = [];
    if (Object.keys(recorded).length)
      sourcePanels.push(panel("Source trade summary", fullHistory + "Date filters apply only to dated trades.",
        sourceRecords(summaryValues, "source trade summary")));
    if (costRows.length)
      sourcePanels.push(panel("Execution costs", fullHistory.trim(), statList(costRows)));
    const totals = sourcePanels.length === 2
      ? `<div class="grid-two">${sourcePanels.join("")}</div>` : sourcePanels.join("");
    const assumptions = panel(
      "Cost assumptions", "",
      `<p class="evidence-text">${escape(s.costModel || "The source did not document its cost model.")}</p>`,
      "", "standalone",
    );
    const omissions = [
      !Object.keys(recorded).length && "The source supplied no full-history trade summary.",
      !costRows.length && "The source supplied no numeric execution cost breakdown.",
    ].filter(Boolean).join(" ");
    const sourceNote = omissions ? `<p class="explain">${escape(omissions)}</p>` : "";
    if (!r.count && unknownCount) return scopeNote + totals + sourceNote + assumptions;
    return (
      scopeNote + (uncertain ? totals : "") +
      summary +
      `<div class="grid-two">${chronology}${sizes}</div><div class="grid-two">` +
      panel(
        "Trade quality",
        "Calculated from the dated ledger.",
        statList([
          ["Average win / |average loss|", decimal(r.payoff)],
          [
            "Longest winning / losing streak",
            uncertain ? "—" : count(r.winStreak) + " / " + count(r.lossStreak),
          ],
          [
            "Mean holding time",
            Number.isFinite(r.meanHoldingHours)
              ? decimal(r.meanHoldingHours, 1) + " hours"
              : "—",
          ],
        ]),
      ) +
      durations +
      "</div>" +
      (uncertain ? "" : totals) + sourceNote + assumptions
    );
  }

  const activeClass = (value, selected) =>
    value === selected ? "selected" : "";
  function overlap(s, b, limits) {
    let i = 0,
      j = 0,
      firstI = -1,
      firstJ = -1,
      lastI = -1,
      lastJ = -1;
    while (i < s.times.length && j < b.times.length) {
      const x = s.times[i],
        y = b.times[j];
      if (Math.min(x, y) > limits.end) break;
      if (x === y) {
        if (x >= limits.start && x <= limits.end) {
          if (firstI < 0) {
            firstI = i;
            firstJ = j;
          }
          lastI = i;
          lastJ = j;
        }
        i++;
        j++;
      } else if (x < y) i++;
      else j++;
    }
    if (firstI === -1 || firstI === lastI) return null;
    const cut = (k, l, r) => ({
      ...k,
      times: k.times.slice(l, r + 1),
      equity: k.equity.slice(l, r + 1),
    });
    return [cut(s, firstI, lastI), cut(b, firstJ, lastJ)];
  }
  function weightComposition(s) {
    const holdings = s.holdings || [];
    if (!holdings.length)
      return empty(
        "Construction weights unavailable",
        "Supply a dated or described weight snapshot for the portfolio.",
      );
    const ordered = [...holdings].sort(
      (a, b) => Math.abs(b.weight) - Math.abs(a.weight),
    );
    const scale = Math.max(1, ...ordered.map((m) => Math.abs(m.weight)));
    return `<ul class="allocation-list">${ordered
      .map((m) => {
        const item = byId.get(m.id);
        const content = `<span>${escape(item?.name || m.id)}</span><strong>${pct(m.weight, 1)}</strong><span class="allocation-track"><i style="width:${(Math.abs(m.weight) / scale) * 100}%;background:${m.weight < 0 ? "var(--loss)" : "var(--brand)"}"></i></span>`;
        return `<li>${item ? `<button type="button" class="allocation-line" data-series="${escape(item.id)}">${content}</button>` : `<div class="allocation-line">${content}</div>`}</li>`;
      })
      .join("")}</ul>`;
  }
  function correlationLabel(r) {
    if (!Number.isFinite(r)) return "—";
    const magnitude = decimal(Math.abs(r));
    if (magnitude === "0.00") return magnitude;
    return (r < 0 ? "−" : "+") + magnitude;
  }

  function correlationGrid(matrix, focus) {
    const { names, values, counts, diagnostics } = matrix;
    function heading(name, i, axis) {
      return `<th scope="${axis}"${i === focus ? " data-focused" : ""}>${escape(name)}</th>`;
    }
    const header = names.map((name, i) => heading(name, i, "col")).join("");
    const grid = values
      .map((row, i) => {
        const cells = row
          .map((r, j) => {
            const d = diagnostics[i][j],
              n = counts[i][j];
            const color = r < 0 ? "var(--loss)" : "var(--brand)";
            const fill = Number.isFinite(r)
              ? ` style="background:color-mix(in srgb, ${color} ${Math.round(38 * Math.abs(r))}%, var(--panel))"`
              : "";
            const value = correlationLabel(r);
            const description = [
              names[i] + " / " + names[j],
              value,
              n + " shared intervals",
              d.reason,
              d.note,
            ]
              .filter(Boolean)
              .join(". ");
            return `<td${i === focus || j === focus ? " data-focused" : ""} aria-label="${escape(description)}"><span class="corr-value"${fill}>${value}<br><small>N ${count(n)}</small></span></td>`;
          })
          .join("");
        return `<tr>${heading(names[i], i, "row")}${cells}</tr>`;
      })
      .join("");
    return `<div class="table-wrap corr-scroll" role="region" aria-label="Scrollable correlation matrix" tabindex="0">
      <table class="corr-grid" aria-label="Strategy return correlations"><thead><tr><th scope="col">Strategy</th>${header}</tr></thead><tbody>${grid}</tbody></table></div>`;
  }

  function focusedCorrelations(matrix, focus) {
    const { names, values, counts, diagnostics } = matrix;
    const peers = names
      .map((name, j) => {
        if (j === focus) return "";
        const d = diagnostics[focus][j];
        const span =
          d.start == null ? "" : `${date(d.start)} – ${date(d.end)}.`;
        const detail = [d.reason, span, d.note].filter(Boolean).join(" ");
        return `<tr><th scope="row">${escape(name)}</th><td>${correlationLabel(values[focus][j])}</td><td>${count(counts[focus][j])}</td><td>${escape(detail)}</td></tr>`;
      })
      .join("");
    const title = "Comparisons for " + names[focus];
    return `<h3 class="subheading corr-detail-title" aria-live="polite">${escape(title)}</h3>
      <div class="table-wrap" role="region" aria-label="Scrollable focused comparisons" tabindex="0"><table class="corr-detail" aria-label="${escape(title)}"><thead><tr><th scope="col">Peer</th><th scope="col">Correlation</th><th scope="col">Shared intervals</th><th scope="col">Matched dates and limits</th></tr></thead><tbody>${peers}</tbody></table></div>`;
  }

  function highlightCorrelation(grid, index, active) {
    const rows = grid.tBodies[0].rows;
    grid.tHead.rows[0].cells[index + 1].toggleAttribute("data-focused", active);
    for (const cell of rows[index].cells)
      cell.toggleAttribute("data-focused", active);
    for (const row of rows)
      row.cells[index + 1].toggleAttribute("data-focused", active);
  }

  function revealCorrelation(grid, index) {
    const region = grid.parentElement,
      view = region.getBoundingClientRect();
    const diagonal =
      grid.tBodies[0].rows[index].cells[index + 1].getBoundingClientRect();
    const corner = grid.tHead.rows[0].cells[0].getBoundingClientRect();
    if (
      diagonal.left < view.left + corner.width ||
      diagonal.right > view.left + region.clientWidth
    ) {
      region.scrollLeft += diagonal.left - view.left - corner.width - 4;
    }
    if (
      diagonal.top < view.top + corner.height ||
      diagonal.bottom > view.top + region.clientHeight
    ) {
      region.scrollTop += diagonal.top - view.top - corner.height - 4;
    }
  }

  function mountCorrelationMatrix(root, s) {
    // Chart callbacks also run on resize. Keep existing controls and keyboard focus.
    if (!root || root.childElementCount) return;
    const defaultSize = 6;
    const anchor = s.kind === "strategy" ? s.id : null;
    const strategies = all.filter((k) => k.kind === "strategy");
    const scopes = new Map();
    function addScope(portfolio) {
      const families = D.strategyGroups(strategies, { portfolio });
      const ids = families.flatMap((f) => f.ids);
      if (portfolio && anchor && !ids.includes(anchor)) return;
      scopes.set(portfolio?.id ?? "", { portfolio, families, ids });
    }
    addScope();
    if (s.kind === "portfolio") addScope(s);
    else if (anchor)
      all.filter((k) => k.kind === "portfolio").forEach(addScope);
    if (state.correlation?.owner !== s.id) {
      // A strategy can belong to several books. Let the reader choose between those books.
      const group = scopes.size === 2 ? Array.from(scopes.keys())[1] : "";
      state.correlation = { owner: s.id, group, focus: anchor };
      state.matrixIds = null;
      state.matrixOpen = false;
    }
    const context = state.correlation;
    const range = bounds(s);
    let matrix;
    function draw() {
      const { portfolio, ids, families } = scopes.get(context.group);
      const pinned = anchor ? [anchor] : [];
      const choices = pinned.concat(
        (state.matrixIds ?? ids).filter((id) => id !== anchor),
      );
      const chosen =
        state.matrixIds == null ? choices.slice(0, defaultSize) : choices;
      const chosenSet = new Set(chosen);
      if (!chosen.includes(context.focus)) context.focus = chosen[0];
      const groups = Array.from(scopes, ([id, group]) => {
        const name = group.portfolio
          ? "Portfolio members · " + group.portfolio.name
          : "All report strategies";
        return `<option value="${escape(id)}" ${activeClass(id, context.group)}>${escape(name)} (${group.ids.length})</option>`;
      }).join("");
      const groupField = `<div><label for="correlation-group">Comparison group</label>
        <select class="input-select" id="correlation-group" ${scopes.size === 1 ? "disabled" : ""}>${groups}</select></div>`;
      let basis = "All strategy histories in this report.";
      if (portfolio)
        basis = Array.isArray(portfolio.holdings)
          ? "Membership uses the reported nonzero holdings with strategy histories."
          : portfolio.evidence?.attribution?.basis === "funded_equity"
            ? "Membership uses the declared funded strategies with histories in this report."
            : "The source did not identify portfolio members.";
      const note = `<p class="explain">${basis} Return closes from ${date(range.start)} through ${date(range.end)} UTC.</p>`;
      let picker = "";
      if (ids.length > 1) {
        const fields = families
          .map((f) => {
            const boxes = f.ids
              .map((id) => {
                const checked = chosenSet.has(id);
                return `<label><input type="checkbox" data-matrix="${escape(id)}" ${checked ? "checked" : ""} ${id === anchor ? "disabled" : ""}> ${escape(byId.get(id).name)}</label>`;
              })
              .join("");
            return `<fieldset><legend>${escape(f.family)}</legend><div class="checkbox-list">${boxes}</div></fieldset>`;
          })
          .join("");
        picker = `<div class="corr-actions"><button type="button" class="small-button" id="correlation-show-all" ${chosen.length === ids.length ? "disabled" : ""}>Show all strategies</button>
          <button type="button" class="small-button" id="correlation-reset" ${state.matrixIds == null ? "disabled" : ""}>Reset selection</button></div>
          <details class="picker corr-picker" ${state.matrixOpen ? "open" : ""}><summary>Choose strategies (${count(chosen.length)} of ${count(ids.length)})</summary>
          ${anchor ? '<p class="explain">The active strategy stays selected.</p>' : ""}${fields}</details>`;
      }
      if (chosen.length < 2) {
        matrix = null;
        context.cache = null;
        const reason =
          ids.length === 0
            ? portfolio
              ? "No portfolio member has a strategy history in this group."
              : "This report has no strategy histories."
            : ids.length === 1
              ? "This group contains only one strategy history. A pair needs two different strategies."
              : "Select at least two strategies from the group.";
        root.innerHTML =
          groupField + note + picker + empty("No strategy pair", reason);
        return;
      }
      const key = JSON.stringify([
        context.group,
        range.start,
        range.end,
        chosen,
      ]);
      if (context.cache?.key !== key) {
        context.cache = {
          key,
          matrix: D.correlationMatrix(strategies, {
            ...range,
            ids: chosen,
            portfolio,
            diagnostics: true,
          }),
        };
      }
      matrix = context.cache.matrix;
      const option = (id) =>
        `<option value="${escape(id)}" ${activeClass(id, context.focus)}>${escape(byId.get(id).name)}</option>`;
      const others = ids.filter((id) => !chosenSet.has(id));
      let focusOptions = chosen.map(option).join("");
      if (others.length)
        focusOptions = `<optgroup label="Selected strategies">${focusOptions}</optgroup>
        <optgroup label="Focus and show all peers">${others.map(option).join("")}</optgroup>`;
      const focus = matrix.ids.indexOf(context.focus);
      const scale = legend([
        ["−1 inverse", "var(--loss)"],
        ["0 no linear relation", "var(--line)"],
        ["+1 positive", "var(--brand)"],
      ]);
      root.innerHTML = `<div class="corr-controls">${groupField}<div><label for="correlation-focus">Focus strategy</label>
        <select class="input-select" id="correlation-focus" aria-controls="correlation-tables">${focusOptions}</select></div></div>
        ${note}${picker}${scale}<p class="explain">N counts intervals with matching opening and closing marks. Both strategies must use the same currency, frequency and periods per year.</p>
        ${chosen.length > defaultSize ? '<p class="explain">Scroll across and down to explore the full matrix.</p>' : ""}
        <div id="correlation-tables">${correlationGrid(matrix, focus)}<div id="correlation-peers">${focusedCorrelations(matrix, focus)}</div></div>`;
      if (focus > 0 && chosen.length > defaultSize)
        revealCorrelation(root.querySelector(".corr-grid"), focus);
    }
    root.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (
        !button ||
        !["correlation-show-all", "correlation-reset"].includes(button.id)
      )
        return;
      state.matrixIds =
        button.id === "correlation-show-all"
          ? scopes.get(context.group).ids
          : null;
      draw();
      root.querySelector("#correlation-focus")?.focus({ preventScroll: true });
    });
    root.addEventListener("change", (event) => {
      const el = event.target;
      if (el.id === "correlation-focus") {
        const previous = matrix.ids.indexOf(context.focus);
        const next = matrix.ids.indexOf(el.value);
        context.focus = el.value;
        if (next < 0) {
          state.matrixIds = scopes.get(context.group).ids;
          draw();
          root
            .querySelector("#correlation-focus")
            .focus({ preventScroll: true });
        } else if (next !== previous) {
          const grid = root.querySelector(".corr-grid");
          highlightCorrelation(grid, previous, false);
          highlightCorrelation(grid, next, true);
          root.querySelector("#correlation-peers").innerHTML =
            focusedCorrelations(matrix, next);
          revealCorrelation(grid, next);
        }
      } else if (el.id === "correlation-group") {
        context.group = el.value;
        context.focus = anchor;
        state.matrixIds = null;
        state.matrixOpen = false;
        draw();
        root.querySelector("#correlation-group").focus({ preventScroll: true });
      } else if (el.hasAttribute("data-matrix")) {
        state.matrixIds = Array.from(
          root.querySelectorAll("[data-matrix]:checked"),
          (node) => node.dataset.matrix,
        );
        state.matrixOpen = true;
        draw();
        const replacement = Array.from(
          root.querySelectorAll("[data-matrix]"),
        ).find((node) => node.dataset.matrix === el.dataset.matrix);
        replacement?.focus({ preventScroll: true });
      }
    });
    root.addEventListener(
      "toggle",
      (event) => {
        if (root.contains(event.target) && event.target.matches("details"))
          state.matrixOpen = event.target.open;
      },
      true,
    );
    draw();
  }

  function matrixPanel(s) {
    plots.push(() => mountCorrelationMatrix($("strategy-correlations"), s));
    return panel(
      "Strategy correlations",
      "Pearson correlation of sampled strategy returns.",
      '<div id="strategy-correlations"></div>',
      "",
      "standalone",
    );
  }
  function portfolioDetails(s) {
    if (s.kind !== "portfolio") return "";
    const result = D.attribution(s, all, options(s));
    const paper = s.evidence?.attribution?.basis === "paper_additive";
    const rows = result.rows.map((v) => [
      byId.get(v.id)?.kind === "strategy"
        ? `<button class="dir-button" type="button" data-series="${escape(v.id)}">${escape(v.name)}</button>`
        : escape(v.name),
      paper ? `<span class="${valClass(v.returnContribution)}">${pct(v.returnContribution, 2, true)}</span>` : signedCell(v.returnContribution),
      pct(v.riskShare, 2, true),
    ]);
    let description = "Return contributions add to portfolio growth. Risk shares measure contributions to return variance.";
    if (paper) {
      description = rows.length
        ? `Member paper P&L is a percentage of the selected opening equity on ${date(result.openingTime)} UTC. Portfolio return through ${date(result.closingTime)} UTC was ${pct(result.portfolioReturn, 2, true)}.`
        : "Paper attribution requires dated member P&L that reconciles to portfolio equity.";
    }
    if (rows.length && result.reason) description += ` Risk shares unavailable. ${result.reason}`;
    else if (paper && rows.length) {
      description += ` Risk shares divide each member’s covariance with portfolio returns by portfolio variance over ${count(result.riskIntervals)} matched intervals.`;
    }
    const body = rows.length ? table(["Strategy", "Return contribution", "Risk share"], rows)
      : empty("Attribution unavailable", result.reason || "Supply reconciled portfolio contribution evidence.");
    return `<div class="grid-two">${panel("Construction weights", s.evidence?.holdingsBasis || "Source weight snapshot for the full report.", weightComposition(s))}${panel("Portfolio attribution", description, body)}</div>`;
  }
  function peerPanel(s) {
    const peers = all.filter((k) => k.id !== s.id);
    if (!peers.length)
      return panel(
        "Compare series",
        "",
        empty(
          "No comparison series",
          "No source benchmark assigned. The report contains one series.",
        ),
        "",
        "standalone",
      );
    const assigned = byId.get(s.benchmarkId);
    const onlyPeer = peers.length === 1 && peers[0].kind !== "benchmark" ? peers[0] : null;
    const b = byId.get(state.peer) || assigned || onlyPeer;
    const opts = options(s);
    const assignment = assigned ? `Source benchmark is ${assigned.name}.` : "No source benchmark assigned.";
    const choiceNote = b && b.id !== assigned?.id ? ` The comparison uses ${b.name} as a peer.` : "";
    const prompt = !assigned && !onlyPeer ? '<option value="">Choose a comparison series</option>' : "";
    const choices = `<div class="toolbar"><label for="peer-select">Comparison series</label><select class="input-select" id="peer-select">${prompt}${peers.map((k) => `<option value="${escape(k.id)}" ${activeClass(k.id, b?.id)}>${escape(k.name)} · ${kinds[k.kind]}</option>`).join("")}</select></div>
      <p class="evidence-text">${escape(assignment + choiceNote)}</p>`;
    if (!b) return choices;
    const pair = overlap(s, b, opts);
    let comparison = empty(
        "No shared opening and closing marks",
        "The two histories need at least two common timestamps inside the selected dates.",
      ),
      snapshot = "";
    if (pair) {
      const analyses = pair.map((k) =>
        M.analyze(k, {
          months: state.months,
          riskFree: state.riskFree,
          target: state.target,
        }),
      );
      const lines = pair.map((k, i) => ({
        times: k.times,
        values: k.equity.map((e) => (e * 100) / k.equity[0]),
        label: k.name,
        color: chartColors[i],
        gapLimit: gapLimit(k),
      }));
      linePlot("peer-chart", lines, {
        title: "Indexed performance on common dates",
        format: (v) => decimal(v, 0),
        detailFormat: (v) => decimal(v, 2),
        height: 225,
      });
      comparison =
        legend(lines.map((l) => [l.label, l.color])) + chart("peer-chart");
      snapshot = panel(
        "Common-window performance",
        `${date(pair[0].times[0])} – ${date(pair[0].times.at(-1))}. Both series start at index 100.`,
        table(
          ["Series", "CAGR", "Max drawdown", "Sharpe ratio", "Total return"],
          analyses.map((a, i) => [
            escape(pair[i].name),
            growthPct(a.summary.cagr),
            pct(a.summary.maxDrawdown, 2),
            decimal(a.summary.sharpe),
            signedCell(a.summary.totalReturn),
          ]),
        ),
        "",
        "standalone",
      );
    }
    const n = Math.max(2, Math.round((s.periodsPerYear * state.months) / 12));
    const rel = D.benchmark(s, b, { ...opts, rollingWindow: n });
    if (b.kind === "benchmark") {
      const basis = [
        `Benchmark history ${date(b.times[0])} – ${date(b.times.at(-1))} UTC.`,
        typeof b.evidence?.returnCurrency === "string" && `The source gives ${b.evidence.returnCurrency} as its return currency.`,
        b.source, ...(b.notes || []),
      ].filter(Boolean);
      comparison += `<p class="evidence-text">${escape(basis.join(" "))}</p>`;
    }
    if (s.currency !== b.currency)
      comparison += `<p class="chart-caption">Display units are ${escape(s.currency)} for the selected series and ${escape(b.currency)} for the comparison.</p>`;
    if ([s, b].some(k => k.evidence?.markTimeBasis === "date_label"))
      comparison += '<p class="chart-caption">At least one series uses source date labels. Exact observation times are unknown for those marks.</p>';
    const stats = statList([
      ["Matched return intervals", count(rel.count)],
      ["Matched interval dates (UTC)", rel.count
        ? date(rel.coverage.start) + " – " + date(rel.coverage.end) : "—"],
      ...(rel.coverage.segments > 1 ? [["Separate matched periods", count(rel.coverage.segments)]] : []),
      [
        "Selected / reference coverage",
        pct(rel.coverage.seriesFraction, 0) +
          " / " +
          pct(rel.coverage.benchmarkFraction, 0),
      ],
      ["Correlation", decimal(rel.correlation)],
      ["Beta", decimal(rel.beta)],
      ["Annualized alpha", pct(rel.alpha, 2)],
      ["Annualized tracking error", pct(rel.trackingError, 2)],
      ["Information ratio", decimal(rel.informationRatio)],
      [
        "Upside / downside capture",
        pct(rel.upCapture, 1) + " / " + pct(rel.downCapture, 1),
      ],
    ]);
    if (rel.rolling.times.length)
      linePlot(
        "rolling-correlation",
        [
          {
            times: rel.rolling.times,
            values: rel.rolling.correlation,
            label: "Correlation",
          },
        ],
        {
          title: "Rolling comparison correlation",
          format: (v) => decimal(v, 1),
          height: 164,
          empty: `At least ${n} matched return intervals with changing values are required.`,
        },
      );
    const rolling = rel.rolling.times.length
      ? chart("rolling-correlation")
      : empty(
          "Aligned returns unavailable",
          rel.reason ||
            "The reference needs matching opening and closing intervals.",
        );
    return (
      choices +
      `<div class="grid-hero">${panel("Indexed comparison", "Growth of 100 across shared opening and closing marks.", comparison)}${panel("Relative performance", "Measured on paired return intervals.", stats + (rel.reason ? `<p class="chart-caption">${escape(rel.reason)}</p>` : ""))}</div>` +
      snapshot +
      panel(
        "Rolling correlation",
        `${n} matched return intervals per estimate.`,
        rolling,
        "",
        "standalone",
      )
    );
  }

  const score = {
    filter: "",
    sort: "name",
    page: 0,
    cache: new Map(),
    window: null,
  };
  function scorecardPanel(s) {
    if (!all.some((x) => x.kind === "strategy")) return "";
    const range = bounds(s);
    const controls = `<div class="toolbar score-toolbar"><label>Find strategies <input type="search" id="score-filter" placeholder="Name, family or asset class" value="${escape(score.filter)}"></label><label>Sort by <select class="input-select" id="score-sort">${[
      ["name", "Name"],
      ["cagr", "CAGR"],
      ["maxDrawdown", "Shallowest drawdown"],
      ["sharpe", "Sharpe ratio"],
    ]
      .map(
        ([id, title]) =>
          `<option value="${id}" ${activeClass(id, score.sort)}>${title}</option>`,
      )
      .join("")}</select></label></div>`;
    return panel(
      "Strategy scorecard",
      `All report strategies. Selected closes run from ${date(range.start)} through ${date(range.end)} UTC. Each row shows its actual opening and closing marks. Select a name to open its charts.`,
      controls +
        '<div id="score-rows"></div><div class="score-nav"><span id="score-count"></span><div><button type="button" class="small-button" id="score-prev">Previous</button><button type="button" class="small-button" id="score-next">Next</button></div></div>',
      "",
      "standalone",
    );
  }
  function updateScorecard() {
    if (!$("score-rows")) return;
    const opts = options(byId.get(state.id)),
      windowKey = JSON.stringify(opts);
    if (score.window !== windowKey) {
      score.cache.clear();
      score.window = windowKey;
      score.page = 0;
    }
    const query = score.filter.trim().toLowerCase();
    const filtered = all.filter(
      (s) =>
        s.kind === "strategy" &&
        [s.name, s.assetClass, s.family].some(
          (v) => typeof v === "string" && v.toLowerCase().includes(query),
        ),
    );
    function measures(s) {
      if (!score.cache.has(s.id)) {
        const a = analyze(s, opts);
        score.cache.set(s.id, {
          ...a.summary,
          opening: a.meta.baselineTime,
          end: a.times.at(-1),
        });
      }
      return score.cache.get(s.id);
    }
    filtered.sort((a, b) => {
      if (score.sort !== "name") {
        const x = measures(a)[score.sort],
          y = measures(b)[score.sort];
        if (Number.isFinite(x) !== Number.isFinite(y))
          return Number.isFinite(x) ? -1 : 1;
        if (Number.isFinite(x) && x !== y) return y - x;
      }
      return a.name.localeCompare(b.name);
    });
    score.page = Math.max(
      0,
      Math.min(score.page, Math.ceil(filtered.length / 10) - 1),
    );
    const start = score.page * 10;
    const rows = filtered.slice(start, start + 10).map((s) => {
      const m = measures(s);
      return [
        `<button type="button" class="dir-button" data-series="${escape(s.id)}">${escape(s.name)}</button>`,
        escape(s.family || "—"),
        Number.isFinite(m.opening)
          ? date(m.opening) + " – " + date(m.end)
          : "—",
        pct(m.totalReturn, 2),
        growthPct(m.cagr),
        pct(m.maxDrawdown, 2),
        decimal(m.sharpe),
      ];
    });
    $("score-rows").innerHTML = rows.length
      ? table(
          [
            "Strategy",
            "Family",
            "Recorded interval",
            "Total return",
            "CAGR",
            "Max drawdown",
            "Sharpe ratio",
          ],
          rows,
        )
      : empty(
          "No matching strategies",
          "Use a different name, asset class or strategy family.",
        );
    $("score-count").textContent = rows.length
      ? `${start + 1}–${start + rows.length} of ${filtered.length} strategies`
      : "0 strategies";
    $("score-prev").disabled = score.page === 0;
    $("score-next").disabled = start + rows.length >= filtered.length;
  }

  function compareView(s) {
    return (
      matrixPanel(s) + peerPanel(s) + scorecardPanel(s) + portfolioDetails(s)
    );
  }
  function evidenceView(s, a) {
    const e = s.evidence || {},
      rows = D.evidenceCoverage(s);
    const disclosure = (title, body) =>
      `<details><summary>${escape(title)}</summary>${body}</details>`;
    const coverage = `<dl class="definitions">${rows.map(row => {
      const scope = row.scope === "source" ? "Full source history" : "Supplied dated observations";
      const detail = row.available ? scope : (row.missing || []).join(", ") || row.reason;
      return `<div><dt>${escape(row.label || niceKey(row.id))}</dt><dd>${row.available ? "Recorded" : "Unavailable"}. ${escape(detail)}</dd></div>`;
    }).join("")}</dl>`;
    const range = bounds(s), sourcePeriod = sourceDates(s);
    let maxGap = null, previous = a.meta.baselineTime;
    for (const t of a.times) {
      if (Number.isFinite(previous) && t > previous) maxGap = Math.max(maxGap ?? 0, t - previous);
      previous = t;
    }
    const seen = Object.entries(e).filter(
      ([k]) => !["results", "holdingsBasis", "attribution"].includes(k) && !(k === "sourceHorizon" && sourcePeriod),
    );
    const statisticCount = Object.keys(s.sourceMetrics || {}).length;
    const sourceFields = seen.length
      ? disclosure(`Show ${count(seen.length)} source fields`, sourceRecords(Object.fromEntries(seen), "research evidence"))
      : "No additional fields supplied.";
    const sourceStatistics = statisticCount
      ? disclosure(`Show ${count(statisticCount)} source statistics`, sourceRecords(s.sourceMetrics, "source statistics"))
      : "No statistics supplied.";
    const families = {
      winner_removal: "Remove winning trades",
      random_removal: "Random trade removal",
      shuffle: "Change trade order",
      monte_carlo: "Resample outcomes",
      parameter_neighbors: "Nearby parameters",
      signal_cadence: "Signal frequency",
      price_perturbation: "Perturb prices",
      costs: "Cost sensitivity",
      other_markets: "Other markets",
      chronology: "Out-of-sample and walk-forward",
    };
    let records = e.results;
    if (!Array.isArray(records))
      records = Object.entries(records || {}).flatMap(([family, group]) => {
        const items = group?.results ?? group;
        return (Array.isArray(items) ? items : [items])
          .filter(v => v && typeof v === "object" && !Array.isArray(v) && (v.family == null || v.family === family))
          .map(v => ({ ...v, family }));
      });
    records = records.filter(r => r && typeof r === "object" && !Array.isArray(r));
    const tests = records.map(r => {
      const family = Object.hasOwn(families, r.family) ? families[r.family] : niceKey(r.family || "Research test");
      const title = r.label || family;
      const fields = Object.fromEntries(Object.entries(r).filter(([k]) => !["family", "status", "label"].includes(k)));
      const description = r.label ? `<p class="explain">${escape(family)}</p>` : "";
      return disclosure(title + " · " + niceKey(r.status || "Status unspecified"),
        description + (Object.keys(fields).length ? sourceRecords(fields, "source test details") : ""));
    }).join("");
    const missingFamilies = Object.entries(families).filter(([id]) => !records.some(r => r.family === id));
    const missingTests = missingFamilies.length ? disclosure(
      `${count(missingFamilies.length)} test families without a source result`,
      `<ul class="evidence-list">${missingFamilies.map(([, label]) => `<li>${escape(label)}</li>`).join("")}</ul>`,
    ) : "";
    const noteList = s.notes?.length
      ? `<ul class="evidence-list">${s.notes.map((n) => `<li>${escape(n)}</li>`).join("")}</ul>`
      : "";
    const methods = [
      [
        "CAGR",
        "The constant annual growth rate from opening to closing equity, using elapsed calendar time.",
      ],
      [
        "Mean full-year return",
        "The arithmetic average of returns from complete calendar years.",
      ],
      [
        "Maximum drawdown",
        "The largest percentage fall from a prior equity high to a later mark.",
      ],
      [
        "Rolling maximum drawdown",
        "The worst peak-to-trough loss inside the selected trailing calendar window.",
      ],
      [
        "Sharpe ratio",
        "Annualized excess return divided by annualized return volatility.",
      ],
      [
        "Sortino ratio",
        "Annualized return above the target divided by annualized downside deviation.",
      ],
      [
        "Calmar ratio",
        "Compound annual growth divided by the absolute maximum drawdown for the same window.",
      ],
      [
        "Profit factor and expectancy",
        "Profit factor divides total winning P&L by the absolute losing P&L. Expectancy is average P&L per closed trade.",
      ],
      [
        "Expected shortfall",
        "The mean of returns in the lower 5% tail. Values use the return sign.",
      ],
      [
        "Capital basis",
        "Compounded returns use current equity. Fixed-capital contributions use opening capital. External cash flows require a unitized equity series.",
      ],
    ];
    return (
      `<div class="grid-two">${panel(
        "Source and assumptions",
        "Full source history.",
        statList([
          ["Series", s.name],
          ["Type", kinds[s.kind]],
          ["Currency or unit", s.currency],
          ["Asset class", s.assetClass || "Unspecified"],
          ["Strategy family", s.family || "Unspecified"],
          ["Displayed equity history (UTC)", date(s.times[0]) + " – " + date(s.times.at(-1))],
          ["Dates for full-source figures", sourcePeriod || "Source dates unspecified"],
          ["Source benchmark", byId.get(s.benchmarkId)?.name || "None assigned"],
          ["Evidence status", s.status || "Unspecified"],
        ]) +
          `<p class="explain">${escape(s.source || "Source identity was not supplied.")}</p>${noteList}`,
      )}${panel(
        "Measurement basis",
        "Selected analysis window.",
        statList([
          ["Selected dates (UTC)", date(range.start) + " – " + date(range.end)],
          ["Opening equity mark (UTC)", date(a.meta.baselineTime)],
          ["Last selected mark (UTC)", date(a.times.at(-1))],
          ["Equity marks", count(a.times.length)],
          ["Valid return observations", count(a.meta.validReturns)],
          ["Missing intervals", count(a.meta.gaps.length)],
          [
            "Possible holiday intervals",
            count(a.meta.possibleHolidayIntervals),
          ],
          ["Largest mark gap", maxGap === null ? "—" : decimal(maxGap / DAY, 1) + " days"],
          ["Return sampling", periodText(s)],
          ["Annual risk-free rate", pct(state.riskFree, 2)],
          ["Annual downside target", pct(state.target, 2)],
          ["Rolling window", state.months + " months"],
          [
            "Calendar",
            s.sessionDates
              ? "Supplied exchange sessions"
              : "Frequency-based gap rules",
          ],
        ]) +
          `<p class="explain">${escape(s.accounting || "The source did not describe its accounting basis.")}</p><p class="evidence-text">${escape(s.costModel || "The source did not describe its cost model.")}</p>`,
      )}</div>` +
      panel(
        "Research tests",
        records.length ? "Open a source record to read its findings and settings." : "The source supplied no test records.",
        tests + missingTests,
        "",
        "standalone",
      ) +
      panel(
        "Data coverage",
        `${count(rows.filter(row => row.available).length)} of ${count(rows.length)} input groups have the required source records.`,
        disclosure("Availability and input requirements", coverage),
        "",
        "standalone",
      ) +
      (seen.length || statisticCount
        ? `<div class="grid-two">${panel("Research evidence", "Full source history.", sourceFields)}
             ${panel("Source statistics", "The source may use a different return or annualization convention.", sourceStatistics)}</div>`
        : "") +
      panel(
        "Methods",
        "",
        disclosure("Calculation conventions", `<dl class="definitions">${Object.entries(M.conventions)
          .map(
            ([key, value]) =>
              `<div><dt>${escape(niceKey(key))}</dt><dd>${escape(value)}</dd></div>`,
          )
          .join("")}</dl>`) +
        disclosure("Metric definitions", `<dl class="definitions">${methods.map(([k, v]) => `<div><dt>${escape(k)}</dt><dd>${escape(v)}</dd></div>`).join("")}</dl>`),
        "",
        "standalone",
      )
    );
  }

  function explorerItems(s, a) {
    const limits = bounds(s);
    const observed = (s.diagnostics || []).map((d, i) => {
      const first = d.times.findIndex((t) => t >= limits.start);
      let stop = first;
      while (stop >= 0 && stop < d.times.length && d.times[stop] <= limits.end)
        stop++;
      return {
        id: "source-" + i,
        name: d.name,
        unit: d.unit,
        times: first < 0 ? [] : d.times.slice(first, stop),
        values: first < 0 ? [] : d.values.slice(first, stop),
        description: d.description || "Observations supplied with this series.",
      };
    });
    const items = [
      {
        id: "returns",
        name: periodUnit(s) + " returns",
        unit: "%",
        times: a.returns.times,
        values: a.returns.values,
        description:
          "Close-to-close returns at the declared sampling frequency.",
      },
      {
        id: "underwater",
        name: "Underwater drawdown",
        unit: "%",
        times: a.times,
        values: a.drawdown,
        description: "Loss from the most recent equity high.",
      },
      {
        id: "maximum-drawdown",
        name: "Maximum drawdown to date",
        unit: "%",
        times: a.times,
        values: a.maxDrawdownPath,
        description:
          "Worst observed peak-to-trough loss since the start of the selection.",
      },
      ...[
        ["sharpe", "Sharpe", "ratio"],
        ["sortino", "Sortino", "ratio"],
        ["calmar", "Calmar", "ratio"],
        ["volatility", "volatility", "%"],
        ["maxDrawdown", "maximum drawdown", "%"],
        ["return", "return", "%"],
      ].map(([key, name, unit]) => ({
        id: "rolling-" + key,
        name: "Rolling " + name,
        unit,
        times: a.rolling.times,
        values: a.rolling[key],
        description: `Complete trailing ${state.months}-month windows.`,
      })),
    ];
    return [...observed, ...items];
  }
  const explorerTickNumber = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 4 });
  function explorerCard(metric) {
    const { name, times, values, unit } = metric;
    const unitSuffix = unit === "ratio" || unit === "number" ? "" : " " + unit;
    const fmt = v => unit === "%" ? pct(v, 2) :
      Number.isFinite(v) ? decimal(v, 2) + unitSuffix : "—";
    const tick = v => unit === "%" ? explorerTickNumber.format(100 * v) + "%" : explorerTickNumber.format(v);
    let recorded = 0, last = -1, low = Infinity, high = -Infinity, mean = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) continue;
      recorded++;
      last = i;
      low = Math.min(low, v);
      high = Math.max(high, v);
      const delta = v - mean;
      mean = Number.isFinite(delta)
        ? mean + delta / recorded
        : mean * (1 - 1 / recorded) + v / recorded;
    }
    const bins = [];
    if (recorded && low === high) {
      bins.push({ lower: low, upper: high, count: recorded });
    } else if (recorded) {
      const binCount = 18;
      const span = high - low;
      let lower = low;
      for (let i = 1; i <= binCount; i++) {
        const fraction = i / binCount;
        const upper = i === binCount ? high : Number.isFinite(span)
          ? low + span * fraction : low * (1 - fraction) + high * fraction;
        bins.push({ lower, upper, count: 0 });
        lower = upper;
      }
      for (const v of values) {
        if (!Number.isFinite(v)) continue;
        const bin = bins.find(b => v < b.upper) || bins.at(-1);
        bin.count++;
      }
    }
    const timeline = "explorer-chart-" + metric.id;
    linePlot(
      timeline, [{ times, values, label: name }],
      { title: name + " over time", format: tick, detailFormat: fmt, height: 158,
        empty: metric.id.startsWith("rolling-")
          ? `No defined ${state.months}-month observations in this range.`
          : "No recorded values in this range." },
    );
    const histogram = distribution(bins, "explorer-distribution-" + metric.id, tick, false, {
      countScale: "auto", height: 135, title: `${name} distribution (${unit})`, empty: "No recorded values to count.",
    });
    const summary = [
      ["Latest", fmt(values[last])], ["Low", fmt(low)], ["High", fmt(high)],
      ["Mean", fmt(recorded ? mean : null)], ["Recorded", count(recorded)], ["Missing", count(values.length - recorded)],
    ];
    return panel(name, metric.description,
      `<figure><figcaption>Timeline (${escape(unit)})</figcaption>${chart(timeline)}</figure>
       <figure><figcaption>Distribution of values (${escape(unit)})</figcaption>${histogram}</figure>
       <dl class="explorer-summary">${summary.map(([label, value]) =>
         `<div><dt>${label}</dt><dd>${escape(value)}${label === "Latest" && last >= 0 ? `<small>${date(times[last])} UTC</small>` : ""}</dd></div>`,
       ).join("")}</dl>`,
      "", "explorer-card",
    );
  }
  function explorerView(s, a) {
    const range = bounds(s);
    return `<div class="toolbar">${rollingControl()}<span>Rolling measures share this window. Selected dates ${date(range.start)} – ${date(range.end)} UTC.</span></div>
      <div id="explorer-grid">${explorerItems(s, a).map(explorerCard).join("")}</div>`;
  }

  const usd = (v) =>
    Number.isFinite(v) ? "$" + decimal(v, 2) : "Not recorded";
  const marginKinds = {
    broker_requirement: ["Broker overnight margin", "var(--margin)", ""],
    required_equity: ["Broker required equity", "var(--gold)", ""],
    schedule_estimate: ["Modeled overnight margin", "var(--margin)", "5 3"],
    schedule_scenario: ["Overnight margin scenario", "var(--margin)", "2 4"],
  };
  function marginKind(basis) {
    return (
      (Object.hasOwn(marginKinds, basis) && marginKinds[basis]) || [
        "Overnight requirement",
        "var(--margin)",
        "",
      ]
    );
  }
  function intradayKind(basis) {
    const names = { broker_requirement: "Intraday broker margin", required_equity: "Intraday required equity",
      schedule_estimate: "Modeled intraday margin", schedule_scenario: "Intraday margin scenario" };
    const colors = { broker_requirement: "var(--intraday)", required_equity: "var(--gold)",
      schedule_estimate: "var(--intraday)", schedule_scenario: "var(--intraday)" };
    return [names[basis] || "Intraday margin", colors[basis] || "var(--intraday)",
      basis === "schedule_scenario" ? "2 3" : basis === "schedule_estimate" ? "6 3" : ""];
  }
  function closingScenario(row) {
    return row.overnightScenarioUsd ?? (row.marginBasis === "schedule_scenario" ? row.marginUsd : null);
  }
  function activityPositions(row) {
    const positions = row.activePositions;
    if (!Array.isArray(positions)) return '<p class="chart-caption">The source supplies no strategy and contract breakdown for this session.</p>';
    if (!positions.length) return '<p class="chart-caption">The session ledger lists no active positions.</p>';
    const records = [...positions].sort((a, b) => (b.marginUsd ?? -1) - (a.marginUsd ?? -1));
    return table(["Strategy", "Contract / instrument", "Account", "Active during session", "Close quantity", "Attributed USD", "Basis"],
      records.map((p) => [byId.get(p.strategyId)?.name || p.strategyId, p.symbol, p.account || "—",
        p.heldDuring == null ? "—" : p.heldDuring ? "Yes" : "No",
        Number.isFinite(p.closeQty) ? decimal(p.closeQty, Math.abs(p.closeQty) < 1 && p.closeQty ? 5 : 2) : "—",
        Number.isFinite(p.marginUsd) ? usd(p.marginUsd) : "—",
        Number.isFinite(p.marginUsd) ? marginKind(p.marginBasis)[0] : "—"].map(escape)));
  }
  function pointContributors(point) {
    if (!point?.contributors?.length) return "";
    const records = [...point.contributors].sort((a, b) => b.marginUsd - a.marginUsd);
    return '<h3 class="activity-detail-title">Contributors at the selected time</h3>' +
      table(["Strategy", "Contract / instrument", "Quantity at this time", "Attributed USD"],
        records.map((p) => [byId.get(p.strategyId)?.name || p.strategyId, p.symbol,
          decimal(p.quantity, 4), usd(p.marginUsd)].map(escape)));
  }
  // Each record uses the trading date assigned by the source, including overnight sessions.
  function sessionRange(s) {
    const zone = s.activity.timeZone;
    const lastDate = sessionDate(s.times.at(-1), zone);
    // An overnight market may assign a different session label to its actual closing instant.
    const to =
      state.range === "Custom"
        ? iso(state.to)
        : [lastDate, s.activity.rows.at(-1)?.date || lastDate].sort()[1];
    if (state.range === "Custom") return { from: iso(state.from), to };
    if (state.range === "All") {
      const firstDate = sessionDate(s.times[0], zone);
      return {
        from: [firstDate, s.activity.rows[0]?.date || firstDate].sort()[0],
        to,
      };
    }
    const end = Date.parse(to + "T00:00:00Z");
    const from =
      state.range === "YTD"
        ? to.slice(0, 4) + "-01-01"
        : iso(startOfPeriod(end, 12 * parseInt(state.range, 10)));
    return { from, to };
  }
  function sessionRows(s) {
    if (!s.activity) return [];
    const { from, to } = sessionRange(s);
    return s.activity.rows.filter((r) => r.date >= from && r.date <= to);
  }
  const sessionFormatters = new Map();
  function sessionDate(t, zone) {
    if (!zone || zone === "UTC") return iso(t);
    if (!sessionFormatters.has(zone)) {
      sessionFormatters.set(
        zone,
        new Intl.DateTimeFormat("en-CA", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          timeZone: zone,
        }),
      );
    }
    return sessionFormatters.get(zone).format(t);
  }
  function activityView(s) {
    const rows = sessionRows(s);
    if (!rows.length) {
      return panel(
        "Daily strategy activity and overnight margin",
        "",
        empty(
          s.activity
            ? "No daily records in this range"
            : "Daily records unavailable",
          s.activity
            ? "Select dates covered by the session ledger."
            : "Supply daily position records or session totals. Portfolio returns alone cannot identify open strategies or the overnight requirement.",
        ),
      );
    }
    const bases = new Set(), intradayBases = new Set();
    const peaks = new Map();
    let intradaySessions = 0, scenarioCloses = 0, peakScenario = null;
    let peakActive = null,
      peakOvernight = null,
      peakLoad = null,
      countKnown = 0,
      amountKnown = 0,
      invested = 0;
    // Margin load needs an actual USD close on the same trading date.
    const dailyNav = new Map(),
      navAt = new Map();
    if (s.currency === "USD") {
      for (let i = 0; i < s.times.length; i++) {
        const t = s.times[i];
        dailyNav.set(sessionDate(t, s.activity.timeZone), s.equity[i]);
        navAt.set(t, s.equity[i]);
      }
    }
    for (const r of rows) {
      const samples = (r.intradayMargin || []).filter((p) => Number.isFinite(p.marginUsd));
      if (samples.length) intradaySessions++;
      for (const p of samples) intradayBases.add(p.marginBasis);
      const scenario = closingScenario(r);
      if (Number.isFinite(scenario)) {
        scenarioCloses++;
        bases.add("schedule_scenario");
        if (!peakScenario || scenario > peakScenario.amount) peakScenario = {amount: scenario, date: r.date};
      }
      if (Number.isFinite(r.active)) {
        countKnown++;
        if (r.active > 0) invested++;
        peakActive = Math.max(peakActive ?? 0, r.active);
      }
      if (Number.isFinite(r.overnight))
        peakOvernight = Math.max(peakOvernight ?? 0, r.overnight);
      if (!Number.isFinite(r.marginUsd)) continue;
      if (r.marginBasis === "schedule_scenario") continue;
      amountKnown++;
      bases.add(r.marginBasis);
      if (r.marginUsd > (peaks.get(r.marginBasis)?.marginUsd ?? -1))
        peaks.set(r.marginBasis, r);
      const close =
        typeof r.closeTime === "string" ? Date.parse(r.closeTime) : r.closeTime;
      const equity = close == null ? dailyNav.get(r.date) : navAt.get(close);
      if (!["required_equity", "schedule_scenario"].includes(r.marginBasis) && equity > 0)
        peakLoad = Math.max(peakLoad ?? 0, r.marginUsd / equity);
    }
    const byDate = new Map(rows.map((r, i) => [r.date, i]));
    let selectedDate = rows.at(-1).date;
    function showDay(day, point = null) {
      selectedDate = day;
      const input = $("activity-day");
      if (input.value !== day) input.value = day;
      const i = byDate.get(day),
        row = rows[i];
      $("activity-prev").disabled = day <= rows[0].date;
      $("activity-next").disabled = day >= rows.at(-1).date;
      if (!row) {
        $("activity-reading").innerHTML = empty(
          "No session record",
          "Select a date with a recorded session.",
        );
        return;
      }
      let details = statList([
        ["Active during session", count(row.active)],
        ["Held overnight", count(row.overnight)],
        [row.marginBasis === "schedule_scenario" ? "Historical overnight requirement" : marginKind(row.marginBasis)[0],
          usd(row.marginBasis === "schedule_scenario" ? null : row.marginUsd)],
        ...(Number.isFinite(closingScenario(row)) ? [["Overnight margin scenario", usd(closingScenario(row))]] : []),
      ]);
      const samples = row.intradayMargin || [];
      if (point && Number.isFinite(point.time)) {
        const label = (point.kind === "intraday" ? intradayKind : marginKind)(point.marginBasis)[0];
        details += statList([[label + " · " + new Date(point.time).toISOString(),
          usd(point.marginUsd)]]);
      }
      details += pointContributors(point) +
        (point?.contributors?.length && s.activity.metadata?.intradayContributors
          ? '<p class="chart-caption">' + escape(s.activity.metadata.intradayContributors) + '</p>' : '') +
        '<h3 class="activity-detail-title">Active strategies and contracts</h3>' + activityPositions(row);
      if (samples.length) {
        details += '<details class="session-samples"><summary>Intraday observations (' + count(samples.length) + ')</summary>' +
          table(["Timestamp (UTC)", "Basis", "USD"],
            samples.map((sample) => [new Date(sample.time).toISOString(), intradayKind(sample.marginBasis)[0], usd(sample.marginUsd)].map(escape))) + '</details>';
      }
      const gaps = [...new Set(Object.values(row.gaps || {}))];
      if (gaps.length)
        details +=
          '<p class="chart-caption">' + gaps.map(escape).join(" ") + "</p>";
      const entries =
        row.marginDetails?.components || row.marginDetails?.accounts;
      if (Array.isArray(entries) && entries.length) {
        const calculations = entries
          .filter((v) => v && typeof v === "object")
          .map((v) => {
            let rule = v.ruleId || "Account total";
            if (v.method === "per_contract")
              rule += " · " + v.rate + " " + v.currency + " per contract";
            if (v.method === "notional_fraction")
              rule +=
                " · " +
                pct(v.rate, 2) +
                " of notional · price " +
                v.price +
                " " +
                v.currency +
                " × multiplier " +
                v.multiplier;
            if (v.usdPerUnit != null && v.currency !== "USD")
              rule += " · FX " + v.usdPerUnit + " USD/" + v.currency;
            return [
              v.account,
              v.symbol || "Account total",
              v.netQty ?? "—",
              rule,
              usd(v.marginUsd),
            ].map(escape);
          });
        details +=
          "<details><summary>Requirement breakdown</summary>" +
          table(
            [
              "Account",
              "Instrument",
              "Net quantity",
              "Rate rule and inputs",
              "USD requirement",
            ],
            calculations,
          ) +
          "</details>";
      }
      $("activity-reading").innerHTML = details;
    }
    function describe(r) {
      const lines = [
        "Active during session  " + (r.active ?? "Not recorded"),
        "Held overnight  " + (r.overnight ?? "Not recorded"),
        ...(r.marginBasis !== "schedule_scenario" ? [marginKind(r.marginBasis)[0] + "  " + usd(r.marginUsd)] : []),
        ...(Number.isFinite(closingScenario(r)) ? ["Overnight margin scenario  " + usd(closingScenario(r))] : []),
      ];
      if (r.gaps) lines.push(...new Set(Object.values(r.gaps)));
      return lines;
    }
    plots.push(() => {
      const cursor = C.activity($("activity-chart"), rows, {
        range: sessionRange(s),
        color: (key) => marginKind(key)[1],
        dash: (key) => marginKind(key)[2],
        intradayColor: (key) => intradayKind(key)[1],
        intradayDash: (key) => intradayKind(key)[2],
        intradayLabel: (key) => intradayKind(key)[0],
        select: (row, point) => showDay(row.date, point),
        onZoom: ({from, to}) => {
          const fmt = (t) => to - from > 2 * DAY ? iso(t) : new Date(t).toISOString().slice(0, 16).replace("T", " ");
          $("activity-zoom-range").textContent = fmt(from) + " – " + fmt(to) + " UTC";
        },
        describe,
      });
      function pick(day) {
        showDay(day);
        if (byDate.has(day)) cursor.showAt(byDate.get(day));
        else cursor.hide();
      }
      $("activity-day").onchange = (e) => pick(e.target.value);
      const seek = (direction) => {
        let i = byDate.get(selectedDate);
        if (i === undefined) {
          i = rows.findIndex((r) => r.date > selectedDate);
          if (i === -1) i = rows.length;
          if (direction === 1) i--;
        }
        pick(rows[Math.min(rows.length - 1, Math.max(0, i + direction))].date);
      };
      $("activity-prev").onclick = () => seek(-1);
      $("activity-next").onclick = () => seek(1);
      $("activity-zoom-in").onclick = () => cursor.zoomBy(2);
      $("activity-zoom-out").onclick = () => cursor.zoomBy(0.5);
      $("activity-zoom-day").onclick = () => cursor.zoomToSession(selectedDate);
      $("activity-zoom-reset").onclick = () => cursor.resetZoom();
      showDay(selectedDate);
    });
    const keys = [
      ["Active during session", "var(--activity)"],
      ["Held overnight", "var(--overnight)", true],
    ];
    for (const basis of bases) keys.push(marginKind(basis));
    for (const basis of intradayBases) keys.push(intradayKind(basis));
    const summary = [
      [
        "Trading activity",
        countKnown
          ? pct(invested / countKnown, 1) + " of measured sessions"
          : "—",
      ],
      ["Peak active strategies", count(peakActive)],
      ["Peak held overnight", count(peakOvernight)],
      ...Array.from(peaks, ([basis, r]) => [
        "Peak " + marginKind(basis)[0].toLowerCase(),
        usd(r.marginUsd) + " · " + r.date,
      ]),
      ...(peakScenario ? [["Peak overnight margin scenario", usd(peakScenario.amount) + " · " + peakScenario.date]] : []),
      ["Peak margin load", pct(peakLoad, 1)],
    ];
    const source = [
      ["Session records", rows[0].date + " to " + rows.at(-1).date],
      [
        "Active counts recorded",
        count(countKnown) + " / " + count(rows.length),
      ],
      [
        "Historical USD requirements recorded or estimated",
        count(amountKnown) + " / " + count(rows.length),
      ],
      ["Sessions with timestamped intraday margin", count(intradaySessions) + " / " + count(rows.length)],
      ...(scenarioCloses ? [["Sessions with an overnight schedule scenario", count(scenarioCloses) + " / " + count(rows.length)]] : []),
    ];
    const dateControl =
      '<div class="session-picker"><button id="activity-prev" class="icon-button" aria-label="Previous trading day">‹</button>' +
      '<input id="activity-day" type="date" aria-label="Inspect trading day" min="' +
      rows[0].date +
      '" max="' +
      rows.at(-1).date +
      '">' +
      '<button id="activity-next" class="icon-button" aria-label="Next trading day">›</button></div>';
    const methodology = s.activity.metadata || {};
    const chartBody =
      legend(keys) +
      chart("activity-chart") +
      '<div class="chart-meta"><span>Scroll over the chart to zoom. Drag across dates to inspect a region. Click a date to pin its strategies and contracts.</span>' +
      '<div class="activity-zoom"><button class="small-button" id="activity-zoom-in" aria-label="Zoom in">+</button>' +
      '<button class="small-button" id="activity-zoom-out" aria-label="Zoom out">−</button>' +
      '<button class="small-button" id="activity-zoom-day">Selected session</button>' +
      '<button class="small-button" id="activity-zoom-reset">Reset zoom</button></div></div>' +
      '<div class="chart-caption" id="activity-zoom-range" role="status"></div>' +
      (!intradaySessions ? '<p class="chart-caption">Intraday margin is unavailable for these dates. An intraday line requires timestamped USD observations.</p>' : '') +
      (scenarioCloses || intradayBases.has("schedule_scenario") ?
        '<p class="chart-caption"><strong>Schedule scenario' + (methodology.schedule_observed ? ' · ' + escape(methodology.schedule_observed) : '') +
        '.</strong> ' + escape(methodology.intradayBasis || s.activity.description || "The source applies a hypothetical margin schedule to these positions.") + '</p>' : '');
    return (
      panel(
        "Daily strategy activity and overnight margin",
        "The upper chart counts active strategies. The lower chart compares intraday and closing capital requirements in US dollars.",
        chartBody,
        "",
        "standalone",
      ) +
      '<div class="grid-two">' +
      panel(
        "Inspect a trading day",
        "",
        '<div id="activity-reading"></div>',
        dateControl,
      ) +
      panel(
        "Capital requirements",
        "Peaks within the selected dates. Margin load uses matching USD equity.",
        statList(summary),
      ) +
      "</div>" +
      panel(
        "Session coverage",
        s.activity.source,
        statList(source) +
          [methodology.symbolBasis, methodology.positionQuantityBasis, methodology.sampling].filter(Boolean).map((note) =>
            '<p class="chart-caption">' + escape(note) + '</p>').join("") +
          '<p class="chart-caption">Counts use the supplied session dates. Missing dates and measurements appear as gaps.</p>',
        "",
        "standalone",
      ) +
      '<p class="chart-caption">An active strategy held a position at any time during the session. A strategy that closed its final position still counts as active that day.</p>'
    );
  }

  const $view = $("view");
  function showSidebar(open) {
    $("sidebar").classList.toggle("shown", open);
    $("scrim").hidden = !open;
    $("open-navigation").setAttribute("aria-expanded", String(open));
    syncNavAccess();
  }
  function syncNavAccess() {
    const collapse =
      window.matchMedia("(max-width:760px)").matches &&
      !$("sidebar").classList.contains("shown");
    $("sidebar").inert = collapse;
  }
  function wireChrome() {
    $("navigation").innerHTML = Object.entries(views)
      .map(
        ([id, [name, icon]]) =>
          (id === "compare" ? '<div class="nav-divider"></div>' : "") +
          `<button type="button" class="nav-link" data-view="${id}">${icons(icon)}<span>${escape(name)}</span></button>`,
      )
      .join("");
    $("dataset-name").textContent = doc.title;
    const nStrategies = all.filter((x) => x.kind === "strategy").length,
      nBooks = all.filter((x) => x.kind === "portfolio").length;
    $("dataset-count").textContent =
      [
        nBooks ? `${nBooks} portfolio${nBooks === 1 ? "" : "s"}` : "",
        nStrategies
          ? `${nStrategies} strateg${nStrategies === 1 ? "y" : "ies"}`
          : "",
      ]
        .filter(Boolean)
        .join(" · ") || `${all.length} histories`;
    document.title =
      doc.title === "Performance Atlas Dashboard"
        ? doc.title
        : doc.title + " · Performance Atlas Dashboard";
  }
  function setupSeriesPicker() {
    const select = $("series-select"), trigger = $("series-picker-trigger");
    const dialog = $("series-picker"), list = $("series-options"), label = $("series-label");
    if (typeof dialog.showModal !== "function") return;
    const compact = matchMedia("(max-width: 760px), (any-pointer: coarse)");

    function sync() {
      if (dialog.open) dialog.close();
      select.hidden = compact.matches;
      trigger.hidden = !compact.matches;
      label.htmlFor = compact.matches ? trigger.id : select.id;
      trigger.disabled = select.disabled || !select.options.length;
      $("series-picker-value").textContent = select.selectedOptions[0]?.label || "";
    }

    trigger.addEventListener("click", () => {
      const kind = byId.get(state.id).kind;
      $("series-picker-title").textContent = "Choose " + kind;
      const n = select.options.length;
      $("series-picker-count").textContent = n + " " + (n === 1 ? kind : sections[kind]);
      list.replaceChildren(...Array.from(select.options, (option) => {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.value = option.value;
        button.disabled = option.matches(":disabled");
        button.textContent = option.label;
        if (option.selected) {
          button.setAttribute("aria-current", "true");
          const mark = document.createElement("span");
          mark.setAttribute("aria-hidden", "true");
          mark.textContent = "✓";
          button.append(mark);
        }
        return button;
      }));
      dialog.showModal();
      trigger.setAttribute("aria-expanded", "true");
      const current = list.querySelector('[aria-current="true"]:enabled') || list.querySelector(":enabled");
      if (current) {
        current.focus({ preventScroll: true });
        list.scrollTop = current.offsetTop - (list.clientHeight - current.offsetHeight) / 2;
      }
    });

    // Keep native panning and momentum. Some mobile browsers deliver a complete
    // swipe to a modal without moving its overflowing list.
    let swipe = null;
    list.addEventListener("touchstart", (event) => {
      const touch = event.touches[0];
      swipe = event.touches.length === 1
        ? { id: touch.identifier, x: touch.clientX, y: touch.clientY, top: list.scrollTop }
        : null;
    }, { passive: true });
    list.addEventListener("touchcancel", () => { swipe = null; }, { passive: true });
    list.addEventListener("touchend", (event) => {
      const start = swipe, touch = event.changedTouches[0];
      swipe = null;
      if (!start || event.touches.length || touch.identifier !== start.id) return;
      const distance = start.y - touch.clientY;
      if (Math.abs(distance) < 20 || Math.abs(distance) <= Math.abs(start.x - touch.clientX)) return;
      requestAnimationFrame(() => {
        if (dialog.open && !swipe && Math.abs(list.scrollTop - start.top) < 1) {
          list.scrollTop = start.top + distance;
        }
      });
    }, { passive: true });

    list.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button || button.disabled) return;
      dialog.close();
      if (select.value !== button.dataset.value) {
        select.value = button.dataset.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    list.addEventListener("keydown", (event) => {
      if (!["Home", "End", "ArrowDown", "ArrowUp"].includes(event.key)) return;
      const buttons = Array.from(list.querySelectorAll("button:enabled"));
      const index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const last = buttons.length - 1;
      const next = { Home: 0, End: last, ArrowDown: Math.min(index + 1, last), ArrowUp: Math.max(index - 1, 0) };
      buttons[next[event.key]].focus();
    });
    $("series-picker-close").addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
      if (dialog.open) return;
      trigger.setAttribute("aria-expanded", "false");
      (compact.matches ? trigger : select).focus({ preventScroll: true });
    });
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right ||
          event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });

    // Hosted reports can replace the options or disable the selector while loading a book.
    new MutationObserver(sync).observe(select, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["disabled", "selected", "label"],
    });
    compact.addEventListener("change", sync);
    select.addEventListener("change", sync);
    sync();
  }

  function render() {
    const s = byId.get(state.id),
      title = viewTitle();
    document.querySelector("h1").textContent = title;
    $("breadcrumb").textContent = views[state.view][0];
    for (const b of $("navigation").querySelectorAll("[data-view]")) {
      b.hidden = b.dataset.view === "activity" && s.kind !== "portfolio";
      if (b.dataset.view === state.view) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    }
    const selectable = all.some((k) => k.kind !== "benchmark")
      ? ["portfolio", "strategy"]
      : ["benchmark"];
    $("scope").innerHTML = selectable
      .filter((kind) => all.some((k) => k.kind === kind))
      .map(
        (kind) =>
          `<button type="button" data-kind="${kind}" aria-pressed="${kind === s.kind}">${icons(kind === "portfolio" ? "portfolio" : "strategy")}${kinds[kind]}</button>`,
      )
      .join("");
    $("series-label").textContent = kinds[s.kind];
    $("series-select").innerHTML = all
      .filter((k) => k.kind === s.kind)
      .map(
        (k) =>
          `<option value="${escape(k.id)}" ${activeClass(k.id, s.id)}>${escape(k.name)}</option>`,
      )
      .join("");
    $("ranges").innerHTML = ["All", "5Y", "3Y", "1Y", "YTD", "Custom"]
      .map(
        (r) =>
          `<button type="button" data-range="${r}" ${r === "All" ? 'title="Full history"' : ""} aria-pressed="${state.range === r}">${r === "Custom" ? icons("calendar") : ""}${r}</button>`,
      )
      .join("");
    const context = [];
    if (s.assetClass) context.push(escape(s.assetClass));
    if (s.kind === "strategy" && s.family) context.push(escape(s.family));
    if (s.status)
      context.push(`<span class="context-status">${escape(s.status)}</span>`);
    $("series-context").innerHTML = context.length
      ? context.join('<span class="context-sep">·</span>')
      : escape(doc.description || s.name);
    $("footer-source").textContent = doc.title;
    $("note-decision").textContent =
      s.evidence?.type === "synthetic"
        ? "These simulated results demonstrate the reporting method."
        : s.status
          ? `The source classifies this series as ${s.status}.`
          : "This report describes the supplied history.";
    $("note-baseline").textContent =
      `${s.name}. ${periodText(s)}. ${s.accounting || "The opening mark sets the capital basis."}`;
    $("note-tests").textContent =
      s.evidence?.type === "synthetic"
        ? "The example uses simulated prices and trades. Research test results appear when a source supplies them."
        : "Open Evidence and methods for the recorded test results and input coverage.";
    $("note-limits").textContent =
      s.equity.at(-1) <= 0
        ? "Modeled capital reached zero or less. The history ends at the first such mark."
        : "Drawdown uses the supplied equity marks. The available marks determine which losses are visible.";
    plots = [];
    const opts = bounds(s),
      a = opts.start <= opts.end ? analyze(s) : { times: [] };
    const builders = {
      overview,
      drawdowns: drawdownView,
      rolling: rollingView,
      calendar: calendarView,
      trades: tradesView,
      explorer: explorerView,
      compare: compareView,
      evidence: evidenceView,
    };
    const message =
      a.times.length && s.equity.at(-1) <= 0 && opts.end >= s.times.at(-1)
        ? '<p class="notice">Modeled capital reached zero or less. The analysis stops at the first loss of funding.</p>'
        : "";
    if (state.view === "activity") $view.innerHTML = message + activityView(s);
    else if (opts.start > opts.end || (!a.times.length && state.view !== "explorer"))
      $view.innerHTML = empty(
        "No marks in this date range",
        "Select a date range inside the recorded history.",
      );
    else $view.innerHTML = message + builders[state.view](s, a);
    for (const draw of plots) draw();
    updateScorecard();
    glossary.refresh({ series: s });
    lastWidth = $view.clientWidth;
    $("export").disabled =
      state.view === "activity" ? !sessionRows(s).length : state.view === "calendar" ? !a.months.length : !a.times.length;
    $("export").title =
      state.view === "activity"
        ? "Download daily activity and USD requirements as CSV"
        : state.view === "calendar"
          ? "Download monthly returns and changes in equity as CSV"
        : state.view === "explorer"
          ? "Download all displayed measures and units as CSV"
          : "Download the selected equity and drawdown marks as CSV";
  }
  function changeSeries(id) {
    const s = byId.get(id);
    if (!s) return;
    state.id = id;
    if (state.view === "activity" && s.kind !== "portfolio")
      state.view = "overview";
    lastByKind.set(s.kind, id);
    state.peer = null;
    state.matrixIds = null;
    state.matrixOpen = false;
    if (
      state.range === "Custom" &&
      (state.to < s.times[0] || state.from > s.times.at(-1))
    )
      state.range = "All";
  }
  function navigate(view) {
    if (!Object.hasOwn(views, view)) return;
    if (view === "activity" && byId.get(state.id).kind !== "portfolio") view = "overview";
    state.view = view;
    if (location.hash !== "#" + view) history.replaceState(null, "", "#" + view);
    showSidebar(false);
    render();
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function openSettings() {
    const s = byId.get(state.id),
      limits = bounds(s);
    for (const id of ["date-from", "date-to"]) {
      $(id).min = iso(s.times[0]);
      $(id).max = iso(s.times.at(-1));
    }
    $("date-from").value = iso(limits.start);
    $("date-to").value = iso(limits.end);
    $("setting-months").value = String(state.months);
    $("setting-rf").value = String(Number((state.riskFree * 100).toFixed(6)));
    $("setting-target").value = String(Number((state.target * 100).toFixed(6)));
    $("settings-error").textContent = "";
    $("settings").showModal();
  }
  function exportData() {
    const s = byId.get(state.id),
      a = analyze(s);
    const measures = state.view === "explorer" ? explorerItems(s, a) : null;
    const sessions = state.view === "activity" ? sessionRows(s) : null;
    const months = state.view === "calendar" ? D.monthlyAmounts(s, a) : null;
    const rows = months
      ? [["month", "return_pct", "equity_change", "unit", "coverage", "opening_utc", "closing_utc"]]
      : sessions
      ? [
          [
            "session_date",
            "active_strategies",
            "held_overnight",
            "overnight_requirement_usd",
            "requirement_basis",
            "overnight_scenario_usd",
            "intraday_observations",
          ],
        ]
      : measures
        ? [["measure_id", "measure", "timestamp_utc", "value", "unit", "window_months"]]
        : [["timestamp_utc", "equity", "drawdown", "maximum_drawdown_to_date"]];
    if (months) {
      for (const m of months.months) {
        const month = `${m.year}-${String(m.month).padStart(2, "0")}`;
        rows.push([month, Number.isFinite(m.return) ? 100 * m.return : "", m.amount ?? "", months.unit,
          m.coverage, Number.isFinite(m.openingTime) ? new Date(m.openingTime).toISOString() : "",
          new Date(m.closingTime).toISOString()]);
      }
    } else if (sessions) {
      for (const r of sessions)
        rows.push([
          r.date,
          r.active ?? "",
          r.overnight ?? "",
          r.marginBasis === "schedule_scenario" ? "" : r.marginUsd ?? "",
          r.marginBasis ?? "",
          closingScenario(r) ?? "",
          (r.intradayMargin || []).filter((p) => Number.isFinite(p.marginUsd)).length,
        ]);
    } else if (measures) {
      for (const measure of measures) {
        const windowMonths = measure.id.startsWith("rolling-") ? state.months : "";
        for (let i = 0; i < measure.times.length; i++) {
          const v = measure.values[i];
          const value = Number.isFinite(v) ? (measure.unit === "%" ? 100 * v : v) : "";
          rows.push([measure.id, measure.name, new Date(measure.times[i]).toISOString(), value, measure.unit, windowMonths]);
        }
      }
    } else {
      for (let i = 0; i < a.times.length; i++)
        rows.push([
          new Date(a.times[i]).toISOString(),
          a.equity[i],
          a.drawdown[i],
          a.maxDrawdownPath[i],
        ]);
    }
    const csvField = (value) => {
      const field = String(value);
      return /[",\r\n]/.test(field) ? '"' + field.replaceAll('"', '""') + '"' : field;
    };
    const blob = new Blob(
      [rows.map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n"],
      { type: "text/csv;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download =
      (s.id.replace(/[^a-zA-Z0-9_-]+/g, "-") || "series") +
      (months ? "-monthly" : sessions ? "-activity" : measures ? "-measures" : "") +
      "-" +
      (sessions ? sessions[0].date : iso(a.times[0])) +
      "-" +
      (sessions ? sessions.at(-1).date : iso(a.times.at(-1))) +
      ".csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  document.addEventListener("click", (event) => {
    const b = event.target.closest("button");
    if (!b) return;
    if (b.dataset.view || b.dataset.jump) {
      navigate(b.dataset.view || b.dataset.jump);
      return;
    }
    if (b.dataset.kind) {
      const key = b.dataset.kind;
      const id = lastByKind.get(key) || all.find((s) => s.kind === key)?.id;
      changeSeries(id);
      render();
      return;
    }
    if (b.dataset.series) {
      changeSeries(b.dataset.series);
      navigate("overview");
      return;
    }
    if (b.dataset.range) {
      if (b.dataset.range === "Custom") openSettings();
      else {
        state.range = b.dataset.range;
        render();
      }
      return;
    }
    if (b.dataset.units) {
      state.units = b.dataset.units;
      render();
      return;
    }
    switch (b.id) {
      case "score-prev":
        score.page--;
        updateScorecard();
        break;
      case "score-next":
        score.page++;
        updateScorecard();
        break;
      case "open-navigation":
        showSidebar(true);
        $("sidebar").querySelector("button").focus();
        break;
      case "scrim":
        showSidebar(false);
        $("open-navigation").focus();
        break;
      case "open-settings":
        openSettings();
        break;
      case "export":
        exportData();
        break;
      case "defaults": {
        const s = byId.get(state.id);
        $("date-from").value = iso(s.times[0]);
        $("date-to").value = iso(s.times.at(-1));
        $("setting-rf").value = "0";
        $("setting-target").value = "0";
        $("setting-months").value = "6";
        break;
      }
      default:
        if (b.classList.contains("close-dialog")) $("settings").close();
    }
  });
  $("series-select").addEventListener("change", (event) => {
    changeSeries(event.target.value);
    render();
  });
  $view.addEventListener("input", (event) => {
    if (event.target.id === "score-filter") {
      score.filter = event.target.value;
      score.page = 0;
      updateScorecard();
    }
  });
  $view.addEventListener("change", (event) => {
    if (event.target.id === "score-sort") {
      score.sort = event.target.value;
      score.page = 0;
      updateScorecard();
      return;
    }
    const el = event.target;
    if (el.id === "rolling-window") {
      state.months = Number(el.value);
      render();
    } else if (el.id === "peer-select") {
      state.peer = el.value;
      render();
    }
  });
  $("settings-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const s = byId.get(state.id),
      limits = bounds(s);
    const start = $("date-from").valueAsNumber,
      end = $("date-to").valueAsNumber;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
      $("settings-error").textContent =
        "The start date must be on or before the end date.";
      return;
    }
    if (iso(start) === iso(s.times[0]) && iso(end) === iso(s.times.at(-1)))
      state.range = "All";
    else if (
      iso(start) !== iso(limits.start) ||
      iso(end) !== iso(limits.end) ||
      state.range === "Custom"
    ) {
      state.range = "Custom";
      state.from = start;
      state.to = end + DAY - 1;
    }
    state.months = Number($("setting-months").value);
    state.riskFree = Number($("setting-rf").value) / 100;
    state.target = Number($("setting-target").value) / 100;
    $("settings").close();
    render();
  });
  $("settings").addEventListener("click", (event) => {
    if (event.target !== $("settings")) return;
    const rect = $("settings").getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      $("settings").close();
  });
  document.querySelector(".brand").addEventListener("click", (event) => {
    event.preventDefault();
    navigate("overview");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && $("sidebar").classList.contains("shown")) {
      showSidebar(false);
      $("open-navigation").focus();
    }
  });
  window.addEventListener("resize", () => {
    syncNavAccess();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if ($view.clientWidth === lastWidth) return;
      lastWidth = $view.clientWidth;
      for (const draw of plots) draw();
    }, 100);
  });
  const glossary = window.PerformanceGlossary.mount({ report: doc });
  setupSeriesPicker();
  wireChrome();
  syncNavAccess();
  const linkedView = location.hash.slice(1);
  if (Object.hasOwn(views, linkedView)) navigate(linkedView);
  else render();
  window.addEventListener("hashchange", () => {
    const target = location.hash.slice(1);
    if (Object.hasOwn(views, target) && target !== state.view) navigate(target);
  });
})();
