"""Build a full-history research manifest from the data inside a standalone report."""

import argparse
import hashlib
import json
import math
import os
import shlex
import subprocess
import tempfile
from collections import Counter
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from statistics import fmean

from .build import SCRIPTS


ASSETS = Path(__file__).resolve().parent
DAY_MS = 86_400_000
FAMILIES = {
    "winner_removal": "The source supplies no replay with its best trades removed.",
    "random_removal": "The source supplies no seeded replay with trades removed at random.",
    "shuffle": "The source supplies no result for reordered trades or returns.",
    "monte_carlo": "The source supplies no simulated distribution or resampling settings.",
    "parameter_neighbors": "The source supplies no runs with adjacent parameter values.",
    "signal_cadence": "The source supplies no runs at alternate signal intervals.",
    "price_perturbation": "The source supplies no execution replay with perturbed prices.",
    "costs": "The source supplies no replay at different execution costs.",
    "other_markets": "The source supplies no tests of the same rules on other markets.",
    "chronology": "The source supplies no dated out-of-sample or walk-forward test results.",
}


def _strict_json(text):
    def pairs(items):
        obj = {}
        for key, value in items:
            if key in obj:
                raise ValueError(f"Duplicate JSON key {key!r}")
            obj[key] = value
        return obj

    def finite(value):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError(f"Nonfinite JSON number {value}")
        return number

    return json.loads(text, object_pairs_hook=pairs, parse_constant=finite, parse_float=finite)


def _sha(data):
    return hashlib.sha256(data).hexdigest()


class _Payload(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.active = False
        self.scripts = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "script" and attrs.get("id") == "report-data":
            if self.scripts or attrs.get("type") != "application/json" or "src" in attrs:
                raise ValueError("Expected one inline application/json script with id report-data")
            self.active = True
            self.scripts.append([])

    def handle_data(self, data):
        if self.active:
            self.scripts[-1].append(data)

    def handle_endtag(self, tag):
        if tag == "script":
            self.active = False


def read_payload(html):
    """Return the embedded JSON object and the SHA-256 of its exact UTF-8 text."""
    parser = _Payload()
    parser.feed(html)
    parser.close()
    if not parser.scripts or parser.active:
        raise ValueError("Missing or incomplete report-data script")
    raw = "".join(parser.scripts[0])
    return _strict_json(raw), _sha(raw.encode("utf-8"))


def read_source_manifest(path, evidence):
    """Read only the file supplied by the caller. The report must pin its exact bytes."""
    ref = evidence.get("sourceManifest")
    expected = ref.get("sha256") if isinstance(ref, dict) else None
    raw = Path(path).read_bytes()
    if not isinstance(expected, str) or _sha(raw) != expected:
        raise ValueError("Source manifest SHA-256 must match evidence.sourceManifest.sha256")
    return _research_file(raw)


def _research_file(raw):
    source = _strict_json(raw)
    if not isinstance(source, dict) or not isinstance(source.get("baseline"), dict):
        raise ValueError("The attached manifest must contain one baseline object for this series")
    if not isinstance(source.get("results"), (list, dict)):
        raise ValueError("Include the full source result records in the research manifest")
    for section in ("identity", "provenance", "robustness", "costs", "exposure"):
        if section in source and source[section] is not None and not isinstance(source[section], dict):
            raise ValueError(f"The source manifest {section} section must be an object")
    if not isinstance(source["baseline"].get("settings", {}), dict):
        raise ValueError("The source baseline settings must be an object")
    return source


def attach_source_manifest(series, path):
    """Return a copy with a content binding and the source tests for the browser."""
    path = Path(path)
    raw = path.read_bytes()
    source = _research_file(raw)
    evidence = dict(series.get("evidence", {}))
    binding = {"file": path.name, "sha256": _sha(raw)}
    if "sourceManifest" in evidence and (not isinstance(evidence["sourceManifest"], dict)
                                         or evidence["sourceManifest"].get("sha256") != binding["sha256"]):
        raise ValueError("This series already declares a different source manifest SHA-256")
    if "results" in evidence and evidence["results"] != source["results"]:
        raise ValueError("Inline results disagree with the selected source manifest")
    baseline = source["baseline"]
    settings = baseline.get("settings", {})
    identity = source.get("identity") or {}
    provenance = source.get("provenance") or {}
    for key, value in {
        "runId": source.get("run_id", settings.get("run_id")),
        "version": provenance.get("code_version"), "rules": settings.get("rules"),
        "instrument": identity.get("instrument"), "execution": identity.get("execution_clock"),
        "costModel": baseline.get("cost_model"), "seed": baseline.get("seed"),
        "splits": (source.get("robustness") or {}).get("holdout_design", settings.get("splits")),
        "provenance": provenance,
    }.items():
        if value is not None and value != {}:
            evidence.setdefault(key, value)
    evidence.update(sourceManifest=binding, results=source["results"])
    return {**series, "evidence": evidence}


def _date(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).date().isoformat()


def _metric(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _has_number(value):
    if isinstance(value, dict):
        return any(_has_number(v) for v in value.values())
    if isinstance(value, list):
        return any(_has_number(v) for v in value)
    return _metric(value)


def _register(manifest, field, value, reason, *, path=None):
    """Bind each registry entry to the actual stored datum or its specific gap."""
    path = path or field
    group, key = path.split(".", 1)
    missing_text = isinstance(value, str) and value.strip().lower() in {
        "", "unknown", "not recorded", "not available", "unreported", "n/a"}
    if value is None or missing_text or value == [] or value == {}:
        entry = {"status": "not_available", "reason": reason}
    else:
        manifest.setdefault(group, {})[key] = value
        entry = {"status": "computed", "evidence": path}
    manifest["coverage"][field] = entry


def _test_records(source, supplied, baseline, winner_test):
    """Keep source results and their original assumptions. Fill only absent families."""
    if "results" in source and "results" in supplied and source["results"] != supplied["results"]:
        raise ValueError("Inline results disagree with the pinned source manifest")
    records = source.get("results", supplied.get("results", []))
    if isinstance(records, dict):
        flattened = []
        for family, items in records.items():
            if isinstance(items, dict) and "results" in items:
                items = items["results"]
            for item in items if isinstance(items, list) else [items]:
                if not isinstance(item, dict) or item.get("family", family) != family:
                    raise ValueError(f"Invalid result for family {family}")
                flattened.append({**item, "family": family})
        records = flattened
    if not isinstance(records, list):
        raise ValueError("Research results must be a list or a family-to-record map")
    records = list(records)
    supplied_families = set()
    for item in records:
        if not isinstance(item, dict):
            raise ValueError("Each research result must be an object")
        for key in ("family", "status", "source_data", "cost_model", "seed", "settings"):
            if key not in item or item[key] is None or item[key] == "":
                raise ValueError(f"Research result needs {key}")
        if not isinstance(item["family"], str) or not isinstance(item["settings"], dict):
            raise ValueError("Each result needs a named family and settings object")
        if not isinstance(item["status"], str) or isinstance(item["seed"], bool) or not isinstance(item["seed"], (int, str)):
            raise ValueError("A result needs a status and an integer seed or deterministic declaration")
        if item["status"] == "not_run" and not item.get("reason"):
            raise ValueError("A not_run result needs a source reason")
        if item["status"] not in ("not_run", "not_available", "blocked", "pending", "running"):
            metadata = {"family", "status", "settings", "seed", "source_data", "cost_model", "label", "reason"}
            if not item["settings"] or not any(_has_number(v) for k, v in item.items() if k not in metadata):
                raise ValueError("A completed research result needs settings and a measured numeric outcome")
        supplied_families.add(item["family"])
    declared = source.get("families", [])
    if set(declared) - supplied_families:
        raise ValueError("A declared source family has no inline result. Supply its full result record.")
    for family, reason in FAMILIES.items():
        if family not in supplied_families:
            if family == "winner_removal" and winner_test is not None:
                records.append(winner_test)
                continue
            records.append({
                "family": family, "status": "not_run", "reason": reason, "settings": {},
                "seed": "No test ran in this report.",
                "cost_model": baseline["cost_model"], "source_data": baseline["source_data"],
            })
    return records


def _source_fields(manifest, series, dates, reference, supplied, source):
    identity = source.get("identity") or {}
    provenance = {**(source.get("provenance") or {}), **(supplied.get("provenance") or {})}
    baseline = manifest["baseline"]
    version = supplied.get("version", provenance.get("code_version"))
    source_baseline = source.get("baseline", {})
    source_cost = (series.get("costModel") or supplied.get("costModel") or
                   identity.get("cost_model") or source_baseline.get("cost_model"))
    source_seed = supplied.get("seed", source_baseline.get("seed"))
    if source_seed is not None and (isinstance(source_seed, bool) or not isinstance(source_seed, (int, str))
                                    or isinstance(source_seed, str) and not source_seed.strip()):
        raise ValueError("Supply an integer seed or a nonempty deterministic declaration")
    settings = baseline["settings"]
    settings.update({k: supplied[k] for k in ("runId", "version", "rules", "execution", "splits") if k in supplied})
    if source:
        manifest["source_run"] = {"baseline": source_baseline, "identity": identity,
                                  "decision": source.get("decision"), "limitations": source.get("limitations", [])}
    baseline["seed"] = source_seed if source_seed is not None else "Source seed unreported. Mark analysis is deterministic."
    baseline["cost_model"] = source_cost or "The source did not specify a cost model."
    values = {
        "strategy_name": f"{series['name']} ({version})" if isinstance(version, str) and version else series["name"],
        "instrument": supplied.get("instrument", identity.get("instrument")),
        "window_start": dates[0].split("T")[0], "window_end": dates[-1].split("T")[0],
        "starting_capital": series["equity"][0],
        "benchmark": reference["name"] if reference else None,
        "data_source": series.get("source") or identity.get("data_source") or baseline["source_data"],
        "execution_clock": supplied.get("execution", identity.get("execution_clock")),
        "cost_model": source_cost,
    }
    for key, value in values.items():
        _register(manifest, "identity." + key, value,
                  f"The source did not specify the {key.replace('_', ' ')} for this series.")
    manifest["identity"]["currency"] = series["currency"]
    manifest["identity"]["series_id"] = series["id"]
    if "status" in series:
        manifest["identity"]["source_status"] = series["status"]
    for key, value in {
        "seeds": provenance.get("seeds", source_seed),
        "search_space": provenance.get("searchSpace", provenance.get("search_space")),
        "data_vintage": provenance.get("dataVintage", provenance.get("data_vintage")),
    }.items():
        _register(manifest, "provenance." + key, value,
                  f"The source did not record its {key.replace('_', ' ')}. Supply the run provenance.")
    research = {**(source.get("robustness") or {}), **(supplied.get("robustness") or {})}
    for key, value in {
        "holdout_design": supplied.get("splits", research.get("holdout_design")),
        "significance": research.get("significance"),
        "platform_parity": research.get("platform_parity"),
    }.items():
        _register(manifest, "robustness." + key, value,
                  f"The source supplies no {key.replace('_', ' ')} evidence for this series.")
    return provenance


def _same_source_horizon(series, supplied, source, window):
    # The renderer can truncate the account at its first capital loss while keeping
    # full-source totals. An explicit matching endpoint is needed in this case.
    first, last = series["times"][0], series["times"][-1]
    horizon = supplied.get("sourceHorizon")
    if horizon is not None:
        if not isinstance(horizon, dict) or not all(_metric(horizon.get(k)) for k in ("start", "end")):
            raise ValueError("evidence.sourceHorizon needs UTC millisecond start and end")
        if (horizon["start"], horizon["end"]) != (first, last):
            return False
    ident = source.get("identity") or {}
    from .inputs import parse_time
    for key, timestamp in (("window_start", first), ("window_end", last)):
        if key in ident:
            label = ident[key]
            if label == window[key]:
                continue
            try:
                if parse_time(label) != timestamp:
                    return False
            except (TypeError, ValueError, OverflowError):
                return False
    return horizon is not None or series["equity"][-1] > 0


def _original_accounts(manifest, series, supplied, source):
    match = _same_source_horizon(series, supplied, source, manifest["identity"])
    manifest["source_horizon_matches"] = match
    blocks = {"costs": {**(source.get("costs") or {}), **series.get("costs", {})},
              "exposure": {**(source.get("exposure") or {}), **(supplied.get("exposure") or {})}}
    field_names = {
        "costs": {
            "commission_total": ("commission_total", "commissions", "commission"),
            "slippage_total": ("slippage_total", "slippage"),
            "cost_pct_of_gross": ("cost_pct_of_gross",),
            "sensitivity_summary": ("sensitivity_summary",),
        },
        "exposure": {
            "time_in_market_pct": ("time_in_market_pct",),
            "avg_gross_exposure": ("avg_gross_exposure",),
            "max_gross_exposure": ("max_gross_exposure",),
            "trade_count": ("trade_count",),
            "turnover_annual": ("turnover_annual",),
        },
    }
    for group, fields in field_names.items():
        block = blocks[group]
        for key, aliases in fields.items():
            value = next((block[k] for k in aliases if block.get(k) is not None), None)
            reason = f"Supply source {key.replace('_', ' ')} for the account window."
            if key == "cost_pct_of_gross" and not block.get("denominator"):
                value = None
                reason = "Supply the gross cost ratio and identify its denominator."
            if key in ("commission_total", "slippage_total"):
                unit = block.get("currency", block.get("unit", series["currency"]))
                if unit != series["currency"]:
                    value = None
                    reason = "The source uses different cost units. Supply totals in the account currency."
            if key == "sensitivity_summary" and isinstance(value, str):
                source_coverage = (source.get("coverage") or {}).get("costs.sensitivity_summary", {})
                if source_coverage.get("status") != "computed":
                    value = None
                    reason = "Supply measured cost scenarios or a sensitivity result with source evidence."
            if key != "sensitivity_summary" and not _metric(value):
                value = None
            if not match:
                value = None
                reason = "The source total can extend beyond the selected account history."
            _register(manifest, f"{group}.{key}", value, reason)
    if manifest.get("costs"):
        manifest["costs"]["currency"] = series["currency"]
    # Preserve source units, the net exposure measure, total costs, and unknown
    # components even when the registry has no field or the periods differ.
    manifest["source_accounts"] = {k: v for k, v in blocks.items() if v}
    for key in ("tradeSummary", "sourceMetrics", "holdings"):
        if key in series:
            manifest["source_accounts"][key] = series[key]
    if match and "cost_pct_of_gross" in manifest.get("costs", {}):
        manifest["costs"]["denominator"] = blocks["costs"]["denominator"]
    _measured_exposure(manifest, series)
    if "activity" in series:
        ledger = series["activity"]
        rows = ledger["rows"]
        counts = [r["active"] for r in rows if r["active"] is not None]
        peaks = {}
        scenarios = []
        for row in rows:
            value, basis = row["marginUsd"], row["marginBasis"]
            scenario = row.get("overnightScenarioUsd")
            if scenario is None and basis == "schedule_scenario":
                scenario = value
            if scenario is not None:
                scenarios.append({"date": row["date"], "usd": scenario})
            if value is not None and basis != "schedule_scenario" and (basis not in peaks or value > peaks[basis]["usd"]):
                peaks[basis] = {"date": row["date"], "usd": value}
        manifest["session_activity"] = {
            "source": ledger["source"], "series_field": "activity.rows", "session_records": len(rows),
            "active_count_observations": len(counts), "overnight_count_observations": sum(r["overnight"] is not None for r in rows),
            "requirement_observations": sum(r["marginUsd"] is not None and r["marginBasis"] != "schedule_scenario" for r in rows),
            "scenario_observations": len(scenarios),
            "peak_overnight_scenario": max(scenarios, key=lambda p: p["usd"], default=None),
            "intraday_observations_by_basis": {
                basis: sum(p["marginBasis"] == basis and p["marginUsd"] is not None
                           for r in rows for p in r.get("intradayMargin", []))
                for basis in sorted({p["marginBasis"] for r in rows for p in r.get("intradayMargin", [])})
            },
            "active_share_of_measured_sessions": fmean(n > 0 for n in counts) if counts else None,
            "peak_requirement_by_basis": peaks,
        }


def _measured_exposure(manifest, series):
    """Summarize a named fraction-of-equity diagnostic only at matched account marks."""
    records = series.get("diagnostics", [])
    for name in ("Gross exposure", "Net exposure"):
        matches = [(i, d) for i, d in enumerate(records) if d["name"].casefold() == name.casefold()]
        if len(matches) != 1:
            continue
        i, record = matches[0]
        values = record["values"]
        if record["unit"] != "%" or record["times"] != series["times"] or not all(map(_metric, values)):
            continue
        exposure = manifest.setdefault("exposure", {})
        if name == "Gross exposure":
            if min(values) < 0:
                continue
            _register(manifest, "exposure.avg_gross_exposure", fmean(values), "")
            _register(manifest, "exposure.max_gross_exposure", max(values), "")
            if series["frequency"] == "daily":
                days = {}
                for t, gross in zip(series["times"], values, strict=True):
                    day = t // DAY_MS
                    days[day] = days.get(day, False) or gross > 0
                _register(manifest, "exposure.time_in_market_pct", fmean(days.values()), "")
                exposure["time_basis"] = "Fraction of observed UTC dates with positive gross exposure at any supplied mark."
        else:
            exposure["avg_net_exposure"] = fmean(values)
            exposure["min_net_exposure"] = min(values)
            exposure["max_net_exposure"] = max(values)
        exposure[name] = {"source": f"Selected series /diagnostics/{i}", "marks": len(values),
                          "unit": record["unit"], "basis": "Equal weight per observed account mark."}


def _winner_test(closed, baseline, unit):
    """Remove up to ceil(5% of all closes), ranked by positive net P&L."""
    ranked = sorted(range(len(closed)), key=lambda i: -closed[i]["pnl"])
    chosen = [i for i in ranked[:math.ceil(len(closed) / 20)] if closed[i]["pnl"] > 0]
    if not chosen:
        return None
    removed = set(chosen)

    def score(pnl):
        profit = math.fsum(x for x in pnl if x > 0)
        loss = -math.fsum(x for x in pnl if x < 0)
        return {"count": len(pnl), "net_pnl": math.fsum(pnl),
                "expectancy": fmean(pnl) if pnl else None,
                "profit_factor": profit / loss if loss else None}

    return {
        "family": "winner_removal", "label": "Remove the largest winning trades",
        "status": "computed_on_fixed_trade_list",
        "settings": {"fraction_of_all_closes": 0.05, "rounding": "ceil",
                     "rank": "Positive net P&L, descending. Ties retain source order.", "unit": unit},
        "seed": "Deterministic ranking", "cost_model": baseline["cost_model"],
        "source_data": baseline["source_data"] + " /trades",
        "metrics": {"baseline": score([t["pnl"] for t in closed]),
                    "remaining": score([t["pnl"] for i, t in enumerate(closed) if i not in removed])},
        "removed_source_indices": chosen, "removed_net_pnl": math.fsum(closed[i]["pnl"] for i in chosen),
        "note": "The comparison uses the recorded closed trades. A new equity curve and its risk ratios require an execution replay.",
    }


def _trade_evidence(manifest, series, analyzed):
    closed = series.get("trades")
    summary = series.get("tradeSummary", {})
    count = summary.get("closedTrades", summary.get("count"))
    same_window = manifest["source_horizon_matches"]
    sampled = (series.get("evidence", {}).get("tradeCoverage") == "partial" or
               (same_window and count is not None and closed is not None and len(closed) != count))
    has_dated = closed is not None and not sampled
    manifest["trade_scope"] = {
        "currency": series["currency"], "dated_count": len(closed) if closed is not None else None,
        "source_summary_count": count, "partial_ledger": sampled,
        "basis": "Supplied closed trades with exit times inside the account history.",
    }
    fields = {
        "count": "count", "win_rate": "winRate", "avg_win": "avgWin", "avg_loss": "avgLoss",
        "payoff_ratio": "payoff", "profit_factor": "profitFactor", "expectancy_per_trade": "expectancy",
        "longest_losing_streak": "lossStreak", "best_trade": "best", "worst_trade": "worst",
    }
    for key, name in fields.items():
        value = analyzed.get(name) if has_dated else None
        if value is None and same_window:
            value = count if key == "count" else summary.get(key)
        reason = "Supply full dated closed trades or a matching full-history trade statistic."
        if has_dated:
            reason = "The supplied trades lack the observations or denominator required for this measure."
        _register(manifest, "trades." + key, value if _metric(value) else None, reason)
    hours = analyzed.get("meanHoldingHours")
    holding = hours / 24 if has_dated and _metric(hours) and all("holdingHours" in t for t in closed) else None
    _register(manifest, "trades.avg_holding_days", holding, "A complete average needs a holding interval for every closed trade.")
    wins = sorted((t["pnl"] for t in closed or [] if t["pnl"] > 0), reverse=True)
    top5 = math.fsum(wins[:5]) / math.fsum(wins) if wins and has_dated else None
    _register(manifest, "trades.top5_share_of_gross", top5,
              "The full dated trade set must contain positive net trade profits.")
    if top5 is not None:
        manifest["trades"]["concentration_basis"] = "Five largest positive net trade outcomes divided by all positive net trade outcomes."
    declares_complete = series.get("evidence", {}).get("tradeCoverage") == "complete"
    if same_window and has_dated and (count == len(closed) or declares_complete):
        total_pnl = math.fsum(t["pnl"] for t in closed)
        manifest["trade_scope"]["dated_pnl_sum"] = total_pnl
        manifest["trade_scope"]["equity_change_minus_closed_pnl"] = (series["equity"][-1] - series["equity"][0]) - total_pnl
        cost = manifest["source_accounts"].get("costs", {})
        total_cost = cost.get("total")
        currency = cost.get("currency", cost.get("unit", series["currency"]))
        if (wins and _metric(total_cost) and total_cost >= 0 and currency == series["currency"]
                and "cost_pct_of_gross" not in manifest.get("costs", {})):
            _register(manifest, "costs.cost_pct_of_gross", total_cost / math.fsum(wins), "")
            manifest["costs"]["denominator"] = "Sum of positive realized trade P&L after the source cost treatment."
        return _winner_test(closed, manifest["baseline"], series["currency"])
    return None


# Use the same two CommonJS modules that the renderer embeds. No code from an
# input report or source manifest executes. Stdout is one strict JSON record.
_ANALYSIS = """
const fs = require('node:fs');
const path = require('node:path');
const metrics = require(path.join(process.argv[1], 'metrics.js'));
const details = require(path.join(process.argv[1], 'details.js'));
const {series, reference, rollingWindow} = JSON.parse(fs.readFileSync(0, 'utf8'));
const options = {riskFree: 0, target: 0, months: 6};
const a = metrics.analyze(series, options);
const start = series.times[0], end = series.times.at(-1);
let benchmark = null;
if (reference) {
  const left = reference.times.indexOf(start), right = reference.times.indexOf(end);
  if (left >= 0 && right >= left) {
    const window = {...reference, times: reference.times.slice(left, right + 1),
                    equity: reference.equity.slice(left, right + 1)};
    const b = metrics.analyze(window, options);
    benchmark = {summary: b.summary, years: b.years};
  }
}
const relative = details.benchmark(series, reference, {...options, start, end, rollingWindow});
const tails = details.tails(a.returns.values, 0);
const trades = details.trades(series, {start, end});
process.stdout.write(JSON.stringify({summary: a.summary, meta: a.meta, returns: a.returns,
  drawdown: a.drawdown, episodes: a.episodes, years: a.years, months: a.months,
  dates: a.times.map(t => new Date(t).toISOString()), conventions: metrics.conventions,
  benchmark, relative, tails, trades}));
"""


def _analytics(series, benchmark, rolling_window):
    data = {"series": series, "reference": benchmark, "rollingWindow": rolling_window}
    try:
        run = subprocess.run(["node", "-e", _ANALYSIS, str(ASSETS)],
                             input=json.dumps(data, allow_nan=False), text=True, capture_output=True)
    except FileNotFoundError as exc:
        raise ValueError("Install Node.js to run the report analytics for the manifest.") from exc
    if run.returncode:
        raise ValueError("Report analytics failed: " + run.stderr.strip())
    return _strict_json(run.stdout)


def _performance(manifest, series, a):
    reason = "The selected marks lack a valid sample, positive growth base or nonzero denominator for this measure."
    for key, name in {
        "cagr": "cagr", "max_drawdown": "maxDrawdown", "sharpe": "sharpe", "total_return": "totalReturn",
        "annual_volatility": "volatility", "sortino": "sortino", "calmar": "calmar",
    }.items():
        _register(manifest, "performance." + key, a["summary"][name], reason, path="baseline." + key)
    manifest["series"] = {"dates": a["dates"], "equity": series["equity"], "drawdown": a["drawdown"]}
    manifest["sampling"] = {"returns": a["returns"], "diagnostics": a["meta"],
                            "mark_count": len(series["times"]),
                            "valid_period_returns": sum(_metric(v) for v in a["returns"]["values"]),
                            "conventions": a["conventions"]}
    years = {str(y["year"]): {"return": y["return"], "max_drawdown": y["maxDrawdown"],
                             "sharpe": y["sharpe"], "complete": y["complete"]} for y in a["years"]}
    months = {f"{m['year']:04}-{m['month']:02}": m["return"] for m in a["months"]}
    _register(manifest, "calendar.yearly_table", years or None, "No calendar year has sufficient observed equity marks.")
    _register(manifest, "calendar.monthly_returns", months if any(_metric(v) for v in months.values()) else None,
              "The supplied marks do not establish a monthly return.")


def _risk(manifest, series, a):
    daily = series["frequency"] == "daily"
    all_rates = a["returns"]["values"]
    ordered = sorted(v for v in all_rates if _metric(v))
    reason = ("The observed daily returns lack a usable sample for this statistic." if daily else
              "The declared return frequency does not supply daily returns.")
    fifth = a["summary"]["var95"]
    cvar = a["summary"]["cvar95"]
    values = {"var_95_daily": fifth, "cvar_95_daily": cvar, "worst_day": a["summary"]["worst"],
              "skew_daily": a["tails"]["skewness"], "kurtosis_daily": a["tails"]["excessKurtosis"],
              "var_99_daily": None, "cvar_99_daily": None, "longest_losing_streak_days": None}
    if daily and ordered:
        rank = (len(ordered) - 1) * 0.01
        low, high = math.floor(rank), math.ceil(rank)
        threshold = ordered[low] + (ordered[high] - ordered[low]) * (rank - low)
        values["var_99_daily"] = threshold
        values["cvar_99_daily"] = fmean(x for x in ordered if x <= threshold)
        longest = streak = 0
        for rate in all_rates:
            streak = streak + 1 if _metric(rate) and rate < 0 else 0
            longest = max(streak, longest)
        values["longest_losing_streak_days"] = longest
    for key, value in values.items():
        _register(manifest, "risk." + key, value if daily else None, reason)
    date_at = dict(zip(series["times"], a["dates"], strict=True))
    episodes = [{
        "depth": e["depth"], "start": date_at[e["peak"]], "trough_date": date_at[e["trough"]],
        "recovery": date_at.get(e["recovery"]), "days_underwater": e["days"],
        "days_to_recovery": (e["recovery"] - e["trough"]) / DAY_MS if e["recovery"] is not None else None,
    } for e in sorted(a["episodes"], key=lambda e: e["depth"])[:5]]
    _register(manifest, "risk.dd_episodes", episodes,
              "No peak to trough decline occurs in the supplied equity marks.")
    high, high_time = series["equity"][0], series["times"][0]
    stagnation = 0
    for t, equity in zip(series["times"], series["equity"], strict=True):
        stagnation = max(stagnation, t - high_time)
        if equity >= high:
            high, high_time = equity, t
    _register(manifest, "risk.stagnation_days", stagnation / DAY_MS, "")
    # Underwater time in the registry is a share of observed days, not marks.
    daily_closes = {}
    for t, dd in zip(series["times"], a["drawdown"], strict=True):
        daily_closes[t // DAY_MS] = dd
    _register(manifest, "risk.time_underwater_pct",
              fmean(dd < 0 for dd in daily_closes.values()) if daily else None, reason)
    manifest["risk"]["conventions"] = {
        "drawdown": "Running high at all supplied equity marks, including opening equity.",
        "episodes": "Five deepest episodes at original mark timestamps in UTC. An open episode has no recovery time.",
        "time_underwater": "Fraction of observed UTC dates whose final mark is below the all-mark running high.",
        "stagnation": "Longest elapsed interval between marks at or above the previous high, including an open final interval.",
        "losing_streak": "Consecutive negative daily returns. Missing and flat returns break a streak.",
        "tails": "Linearly interpolated empirical percentiles. Expected shortfall averages returns at or below each threshold.",
    }


def _comparison(manifest, a, rolling_window):
    relative, benchmark = a["relative"], a["benchmark"]
    missing = "A full-window comparison needs benchmark marks at both selected account endpoints."
    for key, name in {"total_return": "totalReturn", "cagr": "cagr", "max_drawdown": "maxDrawdown",
                      "sharpe": "sharpe"}.items():
        _register(manifest, "benchmark." + key, benchmark["summary"].get(name) if benchmark else None,
                  missing if not benchmark else "The benchmark lacks a usable sample or denominator for this measure.")
    years = {str(y["year"]): y["return"] for y in benchmark["years"]} if benchmark else {}
    _register(manifest, "calendar.yearly_benchmark", years if any(_metric(v) for v in years.values()) else None,
              "Benchmark endpoints and eligible yearly observations are required.")
    reason = relative.get("reason") or "Matching return intervals or a nonzero comparison denominator are required."
    for key, name in {"beta": "beta", "alpha_annual": "alpha", "correlation": "correlation",
                      "capture_up": "upCapture", "capture_down": "downCapture",
                      "tracking_error": "trackingError", "information_ratio": "informationRatio"}.items():
        _register(manifest, "benchmark." + key, relative[name], "Benchmark comparison unavailable. " + reason)
    rolling = relative["rolling"]
    _register(manifest, "benchmark.correlation_rolling",
              {"window": rolling_window, "times": rolling["times"], "values": rolling["correlation"]}
              if any(_metric(v) for v in rolling["correlation"]) else None,
              "Rolling correlation needs enough consecutive matched returns with nonzero variance.")
    manifest.setdefault("benchmark", {})["paired_intervals"] = {"count": relative["count"], **relative["coverage"]}


def _visuals(manifest, a):
    """Identify the report view and the actual chart data. Browser QA is a separate check."""
    series = manifest["series"]
    calendar = manifest.get("calendar", {})
    rows = [
        ("equity_curve", "overview", "#equity-chart", "series.equity", series["equity"]),
        ("drawdown_curve", "drawdowns", "#dd-full", "series.drawdown", series["drawdown"]),
        ("yearly_bars", "calendar", "#annual-chart", "calendar.yearly_table", [y["return"] for y in a["years"]]),
        ("monthly_heatmap", "calendar", ".heat", "calendar.monthly_returns",
         list(calendar.get("monthly_returns", {}).values())),
        ("rolling_correlation", "compare", "#rolling-correlation", "benchmark.correlation_rolling",
         a["relative"]["rolling"]["correlation"]),
        ("trade_distribution", "trades", "#trade-hist", "dated_trade_bins", [b["count"] for b in a["trades"]["bins"]]),
    ]
    manifest["dated_trade_bins"] = a["trades"]["bins"]
    for key, view, selector, data, numbers in rows:
        evidence = {"view": view, "selector": selector, "data": data} if any(_metric(n) for n in numbers) else None
        _register(manifest, "visuals." + key, evidence,
                  f"The supplied observations yield no numeric data for the {key.replace('_', ' ')}.")


def _exact_demo(bundle, series):
    if series.get("evidence", {}).get("type") != "synthetic":
        return False
    from .demo import demo_bundle
    return bundle == demo_bundle()


def _demo_evidence(series, by_id):
    names = [by_id[h["id"]]["name"] for h in series.get("holdings", [])]
    return {
        "version": "sha256:" + _sha((ASSETS / "demo.py").read_bytes()),
        "rules": "lab/performance/demo.py, demo_bundle and Sleeve.close_mark",
        "instrument": ", ".join(names) or series.get("assetClass", series["name"]),
        "execution": "The generator marks prior positions at each simulated weekday close. New positions earn the next price change.",
        "splits": "One illustrative window. The generator reserves no unseen period.",
        "provenance": {
            "dataVintage": "Seeded synthetic marks through " + _date(series["times"][-1]),
            "searchSpace": "This reproduction generates one fixed configuration. Earlier design trials are unrecorded.",
        },
    }


def build_manifest(html, series_id=None, source_manifest=None):
    """Build a portable manifest for one full series in an existing offline HTML report."""
    from .inputs import validate_bundle

    html = Path(html)
    raw = html.read_bytes()
    page = raw.decode("utf-8")
    payload, payload_digest = read_payload(page)
    page = page.replace("\r\n", "\n")
    bundle = validate_bundle(payload)
    if bundle != payload:
        raise ValueError("The embedded report-data must already match the renderer's normalized bundle")
    series_list = bundle["series"]
    by_id = {s["id"]: s for s in series_list}
    if series_id is None:
        series = next((s for s in series_list if s["kind"] == "portfolio"), None)
        series = series or next((s for s in series_list if s["kind"] == "strategy"), series_list[0])
    else:
        if series_id not in by_id:
            raise ValueError(f"Unknown series id {series_id!r}")
        series = by_id[series_id]
    supplied = series.get("evidence", {})
    for key in ("provenance", "exposure", "robustness", "sourceManifest"):
        if key in supplied and not isinstance(supplied[key], dict):
            raise ValueError(f"evidence.{key} must be an object")
    source = read_source_manifest(source_manifest, supplied) if source_manifest is not None else {}
    benchmark = by_id.get(series.get("benchmarkId"))

    # A report generated with different local code must use its matching checkout.
    # Checking full script tags avoids accepting an engine name quoted in an input.
    hashes = {}
    for name in ("theme.js", *SCRIPTS):
        data = (ASSETS / name).read_bytes()
        content = data.decode("utf-8").replace("\r\n", "\n")
        if "<script>\n" + content + "\n</script>" not in page:
            raise ValueError(f"Embedded {name} differs from the local renderer. Use the matching source version.")
        hashes[name] = _sha(data)
    hashes["evidence.py"] = _sha(Path(__file__).read_bytes())
    hashes["inputs.py"] = _sha((ASSETS / "inputs.py").read_bytes())
    if series.get("activity") is not None:
        hashes["activity.py"] = _sha((ASSETS / "activity.py").read_bytes())
    demo = _exact_demo(bundle, series)
    if demo:
        supplied = {**_demo_evidence(series, by_id), **supplied}
        hashes["demo.py"] = _sha((ASSETS / "demo.py").read_bytes())

    rolling_window = max(2, math.floor(series["periodsPerYear"] * 0.5 + 0.5))
    a = _analytics(series, benchmark, rolling_window)
    source_index = next(i for i, s in enumerate(series_list) if s["id"] == series["id"])
    ref = f"report-data /series/{source_index} (embedded payload SHA-256 {payload_digest})"
    baseline = {"source_data": ref, "status": "computed_from_synthetic_marks" if supplied.get("type") == "synthetic"
                else "computed_from_supplied_marks", "settings": {
        "series_id": series["id"], "frequency": series["frequency"], "periods_per_year": series["periodsPerYear"],
        "risk_free_annual": 0, "downside_target_annual": 0, "rolling_correlation_observations": rolling_window,
        "start_utc_ms": series["times"][0], "end_utc_ms": series["times"][-1],
        "accounting": series.get("accounting"), "scope": "Full selected account history",
    }}
    manifest = {"schema": "performance-evidence-v1", "report_title": bundle["title"], "baseline": baseline,
                "coverage": {}, "source_evidence": series.get("evidence", {}),
                "decision": {"verdict": "Synthetic illustration" if supplied.get("type") == "synthetic" else "Historical observations",
                             "summary": "Use these measurements to inspect the supplied history and its evidence gaps."},
                "limitations": [
                    "Drawdown uses observed account marks. Prices between marks can change.",
                    "The elapsed account window and the count of valid return intervals measure different things.",
                ]}
    source_provenance = _source_fields(manifest, series, a["dates"], benchmark, supplied, source)
    _performance(manifest, series, a)
    trio = [a["summary"][key] for key in ("cagr", "maxDrawdown", "sharpe")]
    if all(_metric(x) for x in trio):
        manifest["decision"]["summary"] = (
            f"Annual compound growth was {trio[0]:.2%}. Maximum observed drawdown was {trio[1]:.2%}. "
            f"The Sharpe ratio was {trio[2]:.2f} at a zero annual cash rate.")
    _risk(manifest, series, a)
    _comparison(manifest, a, rolling_window)
    manifest["benchmark"]["sampling_frequency"] = series["frequency"]
    if benchmark:
        manifest["benchmark"]["source_units"] = [series["currency"], benchmark["currency"]]
    _original_accounts(manifest, series, supplied, source)
    winner_test = _trade_evidence(manifest, series, a["trades"])
    records = _test_records(source, supplied, baseline, winner_test)
    manifest["results"] = records
    manifest["families"] = list(dict.fromkeys(record["family"] for record in records))
    _register(manifest, "robustness.test_battery",
              dict(Counter(record["status"] for record in records)), "Each research family needs a status.")
    _visuals(manifest, a)

    manifest["source_provenance"] = source_provenance
    if series.get("notes"):
        manifest["source_notes"] = series["notes"]
    manifest["source_manifest_status"] = ("hash_verified" if source else
                                          "declared_unchecked" if "sourceManifest" in supplied else "not_supplied")
    report_name = html.name
    cmd = ["python", "-m", "lab.performance.evidence", "--html", report_name, "--series", series["id"]]
    artifacts = [{"role": "standalone report", "file": report_name, "sha256": _sha(raw)},
                 {"role": "canonical embedded JSON", "selector": "#report-data", "sha256": payload_digest}]
    if source_manifest is not None:
        source_name = Path(source_manifest).name
        cmd.extend(["--source-manifest", source_name])
        artifacts.append({"role": "full source research manifest", "file": source_name,
                          "sha256": series["evidence"]["sourceManifest"]["sha256"]})
    _register(manifest, "provenance.artifacts", artifacts, "")
    _register(manifest, "provenance.code_version", hashes, "")
    commands = [shlex.join(cmd)]
    if demo:
        commands.insert(0, shlex.join(["python", "-m", "lab.performance", "--demo", "--output", report_name]))
    _register(manifest, "provenance.run_command", "\n".join(commands), "")
    manifest["provenance"]["command_directory"] = "Report directory with this package on the Python import path."
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--html", type=Path, required=True, help="finished standalone report")
    parser.add_argument("--series", help="series id (default: the opening report view)")
    parser.add_argument("--source-manifest", type=Path, help="full research manifest pinned by this series")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--out", type=Path, help="default: research_tests/manifest.json beside the HTML")
    action.add_argument("--check", type=Path, metavar="MANIFEST", help="recompute and compare an existing manifest")
    args = parser.parse_args(argv)
    target = args.out or args.html.parent / "research_tests" / "manifest.json"
    tmp = None
    try:
        if any(target.resolve() == p.resolve() for p in (args.html, args.source_manifest) if p is not None):
            raise ValueError("The output path must differ from the input files.")
        if args.check:
            expected = _strict_json(args.check.read_bytes())
            series_id = args.series or expected["identity"]["series_id"]
            if build_manifest(args.html, series_id, args.source_manifest) != expected:
                raise ValueError("The manifest differs from the report, source evidence, or local analysis version.")
            print("Verified", args.check)
            return
        manifest = build_manifest(args.html, args.series, args.source_manifest)
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", dir=target.parent, delete=False, encoding="utf-8", newline="\n") as file:
            tmp = Path(file.name)
            json.dump(manifest, file, indent=2, ensure_ascii=False, allow_nan=False)
            file.write("\n")
        os.replace(tmp, target)
    except (ValueError, OSError) as exc:
        parser.exit(2, f"{parser.prog}: {exc}\n")
    finally:
        if tmp:
            tmp.unlink(missing_ok=True)
    print(target)


if __name__ == "__main__":
    main()
