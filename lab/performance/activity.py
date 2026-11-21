"""Historical broker-close activity and overnight USD requirements. Standard library only.

A snapshot describes the entire portfolio at its supplied session label. Authoritative
amounts use broker_requirement or required_equity. Blank fields are independent gaps.
An optional sessionDates list declares expected broker sessions. Missing labels are
never inferred from an equity calendar. timeZone sets the civil-date bounds (default
UTC). A supplied closeTime also filters the session by its exact timestamp.

Position records are per session/account/symbol/strategyId, with signed closeQty and
optional heldDuring. intradayComplete and closeComplete certify each scope separately.
Global declarations apply to dates with ledger records. An empty day needs explicit
per-row completeness and a supplied position ledger. No holdings carry forward.

marginModel="simple_net" declares a linear, additive schedule without cross-product
credits, fixed minimums or complex instruments. Complex legs or opposing net sides
across symbols in one account require a broker amount. Each rule's inclusive validFrom
and validTo bound its use. Per-contract rates already include the contract size.
Account-specific rules take precedence. Within a scope, an exact symbol takes
precedence over its product. An overlap at the selected priority is ambiguous.
Notional fractions require a closing price, currency and explicit multiplier. Dated FX
is USD per unit of the rule currency. Only the rate for the same session qualifies.
"""

import math
from bisect import bisect_right
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from fractions import Fraction
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .inputs import (_array, _csv_number, _csv_path, _csv_rows, _fields, _json_value,
                     _number, _read_json, _text, parse_time)


BROKER_BASES = ("broker_requirement", "required_equity")
BASES = (*BROKER_BASES, "schedule_estimate", "unknown")
COUNTS = ("active", "overnight")
MEASURES = {*COUNTS, "marginUsd"}
COVERAGE = {"intradayComplete", "closeComplete"}
DESCRIPTIVE = {"metadata", "description", "notes"}
CSV_TABLES = {"rows": ("csv", ("date",)),
              "positions": ("positionsCsv", ("date", "account", "strategyId", "symbol")),
              "rules": ("rulesCsv", ("id", "validFrom", "validTo", "side", "method")),
              "fx": ("fxCsv", ("date", "currency", "usdPerUnit")),
              "accountTotals": ("accountTotalsCsv", ("date", "account", "marginUsd", "marginBasis"))}
NUMBERS = MEASURES | {"price", "multiplier", "closeQty", "usdPerUnit", "rate"}
FLAGS = COVERAGE | {"heldDuring", "complex"}
DAY_MS = 86_400_000
EPOCH = date(1970, 1, 1)
AMBIGUOUS = object()


def _day(value):
    if isinstance(value, str) and len(value) == 10:
        try:
            if date.fromisoformat(value).isoformat() == value:
                return value
        except ValueError:
            pass
    raise ValueError(f"activity requires a valid YYYY-MM-DD session date, got {value!r}")


def _flag(value, name):
    if type(value) is not bool:
        raise ValueError(f"activity.{name} must be true or false")
    return value


def _positive(value, field):
    if _number(value, field) <= 0:
        raise ValueError(f"{field} must be positive")
    return value


def _cash(value, field):
    if _number(value, field) < 0:
        raise ValueError(f"{field} must be nonnegative")
    return value


def _fraction(value):
    return Fraction(value) if isinstance(value, int) else Fraction(str(value))


def _as_number(amount):
    try:
        value = float(amount)
    except OverflowError as exc:
        raise ValueError("activity calculation exceeds the supported numeric range") from exc
    if not math.isfinite(value) or (value == 0 and amount != 0):
        raise ValueError("activity calculation exceeds the supported numeric range")
    return value


def _account_ids(value):
    result = set()
    for account in _array(value, "activity.accountIds"):
        account = _text(account, "activity.accountIds")
        if account in result:
            raise ValueError("activity.accountIds must be unique")
        result.add(account)
    if not result:
        raise ValueError("activity.accountIds must name at least one account")
    return result


def _metadata(record):
    if "metadata" in record:
        if not isinstance(record["metadata"], dict):
            raise ValueError("activity metadata must be an object")
        _json_value(record["metadata"], "activity.metadata")
    if "description" in record:
        _text(record["description"], "activity.description", allow_empty=True)
    if "notes" in record:
        for note in _array(record["notes"], "activity.notes"):
            _text(note, "activity.notes", allow_empty=True)
    return {key: record[key] for key in DESCRIPTIVE if key in record}


def _csv_records(path, columns):
    for line, fields in _csv_rows(path, columns):
        record = {}
        try:
            for key, raw in fields.items():
                value = raw.strip()
                if not value:
                    continue
                if key in NUMBERS:
                    number = _csv_number(value, key)
                    if key in COUNTS:
                        exact = Decimal(value)
                        if not 0 <= exact <= 2**53 - 1 or exact != exact.to_integral_value():
                            raise ValueError(f"{key} must be a nonnegative whole count")
                        number = int(exact)
                    elif number == 0 and Decimal(value) != 0:
                        raise ValueError(f"{key} is too small to represent")
                    record[key] = number
                elif key in FLAGS:
                    if value.lower() not in ("true", "false"):
                        raise ValueError(f"{key} must be true or false")
                    record[key] = value.lower() == "true"
                else:
                    record[key] = value
        except (ValueError, InvalidOperation) as exc:
            raise ValueError(f"{path}:{line}: {exc}") from exc
        yield record


def _tables(spec, base_dir, output):
    validated = {}
    for table, (key, columns) in CSV_TABLES.items():
        if key in spec:
            if table in spec:
                raise ValueError(f"activity: supply either {key} or {table}")
            if base_dir is None:
                raise ValueError(f"relative activity.{key} requires a manifest directory")
            path = _csv_path(base_dir, spec[key], output)
            validated[table] = _csv_records(path, columns)
        else:
            validated[table] = _array(spec.get(table, []), f"activity.{table}")
    return validated


class _Positions:
    """One session of evidence. Count strategies before netting margin by account and symbol."""

    def __init__(self):
        self.legs = defaultdict(dict)
        self.known = {k: set() for k in COUNTS}
        self.uncertain = {k: set() for k in COUNTS}

    def add(self, row):
        required = {"date", "account", "strategyId", "symbol"}
        allowed = required | {"closeQty", "heldDuring", "product", "price", "multiplier", "currency", "complex", "offsetGroup"}
        _fields(row, required, allowed, "activity position")
        account, symbol, strategy = (_text(row[k], f"position.{k}") for k in ("account", "symbol", "strategyId"))
        group = self.legs[account, symbol]
        if strategy in group:
            raise ValueError(f"duplicate closing position for {row['date']} / {account} / {symbol} / {strategy}")
        for k in ("product", "currency", "offsetGroup"):
            if row.get(k) is not None:
                _text(row[k], f"position.{k}")
        if row.get("price") is not None:
            _number(row["price"], "position.price")
        if row.get("multiplier") is not None:
            _positive(row["multiplier"], "position.multiplier")
        if "complex" in row:
            _flag(row["complex"], "complex")
        qty, held = row.get("closeQty"), row.get("heldDuring")
        if held is not None:
            _flag(held, "heldDuring")
        if qty is not None:
            _number(qty, "position.closeQty")
        if qty and held is False:
            raise ValueError("nonzero closeQty conflicts with heldDuring=false")
        if qty is None and held is False:
            qty = 0
        group[strategy] = row if "closeQty" in row and row["closeQty"] == qty else dict(row, closeQty=qty)
        states = {"overnight": None if qty is None else qty != 0, "active": True if qty else held}
        for key, status in states.items():
            if status is True:
                self.known[key].add(strategy)
            elif status is None:
                self.uncertain[key].add(strategy)

    def count(self, key, declared, complete):
        known, uncertain = self.known[key], self.uncertain[key]
        if declared is not None:
            if declared < len(known) or (complete and declared > len(known | uncertain)):
                raise ValueError(f"activity.{key} count disagrees with the dated position ledger")
            return declared
        return len(known) if complete and uncertain.issubset(known) else None


def _rule(row):
    required = {"id", "validFrom", "validTo", "side", "method"}
    _fields(row, required, required | {"symbol", "product", "account", "multiplier", "rate", "currency"}, "activity margin rule")
    for key in ("id", "method"):
        _text(row[key], f"rule.{key}")
    if row.get("currency") is not None:
        _text(row["currency"], "rule.currency")
    selectors = [k for k in ("symbol", "product") if row.get(k) is not None]
    if len(selectors) != 1:
        raise ValueError("a margin rule needs exactly one symbol or product")
    kind = selectors[0]
    selector = _text(row[kind], f"rule.{kind}")
    if any(c in selector for c in "*?[]"):
        raise ValueError("margin rules require an exact symbol or product")
    account = row.get("account")
    if account is not None:
        _text(account, "rule.account")
    if row["side"] not in ("long", "short"):
        raise ValueError("margin rule side must be long or short")
    if row.get("rate") is not None:
        _cash(row["rate"], "rule.rate")
    if row.get("multiplier") is not None:
        _positive(row["multiplier"], "rule.multiplier")
    start, end = (date.fromisoformat(_day(row[k])).toordinal() for k in ("validFrom", "validTo"))
    if end < start:
        raise ValueError("margin rule validTo must be on or after validFrom")
    return (account, kind, selector, row["side"]), start, end


class _Schedule:
    """Index inclusive effective windows. An overlapping rate is unknown only while both apply."""

    def __init__(self, rules):
        events = defaultdict(lambda: defaultdict(list))
        ids = set()
        for row in rules:
            key, start, end = _rule(row)
            if row["id"] in ids:
                raise ValueError(f"duplicate margin rule id {row['id']!r}")
            ids.add(row["id"])
            events[key][start].append((row["id"], row))
            events[key][end + 1].append((row["id"], None))
        self.intervals = {}
        for key, changes in events.items():
            starts, applicable, live = sorted(changes), [], {}
            for day in starts:
                for ident, row in changes[day]:
                    if row is None:
                        del live[ident]
                    else:
                        live[ident] = row
                applicable.append(AMBIGUOUS if len(live) > 1 else next(iter(live.values()), None))
            self.intervals[key] = starts, applicable

    def lookup(self, day, account, symbol, product, side):
        for scope in (account, None):
            for kind, name in (("symbol", symbol), ("product", product)):
                bounds = self.intervals.get((scope, kind, name, side))
                if bounds is not None:
                    starts, applicable = bounds
                    index = bisect_right(starts, day) - 1
                    if index >= 0 and applicable[index] is not None:
                        return applicable[index]
        return None


def _fx_quotes(records):
    quotes = {}
    for row in records:
        keys = {"date", "currency"}
        _fields(row, keys, keys | {"usdPerUnit"}, "activity FX quote")
        key = (_day(row["date"]), _text(row["currency"], "FX currency"))
        rate = row.get("usdPerUnit")
        if rate is not None:
            _positive(rate, "usdPerUnit")
        if key in quotes or (key[1] == "USD" and rate not in (1, None)):
            raise ValueError(f"duplicate or inconsistent FX quote for {key}")
        quotes[key] = rate
    return quotes


def _amount(row, allowed):
    value, basis = row.get("marginUsd"), row.get("marginBasis", "unknown")
    if basis not in allowed:
        raise ValueError(f"invalid activity marginBasis {basis!r}")
    if value is not None:
        _cash(value, "marginUsd")
        if basis == "unknown":
            raise ValueError("a USD amount requires an explicit marginBasis")
    return value, basis


def _totals_by_day(records):
    totals = defaultdict(dict)
    for row in records:
        _fields(row, {"date", "account"}, {"date", "account", "marginUsd", "marginBasis"}, "activity account total")
        day, account = _day(row["date"]), _text(row["account"], "account total id")
        if account in totals[day]:
            raise ValueError(f"duplicate USD total for {day} / {account}")
        _amount(row, (*BROKER_BASES, "unknown"))
        totals[day][account] = row
    return totals


def _account_margin(totals, accounts, positions):
    if accounts is None:
        return None, "Declare accountIds to establish the full scope of the account totals."
    if {a for a, _ in positions.legs} - accounts or totals.keys() - accounts:
        return None, "The account scope conflicts with the supplied records."
    missing = sorted(a for a in accounts if a not in totals or totals[a].get("marginUsd") is None)
    if missing:
        return None, "Missing dated account amount for " + ", ".join(missing) + "."
    bases = {totals[a]["marginBasis"] for a in accounts}
    if len(bases) != 1:
        return None, "The accounts do not share a common margin basis."
    components = [{"account": a, "marginUsd": totals[a]["marginUsd"]} for a in sorted(accounts)]
    total = sum(_fraction(c["marginUsd"]) for c in components)
    return {"marginUsd": _as_number(total), "marginBasis": bases.pop(), "marginDetails": {"accounts": components}}, None


def _component(day, ordinal, account, symbol, legs, schedule, quotes):
    qty = Fraction()
    attributes = defaultdict(set)
    for row in legs.values():
        if row["closeQty"] is None:
            return None, f"Missing closing quantity for {account}/{symbol}."
        if row["closeQty"] == 0:
            continue
        if row.get("complex") or row.get("offsetGroup"):
            return None, f"Complex or offset positions in {account}/{symbol} need an account requirement."
        qty += _fraction(row["closeQty"])
        for attr in ("price", "multiplier", "product", "currency"):
            if row.get(attr) is not None:
                attributes[attr].add(row[attr])
    if any(len(values) > 1 for values in attributes.values()):
        return None, f"Inconsistent closing contract data for {account}/{symbol}."
    data = {key: next(iter(values)) for key, values in attributes.items()}
    detail = {"account": account, "symbol": symbol, "netQty": _as_number(qty)}
    if not qty:
        return (detail, Fraction()), None
    side = "long" if qty > 0 else "short"
    record = schedule.lookup(ordinal, account, symbol, data.get("product"), side)
    if record is AMBIGUOUS:
        return None, f"An ambiguous {side} rule applies to {account}/{symbol}."
    if record is None:
        return None, f"No effective {side} margin rule for {account}/{symbol}."
    if record["method"] not in ("per_contract", "notional_fraction"):
        return None, f"Unsupported margin method {record['method']} for {account}/{symbol}."
    if record.get("rate") is None or record.get("currency") is None:
        return None, f"Missing historical rate or currency for {account}/{symbol}."
    currency = record["currency"]
    fx = 1 if currency == "USD" else quotes.get((day, currency))
    if fx is None:
        return None, f"Missing same-session {currency}-to-USD FX for {account}/{symbol}."
    base = abs(qty)
    if record["method"] == "notional_fraction":
        multiplier = data.get("multiplier", record.get("multiplier"))
        if multiplier is None or "price" not in data or data.get("currency") != currency:
            return None, f"A matching closing price, currency and multiplier are required for {account}/{symbol}."
        if record.get("multiplier") is not None and record["multiplier"] != multiplier:
            return None, f"Inconsistent notional multiplier for {account}/{symbol}."
        base *= abs(_fraction(data["price"])) * _fraction(multiplier)
        detail.update(price=data["price"], multiplier=multiplier)
    amount = base * _fraction(record["rate"]) * _fraction(fx)
    detail.update(side=side, ruleId=record["id"], method=record["method"], rate=record["rate"], currency=currency,
                  usdPerUnit=fx, validFrom=record["validFrom"], validTo=record["validTo"])
    return (detail, amount), None


def _estimate(day, positions, schedule, quotes):
    ordinal = date.fromisoformat(day).toordinal()
    components, sides = [], {}
    total = Fraction()
    for (account, symbol), legs in sorted(positions.legs.items()):
        component, reason = _component(day, ordinal, account, symbol, legs, schedule, quotes)
        if reason:
            return None, reason
        detail, amount = component
        side = detail.get("side")
        if side and sides.setdefault(account, side) != side:
            return None, f"Mixed long and short symbols in {account} need broker offset treatment."
        components.append(dict(detail, marginUsd=_as_number(amount)))
        total += amount
    return {"marginUsd": _as_number(total), "marginBasis": "schedule_estimate", "marginDetails": {"components": components}}, None


def _snapshot(row):
    available = {"date", "marginBasis", "closeTime", "gaps", "marginDetails", "accountIds", "marginModel"}
    _fields(row, {"date"}, available | MEASURES | COVERAGE | DESCRIPTIVE, "activity snapshot")
    _day(row["date"])
    result = {"date": row["date"], **_metadata(row)}
    if "closeTime" in row:
        result["closeTime"] = parse_time(row["closeTime"])
    for key in COUNTS:
        value = row.get(key)
        if value is not None:
            _number(value, key)
            if value < 0 or value != int(value) or value > 2**53 - 1:
                raise ValueError(f"activity.{key} must be a nonnegative whole count")
            value = int(value)
        result[key] = value
    if "gaps" in row:
        gaps = row["gaps"]
        _fields(gaps, set(), MEASURES, "activity.gaps")
        result["gaps"] = {k: _text(v, f"gaps.{k}") for k, v in gaps.items()}
    result["marginUsd"], result["marginBasis"] = _amount(row, BASES)
    if "marginDetails" in row:
        if not isinstance(row["marginDetails"], dict):
            raise ValueError("activity.marginDetails must be an object")
        _json_value(row["marginDetails"], "activity.marginDetails")
        result["marginDetails"] = row["marginDetails"]
    for key in COVERAGE & row.keys():
        result[key] = _flag(row[key], key)
    if "marginModel" in row:
        result["marginModel"] = _text(row["marginModel"], "activity.marginModel")
    if "accountIds" in row:
        result["accountIds"] = _account_ids(row["accountIds"])
    return result


def _session(day, snapshot, positions, has_ledger, defaults, totals, schedule, quotes):
    row = dict(snapshot)
    supplied_gaps = row.pop("gaps", {})
    gaps = {}
    complete = {key: row.pop(key, bool(positions.legs) and defaults[key]) and has_ledger for key in COVERAGE}
    model = row.pop("marginModel", defaults["marginModel"])
    accounts = row.pop("accountIds", defaults["accountIds"])
    for key, coverage in (("active", "intradayComplete"), ("overnight", "closeComplete")):
        row[key] = positions.count(key, row.get(key), complete[coverage])
        if row[key] is None:
            gaps[key] = supplied_gaps.get(key, f"The session lacks a complete {key} strategy count.")
    if row["active"] is not None and row["overnight"] is not None and row["active"] < row["overnight"]:
        raise ValueError(f"{day}: overnight cannot exceed active")
    # A plain canonical snapshot may carry a separately sourced and labeled estimate.
    # If the caller also supplies accounting evidence, prefer the dated broker totals
    # or compute from that evidence. An old estimate cannot certify an unsupported day.
    external_estimate = row.get("marginBasis") == "schedule_estimate"
    has_new_evidence = has_ledger or totals or model is not None
    if row.get("marginUsd") is None or (external_estimate and has_new_evidence):
        row.pop("marginDetails", None)
        amount = None
        if totals:
            amount, reason = _account_margin(totals, accounts, positions)
        elif model != "simple_net":
            reason = "No account amount or applicable simple overnight model was supplied."
        elif not complete["closeComplete"]:
            reason = "The closing position ledger is incomplete."
        elif accounts is not None and {a for a, _ in positions.legs} - accounts:
            reason = "The closing positions exceed the declared account scope."
        else:
            amount, reason = _estimate(day, positions, schedule, quotes)
        if amount is None:
            row.update(marginUsd=None, marginBasis="unknown")
            gaps["marginUsd"] = supplied_gaps.get("marginUsd", reason)
        else:
            row.update(amount)
    if gaps:
        row["gaps"] = gaps
    return row


def _session_labels(spec, supplied):
    if supplied is not None and "sessionDates" in spec:
        raise ValueError("supply activity.sessionDates or session_dates only once")
    declared = spec.get("sessionDates") if supplied is None else supplied
    if declared is None:
        return None
    labels = _array(declared, "activity.sessionDates")
    previous = ""
    for day in labels:
        if _day(day) <= previous:
            raise ValueError("activity.sessionDates must be unique and strictly increasing")
        previous = day
    return labels


def build_activity(spec, *, session_dates=None, base_dir=None, output=None):
    """Compile portfolio snapshots and optional dated ledgers. Raw tables stay outside the browser payload."""
    allowed = {"source", "sessionDates", "timeZone", "marginModel", "accountIds"} | COVERAGE | DESCRIPTIVE
    allowed.update(CSV_TABLES)
    allowed.update(key for key, _ in CSV_TABLES.values())
    _fields(spec, {"source"}, allowed, "activity")
    result = {"source": _text(spec["source"], "activity.source"), **_metadata(spec)}
    if "timeZone" in spec:
        zone = _text(spec["timeZone"], "activity.timeZone")
        try:
            ZoneInfo(zone)
        except (ValueError, ZoneInfoNotFoundError) as exc:
            raise ValueError(f"unknown activity.timeZone {zone!r}") from exc
        result["timeZone"] = zone
    labels = _session_labels(spec, session_dates)
    target = Path(output).resolve() if output is not None else None
    tables = _tables(spec, Path(base_dir) if base_dir is not None else None, target)
    defaults = {k: _flag(spec.get(k, False), k) for k in COVERAGE}
    defaults["marginModel"] = _text(spec["marginModel"], "activity.marginModel") if "marginModel" in spec else None
    defaults["accountIds"] = _account_ids(spec["accountIds"]) if "accountIds" in spec else None
    snapshots, ledger = {}, defaultdict(_Positions)
    previous = ""
    for raw in tables["rows"]:
        row = _snapshot(raw)
        day = row["date"]
        if day <= previous:
            raise ValueError("activity snapshot dates must be unique and strictly increasing")
        previous = day
        snapshots[day] = row
    for raw in tables["positions"]:
        if not isinstance(raw, dict):
            raise ValueError("activity position must be an object")
        ledger[_day(raw.get("date"))].add(raw)
    schedule = _Schedule(tables["rules"])
    quotes = _fx_quotes(tables["fx"])
    totals = _totals_by_day(tables["accountTotals"])
    dates = snapshots.keys() | ledger.keys() | totals.keys()
    if labels is not None:
        extra = dates.difference(labels)
        if extra:
            raise ValueError(f"activity session {min(extra)} is outside the supplied broker calendar")
        dates = labels
    else:
        dates = sorted(dates)
    empty = _Positions()
    has_ledger = "positions" in spec or "positionsCsv" in spec
    result["rows"] = [_session(day, snapshots.get(day, {"date": day}), ledger.get(day, empty), has_ledger,
                               defaults, totals.get(day), schedule, quotes) for day in dates]
    return result


def load_activity_file(path, *, output=None, session_dates=None):
    """Read a JSON activity sidecar or a dated snapshot CSV. Resolve its CSV references beside the file."""
    path = Path(path)
    if output is not None and path.resolve() == Path(output).resolve():
        raise ValueError("output would replace the activity input file")
    if path.suffix.lower() == ".json":
        spec = _read_json(path)
    elif path.suffix.lower() == ".csv":
        spec = {"source": path.name, "csv": path.name}
    else:
        raise ValueError("activity file must be a local JSON object or snapshot CSV")
    return build_activity(spec, session_dates=session_dates, base_dir=path.parent, output=output)


def _ordinal(mark, zone):
    if zone is None:
        return EPOCH.toordinal() + mark // DAY_MS
    try:
        utc = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=mark)
        return utc.astimezone(zone).date().toordinal()
    except OverflowError as exc:
        raise ValueError("equity date is outside the supported activity time zone range") from exc


def validate_activity(spec, first, last, terminal):
    """Validate the full source horizon before truncating at the first nonpositive equity mark."""
    result = build_activity(spec)
    zone = ZoneInfo(result["timeZone"]) if "timeZone" in result else None
    first_day, last_day, end_day = (_ordinal(mark, zone) for mark in (first, last, terminal))
    keep = []
    previous = None
    for row in result["rows"]:
        ordinal = date.fromisoformat(row["date"]).toordinal()
        if not first_day <= ordinal <= last_day:
            raise ValueError(f"{row['date']}: activity session outside the source equity history")
        include = ordinal <= end_day
        if "closeTime" in row:
            t = row["closeTime"]
            if not first <= t <= last or (previous is not None and previous >= t):
                raise ValueError(f"{row['date']}: activity closeTime outside the equity history or out of order")
            previous = t
            include = include and t <= terminal
        if include:
            keep.append(row)
    result["rows"] = keep
    return result
