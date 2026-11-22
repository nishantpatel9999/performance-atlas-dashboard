"""Check the monthly percentages a reader sees against independent source returns."""
import argparse
import csv
import hashlib
import json
import math
import os
import re
from pathlib import Path

from .evidence import read_payload


def read_expected(path):
    """Returns are fractions in a long table. A blank means no measured interval."""
    expected = {}
    with path.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        fields = {"series_id", "month", "return_fraction"}
        if not fields.issubset(reader.fieldnames or ()):
            raise ValueError("Expected CSV columns: series_id,month,return_fraction")
        for row in reader:
            sid, month = row["series_id"], row["month"]
            if not sid or not re.fullmatch(r"[0-9]{4}-(?:0[1-9]|1[0-2])", month):
                raise ValueError(f"Invalid series or month on CSV line {reader.line_num}")
            values = expected.setdefault(sid, {})
            if month in values:
                raise ValueError(f"Duplicate source month {sid} {month}")
            value = float(row["return_fraction"]) if row["return_fraction"].strip() else None
            if value is not None and not math.isfinite(value):
                raise ValueError(f"Nonfinite source return for {sid} {month}")
            values[month] = value
    return expected


def verify_percentage(raw, label, value, where):
    if value is None:
        if raw is not None or label != "—":
            raise ValueError(f"{where}: missing observation displayed as {label!r}")
        return
    if raw is None or not math.isfinite(value) or not math.isclose(float(raw), value, rel_tol=1e-10, abs_tol=1e-11):
        raise ValueError(f"{where}: heatmap data {raw!r} differs from source {value}")
    readable = label.replace("−", "-")
    if not re.fullmatch(r"[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)[.]\d{2,}%", readable):
        raise ValueError(f"{where}: reader sees {label!r}, expected a percentage")
    if (value > 0 and not readable.startswith("+")) or (value < 0 and not readable.startswith("-")):
        raise ValueError(f"{where}: sign differs from source {value}")
    shown = float(readable[:-1].replace(",", ""))
    places = len(readable.split(".")[1]) - 1
    percent = 100 * value
    increment = 10 ** -places
    # Source and browser can land on either side of the same half-unit tie.
    roundoff = max(2 * math.ulp(percent), min(1e-10, increment / 1000))
    tolerance = .5 * increment + roundoff
    if ((shown == 0 and abs(percent) >= 5e-13)
            or not math.isclose(shown, percent, rel_tol=0, abs_tol=tolerance)):
        raise ValueError(f"{where}: reader sees {label}, source is {100 * value}%")


def verify_cells(rows, expected, view, sid):
    displayed = set()
    years = sorted({month[:4] for month in expected})
    if view == "overview":
        years = years[-4:]
    for month, raw, label in rows:
        where = f"{sid} {view} {month}"
        if not isinstance(month, str) or not re.fullmatch(r"[0-9]{4}-(?:0[1-9]|1[0-2])", month):
            raise ValueError(f"{where}: calendar cell has no identified month; reader sees {label!r}")
        if month in displayed:
            raise ValueError(f"{where}: duplicated month")
        displayed.add(month)
        value = expected.get(month)
        verify_percentage(raw, label, value, where)
    missing = [month for month in expected if expected[month] is not None
               and month[:4] in years and month not in displayed]
    if missing:
        raise ValueError(f"{sid} {view}: missing expected month {missing[0]}")
    return sum(expected.get(month) is not None for month in displayed)


# Read all visible body cells, including cells with absent or malformed identifiers.
TABLE = r"""table => {
    const visible = c => c.checkVisibility({visibilityProperty: true, opacityProperty: true});
    const cell = c => ({...c.dataset, label: c.innerText.trim().split('\n')[0].replace(/[†‡*]$/, '')});
    const rows = section => Array.from(table.querySelectorAll(section + ' tr')).filter(visible).map(r => ({
        heading: r.querySelector('th')?.innerText.trim(),
        cells: Array.from(r.querySelectorAll('td')).filter(visible).map(cell)
    }));
    return {header: table.querySelector('thead th:last-child')?.innerText.trim(),
            body: rows('tbody'), footer: rows('tfoot')};
}"""


def verify_table(table, expected, view, sid, history):
    where = f"{sid} {view}"
    if table["header"] != "Year return" or len(table["footer"]) != 1:
        raise ValueError(f"{where}: expected a Year return column and one Average row")
    rows = []
    for row in table["body"]:
        year, cells = row["heading"], row["cells"]
        if not year or not re.fullmatch(r"[0-9]{4}", year):
            raise ValueError(f"{where}: invalid year heading {year!r}")
        months = [f"{year}-{i:02}" for i in range(1, 13)]
        if (len(cells) != 13 or cells[-1].get("yearReturn") != year or "month" in cells[-1]
                or any("yearReturn" in c for c in cells[:-1])):
            raise ValueError(f"{where} {year}: expected twelve monthly cells followed by the identified year")
        if [c.get("month") for c in cells[:-1]] != months:
            raise ValueError(f"{where} {year}: missing, misplaced or unidentified monthly cell")
        for month, cell in zip(months, cells):
            rows.append((month, cell.get("return"), cell["label"]))
            if expected.get(month) is not None:
                if cell.get("coverage") not in {"full", "partial", "gap"}:
                    raise ValueError(f"{where} {month}: missing coverage")
                if view == "calendar" and cell["coverage"] == "full":
                    history[int(month[-2:]) - 1].append(expected[month])

        annual = cells[-1]
        raw = annual.get("return")
        value = float(raw) if raw is not None else None
        if annual.get("coverage") not in {"full", "partial", "gap"}:
            raise ValueError(f"{where} {year}: missing annual coverage")
        verify_percentage(raw, annual["label"], value, f"{where} {year}")
        if annual["coverage"] == "full":
            if value is None:
                raise ValueError(f"{where} {year}: full year has no return")
            # Only continuous, closed months support reconstruction from the CSV.
            if all(expected.get(m) is not None and c.get("coverage") == "full"
                   for m, c in zip(months, cells)):
                compound = math.prod(1 + expected[m] for m in months) - 1
                if not math.isclose(value, compound, rel_tol=1e-10, abs_tol=1e-11):
                    raise ValueError(f"{where} {year}: annual return differs from compounded source months")
            if view == "calendar":
                history[-1].append(value)

    checked = verify_cells(rows, expected, view, sid)
    footer = table["footer"][0]
    cells = footer["cells"]
    if (footer["heading"] != "Average" or len(cells) != 13 or "yearAverage" not in cells[-1]
            or "monthAverage" in cells[-1] or any("yearAverage" in c for c in cells[:-1])
            or [c.get("monthAverage") for c in cells[:-1]] != [str(i) for i in range(1, 13)]):
        raise ValueError(f"{where}: malformed Average row")
    for column, (cell, values) in enumerate(zip(cells, history), 1):
        if float(cell.get("count") or "nan") != len(values):
            raise ValueError(f"{where} Average column {column}: expected count {len(values)}")
        value = math.fsum(values) / len(values) if values else None
        raw = cell.get("return")
        # Validate the printed sign against its own raw value. Independently
        # accumulated means can differ in sign within floating-point roundoff.
        observed = float(raw) if raw is not None else None
        if value is not None and (observed is None or not math.isclose(
                observed, value, rel_tol=1e-10, abs_tol=1e-11)):
            raise ValueError(f"{where} Average column {column}: expected mean {value}")
        verify_percentage(raw, cell["label"], observed if values else None, f"{where} Average column {column}")
    return checked


def verify(html, expected, url=None):
    from playwright.sync_api import sync_playwright

    raw = html.read_bytes()
    bundle, _ = read_payload(raw.decode())
    series = [s for s in bundle["series"] if s["kind"] != "benchmark"] or bundle["series"]
    ids = {s["id"] for s in series}
    if ids != set(expected):
        raise ValueError(f"Source CSV and report cover different series: {sorted(ids ^ set(expected))}")
    counts = {"overview": 0, "calendar": 0}
    per_series = {}
    errors = []
    with sync_playwright() as api:
        browser = api.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"))
        page = browser.new_page(viewport={"width": 1440, "height": 960})
        page.on("pageerror", lambda error: errors.append(str(error)))
        if url:
            # Verify the network response, then render those same bytes. The
            # browser's resource-inspection cache can evict a large document.
            delivered = page.request.get(url, timeout=60_000)
            try:
                if not delivered.ok or delivered.body() != raw:
                    raise ValueError("The supplied URL did not serve the specified HTML bytes")
                page.route("**/*", lambda route: route.fulfill(response=delivered), times=1)
                page.goto(delivered.url, timeout=60_000)
            finally:
                delivered.dispose()
        else:
            page.goto(html.resolve().as_uri())
        page.wait_for_selector("#series-select")
        kind = None
        for item in series:
            sid = item["id"]
            if kind != item["kind"]:
                kind = item["kind"]
                page.locator(f'#scope [data-kind="{kind}"]').click()
            page.locator("#series-select").select_option(sid)
            per_series[sid] = {}
            # The CSV supplies independent values. Only the full Calendar supplies
            # coverage for years hidden by the Overview cutoff.
            history = [[] for _ in range(13)]
            for view in ("calendar", "overview"):
                page.locator(f'#navigation [data-view="{view}"]').click()
                heat = page.locator(".heat:visible")
                if heat.count():
                    checked = verify_table(heat.evaluate(TABLE), expected[sid], view, sid, history)
                else:
                    checked = verify_cells([], expected[sid], view, sid)
                counts[view] += checked
                per_series[sid][view] = checked
        browser.close()
    if errors:
        raise ValueError("Browser reported " + "; ".join(errors))
    return {"series_checked": len(ids), "by_series": per_series, "visible_months_checked": counts,
            "html_sha256": hashlib.sha256(raw).hexdigest(), "served_bytes_verified": bool(url)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--html", type=Path, required=True)
    parser.add_argument("--expected", type=Path, required=True, help="independently computed monthly returns CSV")
    parser.add_argument("--url", help="optional URL serving the exact same report")
    parser.add_argument("--receipt", type=Path, help="write a JSON receipt for the document preflight")
    args = parser.parse_args()
    try:
        for source in (args.html, args.expected):
            if args.receipt and source.resolve() == args.receipt.resolve():
                raise ValueError("Receipt must have a different path from the report and reference CSV")
        receipt = verify(args.html, read_expected(args.expected), args.url)
        receipt["reference_sha256"] = hashlib.sha256(args.expected.read_bytes()).hexdigest()
        if args.receipt:
            args.receipt.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({k: v for k, v in receipt.items() if k != "by_series"}, indent=2))
    except (ValueError, OSError, ImportError) as exc:
        parser.exit(1, f"{exc}\n")


if __name__ == "__main__":
    main()
