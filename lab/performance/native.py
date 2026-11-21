"""Export Quantreo saved strategies and the existing all-candidate book construction.

Native construction always sizes on the upstream 365-period basis. Report ratios use 365
for a seven-day UTC calendar or 252 for weekdays. The default recognizes weekday-only
histories spanning at least two weeks and containing all five weekdays. A local session
calendar can specify another annualizer. Expected dates are independent of observed marks.
"""

import json
import math
import re
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

from lab import book_report, strategy_report
from lab.portfolio import read_runs
from lab.sheets import sheet_path

from .build import render_bundle
from .inputs import equity_from_returns, parse_time, validate_bundle


RUN_ID = re.compile(r"^\d{8}-\d{6}-(train\+validation|train|validation|test)-(.+)$")
BAR_SIZE = {"D": "1D", "h": "1h", "min": "1min", "H": "1h", "T": "1min"}
DAY_MS = 86_400_000
MS = pd.Timedelta(milliseconds=1)
EPOCH = pd.Timestamp("1970-01-01", tz="UTC")


def render_native(bundle, output, *, imports=(), session_dates=None):
    """Write the optional HTML without replacing a saved input or a test lock."""
    destination = Path(output).resolve()
    run_file = (destination.parent / "daily.parquet").is_file() and (destination.parent / "summary.json").is_file()
    if destination.name == "TEST_DONE" or (run_file and destination.exists() and destination.suffix in (".parquet", ".json", ".csv")):
        raise ValueError(f"HTML output would overwrite a protected native artifact: {destination.name}")
    if any(destination == (book_report.ROOT / file).resolve() for _, file, _ in imports):
        raise ValueError("HTML output would overwrite an imported contributions file")
    if isinstance(session_dates, (str, Path)) and destination == Path(session_dates).resolve():
        raise ValueError("HTML output would overwrite the supplied session calendar")
    return render_bundle(bundle, output)


def _runs(directory, require_test):
    lock_path = directory / "TEST_DONE"
    lock = None
    variant = "base"
    if lock_path.exists():
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
        if not isinstance(lock, dict) or not isinstance(lock.get("variant"), str) or not isinstance(lock.get("run"), str):
            raise ValueError("TEST_DONE requires a frozen variant and a specific test run id")
        variant = lock["variant"]
        match = RUN_ID.fullmatch(lock["run"])
        if not match or match.groups() != ("test", variant):
            raise ValueError("TEST_DONE does not identify a test run of its frozen variant")
    elif require_test:
        raise ValueError(f"{directory.name}: its test is still sealed")

    # The saver puts the period and variant in the directory name. Inspect only eligible summaries.
    chosen = {}
    for path in sorted(directory.iterdir()):
        match = RUN_ID.fullmatch(path.name)
        if not match or match[2] != variant or match[1] == "test":
            continue
        if (path / "summary.json").is_file() and (path / "daily.parquet").is_file():
            chosen[match[1]] = path
    if lock is not None:
        path = directory / lock["run"]
        if not (path / "summary.json").is_file() or not (path / "daily.parquet").is_file():
            raise ValueError("TEST_DONE refers to a missing or incomplete test run")
        chosen["test"] = path
    if not chosen:
        raise ValueError(f"{directory.name}: no complete saved run for variant {variant!r}")
    return chosen, variant, lock


def _read_period(path, summary, lower, upper):
    # Native summaries use inclusive UTC dates. The parquet predicate also excludes stray
    # warm-up or sealed rows physically stored outside the admitted span.
    start = max(date.fromisoformat(summary["start"]), date.fromisoformat(lower))
    end = date.fromisoformat(summary["end"])
    if upper is not None:
        end = min(end, date.fromisoformat(upper))
    if end < start:
        return pd.DataFrame()
    schema = pq.read_schema(path)
    index = (schema.pandas_metadata or {}).get("index_columns", [])
    if len(index) != 1 or not isinstance(index[0], str) or "total" not in schema.names:
        raise ValueError(f"{path.name} requires the native datetime index and total column")
    tz = getattr(schema.field(index[0]).type, "tz", None)
    a, b = pd.Timestamp(start), pd.Timestamp(end) + pd.Timedelta(days=1)
    if tz is not None:
        a, b = a.tz_localize("UTC"), b.tz_localize("UTC")
    columns = [k for k in ("total", "cost", "funding", "liquidation") if k in schema.names]
    frame = pd.read_parquet(path, columns=columns, engine="pyarrow",
                            filters=[(index[0], ">=", a.to_pydatetime()), (index[0], "<", b.to_pydatetime())])
    frame.index = pd.to_datetime(frame.index, utc=True)
    if not frame.index.is_monotonic_increasing or not frame.index.is_unique:
        raise ValueError(f"{path.name} requires strictly increasing original bars")
    if not np.isfinite(frame.to_numpy(dtype=float)).all():
        raise ValueError(f"{path.name} contains missing or nonfinite native P&L")
    bar = summary.get("bar", (summary.get("engine") or {}).get("freq", "D"))
    if bar not in BAR_SIZE:
        raise ValueError(f"unsupported native bar size {bar!r}")
    size = pd.Timedelta(BAR_SIZE[bar])
    if not frame.index.floor(size).equals(frame.index):
        raise ValueError(f"{path.name} contains timestamps off the {bar} bar grid")
    frame["close"] = frame.index + size - MS
    return frame


def _stitch(older, newer):
    """Replace bars fully covered by the newer marks. Preserve holes between newer intervals."""
    if older.empty:
        return newer
    starts, ends = newer.index, pd.DatetimeIndex(newer["close"])
    breaks = starts[1:] != ends[:-1] + MS
    left = starts[np.r_[True, breaks]]
    right = ends[np.r_[breaks, True]]
    # For each older bar, the first newer span ending on or after its open is
    # the only span that can fully cover it. Two spans have a real gap between them.
    pos = right.searchsorted(older.index)
    candidate = np.minimum(pos, len(right) - 1)
    old_end = pd.DatetimeIndex(older["close"])
    overlap = (pos < len(right)) & (old_end >= left[candidate])
    if (overlap & ((older.index < left[candidate]) | (old_end > right[candidate]))).any():
        raise ValueError("partial coverage by overlapping runs would split an existing native bar")
    return pd.concat([older.loc[~overlap], newer]).sort_index()


def _book_days(frame, run_id):
    """Aggregate observed bars only. A missing intraday bar makes its daily contribution unverifiable."""
    index = frame.index
    size = frame["close"].iloc[0] - index[0] + MS
    if size < pd.Timedelta(days=1):
        breaks = np.flatnonzero(index[1:] != index[:-1] + size)
        if len(breaks):
            first = index[breaks[0]] + size
            next_bar = index[breaks[0] + 1]
            raise ValueError(f"{run_id}: {first.isoformat()} to {next_bar.isoformat()} has missing intraday bars. "
                             "Daily construction requires recorded P&L. Upstream resampling can report an empty day as zero.")
        if len(index) == 1 and index[0] != index[0].normalize():
            raise ValueError(f"{run_id}: the upstream book cannot align a single non-midnight intraday bar to a daily close")
    days = index.normalize()
    daily = frame["total"].groupby(days).sum().to_frame()
    daily["open"] = index.to_series().groupby(days).first()
    daily["close"] = frame["close"].groupby(days).last()
    return daily


def _stitch_book_days(older, newer):
    if older.empty:
        return newer
    common = older.index.intersection(newer.index)
    old, new = older.loc[common], newer.loc[common]
    partial = (new["open"] > old["open"]) | (new["close"] < old["close"])
    if partial.any():
        day = partial[partial].index[0].date()
        raise ValueError(f"{day}: a partial daily overlap would discard scored bars in the native book")
    return pd.concat([older.drop(common), newer]).sort_index()


def _capital(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError("opening capital must be a positive finite number")
    return value


def _strategy(name, currency, capital, require_test):
    _, train, valid, test_start = strategy_report.periods_of(name)
    directory = strategy_report.results_dir(name)
    chosen, variant, lock = _runs(directory, require_test)
    before_test = (date.fromisoformat(test_start) - timedelta(days=1)).isoformat()
    rows = pd.DataFrame()
    sources = []
    for period in ("train", "validation", "train+validation", "test"):
        if period not in chosen:
            continue
        folder = chosen[period]
        summary = json.loads((folder / "summary.json").read_text(encoding="utf-8"))
        if (summary.get("strategy"), summary.get("period"), summary.get("variant"), summary.get("run_id")) != (
                name, period, variant, folder.name):
            raise ValueError(f"{'TEST_DONE ' if period == 'test' else ''}run identity mismatch for {folder.name}")
        if period == "test" and any(lock[k] != summary.get(k) for k in ("code_sha", "lab_sha") if k in lock):
            raise ValueError("TEST_DONE hashes disagree with the saved test summary")
        if period == "test":
            if summary["end"] < test_start:
                raise ValueError("TEST_DONE identifies a run that ended before its test period")
            # The pinned, scored test ledger can include its entry debit on the preceding close.
            lo, hi = summary["start"], None
        elif require_test:
            if summary["end"] >= test_start:
                raise ValueError(f"{folder.name}: a pre-test ledger includes test dates outside its recorded test run")
            lo, hi = summary["start"], None
        else:
            lo, hi = train[0], min(valid[1], before_test)
        frame = _read_period(folder / "daily.parquet", summary, lo, hi)
        if frame.empty:
            if period == "test":
                raise ValueError("TEST_DONE test run has no marks in the recorded test period")
            continue
        if period == "test" and frame.index[-1].date() < date.fromisoformat(test_start):
            raise ValueError("TEST_DONE test run has no marks in the recorded test period")
        source = {"id": folder.name, "period": period,
                  **{k: summary[k] for k in ("code_sha", "lab_sha") if summary.get(k)}}
        if require_test:
            daily = _book_days(frame, folder.name)
            zero_days = daily["total"].eq(0)
            partial = (daily["open"] != daily.index) | (daily["close"] + MS != daily.index + pd.Timedelta(days=1))
            source["partialUtcDays"] = [d.date().isoformat() for d in daily.index[partial]]
            rows = _stitch_book_days(rows, daily)
        else:
            zero_days = frame["total"].groupby(frame.index.normalize()).sum().eq(0)
            rows = _stitch(rows, frame)
        span = (zero_days.index[-1] - zero_days.index[0]).days + 1
        source.update(recordedUtcDays=len(zero_days), recordedZeroNetDays=int(zero_days.sum()),
                      unrecordedUtcDays=span - len(zero_days))
        sources.append(source)
    if not sources:
        raise ValueError(f"{name}: no scored bars in the permitted periods")
    try:
        card = strategy_report.frontmatter(sheet_path(name))
    except FileNotFoundError:
        card = {}
    item = {"id": name, "name": name, "kind": "strategy", "currency": currency,
            "frequency": "daily", "periodsPerYear": book_report.A,
            "accounting": "Net P&L on fixed initial capital", "source": "Quantreo saved run ledger",
            "evidence": {"type": "native", "method": "Add each scored bar's net contribution to initial capital.",
                         "runs": sources, "variant": variant, "openedTest": lock is not None,
                         "splits": {"train": list(train), "validation": list(valid), "testStart": test_start}},
            "notes": ["Each bar is marked at its final UTC millisecond. Ratios use UTC daily closes.",
                      "The native trade log records rebalances. Closed-trade P&L is unavailable."]}
    for source, target in (("asset", "assetClass"), ("family", "family"), ("status", "status")):
        if card.get(source):
            item[target] = card[source]
    # Both upstream reports start at the first nonzero net contribution. An
    # all-zero ledger retains its first row, as in the upstream idxmax rule.
    first = int(rows["total"].ne(0).to_numpy().argmax())
    rows = rows.iloc[first:]
    item["evidence"]["preScoreDaysRemoved" if require_test else "preScoreBarsRemoved"] = first
    item["evidence"]["zeroDayBasis"] = ("A recorded zero is a source ledger value. The engine can record zero on a "
                                       "calendar day without a market quote. Quote coverage is unavailable.")
    if require_test:
        return item, rows["total"]
    item["evidence"]["openingBasis"] = "Initial capital one millisecond before the first scored bar opens in UTC."
    # Label each bar by its last UTC millisecond so its P&L belongs to its source day.
    item["times"] = [int((rows.index[0] - EPOCH) // MS) - 1, *((rows["close"] - EPOCH) // MS).tolist()]
    item["equity"] = equity_from_returns(rows["total"], capital, "contributions")
    metrics = {"barCount": len(rows), "netContributionOnInitialCapital": float(rows["total"].sum())}
    for column in ("funding", "liquidation"):
        if column in rows and rows[column].notna().all():
            metrics[column + "Pnl"] = capital * float(rows[column].sum())
    item["sourceMetrics"] = metrics
    if "cost" in rows and rows["cost"].notna().all():
        expense = -capital * float(rows["cost"].sum())
        field = "total" if "liquidation" in rows and rows["liquidation"].eq(0).all() else "reportedCost"
        item["costs"] = {"currency": currency, field: expense}
        item["costModel"] = ("The saved cost column includes source execution charges and any borrow booked there. "
                             "The liquidation P&L column includes separate forced-exit effects.")
    return item, rows["total"]


def _bundle(title, series, description):
    return validate_bundle({"version": 1, "title": title, "description": description, "series": series})


def _exchange_calendar(value):
    if isinstance(value, (str, Path)):
        with Path(value).open(encoding="utf-8-sig") as file:
            value = json.load(file)
    periods = 252
    if isinstance(value, dict):
        if value.keys() - {"sessionDates", "periodsPerYear"}:
            raise ValueError("session calendar accepts sessionDates and optional periodsPerYear")
        periods = value.get("periodsPerYear", periods)
        value = value.get("sessionDates")
    if type(periods) not in (float, int) or not math.isfinite(periods) or periods <= 0:
        raise ValueError("session calendar periodsPerYear must be a finite positive number")
    if not isinstance(value, list) or not value:
        raise ValueError("session calendar requires a nonempty list of ISO dates")
    previous = ""
    for day in value:
        try:
            if not isinstance(day, str) or date.fromisoformat(day).isoformat() != day or day <= previous:
                raise ValueError
        except ValueError as exc:
            raise ValueError("session calendar requires strictly increasing, unique YYYY-MM-DD dates") from exc
        previous = day
    return value, periods


def _apply_calendar(series, active, calendar, session_dates, imported=False):
    """Use the common output clock for ratios. Leave upstream scaling and net P&L intact."""
    if calendar not in (None, "daily", "weekday") or (calendar is not None and session_dates is not None):
        raise ValueError("select one calendar: daily, weekday, or a session-dates file")
    active = active.groupby(active.index.normalize()).any()
    days = active.index
    first, last = days[0].date(), days[-1].date()
    schedule = None
    if session_dates is not None:
        calendar = "exchange"
        schedule, periods = _exchange_calendar(session_dates)
        basis = "Caller-supplied exchange sessions. The calendar specifies the annualization factor or defaults to 252."
    else:
        if calendar is not None:
            basis = "Caller-declared UTC sampling calendar."
        elif (last - first).days >= 14 and set(days.day_of_week) == set(range(5)):
            calendar = "weekday"
            basis = "Inferred weekday convention from at least two weeks of weekday-only marks covering all five weekdays."
        elif not imported:
            calendar, basis = "daily", "Native seven-day UTC ledger convention."
        elif len(days) == (last - first).days + 1:
            calendar, basis = "daily", "Inferred seven-day convention from an uninterrupted common daily panel."
        else:
            raise ValueError("ambiguous imported session calendar; supply --calendar daily, --calendar weekday, or --session-dates")
        periods = 365 if calendar == "daily" else 252
        if calendar == "weekday":
            # Generate all weekdays in the touched years, including absent weekdays.
            # A calendar made from observed marks would conceal missing sessions.
            start = date((first - timedelta(days=1)).year, 1, 1)
            schedule = [d.date().isoformat() for d in pd.bdate_range(start, date(last.year, 12, 31))]
            basis += " Every Monday through Friday is expected. Exchange holidays need a supplied schedule."

    observed = {d.date().isoformat() for d in days}
    if schedule is None:
        expected = {d.date().isoformat() for d in pd.date_range(first, last)}
    else:
        expected = {d for d in schedule if first.isoformat() <= d <= last.isoformat()}
        outside = {d.date().isoformat() for d in days[active]} - expected
        if outside:
            raise ValueError(f"{min(outside)}: a nonzero contribution falls outside the declared session calendar")
        if not expected.intersection(observed):
            raise ValueError("session calendar has no common dates with the scored history")
    missing = expected - observed
    provenance = {"name": calendar, "basis": basis, "nativePeriodsPerYear": book_report.A,
                  "ratioPeriodsPerYear": periods, "missingExpectedSessions": len(missing),
                  "recordedOffSessionDays": len(observed - expected)}
    if missing:
        provenance["firstMissingSession"] = min(missing)
    for item in series:
        item["periodsPerYear"] = periods
        if schedule is not None:
            item["sessionDates"] = schedule
        item["evidence"]["calendar"] = provenance
        item.setdefault("notes", []).append(f"NAV ratios use {periods:g} periods per year. The native scaling basis is "
                                            f"{book_report.A} per year. Missing expected sessions have no imputed return.")


def strategy_bundle(name, *, currency="INDEX", opening_capital=1.0, calendar=None, session_dates=None):
    """Export the frozen strategy. Read its test solely from the run named in its lock."""
    item, net = _strategy(name, currency, _capital(opening_capital), require_test=False)
    _apply_calendar([item], net.ne(0), calendar, session_dates)
    return _bundle(name, [item], "Native strategy report from saved net P&L.")


def _imported(name, file, family, currency, opening_date):
    path = Path(file)
    if not path.is_absolute():
        path = book_report.ROOT / path
    if not path.is_file() or path.suffix not in (".csv", ".parquet"):
        raise ValueError(f"{name}: --import requires a preconverted daily contributions file (CSV or parquet)")
    # A saved run must pass the native selector, even when someone names a file inside it.
    if any((p / "daily.parquet").is_file() and (p / "summary.json").is_file() for p in path.resolve().parents):
        raise ValueError("use --strategy to export a saved native run")
    try:
        net, _, _ = read_runs([path])
    except (IndexError, KeyError) as exc:
        raise ValueError(f"{path.name}: expected dated net or total contributions") from exc
    net.index = pd.to_datetime(net.index, utc=True)
    if len(net) == 0 or not net.index.normalize().is_unique or not np.isfinite(net.to_numpy(dtype=float)).all():
        raise ValueError(f"{name}: expected one finite net contribution per UTC day")
    opening = parse_time(opening_date)
    if opening >= int((net.index[0].normalize() - EPOCH) // MS) + DAY_MS - 1:
        raise ValueError(f"{name}: opening date must precede the first imported close")
    item = {"id": name, "name": name, "kind": "strategy", "currency": currency,
            "family": family, "frequency": "daily", "periodsPerYear": book_report.A, "source": path.name,
            "accounting": "Net contributions on fixed initial capital", "status": "Imported",
            "evidence": {"type": "imported", "sourceOpeningTime": opening,
                         "method": "Caller-supplied daily net contributions in the common currency."}}
    return item, net


def book_bundle(name, strategies=(), imports=(), *, currency=None, opening_date=None, opening_capital=None,
                calendar=None, session_dates=None):
    """Export construct_compute's full all-candidate book and its standalone comparison series."""
    if not isinstance(currency, str) or not currency.strip():
        raise ValueError("supply --currency for the common, already converted capital basis of every input")
    if imports and (opening_date is None or opening_capital is None):
        raise ValueError("imported contributions require --opening-date and --opening-capital")
    capital = _capital(1.0 if opening_capital is None else opening_capital)
    desk = list(strategies or [])
    if not desk and not imports:
        desk = book_report.passed_strategies()
    names = desk + [entry[0] for entry in imports]
    if len(names) < 2 or len(set(names + [name])) != len(names) + 1:
        raise ValueError("a book requires at least two distinct strategy names and a separate portfolio name")
    members, nets, families = [], {}, {}
    for n in desk:
        item, nets[n] = _strategy(n, currency, capital, require_test=True)
        families[n] = item.get("family", n)
        members.append(item)
    for n, path, family in imports:
        item, nets[n] = _imported(n, path, family, currency, opening_date)
        families[n] = family
        members.append(item)

    scaled = pd.DataFrame({n: book_report.scale(net) for n, net in nets.items()}).dropna()
    if len(scaled) < 250:
        raise ValueError(f"only {len(scaled)} common scaled days: native construction needs at least 250")
    if not np.isfinite(scaled.to_numpy()).all():
        raise ValueError("a member has zero trailing volatility and an undefined native scale")
    model = book_report.Book(scaled, families)
    weights = model.eq_weights(names)
    try:
        pnl, _, multiplier = model.run(weights)
    except (ZeroDivisionError, ValueError) as exc:
        raise ValueError("native diversification sizing is undefined on the common window") from exc
    if not np.isfinite(pnl.to_numpy()).all():
        raise ValueError("the native book has nonfinite P&L on the common window")
    days = pnl.index.normalize()
    times = [int((days[0] - EPOCH) // MS) - 1, *(((days - EPOCH) // MS) + DAY_MS - 1).tolist()]
    for member in members:
        alone = scaled[member["name"]] * book_report.BOOK_VOL / book_report.STRAT_VOL
        member.update(times=times, equity=equity_from_returns(alone, capital, "contributions"),
                      accounting="Native standalone comparison on fixed initial capital at the book volatility target.")
        member["evidence"]["method"] = ("Upstream standalone comparison: apply the lagged strategy volatility scaler, "
                                        "then multiply by the book-to-strategy target volatility ratio.")
    item = {"id": name, "name": name, "kind": "portfolio", "currency": currency,
            "frequency": "daily", "periodsPerYear": book_report.A, "times": times,
            "equity": equity_from_returns(pnl, capital, "contributions"), "source": "Quantreo book construction",
            "accounting": "Risk-scaled daily net contributions on fixed initial capital",
            "holdings": [{"id": n, "weight": float(weights[n])} for n in names],
            "evidence": {"type": "native", "method": "All-candidate construction with native lagged volatility sizing. "
                         "The diversification multiplier uses in-sample correlations from the full common window.",
                         "holdingsBasis": "Family risk-budget fractions before volatility and diversification scaling.",
                         "diversificationMultiplier": multiplier,
                         "annualVolatilityTarget": book_report.BOOK_VOL},
            "notes": ["This is the full all-candidate book. The upstream pruned proposal is a separate result.",
                      "Each strategy shows its native standalone comparison on the same common window.",
                      "Input net P&L includes the charges in each source ledger. Portfolio-level costs are unavailable."]}
    if all(member.get("assetClass") for member in members):
        classes = {member["assetClass"] for member in members}
        item["assetClass"] = classes.pop() if len(classes) == 1 else "Multi-asset"
    series = [item, *members]
    _apply_calendar(series, scaled.ne(0).any(axis=1), calendar, session_dates, imported=bool(imports))
    return _bundle(name, series, "Native all-candidate construction from common-currency net contributions.")
