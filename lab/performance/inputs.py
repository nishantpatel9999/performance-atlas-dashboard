"""Validate browser payloads and read portable JSON/CSV manifests (standard library).

Daily series can supply sessionDates: sorted, unique exchange dates (YYYY-MM-DD).
The calendar can extend beyond the record. No calendar is inferred from observed marks.

An optional diagnostics array contains named histories with unit, times, values and an
optional description. Each clock is independent. A percent unit (%) uses fractions;
all other units are literal. Null denotes a missing observation. A diagnostic may
specify a relative csv with dateColumn and valueColumn (defaults: date and value).

Portfolios may supply broker-close activity inline or with a relative activityFile.
The activity module reads authoritative snapshots and optional historical position,
margin-rule and FX ledgers.
"""

import csv
import json
import math
import re
from datetime import date, datetime, timedelta, timezone
from fractions import Fraction
from pathlib import Path


DEFAULT_TITLE = "Performance Atlas"
FREQUENCIES = ("daily", "weekly", "monthly", "annual")
REQUIRED = {"id", "name", "kind", "currency", "periodsPerYear", "frequency", "times", "equity"}
TEXT = {"assetClass", "family", "accounting", "costModel", "source", "status", "benchmarkId"}
OBJECTS = {"costs", "tradeSummary", "sourceMetrics", "evidence"}
OPTIONAL = TEXT | OBJECTS | {"trades", "holdings", "notes", "sessionDates", "diagnostics", "activity"}
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
MILLISECOND = timedelta(milliseconds=1)


def _fields(obj, required, allowed, where):
    if not isinstance(obj, dict) or not all(isinstance(k, str) for k in obj):
        raise ValueError(f"{where} must be an object with string keys")
    missing = required - obj.keys()
    if missing:
        raise ValueError(f"{where} requires {', '.join(sorted(missing))}")
    extra = obj.keys() - allowed
    if extra:
        raise ValueError(f"{where} has unknown fields: {', '.join(sorted(extra))}")


def _array(value, where):
    if not isinstance(value, list):
        raise ValueError(f"{where} must be an array")
    return value


def _text(value, where, *, allow_empty=False):
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        raise ValueError(f"{where} must be {'a string' if allow_empty else 'a nonempty string'}")
    return value


def _number(value, where):
    if type(value) in (int, float):
        try:
            if math.isfinite(value):
                return value
        except OverflowError:
            pass
    raise ValueError(f"{where} must be a finite number")


def _timestamp(value, where):
    # ECMAScript Date's TimeClip range is inside the integer precision of a double.
    n = _number(value, where)
    if abs(n) > 8_640_000_000_000_000 or int(n) != n:
        raise ValueError(f"{where} must be whole UTC epoch milliseconds in the browser date range")
    return int(n)


def parse_time(value):
    """An ISO date/time (naive means UTC) or integer epoch milliseconds."""
    if not isinstance(value, str):
        return _timestamp(value, "time")
    value = value.strip()
    if re.fullmatch(r"[+-]?\d+", value):
        return _timestamp(int(value), "time")
    # fromisoformat discards digits beyond microseconds; refuse a lossy conversion.
    for fraction in re.findall(r"[.,]([0-9]+)", value):
        if fraction[3:].strip("0"):
            raise ValueError(f"time {value!r} must have whole-millisecond precision")
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        delta = dt - EPOCH
    except (ValueError, OverflowError) as exc:
        raise ValueError(f"invalid ISO date/time {value!r}") from exc
    if delta % MILLISECOND:
        raise ValueError(f"time {value!r} must have whole-millisecond precision")
    return delta // MILLISECOND


def _json_value(value, where):
    if value is None or isinstance(value, (str, bool)):
        return
    if isinstance(value, dict) and all(isinstance(k, str) for k in value):
        for key, item in value.items():
            _json_value(item, f"{where}.{key}")
    elif isinstance(value, list):
        for item in value:
            _json_value(item, where)
    else:
        _number(value, where)


def _closed_trades(value, first, last, terminal, where):
    kept = []
    for i, row in enumerate(_array(value, where)):
        field = f"{where}[{i}]"
        _fields(row, {"time", "pnl"}, {"time", "pnl", "side", "holdingHours"}, field)
        t = _timestamp(row["time"], f"{field}.time")
        _number(row["pnl"], f"{field}.pnl")
        if not first <= t <= last:
            raise ValueError(f"{field}.time is outside the source equity history")
        if "side" in row:
            _text(row["side"], f"{field}.side")
        if "holdingHours" in row and _number(row["holdingHours"], f"{field}.holdingHours") < 0:
            raise ValueError(f"{field}.holdingHours must be nonnegative")
        if t <= terminal:
            kept.append(row)
    return sorted(kept, key=lambda trade: trade["time"])


def _session_dates(item, where):
    if item["frequency"] != "daily":
        raise ValueError(f"{where} is available only for daily series")
    previous = ""
    for day in _array(item["sessionDates"], where):
        if not isinstance(day, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", day):
            raise ValueError(f"{where} requires ISO YYYY-MM-DD dates")
        try:
            date.fromisoformat(day)
        except ValueError as exc:
            raise ValueError(f"{where} has an invalid calendar date {day!r}") from exc
        if day <= previous:
            raise ValueError(f"{where} must be strictly increasing and unique")
        previous = day


def _diagnostics(value, first, last, terminal, where):
    histories, names = [], set()
    required = {"name", "unit", "times", "values"}
    for i, row in enumerate(_array(value, where)):
        field = f"{where}[{i}]"
        _fields(row, required, required | {"description"}, field)
        name = _text(row["name"], f"{field}.name")
        if name in names:
            raise ValueError(f"{field} has duplicate diagnostic name {name!r}")
        names.add(name)
        _text(row["unit"], f"{field}.unit")
        if "description" in row:
            _text(row["description"], f"{field}.description", allow_empty=True)
        times, values = _array(row["times"], f"{field}.times"), _array(row["values"], f"{field}.values")
        if len(times) != len(values):
            raise ValueError(f"{field}.times and values must have equal lengths")
        stop = 0
        previous = None
        for t, v in zip(times, values):
            t = _timestamp(t, f"{field}.times")
            if previous is not None and t <= previous:
                raise ValueError(f"{field}.times must be strictly increasing")
            if not first <= t <= last:
                raise ValueError(f"{field}.times must lie within the source equity history")
            previous = t
            if v is not None:
                _number(v, f"{field}.values")
            if t <= terminal:
                stop += 1
        histories.append(row if stop == len(times) else dict(row, times=times[:stop], values=values[:stop]))
    return histories


def _validate_series(item, where):
    _fields(item, REQUIRED, REQUIRED | OPTIONAL, where)
    for key in ("id", "name", "currency"):
        _text(item[key], f"{where}.{key}")
    for key in TEXT & item.keys():
        _text(item[key], f"{where}.{key}", allow_empty=(key != "benchmarkId"))
    if item["kind"] not in ("portfolio", "strategy", "benchmark"):
        raise ValueError(f"{where}.kind must be portfolio, strategy or benchmark")
    if item["frequency"] not in FREQUENCIES:
        raise ValueError(f"{where}.frequency must be one of {', '.join(FREQUENCIES)}")
    if _number(item["periodsPerYear"], f"{where}.periodsPerYear") <= 0:
        raise ValueError(f"{where}.periodsPerYear must be positive")
    times = _array(item["times"], f"{where}.times")
    equity = _array(item["equity"], f"{where}.equity")
    if not times or len(times) != len(equity):
        raise ValueError(f"{where}.times and equity must have equal lengths and an opening mark")
    stop = len(times)
    prev = None
    for i, (t, e) in enumerate(zip(times, equity)):
        t = _timestamp(t, f"{where}.times[{i}]")
        if prev is not None and prev >= t:
            raise ValueError(f"{where}.times must be strictly increasing at mark {i}")
        prev = t
        if _number(e, f"{where}.equity[{i}]") <= 0:
            if i == 0:
                raise ValueError(f"{where}.equity must start with a positive opening mark")
            stop = min(stop, i + 1)
    result = dict(item)
    if stop < len(times):
        result.update(times=times[:stop], equity=equity[:stop])
    if "trades" in item:
        result["trades"] = _closed_trades(item["trades"], times[0], times[-1], times[stop - 1], f"{where}.trades")
    if "sessionDates" in item:
        _session_dates(item, f"{where}.sessionDates")
    if "diagnostics" in item:
        result["diagnostics"] = _diagnostics(item["diagnostics"], times[0], times[-1], times[stop - 1],
                                             f"{where}.diagnostics")
    if "activity" in item:
        from .activity import validate_activity
        if item["kind"] != "portfolio":
            raise ValueError(f"{where}.activity requires a portfolio")
        result["activity"] = validate_activity(item["activity"], times[0], times[-1], times[stop - 1])
    if "notes" in item:
        for note in _array(item["notes"], f"{where}.notes"):
            _text(note, f"{where}.notes", allow_empty=True)
    if "holdings" in item:
        seen = set()
        for row in _array(item["holdings"], f"{where}.holdings"):
            _fields(row, {"id", "weight"}, {"id", "weight"}, f"{where}.holdings")
            ident = _text(row["id"], f"{where}.holdings.id")
            if ident in seen:
                raise ValueError(f"{where}.holdings has duplicate id {ident!r}")
            seen.add(ident)
            _number(row["weight"], f"{where}.holdings.weight")
    for key in OBJECTS & item.keys():
        if not isinstance(item[key], dict):
            raise ValueError(f"{where}.{key} must be an object")
        _json_value(item[key], f"{where}.{key}")
    return result


def validate_bundle(bundle):
    """Return a validated v1 bundle. Retain the first nonpositive mark and stop there."""
    _fields(bundle, {"version", "title", "series"}, {"version", "title", "description", "series", "glossary"}, "report")
    if type(bundle["version"]) is not int or bundle["version"] != 1:
        raise ValueError("version must be 1")
    _text(bundle["title"], "title")
    if "description" in bundle:
        _text(bundle["description"], "description", allow_empty=True)
    if "glossary" in bundle:
        glossary = bundle["glossary"]
        if not isinstance(glossary, dict):
            raise ValueError("report.glossary must map terms to definitions")
        for term, definition in glossary.items():
            _text(term, "report.glossary term")
            _text(definition, f"report.glossary[{term!r}]")
    rows = _array(bundle["series"], "series")
    if not rows:
        raise ValueError("series must contain at least one history")
    series = [_validate_series(row, f"series[{i}]") for i, row in enumerate(rows)]
    kinds = {row["id"]: row["kind"] for row in series}
    if len(kinds) != len(series):
        raise ValueError("series ids must be unique")
    for row in series:
        ref = row.get("benchmarkId")
        if ref is not None and (ref == row["id"] or kinds.get(ref) != "benchmark"):
            raise ValueError(f"{row['id']}.benchmarkId must refer to another benchmark series")
    return dict(bundle, series=series)


def equity_from_returns(values, opening, mode):
    """The input is a fraction of current equity or a contribution per unit of initial capital."""
    if _number(opening, "openingCapital") <= 0:
        raise ValueError("openingCapital must be positive")
    if mode not in ("returns", "contributions"):
        raise ValueError("mode must be returns or contributions")
    equity = [opening]
    # Fixed contributions are decimal fractions of the initial capital. Keep their
    # sum exact so the size of the account never changes its failure date.
    fixed_capital = Fraction(str(opening)) if mode == "contributions" else None
    funded_units = Fraction(1)
    for value in values:
        _number(value, "return")
        previous = equity[-1]
        if previous <= 0:
            # Preserve the source horizon until all related records have been validated.
            equity.append(previous)
            continue
        if fixed_capital is None:
            factor = 1 + value
            mark = previous * factor
            is_zero = factor == 0
        else:
            funded_units += Fraction(str(value))
            try:
                mark = float(fixed_capital * funded_units)
            except OverflowError as exc:
                raise ValueError("resulting equity exceeds the supported numeric range") from exc
            is_zero = funded_units == 0
        if mark == 0 and not is_zero:
            raise ValueError("resulting equity is too small to represent")
        equity.append(_number(mark, "resulting equity"))
    return equity


def _csv_path(base, value, output_path):
    path = Path(_text(value, "CSV path"))
    if path.is_absolute() or "://" in value:
        raise ValueError(f"expected a local CSV path relative to the manifest: {value!r}")
    source = base / path
    if output_path is not None and source.resolve() == output_path:
        raise ValueError(f"output would replace input CSV {value!r}")
    return source


def _csv_rows(path, columns):
    with path.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f, strict=True)
        names = reader.fieldnames or []
        if not set(columns) <= set(names) or len(names) != len(set(names)) or "" in names:
            raise ValueError(f"{path}: expected unique headers including {', '.join(columns)}")
        for row in reader:
            if None in row or None in row.values():
                raise ValueError(f"{path}:{reader.line_num}: wrong number of fields")
            yield reader.line_num, row


def _csv_number(raw, column):
    try:
        return _number(float(raw), column)
    except (ValueError, TypeError, OverflowError) as exc:
        raise ValueError(f"{column} requires a finite decimal number, got {raw!r}") from exc


def _trade_csv(path):
    trades = []
    for line, row in _csv_rows(path, ["time", "pnl"]):
        try:
            trade = {"time": parse_time(row["time"]), "pnl": _csv_number(row["pnl"], "pnl")}
            if row.get("side"):
                trade["side"] = row["side"]
            if row.get("holdingHours"):
                trade["holdingHours"] = _csv_number(row["holdingHours"], "holdingHours")
        except ValueError as exc:
            raise ValueError(f"{path}:{line}: {exc}") from exc
        trades.append(trade)
    return trades


def _diagnostic_csv(row, path):
    if "times" in row or "values" in row:
        raise ValueError(f"{path}: supply either a diagnostic CSV or inline times and values")
    date_col = _text(row.pop("dateColumn", "date"), "diagnostic dateColumn")
    value_col = _text(row.pop("valueColumn", "value"), "diagnostic valueColumn")
    times, values = [], []
    for line, fields in _csv_rows(path, [date_col, value_col]):
        try:
            t = parse_time(fields[date_col])
            if times and t <= times[-1]:
                raise ValueError("diagnostic dates must be strictly increasing")
            times.append(t)
            raw = fields[value_col].strip()
            values.append(_csv_number(raw, value_col) if raw else None)
        except ValueError as exc:
            raise ValueError(f"{path}:{line}: {exc}") from exc
    row.update(times=times, values=values)


def _load_marks(series, path):
    mode = series.pop("mode", "equity")
    if mode not in ("equity", "returns", "contributions"):
        raise ValueError(f"{path}: mode must be equity, returns or contributions")
    if "times" in series or "equity" in series:
        raise ValueError(f"{path}: supply either CSV marks or inline marks")
    date_col = _text(series.pop("dateColumn", "date"), "dateColumn")
    val_col = _text(series.pop("valueColumn", "equity" if mode == "equity" else "net"), "valueColumn")
    cols = [date_col, val_col]
    convert = "fxColumn" in series or "sourceCurrency" in series
    rates = []
    if convert:
        fx_col = _text(series.pop("fxColumn", None), "fxColumn")
        source_ccy = _text(series.pop("sourceCurrency", None), "sourceCurrency")
        if source_ccy == series.get("currency"):
            raise ValueError(f"{path}: sourceCurrency must differ from the output currency when using FX")
        cols.append(fx_col)
    times, values = [], []
    if mode != "equity":
        opening = _number(series.pop("openingCapital", None), "openingCapital")
        if "openingDate" not in series:
            raise ValueError(f"{path}: return streams require openingDate")
        times.append(parse_time(series.pop("openingDate")))
        if convert:
            rates.append(_number(series.pop("openingFxRate", None), "openingFxRate"))
    for line, row in _csv_rows(path, cols):
        try:
            t = parse_time(row[date_col])
            if times and t <= times[-1]:
                raise ValueError("dates must be strictly increasing after the opening mark")
            times.append(t)
            values.append(_csv_number(row[val_col], val_col))
            if convert:
                rates.append(_csv_number(row[fx_col], fx_col))
        except ValueError as exc:
            raise ValueError(f"{path}:{line}: {exc}") from exc
    if not values:
        raise ValueError(f"{path}: the CSV has no observations")
    equity = values if mode == "equity" else equity_from_returns(values, opening, mode)
    if convert:
        if any(rate <= 0 for rate in rates):
            raise ValueError(f"{path}: FX rates must be positive units of output currency per source unit")
        equity = [v * rate for v, rate in zip(equity, rates)]
    series.update(times=times, equity=equity)
    labels = {"equity": "Supplied net equity marks", "returns": "Compounded net returns",
              "contributions": "Net contributions on fixed initial capital"}
    series.setdefault("accounting", labels[mode])
    series.setdefault("source", path.name)
    series.setdefault("evidence", {"type": "imported", "method": labels[mode]})
    if convert:
        note = f"Equity uses {fx_col} units of {series.get('currency')} per {source_ccy} at each mark."
        series["notes"] = [*_array(series.get("notes", []), "notes"), note]


def _unique_keys(pairs):
    result = {}
    for k, v in pairs:
        if k in result:
            raise ValueError(f"duplicate JSON key {k!r}")
        result[k] = v
    return result


def _read_json(path):
    """Read a portable manifest or activity sidecar without rounding nonzero amounts to zero."""
    def finite_float(raw):
        value = _number(float(raw), "JSON number")
        if value == 0 and re.search("[1-9]", raw.lower().partition("e")[0]):
            raise ValueError("a nonzero JSON number is too small to represent")
        return value

    with path.open(encoding="utf-8-sig") as stream:
        return json.load(stream, object_pairs_hook=_unique_keys, parse_float=finite_float)


def load_config(path, *, output=None):
    """Load canonical JSON or a portable manifest. All trade P&L is in the output currency."""
    path = Path(path)
    output_path = Path(output).resolve() if output is not None else None
    if path.resolve() == output_path:
        raise ValueError("--output must differ from --config")
    config = _read_json(path)
    if not isinstance(config, dict):
        raise ValueError("the manifest must be a JSON object")
    config.setdefault("title", DEFAULT_TITLE)
    config.setdefault("version", 1)
    for row in _array(config.get("series"), "series"):
        if not isinstance(row, dict):
            raise ValueError("each series must be a JSON object")
        if "csv" in row:
            _load_marks(row, _csv_path(path.parent, row.pop("csv"), output_path))
        if "tradesCsv" in row:
            if "trades" in row:
                raise ValueError("supply either trades or tradesCsv")
            row["trades"] = _trade_csv(_csv_path(path.parent, row.pop("tradesCsv"), output_path))
        if "activityFile" in row:
            from .activity import load_activity_file
            if "activity" in row:
                raise ValueError("supply either activity or activityFile")
            source = _csv_path(path.parent, row.pop("activityFile"), output_path)
            row["activity"] = load_activity_file(source, output=output_path)
        elif "activity" in row:
            from .activity import build_activity
            row["activity"] = build_activity(row["activity"], base_dir=path.parent, output=output_path)
        for diagnostic in _array(row.get("diagnostics", []), "diagnostics"):
            if isinstance(diagnostic, dict) and "csv" in diagnostic:
                _diagnostic_csv(diagnostic, _csv_path(path.parent, diagnostic.pop("csv"), output_path))
    return validate_bundle(config)
