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
    const y = (value) =>
      f.top + ((scale.hi - value) / (scale.hi - scale.lo)) * (f.bottom - f.top);
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
    const source = seriesWithData[0],
      tip = tooltip(host, f);
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
      (options.title || "Time series") +
        ". Use left and right arrow keys to inspect points.",
    );
    let index = source.times.length - 1;
    function showAt(i) {
      index = Math.max(0, Math.min(source.times.length - 1, i));
      const t = source.times[index],
        pos = x(t);
      cursor.setAttribute("visibility", "visible");
      cursor.setAttribute("x1", pos);
      cursor.setAttribute("x2", pos);
      const rows = [];
      for (const s of seriesWithData) {
        const j = nearest(s.times, t);
        if (s.times[j] === t)
          rows.push(
            s.label +
              "  " +
              (Number.isFinite(s.values[j])
                ? (options.detailFormat || format)(s.values[j])
                : "—"),
          );
      }
      const intraday =
        source.times.length > 1 &&
        Math.floor(t / DAY) ===
          Math.floor(source.times[Math.max(0, index - 1)] / DAY) &&
        index > 0;
      const date =
        dateFormat.format(t) +
        (intraday
          ? " · " + new Date(t).toISOString().slice(11, 16) + " UTC"
          : "");
      tip.show(pos, date, rows);
    }
    function hide() {
      tip.hide();
      cursor.setAttribute("visibility", "hidden");
    }
    host.onpointermove = (e) => {
      const pos = e.clientX - host.getBoundingClientRect().left;
      const t = tMin + ((pos - f.left) / (f.right - f.left)) * (tMax - tMin);
      showAt(nearest(source.times, t));
    };
    host.onpointerleave = hide;
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
              ? source.times.length - 1
              : index + (e.key === "ArrowLeft" ? -1 : 1),
        );
    };
  }

  function bars(host, data, options = {}) {
    if (!host) return;
    const usable = data.filter((d) => Number.isFinite(d.value));
    if (!usable.length) {
      empty(host, options.empty || "This period has no recorded observations.");
      return;
    }
    const format = options.format || ((n) => axisFormat.format(n));
    const scale = bounds(
      Math.min(...usable.map((d) => d.value)),
      Math.max(...usable.map((d) => d.value)),
      true,
    );
    const f = frame(
      host,
      options.title || "Bar chart",
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
        height: Math.max(1, Math.abs(pos - y(0))),
        rx: Math.min(2, width * 0.1),
        fill: item.color || (v < 0 ? "var(--loss)" : primary),
        tabindex: "0",
      });
      const help = item.detail || item.label + " · " + format(v);
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
  }
  window.PerformanceCharts = { line, bars, empty };
})();
