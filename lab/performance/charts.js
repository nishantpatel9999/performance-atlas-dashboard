/* Offline SVG charts. Statistics and pointer values use the original observations. */
(() => {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const DAY = 86400000;
  const primary = "var(--brand)";
  const axisFormat = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
  const dateFormat = new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  let chartId = 0;

  function svgElement(name, attributes, text) {
    const element = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attributes))
      element.setAttribute(key, value);
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function frame(host, title, height, left) {
    const width = Math.max(160, Math.round(host.getBoundingClientRect().width));
    const svg = svgElement("svg", {
      viewBox: "0 0 " + width + " " + height,
      role: "img",
      "aria-label": title,
    });
    svg.append(svgElement("title", {}, title));
    host.replaceChildren(svg);
    return {
      svg,
      width,
      height,
      left,
      right: width - 12,
      top: 13,
      bottom: height - 26,
    };
  }
  function empty(host, reason) {
    const box = document.createElement("div");
    box.className = "empty";
    box.textContent = reason;
    host.replaceChildren(box);
  }
  function bounds(min, max, zero) {
    if (zero) {
      min = Math.min(min, 0);
      max = Math.max(max, 0);
    }
    const span = max - min || Math.abs(max) * 0.15 || 0.02;
    const rough = span / 4;
    const power = Math.pow(10, Math.floor(Math.log10(rough)));
    const step = [1, 2, 2.5, 5, 10].find((n) => n * power >= rough) * power;
    const lo = Math.floor(min / step) * step;
    let hi = Math.ceil(max / step) * step;
    if (hi <= lo) hi = lo + step;
    const ticks = [];
    for (let i = 0; lo + i * step <= hi + step * 0.01 && i < 12; i++)
      ticks.push(lo + i * step);
    return { lo, hi, ticks };
  }
  function grid(f, scale, format) {
    const project = scale.project || ((value) => value);
    const ceiling = project(scale.hi);
    const span = ceiling - project(scale.lo);
    const y = (value) =>
      f.top + ((ceiling - project(value)) / span) * (f.bottom - f.top);
    for (const tick of scale.ticks) {
      const pos = y(tick);
      f.svg.append(
        svgElement("line", {
          x1: f.left,
          x2: f.right,
          y1: pos,
          y2: pos,
          stroke: "var(--grid)",
          "stroke-dasharray": tick ? "3 4" : "none",
        }),
      );
      f.svg.append(
        svgElement(
          "text",
          { x: f.left - 8, y: pos + 3, "text-anchor": "end" },
          format(tick),
        ),
      );
    }
    return y;
  }
  function timeTicks(f, min, max, x) {
    const span = (max - min) / DAY;
    const count = Math.max(2, Math.min(7, Math.floor((f.right - f.left) / 73)));
    const opts =
      span < 2
        ? { hour: "2-digit", minute: "2-digit", hour12: false }
        : span < 120
          ? { month: "short", day: "numeric" }
          : { month: "short", year: "2-digit" };
    const formatter = new Intl.DateTimeFormat("en-GB", {
      ...opts,
      timeZone: "UTC",
    });
    for (let i = 0; i < count; i++) {
      const t = min + ((max - min) * i) / (count - 1);
      f.svg.append(
        svgElement(
          "text",
          {
            x: x(t),
            y: f.height - 5,
            "text-anchor":
              i === 0 ? "start" : i === count - 1 ? "end" : "middle",
          },
          formatter.format(t),
        ),
      );
    }
  }

  // Retain both extrema in every horizontal pixel bucket and the endpoints of each run.
  function runs(times, values, x, gapLimit) {
    const result = [];
    let run = [],
      bucket = -Infinity,
      first = 0,
      last = 0,
      low = 0,
      high = 0,
      active = false;
    function flush() {
      if (!active) return;
      const indices = Array.from(new Set([first, low, high, last])).sort(
        (a, b) => a - b,
      );
      run.push(...indices);
      active = false;
    }
    function endRun() {
      flush();
      if (run.length) result.push(run);
      run = [];
    }
    for (let i = 0; i < values.length; i++) {
      if (!Number.isFinite(values[i])) {
        endRun();
        continue;
      }
      if (i > 0 && gapLimit && times[i] - times[i - 1] > gapLimit) endRun();
      const column = Math.floor(x(times[i]));
      if (!active || column !== bucket) {
        flush();
        first = last = low = high = i;
        bucket = column;
        active = true;
      } else {
        last = i;
        if (values[i] < values[low]) low = i;
        if (values[i] > values[high]) high = i;
      }
    }
    endRun();
    return result;
  }
  function nearest(times, t) {
    let lo = 0,
      hi = times.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (times[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && t - times[lo - 1] < times[lo] - t ? lo - 1 : lo;
  }
  function tooltip(host, f) {
    const tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.hidden = true;
    host.append(tip);
    function show(x, heading, rows) {
      const title = document.createElement("strong");
      title.textContent = heading;
      tip.replaceChildren(title);
      for (const row of rows) {
        const line = document.createElement("span");
        line.textContent = row;
        tip.append(line);
      }
      tip.hidden = false;
      tip.style.left =
        Math.max(2, Math.min(f.width - tip.offsetWidth - 2, x + 10)) + "px";
      tip.style.top = "8px";
    }
    return {
      show,
      hide: () => {
        tip.hidden = true;
      },
    };
  }
  function line(host, series, options = {}) {
    if (!host) return;
    const format = options.format || ((n) => axisFormat.format(n));
    const seriesWithData = series.filter(
      (s) => s.times.length && s.values.some(Number.isFinite),
    );
    if (!seriesWithData.length) {
      empty(
        host,
        options.empty || "This period has too few observations for this chart.",
      );
      return;
    }
    let tMin = Infinity,
      tMax = -Infinity,
      vMin = Infinity,
      vMax = -Infinity;
    for (const item of seriesWithData) {
      tMin = Math.min(tMin, item.times[0]);
      tMax = Math.max(tMax, item.times.at(-1));
      for (const v of item.values)
        if (Number.isFinite(v)) {
          vMin = Math.min(vMin, v);
          vMax = Math.max(vMax, v);
        }
    }
    const scale = bounds(vMin, vMax, options.zero);
    const labelWidth =
      Math.max(...scale.ticks.map((v) => format(v).length)) * 6.2 + 10;
    const f = frame(
      host,
      options.title || "Time series",
      options.height || 235,
      Math.max(30, Math.min(83, labelWidth)),
    );
    const x = (t) =>
      f.left + ((t - tMin) / (tMax - tMin || 1)) * (f.right - f.left);
    const y = grid(f, scale, format);
    timeTicks(f, tMin, tMax, x);
    for (const s of seriesWithData) {
      const color = s.color || primary;
      let gradient;
      if (s.area) {
        const id = "area-" + ++chartId;
        gradient = svgElement("linearGradient", {
          id,
          x1: "0",
          x2: "0",
          y1: "0",
          y2: "1",
        });
        gradient.append(
          svgElement("stop", {
            offset: "0%",
            "stop-color": color,
            "stop-opacity": s.area === "under" ? 0.04 : 0.21,
          }),
          svgElement("stop", {
            offset: "100%",
            "stop-color": color,
            "stop-opacity": s.area === "under" ? 0.24 : 0.025,
          }),
        );
        const defs = svgElement("defs", {});
        defs.append(gradient);
        f.svg.append(defs);
      }
      for (const run of runs(
        s.times,
        s.values,
        x,
        s.gapLimit || options.gapLimit,
      )) {
        const path = run
          .map(
            (i, j) =>
              (j === 0 ? "M" : "L") +
              x(s.times[i]).toFixed(2) +
              "," +
              y(s.values[i]).toFixed(2),
          )
          .join(" ");
        if (s.area) {
          const base = s.area === "under" ? y(0) : f.bottom;
          const area =
            path +
            " L" +
            x(s.times[run.at(-1)]).toFixed(2) +
            "," +
            base +
            " L" +
            x(s.times[run[0]]).toFixed(2) +
            "," +
            base +
            " Z";
          f.svg.append(
            svgElement("path", { d: area, fill: "url(#" + gradient.id + ")" }),
          );
        }
        if (run.length === 1)
          f.svg.append(
            svgElement("circle", {
              cx: x(s.times[run[0]]),
              cy: y(s.values[run[0]]),
              r: 2,
              fill: color,
            }),
          );
        else
          f.svg.append(
            svgElement("path", {
              d: path,
              fill: "none",
              stroke: color,
              "stroke-width": s.width || 1.9,
              "stroke-linejoin": "round",
              "stroke-linecap": "round",
              "stroke-dasharray": s.dash || "none",
            }),
          );
      }
    }
    const times = seriesWithData[0].times;
    inspectTime(
      host,
      f,
      times,
      x,
      options.title || "Time series",
      (t) => {
        const rows = [];
        for (const item of seriesWithData) {
          const j = nearest(item.times, t);
          if (item.times[j] === t) {
            const value = item.values[j];
            rows.push(
              item.label +
                "  " +
                (Number.isFinite(value)
                  ? (options.detailFormat || format)(value)
                  : "—"),
            );
          }
        }
        return rows;
      },
      tMin,
      tMax,
    );
  }

  function inspectTime(
    host,
    f,
    times,
    x,
    title,
    describe,
    min,
    max,
    sparse = false,
  ) {
    const tip = tooltip(host, f);
    const cursor = svgElement("line", {
      y1: f.top,
      y2: f.bottom,
      class: "crosshair",
      visibility: "hidden",
    });
    f.svg.append(cursor);
    host.tabIndex = 0;
    host.setAttribute(
      "aria-label",
      title + ". Use left and right arrow keys to inspect points.",
    );
    let index = times.length - 1;
    function showAt(i) {
      index = Math.max(0, Math.min(times.length - 1, i));
      const t = times[index],
        pos = x(t);
      cursor.setAttribute("visibility", "visible");
      cursor.setAttribute("x1", pos);
      cursor.setAttribute("x2", pos);
      const intraday =
        index > 0 && Math.floor(t / DAY) === Math.floor(times[index - 1] / DAY);
      const stamp =
        dateFormat.format(t) +
        (intraday
          ? " · " + new Date(t).toISOString().slice(11, 16) + " UTC"
          : "");
      tip.show(pos, stamp, describe(t, index));
    }
    function hide() {
      tip.hide();
      cursor.setAttribute("visibility", "hidden");
    }
    function point(e) {
      const pos = e.clientX - host.getBoundingClientRect().left;
      const t = min + ((pos - f.left) / (f.right - f.left)) * (max - min);
      const i = nearest(times, t);
      if (
        sparse &&
        Math.abs(x(times[i]) - pos) > 9 &&
        Math.abs(times[i] - t) > DAY / 2
      )
        hide();
      else showAt(i);
    }
    host.onpointermove = point;
    host.onpointerdown = point;
    host.onpointerleave = (e) => {
      if (e.pointerType !== "touch") hide();
    };
    host.onblur = hide;
    host.onkeydown = (e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(e.key))
        return;
      e.preventDefault();
      if (e.key === "Escape") hide();
      else
        showAt(
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? times.length - 1
              : index + (e.key === "ArrowLeft" ? -1 : 1),
        );
    };
    return { showAt, hide };
  }

  // Session labels identify the trading day. Only a supplied clock identifies a close instant.
  function activity(host, rows, labels) {
    if (!host || !rows.length) return;
    const title = "Strategy counts and intraday and overnight margin in US dollars";
    const f = frame(host, title, 352, 56);
    const plot = svgElement("g", {});
    f.svg.append(plot);
    const dollars = new Intl.NumberFormat("en-US", {style: "currency", currency: "USD",
      notation: "compact", maximumFractionDigits: 1});
    const amount = new Intl.NumberFormat("en-US", {style: "currency", currency: "USD"});
    const dayStart = iso => Date.parse(iso + "T00:00:00Z");
    function clock(value) {
      if (typeof value === "string" && /T.*(?:Z|[+-]\d\d:\d\d)$/i.test(value)) value = Date.parse(value);
      return Number.isSafeInteger(value) ? value : null;
    }

    const segments = [], sessions = [], margins = [], keyboard = [];
    const tracks = new Map();
    function append(track, basis, at, value, continuous) {
      const key = track + ":" + basis;
      let line = tracks.get(key);
      if (!continuous || !line) {
        line = {track, basis, times: [], values: []};
        tracks.set(key, line);
        segments.push(line);
      }
      line.times.push(at);
      line.values.push(value);
    }
    let first = dayStart(labels.range?.from || rows[0].date);
    let last = dayStart(labels.range?.to || rows.at(-1).date) + DAY - 1;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i], day = dayStart(row.date), close = clock(row.closeTime);
      const session = {row, i, kind: "session", at: close ?? day + DAY - 1, time: close,
        first: day, last: day + DAY - 1, closes: new Map()};
      const prior = sessions.at(-1);
      const adjacent = prior && day === dayStart(prior.row.date) + DAY && prior.at < session.at;
      for (const [key, track] of [["active", "active"], ["overnight", "held"]]) {
        if (!Number.isFinite(row[key])) continue;
        append(track, "", session.at, row[key], adjacent && Number.isFinite(prior.row[key]));
      }
      if (Number.isFinite(row.marginUsd)) session.closes.set(row.marginBasis, row.marginUsd);
      if (Number.isFinite(row.overnightScenarioUsd)) session.closes.set("schedule_scenario", row.overnightScenarioUsd);
      for (const [basis, value] of session.closes) {
        append("margin", basis, session.at, value, adjacent && prior.closes.has(basis));
        const point = {row, i, kind: "overnight", at: session.at, time: close, value, basis};
        session.close ??= point;
        margins.push(point);
        keyboard.push(point);
      }
      if (!session.close) keyboard.push(session);
      let previous = null;
      for (const source of row.intradayMargin || []) {
        const time = clock(source.time);
        if (time !== null) {
          session.first = Math.min(session.first, time);
          session.last = Math.max(session.last, time);
        }
        if (time === null || !Number.isFinite(source.marginUsd)) {
          previous = null;
          continue;
        }
        const point = {row, i, kind: "intraday", at: time, time, value: source.marginUsd,
          basis: source.marginBasis, source};
        append("intraday", point.basis, time, point.value,
          previous !== null && previous.at < time && previous.basis === point.basis);
        previous = point;
        margins.push(point);
        keyboard.push(point);
      }
      session.first = Math.min(session.first, session.at);
      session.last = Math.max(session.last, session.at);
      first = Math.min(first, session.first);
      last = Math.max(last, session.last);
      sessions.push(session);
    }
    const byTime = (a, b) => a.at - b.at;
    margins.sort(byTime);
    keyboard.sort(byTime);
    const countsByTime = [...sessions].sort(byTime);
    function draw(from, to) {
      plot.replaceChildren();
      const x = t => f.left + (t - from) / (to - from) * (f.right - f.left);
      const inView = p => p.at >= from && p.at <= to;
      const countRows = countsByTime.filter(inView), amounts = margins.filter(inView);
      const countScale = {lo: 0, hi: 1, ticks: [0, 1]};
      let maxCount = 0, maxAmount = 0;
      const hasCounts = countRows.some(p => Number.isFinite(p.row.active) || Number.isFinite(p.row.overnight));
      for (const p of countRows) maxCount = Math.max(maxCount, p.row.active || 0, p.row.overnight || 0);
      for (const p of amounts) maxAmount = Math.max(maxAmount, p.value);
      const step = Math.max(1, Math.ceil(maxCount / 4));
      countScale.hi = Math.max(1, Math.ceil(maxCount / step)) * step;
      countScale.ticks = Array.from({length: countScale.hi / step + 1}, (_, i) => i * step);
      function axis(top, bottom, heading, scale, format, emptyText) {
        plot.append(svgElement("text", {x: f.left, y: top - 12, class: "track-title"}, heading));
        if (scale) return grid({...f, svg: plot, top, bottom}, scale, format);
        plot.append(svgElement("text", {x: (f.left + f.right) / 2, y: (top + bottom) / 2,
          "text-anchor": "middle"}, emptyText));
        return null;
      }
      const cy = axis(30, 132, "Strategies", hasCounts && countScale, String, "No strategy counts recorded");
      const my = axis(183, 317, "Intraday and overnight margin · USD",
        amounts.length && bounds(0, maxAmount || 1, true), n => dollars.format(n), "No margin recorded");
      const paths = new Map();
      for (const {track, basis, times, values} of segments) {
        if (times.at(-1) < from || times[0] > to) continue;
        const counts = track === "active" || track === "held";
        const y = counts ? cy : my;
        if (!y) continue;
        const key = track + ":" + basis;
        if (!paths.has(key)) paths.set(key, {track, basis, strokes: []});
        const strokes = paths.get(key).strokes;
        // Decimate only the displayed geometry. Inspection and peaks use every source observation.
        const a = times[0] >= from ? 0 : times.findIndex(t => t >= from);
        const b = times.at(-1) <= to ? times.length : times.findIndex(t => t > to);
        const visibleTimes = times.slice(a, b), visibleValues = values.slice(a, b);
        for (const run of runs(visibleTimes, visibleValues, x)) {
          let d = "";
          for (const i of run) {
            const px = x(visibleTimes[i]).toFixed(2), py = y(visibleValues[i]).toFixed(2);
            d += !d ? "M" + px + "," + py : counts ? "H" + px + "V" + py : "L" + px + "," + py;
          }
          strokes.push(run.length === 1 ? d + "h0.01" : d);
        }
      }
      for (const {track, basis, strokes} of paths.values()) {
        if (!strokes.length) continue;
        const intraday = track === "intraday";
        const color = track === "active" ? "var(--activity)" : track === "held" ? "var(--overnight)"
          : intraday ? (labels.intradayColor?.(basis) || "var(--brand)") : labels.color(basis);
        const dash = track === "active" ? "" : track === "held" ? "5 3"
          : intraday ? (labels.intradayDash?.(basis) ?? labels.dash(basis)) : labels.dash(basis);
        plot.append(svgElement("path", {d: strokes.join(" "), fill: "none", stroke: color,
          "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round",
          "stroke-dasharray": dash || "none", "data-track": track, "data-basis": basis}));
      }
      timeTicks({...f, svg: plot}, from, to, x);
      return {x, cy, my, countRows, amounts, points: keyboard.filter(inView)};
    }

    function describe(point) {
      const lines = labels.describe?.(point.row, point.kind === "session" ? undefined : payload(point)) || [];
      if (point.kind === "intraday") {
        const name = labels.intradayLabel?.(point.basis) || "Intraday " + String(point.basis || "margin").replaceAll("_", " ");
        return [name + "  " + amount.format(point.value), ...lines];
      }
      if (point.kind === "overnight" && point.basis === "schedule_scenario" && point.row.marginBasis !== point.basis) {
        return ["Overnight margin scenario  " + amount.format(point.value), ...lines];
      }
      return lines;
    }
    function payload(p) {
      return p.kind === "session" ? undefined
        : {...p.source, kind: p.kind, time: p.time, marginUsd: p.value, marginBasis: p.basis};
    }
    return activityInteractions(host, f, {first, last, sessions, margins, title, draw, describe},
      (p) => labels.select?.(p.row, payload(p)), labels.onZoom);
  }

  function activityInteractions(host, f, data, select, onZoom) {
    const {first, last, sessions} = data;
    let from = first, to = last, view = data.draw(from, to);
    const tip = tooltip(host, f);
    const reading = host.querySelector(".chart-tip");
    reading.setAttribute("role", "status");
    reading.setAttribute("aria-atomic", "true");
    const crosshair = svgElement("line", {y1: 30, y2: 317, class: "crosshair", visibility: "hidden"});
    const brush = svgElement("rect", {y: 30, height: 287, fill: "var(--brand)", "fill-opacity": .14,
      stroke: "var(--brand)", "stroke-width": 1, "pointer-events": "none", visibility: "hidden"});
    f.svg.append(brush, crosshair);
    let current = null, drag = null, anchor = null;
    const limit = (n, a, b) => Math.max(a, Math.min(n, b));
    const timeAt = px => from + (px - f.left) / (f.right - f.left) * (to - from);
    function hide() {
      tip.hide();
      crosshair.setAttribute("visibility", "hidden");
    }
    function clearBrush() {
      anchor = null;
      brush.setAttribute("visibility", "hidden");
    }
    function brushTo(a, b) {
      brush.setAttribute("x", Math.min(a, b));
      brush.setAttribute("width", Math.abs(a - b));
      brush.setAttribute("visibility", "visible");
    }
    function viewport(a, b) {
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return;
      const span = limit(Math.round(b - a), 1, last - first);
      a = limit(Math.round(a), first, last - span);
      if (a === from && a + span === to) return;
      from = a;
      to = a + span;
      clearBrush();
      hide();
      view = data.draw(from, to);
      onZoom?.({from, to});
    }
    function zoomBy(factor, at = current && current.at >= from && current.at <= to ? current.at : (from + to) / 2) {
      if (Number.isFinite(factor) && factor > 0) viewport(at + (from - at) / factor, at + (to - at) / factor);
    }
    function resetZoom() { clearBrush(); viewport(first, last); }
    function zoomToSession(date) {
      const s = sessions.find(p => p.row.date === date);
      if (s) viewport(s.first, s.last);
    }
    function show(p) {
      if (!p) return hide();
      if (current === p && crosshair.getAttribute("visibility") === "visible") return;
      current = p;
      const x = view.x(p.at);
      crosshair.setAttribute("x1", x);
      crosshair.setAttribute("x2", x);
      crosshair.setAttribute("visibility", "visible");
      const heading = p.row.date + " session" + (p.time === null ? "" : " · " +
        new Date(p.time).toISOString().replace("T", " ").replace(/(?:\.000)?Z$/, " UTC"));
      tip.show(x, heading, data.describe(p));
    }
    function showAt(i) {
      const s = sessions[i];
      if (!s) return hide();
      if (s.at < from || s.at > to) {
        const half = (to - from) / 2;
        viewport(s.at - half, s.at + half);
      }
      show(s.close || s);
    }
    function zoomRegion(a, b) {
      const lo = Math.min(a, b), hi = Math.max(a, b);
      let peak = null;
      for (const p of view.amounts) {
        if (p.at > hi) break;
        if (p.at >= lo && (!peak || p.value > peak.value)) peak = p;
      }
      clearBrush();
      viewport(lo, hi);
      if (peak) { show(peak); select(peak); }
    }
    function position(e) {
      const ctm = f.svg.getScreenCTM();
      if (!ctm) return null;
      return new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    }
    // Hit the centre of a boundary marker even when the browser rounds a scaled device pixel.
    const inside = p => p && p.x >= f.left - 2 && p.x <= f.right + 2 && p.y >= 28 && p.y <= 319;
    function hit(p) {
      if (!inside(p)) return null;
      const counts = p.y <= 142;
      if ((counts && !view.cy) || (!counts && p.y < 173)) return null;
      const points = counts ? view.countRows : view.amounts;
      const earliest = timeAt(p.x - 10);
      let lo = 0, hi = points.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (points[mid].at < earliest) lo = mid + 1;
        else hi = mid;
      }
      let best = null, distance = Infinity;
      for (let i = lo; i < points.length; i++) {
        const q = points[i], dx = view.x(q.at) - p.x;
        if (dx > 10) break;
        const ys = counts ? [q.row.active, q.row.overnight].filter(Number.isFinite).map(view.cy)
          : [view.my(q.value)];
        for (const y of ys) {
          const d = dx * dx + (y - p.y) ** 2;
          if (d < distance) { best = q; distance = d; }
        }
      }
      return best;
    }

    host.tabIndex = 0;
    host.style.touchAction = "pan-y";
    host.setAttribute("role", "group");
    host.setAttribute("aria-label", data.title +
      ". Arrows inspect observations. Enter selects. Shift and arrows mark a region. Enter zooms to its peak. Plus and minus zoom. Zero resets.");
    host.onwheel = e => {
      const p = position(e);
      if (!inside(p) || !e.deltaY || !e.cancelable) return;
      e.preventDefault();
      const pixels = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? f.height : 1);
      zoomBy(Math.exp(limit(-pixels / 420, -1, 1)), timeAt(limit(p.x, f.left, f.right)));
    };
    host.onpointerdown = e => {
      const p = position(e);
      if (e.button !== 0 || e.isPrimary === false || !inside(p)) return;
      clearBrush();
      host.focus({preventScroll: true});
      drag = {id: e.pointerId, x: limit(p.x, f.left, f.right), clientX: e.clientX};
      host.setPointerCapture(e.pointerId);
    };
    host.onpointermove = e => {
      const p = position(e);
      if (!p) return;
      if (drag) {
        if (e.pointerId !== drag.id || Math.abs(e.clientX - drag.clientX) < 4) return;
        hide();
        brushTo(drag.x, limit(p.x, f.left, f.right));
      } else show(hit(p));
    };
    host.onpointerup = e => {
      if (!drag || drag.id !== e.pointerId) return;
      const start = drag, p = position(e);
      drag = null;
      if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId);
      clearBrush();
      if (!p) return;
      if (Math.abs(e.clientX - start.clientX) >= 4) {
        zoomRegion(timeAt(start.x), timeAt(limit(p.x, f.left, f.right)));
      } else {
        const q = hit(p);
        if (q) { show(q); select(q); }
      }
    };
    host.onpointercancel = host.onlostpointercapture = () => { drag = null; clearBrush(); };
    host.onpointerleave = () => { if (!drag) hide(); };
    host.onblur = () => { clearBrush(); hide(); };
    host.onkeydown = e => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const points = view.points;
      if (!["ArrowLeft", "ArrowRight", "Home", "End", "Escape", "Enter", "+", "=", "-", "0"].includes(e.key)) return;
      e.preventDefault();
      if (e.key === "0") return resetZoom();
      if (e.key === "Escape") { clearBrush(); hide(); return; }
      if (["+", "=", "-"].includes(e.key)) return zoomBy(e.key === "-" ? .5 : 2);
      if (!points.length) return;
      if (e.key === "Enter") {
        if (anchor !== null && current && anchor !== current.at) zoomRegion(anchor, current.at);
        else if (current && current.at >= from && current.at <= to) select(current);
        return;
      }
      let i = points.indexOf(current);
      if (i < 0 && current?.kind === "session") i = points.indexOf(sessions[current.i].close);
      if (i < 0) i = points.length - 1;
      if (e.shiftKey && anchor === null) anchor = points[i].at;
      if (!e.shiftKey) clearBrush();
      i = e.key === "Home" ? 0 : e.key === "End" ? points.length - 1
        : limit(i + (e.key === "ArrowLeft" ? -1 : 1), 0, points.length - 1);
      show(points[i]);
      if (anchor !== null) brushTo(view.x(anchor), view.x(current.at));
    };
    return {showAt, hide, resetZoom, zoomToSession, zoomBy};
  }

  function bars(host, data, options = {}) {
    if (!host) return;
    const usable = data.filter((d) => Number.isFinite(d.value));
    if (!usable.length) {
      empty(host, options.empty || "This period has no recorded observations.");
      return;
    }
    const format = options.format || ((n) => axisFormat.format(n));
    const values = usable.map((d) => d.value);
    const maximum = Math.max(...values);
    const isCount = Boolean(options.countScale);
    const positive = isCount ? values.filter((n) => n > 0).sort((a, b) => a - b) : [];
    const middle = positive[Math.floor((positive.length - 1) / 2)] || 1;
    const concentrated = maximum >= 20 && (maximum >= 8 * middle ||
      (values.length > 1 && maximum >= 0.65 * values.reduce((a, b) => a + b, 0)));
    const choice = host.dataset.countPreference || options.countScale;
    const logarithmic = isCount && (choice === "log" || (choice === "auto" && concentrated));
    let scale = bounds(Math.min(...values), maximum, true);
    if (logarithmic) {
      const hi = Math.max(1, maximum);
      const ticks = [0, 1];
      for (let power = 10; power <= hi; power *= 10) ticks.push(power);
      if (hi >= 2 * ticks.at(-1)) ticks.push(hi);
      scale = { lo: 0, hi, ticks, project: Math.log1p };
    } else if (isCount) {
      scale.ticks = scale.ticks.filter(Number.isInteger);
    }
    const f = frame(
      host,
      (options.title || "Bar chart") + (isCount ? (logarithmic ? " · logarithmic count axis" : " · linear count axis") : ""),
      options.height || 205,
      Math.max(
        27,
        Math.min(
          70,
          Math.max(...scale.ticks.map((t) => format(t).length)) * 6 + 10,
        ),
      ),
    );
    const y = grid(f, scale, format),
      width = (f.right - f.left) / data.length,
      gap = Math.min(8, width * 0.24);
    const stride = Math.max(
      1,
      Math.ceil(
        data.length /
          Math.max(
            2,
            Math.floor((f.right - f.left) / (options.labelWidth || 37)),
          ),
      ),
    );
    const tip = tooltip(host, f);
    data.forEach((item, i) => {
      if (!Number.isFinite(item.value)) return;
      const x = f.left + i * width,
        v = item.value,
        pos = y(v);
      const box = svgElement("rect", {
        x: x + gap / 2,
        y: Math.min(y(0), pos),
        width: Math.max(0.3, width - gap),
        height: isCount && v === 0 ? 0 : Math.max(1, Math.abs(pos - y(0))),
        rx: Math.min(2, width * 0.1),
        fill: item.color || (v < 0 ? "var(--loss)" : primary),
        tabindex: "0",
      });
      const help = isCount ? item.label + " · " + item.detail : item.detail || item.label + " · " + format(v);
      box.append(svgElement("title", {}, help));
      box.setAttribute("aria-label", help);
      box.onpointerenter = box.onfocus = () =>
        tip.show(x, item.label, [item.detail || format(v)]);
      box.onpointerleave = box.onblur = tip.hide;
      f.svg.append(box);
      if (i % stride === 0)
        f.svg.append(
          svgElement(
            "text",
            { x: x + width / 2, y: f.height - 6, "text-anchor": "middle" },
            item.short || item.label,
          ),
        );
    });
    if (isCount) {
      host.dataset.countScale = logarithmic ? "log" : "linear";
      const control = document.createElement("button");
      control.type = "button";
      control.className = "count-scale";
      control.textContent = logarithmic ? "Log count axis" : "Linear count axis";
      control.setAttribute("aria-pressed", String(logarithmic));
      control.setAttribute("aria-label", "Log count axis");
      control.title = logarithmic
        ? "Bar height uses log(1 + count). Counts and empty bins keep their original values. Switch to linear."
        : "Bar height is proportional to the observation count. Switch to logarithmic.";
      control.onclick = () => {
        host.dataset.countPreference = logarithmic ? "linear" : "log";
        bars(host, data, options);
        host.querySelector(".count-scale").focus();
      };
      host.append(control);
    }
  }
  window.PerformanceCharts = { line, bars, activity, empty };
})();
