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
    `<div class="chart-legend">${items.map(([label, color]) => `<span class="legend-item"><i class="legend-swatch" style="background:${color}"></i>${escape(label)}</span>`).join("")}</div>`;
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
  const chartColors = ["var(--brand)", "var(--gold)", "var(--loss)", "#5a78a1"];
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
        ["Worst to date", "var(--gold)"],
      ]) + chart(id),
      large ? "" : linkView("drawdowns", "Explore"),
    );
  }
  function kpis(s, a) {
    const m = a.summary;
    const row = (key, label, value, desc, cls = "") =>
      `<div class="kpi" data-metric="${key}"><div class="kpi-label">${escape(label)}</div><div class="kpi-value ${cls}">${escape(value)}</div><div class="kpi-foot">${escape(desc)}</div></div>`;
    return `<section aria-label="Performance summary" class="kpi-strip">${row("cagr", "Annual growth (CAGR)", pct(m.cagr, 2), "Annualized compound growth", valClass(m.cagr))}${row("maxDrawdown", "Maximum drawdown", pct(m.maxDrawdown, 2), "Worst peak-to-trough loss", m.maxDrawdown < 0 ? "negative" : "")}${row("sharpe", "Sharpe ratio", decimal(m.sharpe), "Excess return per unit of risk")}${row("totalReturn", "Total return", pct(m.totalReturn, 2, true), "Selected period", valClass(m.totalReturn))}</section>`;
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
        ["Gain", "var(--brand)"],
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
  function heatmap(a, compact = false) {
    let years = [...new Set(a.months.map((m) => m.year))].reverse();
    if (compact) years = years.slice(0, 4);
    if (!years.length)
      return empty(
        "No monthly returns",
        "Supply at least two dated equity marks.",
      );
    const months = new Map(
      a.months.map((m) => [m.year + "-" + m.month, m.return]),
    );
    let max = 0;
    for (const m of a.months)
      if (Number.isFinite(m.return)) max = Math.max(max, Math.abs(m.return));
    const cells = years
      .map(
        (y) =>
          `<tr><th scope="row">${y}</th>${monthNames
            .map((name, j) => {
              const v = months.get(y + "-" + (j + 1));
              if (!Number.isFinite(v))
                return '<td aria-label="No observation">·</td>';
              const color = v < 0 ? "var(--loss)" : "var(--brand)",
                strength =
                  v === 0
                    ? 0
                    : Math.round(15 + 55 * Math.sqrt(Math.abs(v) / (max || 1)));
              const title = `${name} ${y} · ${pct(v, 2, true)}`;
              return `<td data-tip="${title}" title="${title}" aria-label="${title}" tabindex="0" style="background:color-mix(in srgb, ${color} ${strength}%, var(--faint))">${compact ? (v === 0 ? "0" : v < 0 ? "−" : "+") : pct(v, 1)}</td>`;
            })
            .join("")}</tr>`,
      )
      .join("");
    return `<div class="heat-wrap"><table class="heat"><thead><tr><th scope="col">Year</th>${monthNames.map((m) => `<th scope="col" title="${m}">${compact ? m[0] : m}</th>`).join("")}</tr></thead><tbody>${cells}</tbody></table></div><div class="heat-scale"><span>Loss</span><i style="background:var(--loss)"></i><i style="background:var(--faint)"></i><i style="background:var(--brand)"></i><span>Gain</span></div>`;
  }
  function profile(a, s) {
    const m = a.summary,
      tails = D.tails(
        a.returns.values,
        Math.expm1(Math.log1p(state.target) / s.periodsPerYear),
      );
    const gain = m.endEquity - m.startEquity;
    return (
      sectionTitle("Performance statistics", periodText(s)) +
      `<div class="grid-three">` +
      panel(
        "Return and growth",
        "",
        statList([
          ["Total return", pct(m.totalReturn, 2)],
          ["Compound annual growth (CAGR)", pct(m.cagr, 2)],
          ["Mean full-year return", pct(m.meanYearReturn, 2)],
          ["Change in equity", cur(s, gain, 2)],
          ["Opening equity", cur(s, m.startEquity, 2)],
          ["Closing equity", cur(s, m.endEquity, 2)],
        ]),
      ) +
      panel(
        "Risk-adjusted returns",
        "",
        statList([
          ["Sharpe ratio", decimal(m.sharpe)],
          ["Sortino ratio", decimal(m.sortino)],
          ["Calmar ratio", decimal(m.calmar)],
          ["Recovery factor", decimal(m.recoveryFactor)],
          ["Annual volatility", pct(m.volatility, 2)],
          ["Annual downside deviation", pct(m.downside, 2)],
          ["Omega ratio", decimal(tails.omega)],
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
  function distribution(bins, id, formatter, negativeColors = false) {
    barPlot(
      id,
      bins.map((b, i) => ({
        label: `${formatter(b.lower)} to ${formatter(b.upper)}`,
        short: formatter((b.lower + b.upper) / 2),
        value: b.count,
        detail: `${count(b.count)} observations`,
        color: negativeColors && b.upper <= 0 ? "var(--loss)" : "var(--brand)",
      })),
      { title: "Distribution", height: 191, format: count, labelWidth: 63 },
    );
    return chart(id);
  }
  function overview(s, a) {
    return (
      kpis(s, a) +
      `<div class="grid-hero">${equityPanel(s, a)}${annualPanel(a, true)}</div><div class="grid-two">${drawdowns(s, a, "dd-preview", false)}${panel("Monthly returns", "Calendar-month performance at a glance.", heatmap(a, true), linkView("calendar", "Explore"))}</div>` +
      profile(a, s)
    );
  }

  function rollingControl() {
    return `<label class="settings-control">Window <select class="input-select" id="rolling-window">${[3, 6, 12, 24, 36].map((n) => `<option value="${n}" ${n === state.months ? "selected" : ""}>${n} months</option>`).join("")}</select></label>`;
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
    const rows = episodes.map((e) => [
      date(e.peak),
      date(e.trough),
      Number.isFinite(e.recovery) ? date(e.recovery) : "Open",
      signedCell(e.depth),
      count(e.days),
    ]);
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
        distribution(a.bins, "risk-distribution", (v) => pct(v, 1), true),
      )}</div>` +
      panel(
        "Drawdown episodes",
        "Deepest first. Duration runs from the peak to recovery or the last selected mark.",
        rows.length
          ? table(["Peak", "Trough", "Recovery", "Depth", "Days"], rows)
          : empty(
              "No drawdown episodes",
              "Selected marks show no decline from a previous high.",
            ),
        "",
        "standalone",
      )
    );
  }
  function rollingView(s, a) {
    return (
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
    const rows = [...a.years]
      .reverse()
      .map((y) => [
        String(y.year),
        y.complete ? "Full year" : "Partial",
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
          ["Full-period CAGR", pct(a.summary.cagr, 2)],
        ]),
      )}</div>` +
      panel(
        "Monthly return heatmap",
        "Each cell shows the change in equity across the observed month. A dot marks missing data.",
        heatmap(a),
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
  function tradesView(s, a) {
    const r = D.trades(s, bounds(s));
    const amount = (v) => cur(s, v, 2);
    const hasLedger = Array.isArray(s.trades);
    const n = hasLedger ? count(r.count) : "—";
    const why =
      r.reason || "Supply dated net profit or loss for each closed trade.";
    const summary = panel(
      "Closed trades",
      hasLedger
        ? "Trades that closed inside the selected dates."
        : "Dated trades are unavailable.",
      statList([
        ["Trades", n],
        [
          "Wins / losses / flat",
          hasLedger ? [r.wins, r.losses, r.flat].map(count).join(" / ") : "—",
        ],
        ["Win rate", pct(r.winRate, 2)],
        ["Profit factor", decimal(r.profitFactor)],
        ["Expectancy per trade", amount(r.expectancy)],
        ["Average win / loss", amount(r.avgWin) + " / " + amount(r.avgLoss)],
      ]),
    );
    const sizes = panel(
      "Trade outcomes",
      "Realized profit or loss per closed trade.",
      r.bins.length
        ? distribution(r.bins, "trade-hist", (v) => decimal(v, 0), true)
        : empty("Trade distribution unavailable", why),
    );
    const sides = Object.entries(r.bySide || {}).map(([side, v]) => [
      escape(niceKey(side)),
      count(v.count),
      pct(v.winRate),
      amount(v.pnl),
    ]);
    const closed = (s.trades || []).filter(
      (t) =>
        Number.isFinite(t.holdingHours) &&
        t.time >= bounds(s).start &&
        t.time <= bounds(s).end,
    );
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
      "fees",
      "slippage",
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
    return (
      (s.evidence?.tradeCoverage === "partial"
        ? `<p class="notice">${escape(r.reason)}</p>`
        : "") +
      `<div class="grid-hero">${sizes}${summary}</div><div class="grid-two">` +
      panel(
        "Trade quality",
        "Calculated from the dated ledger.",
        statList([
          ["Average win / |average loss|", decimal(r.payoff)],
          ["Largest gain / loss", amount(r.best) + " / " + amount(r.worst)],
          [
            "Longest winning / losing streak",
            hasLedger ? count(r.winStreak) + " / " + count(r.lossStreak) : "—",
          ],
          [
            "Mean holding time",
            Number.isFinite(r.meanHoldingHours)
              ? decimal(r.meanHoldingHours, 1) + " hours"
              : "—",
          ],
        ]) +
          (sides.length
            ? table(["Side", "Trades", "Win rate", "Net P&L"], sides)
            : ""),
      ) +
      durations +
      "</div>" +
      `<div class="grid-two">${panel("Execution costs", "Source totals for the full history.", costRows.length ? statList(costRows) : empty("Cost breakdown unavailable", "Supply recorded cost amounts and their currency."))}${panel("Source trade summary", "Full source history. Date filters apply to the dated ledger above.", sourceRecords(s.tradeSummary, "source trade summary"))}</div>` +
      panel(
        "Cost assumptions",
        "",
        `<p class="evidence-text">${escape(s.costModel || "The source did not document its cost model.")}</p>`,
        "",
        "standalone",
      )
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
  function matrixPanel(s) {
    const allMembers =
      s.kind === "portfolio" && s.holdings?.length
        ? new Set(s.holdings.filter((h) => h.weight !== 0).map((h) => h.id))
        : null;
    const list = all.filter(
      (k) => k.kind === "strategy" && (!allMembers || allMembers.has(k.id)),
    );
    if (list.length < 2)
      return panel(
        "Strategy correlations",
        "",
        empty(
          "Two strategy histories are required",
          "Supply overlapping strategy return histories.",
        ),
        "",
        "standalone",
      );
    const chosen = state.matrixIds ?? list.slice(0, 6).map((k) => k.id);
    const matrix = D.correlationMatrix(all, {
      ...options(s),
      ids: chosen,
      portfolio: allMembers ? s : undefined,
    });
    const picker = `<details class="picker" ${state.matrixOpen ? "open" : ""}><summary>Choose strategies (${chosen.length})</summary><div class="checkbox-list">${list.map((k) => `<label><input type="checkbox" data-matrix="${escape(k.id)}" ${chosen.includes(k.id) ? "checked" : chosen.length >= 12 ? "disabled" : ""}> ${escape(k.name)}</label>`).join("")}</div></details>`;
    const rows = matrix.values.map((row, i) => [
      escape(matrix.names[i]),
      ...row.map((v, j) => {
        if (!Number.isFinite(v))
          return `<span title="${count(matrix.counts[i][j])} matched intervals">—</span>`;
        const color = v < 0 ? "var(--gold)" : "var(--brand)";
        return `<span class="corr-value" title="${count(matrix.counts[i][j])} matched intervals" style="background:color-mix(in srgb, ${color} ${Math.round(8 + 34 * Math.abs(v))}%, var(--panel))">${decimal(v)}</span>`;
      }),
    ]);
    return panel(
      "Strategy correlations",
      "Pairwise correlation over matching intervals. Select up to 12 strategies.",
      picker +
        (matrix.ids.length
          ? table(["Strategy", ...matrix.names], rows)
          : empty(
              "No strategies selected",
              "Choose strategies above to build the matrix.",
            )),
      "",
      "standalone",
    );
  }
  function portfolioDetails(s) {
    if (s.kind !== "portfolio") return "";
    const result = D.attribution(s, all, options(s));
    const rows = result.rows.map((v) => [
      byId.has(v.id)
        ? `<button class="dir-button" type="button" data-series="${escape(v.id)}">${escape(v.name)}</button>`
        : escape(v.name),
      signedCell(v.returnContribution),
      pct(v.riskShare, 2, true),
    ]);
    return `<div class="grid-two">${panel("Construction weights", s.evidence?.holdingsBasis || "Source weight snapshot for the full report.", weightComposition(s))}${panel("Portfolio attribution", "Return contributions add to portfolio growth. Risk shares measure contributions to return variance.", rows.length ? table(["Strategy", "Return contribution", "Risk share"], rows) : empty("Attribution unavailable", result.reason || "Supply reconciled funded sleeve histories."))}</div>`;
  }
  function peerPanel(s) {
    const peers = all.filter((k) => k.id !== s.id);
    if (!peers.length)
      return panel(
        "Compare series",
        "",
        empty(
          "No comparison series",
          "Supply a benchmark or another strategy or portfolio.",
        ),
        "",
        "standalone",
      );
    const b =
      byId.get(state.peer) ||
      byId.get(s.benchmarkId) ||
      peers.find((k) => k.kind === "benchmark") ||
      peers[0];
    const opts = options(s);
    const choices = `<div class="toolbar"><label>Comparison series <select class="input-select" id="peer-select">${peers.map((k) => `<option value="${escape(k.id)}" ${activeClass(k.id, b.id)}>${escape(k.name)} · ${kinds[k.kind]}</option>`).join("")}</select></label></div>`;
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
            pct(a.summary.cagr, 2),
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
    if (s.currency !== b.currency)
      comparison += `<p class="chart-caption">Each index uses its source currency (${escape(s.currency)} and ${escape(b.currency)}).</p>`;
    const stats = statList([
      ["Matched return intervals", count(rel.count)],
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
  function scorecardPanel() {
    if (!all.some((x) => x.kind === "strategy")) return "";
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
      "Each row uses the recorded history within the selected dates. Select a name to open its charts.",
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
        pct(m.cagr, 2),
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
      peerPanel(s) + scorecardPanel() + portfolioDetails(s) + matrixPanel(s)
    );
  }
  function evidenceView(s, a) {
    const e = s.evidence || {},
      rows = D.evidenceCoverage(s);
    const coverage = table(
      ["Data", "Availability", "Scope and input requirements"],
      rows.map((row) => [
        escape(row.label || niceKey(row.id)),
        row.available ? "Recorded" : "Unavailable",
        escape(
          row.available
            ? row.scope === "source"
              ? "Full source history"
              : "Dated observations"
            : (row.missing || []).join(", ") ||
                row.reason ||
                "The source did not supply this input.",
        ),
      ]),
    );
    let maxGap = 0;
    for (let i = 1; i < a.times.length; i++)
      maxGap = Math.max(maxGap, a.times[i] - a.times[i - 1]);
    const seen = Object.entries(e).filter(
      ([k]) => !["results", "holdingsBasis", "attribution"].includes(k),
    );
    const sourceData = seen.length
      ? sourceRecords(Object.fromEntries(seen), "research evidence")
      : "";
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
      records = Object.entries(records || {}).flatMap(([family, res]) =>
        (Array.isArray(res) ? res : [res]).map((v) => ({ ...v, family })),
      );
    const tests = Object.entries(families).flatMap(([id, label]) => {
      const results = records.filter((r) => r && r.family === id);
      if (!results.length) return [[label, "No result supplied", "—"]];
      return results.map((r) => [
        label,
        escape(niceKey(r.status || "Unknown")),
        escape(r.reason || r.description || r.summary || "See source evidence"),
      ]);
    });
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
          ["History", date(s.times[0]) + " – " + date(s.times.at(-1))],
          ["Evidence status", s.status || "Unspecified"],
        ]) +
          `<p class="explain">${escape(s.source || "Source identity was not supplied.")}</p>${noteList}`,
      )}${panel(
        "Measurement basis",
        "Selected analysis window.",
        statList([
          ["Equity marks", count(a.times.length)],
          ["Valid return observations", count(a.meta.validReturns)],
          ["Missing intervals", count(a.meta.gaps.length)],
          [
            "Possible holiday intervals",
            count(a.meta.possibleHolidayIntervals),
          ],
          ["Largest mark gap", decimal(maxGap / DAY, 1) + " days"],
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
        "Data coverage",
        "Missing observations and optional inputs stay visible.",
        coverage,
        "",
        "standalone",
      ) +
      panel(
        "Research tests",
        "Reported test status comes from the source record.",
        table(["Test family", "Status", "Source finding"], tests),
        "",
        "standalone",
      ) +
      (seen.length || s.sourceMetrics
        ? `<div class="grid-two">${panel("Research evidence", "Full source history.", sourceData || empty("Research evidence unavailable", "Supply run settings, source identities and test records."))}${panel("Source statistics", "The source may use a different return or annualization convention.", sourceRecords(s.sourceMetrics, "source statistics"))}</div>`
        : "") +
      panel(
        "Calculation conventions",
        "",
        `<dl class="definitions">${Object.entries(M.conventions)
          .map(
            ([key, value]) =>
              `<div><dt>${escape(niceKey(key))}</dt><dd>${escape(value)}</dd></div>`,
          )
          .join("")}</dl>`,
        "",
        "standalone",
      ) +
      panel(
        "Metric definitions",
        "",
        `<dl class="definitions">${methods.map(([k, v]) => `<div><dt>${escape(k)}</dt><dd>${escape(v)}</dd></div>`).join("")}</dl>`,
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
  function explorerView(s, a) {
    const items = explorerItems(s, a),
      selected = items.find((m) => m.id === state.explore) || items[0];
    const fmt = (v) =>
      selected.unit === "%"
        ? pct(v, 2)
        : Number.isFinite(v)
          ? decimal(v, 2) +
            (selected.unit === "ratio" || selected.unit === "number"
              ? ""
              : " " + selected.unit)
          : "—";
    const controls = `<div class="toolbar"><label>Measure <select id="explorer-metric" class="input-select">${items.map((m) => `<option value="${escape(m.id)}" ${activeClass(m.id, selected.id)}>${escape(m.name)}</option>`).join("")}</select></label>${rollingControl()}</div>`;
    const values = selected.values.filter(Number.isFinite);
    let min = Infinity,
      max = -Infinity,
      total = 0;
    for (const v of values) {
      min = Math.min(min, v);
      max = Math.max(max, v);
      total += v;
    }
    const bins = [];
    if (values.length) {
      const n =
          min === max
            ? 1
            : Math.min(30, Math.ceil(Math.log2(values.length) + 1)),
        step = (max - min) / n;
      for (let i = 0; i < n; i++)
        bins.push({
          lower: min + i * step,
          upper: i === n - 1 ? max : min + (i + 1) * step,
          count: 0,
        });
      for (const v of values) {
        const bucket =
          min === max
            ? 0
            : Math.max(0, Math.min(n - 1, Math.floor((v - min) / step)));
        bins[bucket].count++;
      }
    }
    linePlot(
      "explorer-chart",
      [
        {
          times: selected.times,
          values: selected.values,
          label: selected.name,
        },
      ],
      { title: selected.name, format: fmt, detailFormat: fmt, height: 229 },
    );
    return (
      controls +
      `<div class="grid-hero">${panel(selected.name, selected.description, chart("explorer-chart"))}${panel(
        "Observation summary",
        "Selected dates and source units.",
        statList([
          ["Latest recorded value", fmt(values.at(-1))],
          ["Lowest value", fmt(min)],
          ["Highest value", fmt(max)],
          [
            "Mean observation",
            values.length ? fmt(total / values.length) : "—",
          ],
          ["Recorded observations", count(values.length)],
          ["Missing values", count(selected.values.length - values.length)],
        ]),
      )}</div>` +
      panel(
        "Distribution of observations",
        "Count of recorded values in each interval.",
        distribution(bins, "explorer-distribution", fmt),
        "",
        "standalone",
      )
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
      doc.title === "Performance Atlas"
        ? doc.title
        : doc.title + " · Performance Atlas";
  }
  function render() {
    const s = byId.get(state.id),
      title = viewTitle();
    document.querySelector("h1").textContent = title;
    $("breadcrumb").textContent = views[state.view][0];
    for (const b of $("navigation").querySelectorAll("[data-view]")) {
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
    if (!a.times.length || opts.start > opts.end)
      $view.innerHTML = empty(
        "No marks in this date range",
        "Select a date range inside the recorded history.",
      );
    else $view.innerHTML = message + builders[state.view](s, a);
    for (const draw of plots) draw();
    updateScorecard();
    lastWidth = $view.clientWidth;
    $("export").disabled = !a.times.length;
    $("export").title =
      state.view === "explorer"
        ? "Download the selected metric as CSV"
        : "Download the selected equity and drawdown marks as CSV";
  }
  function changeSeries(id) {
    const s = byId.get(id);
    if (!s) return;
    state.id = id;
    state.explore = null;
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
    if (!views[view]) return;
    state.view = view;
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
    const metric =
      state.view === "explorer"
        ? explorerItems(s, a).find((m) => m.id === state.explore) ||
          explorerItems(s, a)[0]
        : null;
    const rows = metric
      ? [["timestamp_utc", "value"]]
      : [["timestamp_utc", "equity", "drawdown", "maximum_drawdown_to_date"]];
    if (metric) {
      for (let i = 0; i < metric.times.length; i++)
        rows.push([
          new Date(metric.times[i]).toISOString(),
          metric.values[i] ?? "",
        ]);
    } else {
      for (let i = 0; i < a.times.length; i++)
        rows.push([
          new Date(a.times[i]).toISOString(),
          a.equity[i],
          a.drawdown[i],
          a.maxDrawdownPath[i],
        ]);
    }
    const blob = new Blob(
      [rows.map((row) => row.join(",")).join("\r\n") + "\r\n"],
      { type: "text/csv;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download =
      (s.id.replace(/[^a-zA-Z0-9_-]+/g, "-") || "series") +
      (metric ? "-" + metric.id : "") +
      "-" +
      iso(a.times[0]) +
      "-" +
      iso(a.times.at(-1)) +
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
    if (el.id === "explorer-metric") {
      state.explore = el.value;
      render();
    } else if (el.id === "rolling-window") {
      state.months = Number(el.value);
      render();
    } else if (el.id === "peer-select") {
      state.peer = el.value;
      render();
    } else if (el.hasAttribute("data-matrix")) {
      state.matrixIds = Array.from(
        $view.querySelectorAll("[data-matrix]:checked"),
        (node) => node.dataset.matrix,
      );
      state.matrixOpen = true;
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
  wireChrome();
  syncNavAccess();
  render();
})();
