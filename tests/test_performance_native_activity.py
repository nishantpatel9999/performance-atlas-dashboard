"""Native portfolio activity must come from dated held positions or the supplied sidecar."""

import importlib.util
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
HAS_NATIVE = all(importlib.util.find_spec(name) for name in ("numpy", "pandas", "pyarrow", "matplotlib"))


@unittest.skipUnless(HAS_NATIVE, "requires the native backtest environment")
class NativeActivityTests(unittest.TestCase):
    def setUp(self):
        import numpy as np
        import pandas as pd
        from lab import runs, strategy_report

        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.days = pd.date_range("2021-01-01", periods=295)
        self.names = ["Long short", "Directional"]
        self.prices = 100 + np.sin(np.arange(len(self.days)) / 5)
        self.prices[101] = self.prices[100]
        self.folders = {}
        self.positions = {}
        self.engine_hash = runs.lab_sha()
        strategies = self.root / "strategies"
        strategies.mkdir()
        for name in self.names:
            (strategies / (runs.slug(name) + ".py")).write_text(
                f'NAME = "{name}"\nTRAIN = ("2019-01-01", "2019-12-31")\n'
                'VALIDATION = ("2020-01-01", "2020-12-31")\nTEST_START = "2021-01-01"\n')
        self.enterContext(patch.object(strategy_report, "ROOT", self.root))

    def save(self, name, freq="D", *, times=None, period="test", targets=None):
        import numpy as np
        import pandas as pd
        from lab import runs
        from lab.backtest import backtest

        times = self.days if times is None else times
        seq = np.arange(len(times))
        prices = self.prices if times.equals(self.days) else 100 + np.sin(seq / 5)
        bars = pd.concat([pd.DataFrame({"time": times, "symbol": symbol, "high": price + 1,
                                       "low": price - 1, "close": price})
                          for symbol, price in (("X", prices), ("Y", 105 - (prices - 100) / 2))])
        if targets is None:
            held = (seq % 4 < 2).astype(float)
            targets = (pd.DataFrame({"X": held, "Y": -held}, index=times) if name == self.names[0]
                       else pd.DataFrame({"X": -0.5 * (seq % 3 != 0)}, index=times))
        result = backtest(targets, bars, cost_bp=0, freq=freq, end=times[-1])
        code = self.root / "strategies" / (runs.slug(name) + ".py")
        with patch.object(runs, "ROOT", self.root), patch.object(runs, "lab_sha", return_value=self.engine_hash):
            folder, info = runs.save_run(name, period, "base", result, code_file=code)
        if period == "test":
            (folder.parent / "TEST_DONE").write_text(json.dumps({"variant": "base", "run": info["run_id"],
                                                                  "code_sha": info["code_sha"], "lab_sha": info["lab_sha"]}))
        self.folders[name] = folder
        self.positions[name] = result.positions
        return result

    def book(self, **kwargs):
        from lab.performance.native import book_bundle

        return book_bundle("Book", self.names, currency="USD", **kwargs)["series"][0]

    def test_counts_distinct_strategies_from_engine_records_even_on_zero_pnl(self):
        ledgers = [self.save(name) for name in self.names]
        book = self.book()
        rows = {r["date"]: r for r in book["activity"]["rows"]}
        self.assertEqual(len(rows), len(book["times"]) - 1)
        counts = [sum(int((p.loc[date] != 0).any()) for p in self.positions.values()) for date in rows]
        self.assertEqual([row["active"] for row in rows.values()], counts)
        self.assertEqual(set(counts), {0, 1, 2})
        day = self.days[101]
        self.assertTrue(all(ledger.daily.at[day, "total"] == 0 for ledger in ledgers))
        self.assertEqual(rows[day.date().isoformat()]["active"], 2)
        self.assertTrue(all(r["overnight"] is None and r["marginUsd"] is None for r in rows.values()))
        self.assertIn("UTC", book["activity"]["source"])

    def test_intraday_flat_open_cannot_rule_out_an_intraday_round_trip(self):
        import pandas as pd

        hours = pd.date_range(self.days[0], self.days[-1] + pd.Timedelta(hours=23), freq="h")
        # Flat at most midnights, with real risk between 03:00 and 06:00 UTC daily.
        # On one date leave the sleeve open across midnight.
        weights = {self.days[0]: 0}
        for day in self.days:
            weights[day + pd.Timedelta(hours=2)] = 0.4
            if day != self.days[110]:
                weights[day + pd.Timedelta(hours=5)] = 0
        self.save(self.names[0], "h", times=hours, targets=pd.Series(weights, name="X").sort_index().to_frame())
        self.save(self.names[1])
        rows = {r["date"]: r for r in self.book()["activity"]["rows"]}
        day, next_day = self.days[110:112]
        self.assertEqual(self.positions[self.names[0]].at[day, "X"], 0)
        self.assertIsNone(rows[day.date().isoformat()]["active"])
        other = int(self.positions[self.names[1]].at[next_day, "X"] != 0)
        self.assertEqual(rows[next_day.date().isoformat()]["active"], 1 + other)

    def test_missing_position_file_cannot_be_replaced_by_trades_or_returns(self):
        for name in self.names:
            self.save(name)
        folder = self.folders[self.names[1]]
        (folder / "positions.parquet").unlink()
        self.assertTrue((folder / "trades.parquet").is_file())
        book = self.book()
        self.assertNotIn("activity", book)
        self.assertIn("--activity", " ".join(book["notes"]))

    def test_mixed_desk_and_return_only_member_needs_portfolio_evidence(self):
        import numpy as np
        import pandas as pd
        from lab.performance.native import book_bundle

        self.save(self.names[0])
        path = self.root / "member.csv"
        # Additional columns on a contribution file do not certify a position ledger.
        pd.DataFrame({"date": self.days, "net": np.sin(np.arange(len(self.days)) / 8) / 1000,
                      "gross": 0.01, "active": 1}).to_csv(path, index=False)
        args = ("Mixed", [self.names[0]], [(self.names[1], path, "Other")])
        options = dict(currency="USD", opening_capital=100, opening_date="2020-12-31")
        baseline = book_bundle(*args, **options)["series"][0]
        self.assertNotIn("activity", baseline)
        self.assertIn("--activity", " ".join(baseline["notes"]))
        statement = self.root / "snapshot.csv"
        statement.write_text("date,active,overnight,marginUsd,marginBasis\n2021-05-02,2,1,42,broker_requirement\n")
        portfolio = book_bundle(*args, **options, activity=statement)["series"][0]
        self.assertEqual(portfolio["activity"]["rows"][0]["marginUsd"], 42)
        self.assertEqual(portfolio["equity"], baseline["equity"])

    def test_overlap_uses_positions_of_the_scored_run_in_utc(self):
        import pandas as pd

        pre = pd.date_range("2020-01-01", periods=280)
        for name in self.names:
            self.save(name, times=pre, period="train")
        first, absent, last = pre[101:104]
        self.assertTrue(self.positions[self.names[0]].loc[first].ne(0).any())
        other = self.positions[self.names[1]]
        self.save(self.names[0], times=pre[101:104], period="validation")
        path = self.folders[self.names[0]] / "positions.parquet"
        held = pd.read_parquet(path).drop(absent)
        self.assertFalse(held.loc[first].ne(0).any())  # The replacement run starts flat.
        held.index = held.index.tz_localize("UTC").tz_convert("America/New_York")
        held.to_parquet(path)
        for name in self.names:
            self.save(name)
        rows = {r["date"]: r["active"] for r in self.book()["activity"]["rows"]}
        self.assertEqual(rows[first.date().isoformat()], int(other.loc[first].ne(0).any()))
        self.assertIsNone(rows[absent.date().isoformat()])
        self.assertEqual(rows[last.date().isoformat()], 1 + int(other.loc[last].ne(0).any()))

    def test_bad_snapshots_leave_local_gaps(self):
        import pandas as pd

        for name in self.names:
            self.save(name)
        path = self.folders[self.names[0]] / "positions.parquet"
        held = pd.read_parquet(path)
        nonfinite, late, duplicate, valid = self.days[106:110]
        held.loc[nonfinite, "Y"] = float("nan")
        held = held.rename(index={late: late + pd.Timedelta(hours=1)})
        pd.concat([held, held.loc[[duplicate]]]).sort_index().to_parquet(path)
        rows = {r["date"]: r["active"] for r in self.book()["activity"]["rows"]}
        for day in (nonfinite, late, duplicate):
            self.assertIsNone(rows[day.date().isoformat()])
        self.assertEqual(rows[valid.date().isoformat()], sum(int(p.loc[valid].ne(0).any()) for p in self.positions.values()))

    def test_declared_sessions_keep_missing_dates_unknown_and_exclude_holidays(self):
        import pandas as pd

        for name in self.names:
            self.save(name)
        missing, holiday = self.days[102:104]
        for folder in self.folders.values():
            path = folder / "daily.parquet"
            daily = pd.read_parquet(path).drop(missing)
            daily.loc[holiday, "total"] = 0
            daily.to_parquet(path)
        sessions = [d.date().isoformat() for d in self.days if d != holiday]
        book = self.book(session_dates=sessions)
        rows = {r["date"]: r for r in book["activity"]["rows"]}
        self.assertNotIn(holiday.date().isoformat(), rows)
        self.assertIsNone(rows[missing.date().isoformat()]["active"])
        self.assertIn("active", rows[missing.date().isoformat()]["gaps"])

    def test_sidecar_owns_its_session_clock_and_dates_and_counts_must_fit_the_book(self):
        for name in self.names:
            self.save(name)
        day = self.days[101].date().isoformat()
        path = self.root / "statement.json"
        spec = {"source": "Account close", "timeZone": "America/New_York",
                "rows": [{"date": day, "closeTime": day + "T20:00:00Z", "overnight": 0,
                          "marginUsd": 0, "marginBasis": "broker_requirement"}]}
        path.write_text(json.dumps(spec))
        result = self.book(activity=path)["activity"]
        self.assertEqual(result["timeZone"], spec["timeZone"])
        self.assertEqual(len(result["rows"]), 1)
        row = result["rows"][0]
        self.assertEqual((row["date"], row["active"], row["overnight"], row["marginUsd"]), (day, None, 0, 0))
        spec["rows"] = [{"date": day, "active": 3}]
        path.write_text(json.dumps(spec))
        with self.assertRaisesRegex(ValueError, "exceeds"):
            self.book(activity=path)
        spec["rows"] = [{"date": "1970-01-01", "active": 0}]
        path.write_text(json.dumps(spec))
        with self.assertRaisesRegex(ValueError, "outside"):
            self.book(activity=path)

    def test_cli_loads_relative_ledger_without_reexporting_nav_and_protects_inputs(self):
        import csv
        import math
        from lab.performance.native import book_bundle

        entries = []
        for i, name in enumerate(self.names):
            path = self.root / f"leg{i}.csv"
            with path.open("w", newline="") as file:
                writer = csv.writer(file)
                writer.writerow(["date", "net"])
                writer.writerows((d.date(), math.sin(j / (5 + i)) / 1000) for j, d in enumerate(self.days))
            entries.append((name, str(path), name))
        options = dict(currency="EUR", opening_capital=100, opening_date="2020-12-31")
        baseline = book_bundle("Imported", imports=entries, **options)["series"][0]
        self.assertNotIn("activity", baseline)
        self.assertIn("--activity", " ".join(baseline["notes"]))
        sidecar = self.root / "account.json"
        ledger = self.root / "dates.csv"
        sidecar.write_text(json.dumps({"source": "Account statement", "csv": ledger.name}))
        ledger.write_text("date,active,overnight,marginUsd,marginBasis\n2021-05-02,2,1,125,broker_requirement\n")
        output = self.root / "book.html"
        argv = [sys.executable, "-B", "-m", "lab.book_report", "construct", "Imported", "html", "--currency", "EUR",
                "--opening-capital", "100", "--opening-date", "2020-12-31", "--activity", str(sidecar)]
        for entry in entries:
            argv.extend(["--import", *entry])
        for source in (ledger, sidecar):
            with self.subTest(source=source):
                original = source.read_bytes()
                proc = subprocess.run([*argv, "--output", str(source)], cwd=ROOT, capture_output=True, text=True)
                self.assertNotEqual(proc.returncode, 0)
                self.assertIn("output", proc.stderr)
                self.assertEqual(source.read_bytes(), original)
        rendered = subprocess.run([*argv, "--output", str(output)], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(rendered.returncode, 0, rendered.stderr)
        data = re.search(r'<script id="report-data" type="application/json">(.*?)</script>', output.read_text(), re.S)
        book = json.loads(data[1])["series"][0]
        self.assertEqual(book["activity"]["rows"][0], {"date": "2021-05-02", "active": 2, "overnight": 1,
                                                       "marginUsd": 125, "marginBasis": "broker_requirement"})
        for key in ("times", "equity", "holdings"):
            self.assertEqual(book[key], baseline[key])
