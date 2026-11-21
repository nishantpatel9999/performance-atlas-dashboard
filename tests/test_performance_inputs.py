import copy
import contextlib
import importlib.util
import io
import json
import math
import re
import runpy
import shutil
import statistics
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
DAY = 86_400_000


def marked(**changes):
    return dict({"id": "a", "name": "A", "kind": "strategy", "currency": "USD",
                 "periodsPerYear": 252, "frequency": "daily",
                 "times": [0, DAY, 2 * DAY], "equity": [100, 110, 99]}, **changes)


def bundle(*series):
    return {"version": 1, "title": "Performance Atlas", "series": list(series)}


class InputTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def load(self, manifest):
        from lab.performance.inputs import load_config
        path = self.root / "manifest.json"
        path.write_text(json.dumps(manifest), encoding="utf-8")
        return load_config(path)

    def test_canonical_rejects_invalid_fields_and_references(self):
        from lab.performance.inputs import validate_bundle
        invalid = [
            marked(times=[2, 1, 3]), marked(times=[1, 1, 2]), marked(times=[True, 1, 2]),
            marked(times=[1, 2, 3.5]), marked(times=[1, 2, 10**17]), marked(equity=[1, 2]),
            marked(equity=[0, 1, 2]), marked(equity=[1, math.nan, 1]), marked(equity=[True, 1, 2]),
            marked(currency=" "), marked(periodsPerYear=0), marked(periodsPerYear="252"),
            marked(frequency="hourly"), marked(kind="stock"), marked(benchmarkId="missing"),
            marked(trades=[{"time": DAY, "pnl": 10, "holdingHours": -1}]),
            marked(trades=[{"time": 4 * DAY, "pnl": 10}]), marked(costs={"total": math.inf}),
            marked(holdings=[{"id": "a", "weight": True}]), marked(notes="hello"),
            marked(evidence={1: "wrong key"}), marked(unrecognized=True),
        ]
        for item in invalid:
            with self.subTest(item=item), self.assertRaises(ValueError):
                validate_bundle(bundle(item))
        for item in [bundle(), bundle(marked(), marked()), dict(bundle(marked()), version=True),
                     bundle(marked(benchmarkId="b"), marked(id="b")), {"series": [marked()]}]:
            with self.subTest(item=item), self.assertRaises(ValueError):
                validate_bundle(item)

    def test_ruin_preserves_loss_and_source_horizon_summaries(self):
        from lab.performance.inputs import validate_bundle
        source = bundle(marked(times=[0, DAY, 2 * DAY, 3 * DAY], equity=[10, 5, -3, 100],
                               trades=[{"time": DAY, "pnl": -5}, {"time": 3 * DAY, "pnl": 103}],
                               costs={"currency": "USD", "total": 2}, tradeSummary={"closedTrades": 2}))
        original = copy.deepcopy(source)
        item = validate_bundle(source)["series"][0]
        self.assertEqual(item["times"], [0, DAY, 2 * DAY])
        self.assertEqual(item["equity"], [10, 5, -3])
        self.assertEqual(item["trades"], [{"time": DAY, "pnl": -5}])
        self.assertEqual(item["tradeSummary"], {"closedTrades": 2})
        self.assertEqual(item["costs"], source["series"][0]["costs"])
        self.assertEqual(source, original)

    def test_portable_manifest_uses_explicit_accounting_and_exit_times(self):
        data = self.root / "data"
        data.mkdir()
        (data / "ledger.csv").write_text("date,net,nav\n2020-01-02,0.50,70\n2020-01-03,-0.50,35\n")
        (data / "closed.csv").write_text("time,pnl,side,holdingHours\n2020-01-03T03:00:00+03:00,-75,short,12\n")
        source = {"id": "a", "name": "A", "kind": "strategy", "currency": "USD",
                  "frequency": "daily", "periodsPerYear": 365, "csv": "data/ledger.csv"}
        returns = dict(source, mode="returns", valueColumn="net", openingDate="2020-01-01",
                       openingCapital=100, tradesCsv="data/closed.csv", benchmarkId="b")
        additive = dict(returns, mode="contributions", id="p", kind="portfolio",
                        holdings=[{"id": "a", "weight": 1.4}, {"id": "cash", "weight": -0.4}])
        index = dict(source, mode="equity", valueColumn="nav", id="b", kind="benchmark", currency="INDEX")
        config = {"series": [returns, additive, index]}
        report = self.load(config)
        self.assertEqual(report["title"], "Performance Atlas")
        a, p, b = report["series"]
        self.assertEqual(a["equity"], [100, 150, 75])
        self.assertEqual(p["equity"], [100, 150, 100])
        self.assertEqual(b["equity"], [70, 35])
        self.assertEqual(p["holdings"], additive["holdings"])
        self.assertEqual(a["trades"], [{"time": a["times"][-1], "pnl": -75, "side": "short", "holdingHours": 12}])
        self.assertEqual(self.load(report), report)
        for field in ("openingCapital", "openingDate"):
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, field):
                self.load(bundle({k: v for k, v in returns.items() if k != field}, index))
        with self.assertRaisesRegex(ValueError, "openingDate|increasing"):
            self.load(bundle(dict(returns, openingDate="2020-01-02"), index))

    def test_fx_uses_only_the_rate_supplied_for_each_mark(self):
        (self.root / "fx.csv").write_text("date,equity,usd_per_eur\n2021-06-01,100,1.2\n2021-06-02,90,1.1\n")
        row = {"csv": "fx.csv", "id": "eu", "name": "Europe", "kind": "portfolio",
               "currency": "USD", "sourceCurrency": "EUR", "fxColumn": "usd_per_eur",
               "frequency": "monthly", "periodsPerYear": 12}
        item = self.load(bundle(row))["series"][0]
        self.assertEqual(item["currency"], "USD")
        self.assertAlmostEqual(item["equity"][1], 99)
        self.assertEqual(item["equity"][0], 120)
        (self.root / "fx.csv").write_text("date,equity,usd_per_eur\n2021-06-01,100,\n2021-06-02,90,1.1\n")
        with self.assertRaises(ValueError):
            self.load(bundle(row))
        with self.assertRaises(ValueError):
            self.load(bundle({k: v for k, v in row.items() if k != "fxColumn"}))

    def test_fx_return_stream_converts_the_opening_and_each_local_nav(self):
        (self.root / "returns.csv").write_text("date,net,fx\n2020-01-02,0.10,1.25\n2020-01-03,-0.10,1.10\n")
        row = {"id": "eu", "name": "Europe", "kind": "strategy", "frequency": "daily", "periodsPerYear": 252,
               "currency": "USD", "sourceCurrency": "EUR", "csv": "returns.csv", "fxColumn": "fx",
               "mode": "returns", "openingCapital": 200, "openingDate": "2020-01-01", "openingFxRate": 1.2}
        item = self.load(bundle(row))["series"][0]
        for actual, expected in zip(item["equity"], [240, 275, 217.8]):
            self.assertAlmostEqual(actual, expected)
        with self.assertRaisesRegex(ValueError, "openingFxRate"):
            self.load(bundle({k: v for k, v in row.items() if k != "openingFxRate"}))

    def test_csv_times_preserve_utc_millisecond_precision(self):
        from lab.performance.inputs import parse_time
        self.assertEqual(parse_time("1970-01-01T01:00:00.003000000+01:00"), 3)
        self.assertEqual(parse_time("1969-12-31T23:59:59.999Z"), -1)
        for raw in ["1970-01-01T00:00:00.0000001Z", "1970-01-01T00:00:00.123456789Z"]:
            with self.subTest(raw=raw), self.assertRaisesRegex(ValueError, "millisecond"):
                parse_time(raw)

    def test_bad_csv_dates_and_values_report_the_source(self):
        row = {"id": "a", "name": "A", "kind": "portfolio", "currency": "USD", "csv": "ledger.csv",
               "frequency": "weekly", "periodsPerYear": 52}
        for body in ["date,equity\nfoo,1\n", "date,equity\n2020-01-01,inf\n",
                     "date,other\n2020-01-01,10\n", "date,equity\n2,1\n1,2\n",
                     "date,equity,equity\n2020-01-01,10,100\n"]:
            (self.root / "ledger.csv").write_text(body)
            with self.subTest(body=body), self.assertRaisesRegex(ValueError, "ledger.csv"):
                self.load(bundle(row))

    def test_session_calendar_is_explicit_and_validated_independently_of_marks(self):
        from lab.performance.inputs import validate_bundle
        calendar = ["1969-12-31", "1970-01-01", "1970-01-05"]
        self.assertEqual(self.load(bundle(marked(sessionDates=calendar)))["series"][0]["sessionDates"], calendar)
        for bad in [calendar[::-1], ["2024-02-30"], ["2024-2-02"], ["2024-12-31"] * 2, [0], "weekdays"]:
            with self.subTest(bad=bad), self.assertRaisesRegex(ValueError, "sessionDates"):
                validate_bundle(bundle(marked(sessionDates=bad)))
        with self.assertRaisesRegex(ValueError, "daily"):
            validate_bundle(bundle(marked(sessionDates=calendar, frequency="monthly")))

    def test_optional_diagnostics_read_independent_clocks_and_keep_nulls(self):
        row = marked(times=[0, DAY, DAY * 2, DAY * 3], equity=[100, 90, 0, 5])
        (self.root / "signals.csv").write_text("date,value\n0,\n43200000,1.25\n172800000,-0.5\n259200000,8\n")
        row["diagnostics"] = [{"name": "Exposure", "unit": "%", "csv": "signals.csv", "description": "Gross"},
                              {"name": "Contracts", "unit": "lots", "times": [DAY], "values": [2]}]
        diagnostics = self.load(bundle(row))["series"][0]["diagnostics"]
        self.assertEqual(diagnostics, [{"name": "Exposure", "unit": "%", "description": "Gross",
                                        "times": [0, DAY // 2, DAY * 2], "values": [None, 1.25, -0.5]},
                                       {"name": "Contracts", "unit": "lots", "times": [DAY], "values": [2]}])
        for changes in [dict(name=""), dict(unit=" "), dict(times=[DAY, 0], values=[1, 2]),
                        dict(times=[1, 1], values=[None, 0]), dict(times=[3 * DAY], values=[0]),
                        dict(times=[1], values=[]), dict(values=[True]), dict(values=[math.inf])]:
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, "diagnostic"):
                self.load(bundle(marked(diagnostics=[dict(diagnostics[1], **changes)])))
        with self.assertRaisesRegex(ValueError, "diagnostic"):
            self.load(bundle(marked(diagnostics=[diagnostics[1], diagnostics[1]])))

    def test_html_embeds_data_once_without_markup_breakout(self):
        from lab.performance import build
        attack = "</ScRiPt><p>&\u2028\u2029<!--REPORT_SCRIPTS-->"
        report = bundle(marked(name=attack, evidence={"note": attack}))
        template = "<html><!--REPORT_STYLE--><!--REPORT_DATA--><!--REPORT_SCRIPTS--></html>"
        (self.root / "template.html").write_text(template)
        (self.root / "style.css").write_text("body { color: black }")
        scripts = ["metrics.js", "details.js", "charts.js", "app.js"]
        for name in scripts:
            (self.root / name).write_text("// " + name + "\n")
        out = self.root / "nested/report.html"
        with patch.object(build, "ASSET_DIR", self.root):
            self.assertEqual(build.render_bundle(report, out), out)
            regular = self.root / "style.css"
            self.assertEqual(out.stat().st_mode & 0o777, regular.stat().st_mode & 0o777)
            html = out.read_text()
            self.assertNotIn("</ScRiPt>", html)
            self.assertNotIn("<!--REPORT_", html)
            self.assertIn("<style>body { color: black }</style>", html)
            self.assertEqual(sorted(scripts, key=html.index), scripts)
            data = re.search(r'<script id="report-data" type="application/json">(.*?)</script>', html, re.S)
            self.assertEqual(json.loads(data[1]), report)
            out.chmod(0o640)
            build.render_bundle(report, out)
            self.assertEqual(out.stat().st_mode & 0o777, 0o640)
            self.assertEqual(out.read_text(), html)
            with self.assertRaises(ValueError):
                build.render_bundle(bundle(marked(equity=[False, 10, 10])), out)
            self.assertEqual(out.read_text(), html)

    def test_demo_is_reproducible_and_reconciles_trade_and_cost_ledgers(self):
        from lab.performance.demo import demo_bundle
        from lab.performance.inputs import validate_bundle
        data = demo_bundle()
        self.assertEqual(data["title"], "Multi-asset research")
        self.assertEqual(data, demo_bundle())
        self.assertEqual(data, validate_bundle(data))
        series = data["series"]
        legs = [s for s in series if s["kind"] == "strategy"]
        self.assertIn(len(legs), (3, 4, 5))
        self.assertEqual({s["kind"] for s in series}, {"strategy", "portfolio", "benchmark"})
        self.assertEqual(len({s["family"] for s in legs}), len(legs))
        book = next(s for s in series if s["kind"] == "portfolio")
        self.assertEqual(book["evidence"]["attribution"],
                         {"basis": "funded_equity", "members": [s["id"] for s in legs]})
        for i, nav in enumerate(book["equity"]):
            self.assertEqual(sum(s["equity"][i] for s in legs), nav)
        gross, net = book["diagnostics"]
        self.assertEqual((gross["name"], net["name"]), ("Gross exposure", "Net exposure"))
        self.assertEqual(gross["unit"], "%")
        self.assertEqual(gross["times"], book["times"])
        self.assertEqual((gross["values"][0], gross["values"][-1]), (0, 0))
        self.assertGreater(max(gross["values"]), 0.5)
        self.assertLess(min(net["values"]), 0)
        self.assertTrue(all(-g - 1e-12 <= n <= g + 1e-12 for g, n in zip(gross["values"], net["values"])))
        for s in series:
            self.assertEqual(s["evidence"]["type"], "synthetic")
            self.assertGreaterEqual(s["times"][-1] - s["times"][0], DAY * 365 * 5)
            if s["kind"] == "benchmark":
                continue
            self.assertGreater(len(s["trades"]), 20)
            self.assertAlmostEqual(sum(t["pnl"] for t in s["trades"]), s["equity"][-1] - s["equity"][0], places=5)
            self.assertEqual(s["tradeSummary"]["closedTrades"], len(s["trades"]))
            self.assertAlmostEqual(s["costs"]["commissions"] + s["costs"]["slippage"], s["costs"]["total"])

    def test_demo_cli_runs_with_only_the_standard_library(self):
        file = self.root / "offline.html"
        result = subprocess.run([sys.executable, "-S", "-m", "lab.performance", "--demo", "--output", str(file)],
                                cwd=ROOT, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('id="report-data"', file.read_text())

    @unittest.skipUnless(shutil.which("node"), "Node runs the optional browser metric integration check")
    def test_demo_benchmark_pairs_actual_usd_intervals_for_every_strategy_and_portfolio(self):
        from lab.performance.demo import demo_bundle
        series = demo_bundle()["series"]
        benchmark = next(s for s in series if s["kind"] == "benchmark")
        code = """
            const { benchmark } = require(process.argv[1]);
            const rows = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
            const ref = rows.find(s => s.kind === "benchmark");
            const stats = rows.filter(s => s.kind !== "benchmark").map(s => {
              const { count, correlation, alpha, beta, coverage } = benchmark(s, ref, {riskFree: 0});
              return { id: s.id, count, correlation, alpha, beta, coverage };
            });
            process.stdout.write(JSON.stringify(stats));
        """
        run = subprocess.run(["node", "-e", code, str(ROOT / "lab/performance/details.js")],
                             input=json.dumps(series), capture_output=True, text=True, check=True)
        stats = {s["id"]: s for s in json.loads(run.stdout)}
        ref = [b / a - 1 for a, b in zip(benchmark["equity"], benchmark["equity"][1:])]
        self.assertEqual((benchmark["currency"], benchmark["equity"][0]), ("USD", 100))
        self.assertIn("buy-and-hold", benchmark["accounting"].lower())
        for s in (s for s in series if s["kind"] != "benchmark"):
            data = stats[s["id"]]
            self.assertEqual(s["benchmarkId"], benchmark["id"])
            self.assertEqual(data["count"], len(ref))
            self.assertEqual((data["coverage"]["start"], data["coverage"]["end"]), (s["times"][0], s["times"][-1]))
            returns = [b / a - 1 for a, b in zip(s["equity"], s["equity"][1:])]
            beta = statistics.covariance(returns, ref) / statistics.variance(ref)
            self.assertAlmostEqual(data["correlation"], statistics.correlation(returns, ref), places=11)
            self.assertAlmostEqual(data["beta"], beta, places=11)
            self.assertAlmostEqual(data["alpha"], 252 * (statistics.fmean(returns) - beta * statistics.fmean(ref)), places=11)

    def test_config_cli_reads_a_portable_manifest_from_another_working_directory(self):
        marks = self.root / "series.csv"
        marks.write_text("date,equity\n2019-12-31,100\n2020-01-31,105\n")
        path = self.root / "portfolio.json"
        path.write_text(json.dumps({"series": [{"id": "book", "name": "Book", "kind": "portfolio", "currency": "USD",
                                                "csv": "series.csv", "frequency": "monthly", "periodsPerYear": 12}]}))
        output = self.root / "portfolio.html"
        args = [sys.executable, "-S", "-m", "lab.performance", "--config", str(path), "--output", str(output)]
        result = subprocess.run(args, cwd=ROOT, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('"equity":[100.0,105.0]', output.read_text())
        result = subprocess.run([*args, "--demo"], cwd=ROOT, text=True, capture_output=True)
        self.assertEqual(result.returncode, 2)


HAS_NATIVE = all(importlib.util.find_spec(mod) is not None for mod in ("numpy", "pandas", "pyarrow", "matplotlib"))


@unittest.skipUnless(HAS_NATIVE, "native reports use the existing Quantreo environment")
class NativeTests(unittest.TestCase):
    def setUp(self):
        import pandas as pd
        from lab import sheets, strategy_report

        self.pd = pd
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.results = self.root / "results" / "test_model"
        self.results.mkdir(parents=True)
        strategy = self.root / "strategies/model.py"
        strategy.parent.mkdir()
        strategy.write_text('NAME = "Test Model"\nTRAIN = ("2018-01-01", "2018-12-31")\n'
                            'VALIDATION = ("2019-01-01", "2019-12-31")\nTEST_START = "2020-01-01"\n')
        vault = self.root / "vault/2 Strategies"
        sheet = vault / "Passed/Test Model/Test Model.md"
        sheet.parent.mkdir(parents=True)
        sheet.write_text("---\nstatus: passed\nfamily: Trend\nasset: Cross-asset\n---\n")
        for module, key, value in [(strategy_report, "ROOT", self.root), (sheets, "STRATEGIES", vault)]:
            ctx = patch.object(module, key, value)
            ctx.start()
            self.addCleanup(ctx.stop)

    def run_folder(self, period, variant, bars, net, bar="D", stamp="20200101-000000", cost=None, name="Test Model"):
        index = self.pd.to_datetime(bars)
        ident = f"{stamp}-{period}-{variant}"
        folder = self.results.parent / name.lower().replace(" ", "_") / ident
        folder.mkdir(parents=True)
        frame = self.pd.DataFrame({"total": net, "price": net, "funding": 0.0, "liquidation": 0.0,
                                   "cost": cost if cost is not None else [0.0] * len(net)}, index=index)
        frame.to_parquet(folder / "daily.parquet")
        summary = {"run_id": ident, "strategy": name, "period": period, "variant": variant, "bar": bar,
                   "start": index[0].date().isoformat(), "end": index[-1].date().isoformat(),
                   "code_sha": "aaaa", "lab_sha": "bbbb"}
        (folder / "summary.json").write_text(json.dumps(summary))
        return ident

    def test_sealed_run_keeps_original_intraday_marks_and_stops_at_declared_period(self):
        from lab.performance.inputs import parse_time
        from lab.performance.native import strategy_bundle

        approved = self.run_folder("validation", "base",
                                   ["2019-12-31 22:00", "2019-12-31 23:00", "2020-01-01 00:00"],
                                   [-0.2, 0.2, 400], bar="h", cost=[-0.01, 0, -15])
        sealed = self.results / "20200201-000000-test-base"
        sealed.mkdir()
        (sealed / "summary.json").write_text("sealed test summary must never be read")
        (sealed / "daily.parquet").write_bytes(b"sealed test marks must never be read")
        row = strategy_bundle("Test Model")["series"][0]
        self.assertEqual(row["equity"], [1.0, 0.8, 1.0])
        self.assertEqual(len(row["times"]), 3)
        self.assertLess(row["times"][-1], parse_time("2020-01-01"))
        self.assertEqual((row["frequency"], row["periodsPerYear"]), ("daily", 365))
        self.assertEqual(row["evidence"]["runs"][0]["id"], approved)
        self.assertEqual(row["costs"]["total"], 0.01)
        self.assertNotIn("trades", row)
        self.assertNotIn("tradeSummary", row)

    def test_native_strategy_entry_point_replays_a_saved_engine_ledger(self):
        import numpy as np
        from lab import runs, strategy_report
        from lab.backtest import backtest

        times = self.pd.date_range("2019-01-04", periods=72, freq="h")
        prices = 100 + 3 * np.sin(np.arange(72) / 4)
        bars = self.pd.DataFrame({"time": times, "symbol": "UNIT", "high": prices + 1,
                                  "low": prices - 1, "close": prices})
        weights = self.pd.DataFrame({"UNIT": [0.6, -0.4, 0.0]}, index=times[[0, 30, 70]])
        result = backtest(weights, bars, cost_bp=8.0)
        engine_hash = runs.lab_sha()
        with patch.object(runs, "ROOT", self.root), patch.object(runs, "lab_sha", return_value=engine_hash):
            folder, _ = runs.save_run("Test Model", "validation", "base", result,
                                      code_file=self.root / "strategies/model.py")
        output = self.root / "single.html"
        argv = ["strategy_report", "Test Model", "html", "--currency", "USD", "--opening-capital", "100",
                "--output", str(output)]
        with patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()):
            runpy.run_path(strategy_report.__file__, run_name="__main__")
        data = re.search(r'<script id="report-data" type="application/json">(.*?)</script>', output.read_text(), re.S)
        row = json.loads(data[1])["series"][0]
        np.testing.assert_allclose(np.diff(row["equity"]) / 100, result.daily["total"], atol=1e-15)
        self.assertEqual(row["periodsPerYear"], 365)
        self.assertEqual(row["evidence"]["runs"][0]["id"], folder.name)
        self.assertAlmostEqual(row["costs"]["total"], -100 * result.daily["cost"].sum())
        self.assertNotIn("trades", row)

    def test_lock_admits_only_the_named_test_and_verifies_its_identity(self):
        from lab.performance.native import strategy_bundle
        self.run_folder("train", "v2", ["2018-01-01"], [0.1])
        test_id = self.run_folder("test", "v2", ["2020-01-01"], [0.2])
        self.run_folder("test", "v2", ["2020-01-02"], [20.0], stamp="20200301-000000")
        lock = self.results / "TEST_DONE"
        baseline = {"run": test_id, "variant": "v2", "code_sha": "aaaa", "lab_sha": "bbbb"}
        lock.write_text(json.dumps(baseline))
        rows = strategy_bundle("Test Model")["series"][0]
        self.assertAlmostEqual(rows["equity"][-1], 1.3)
        self.assertEqual(rows["evidence"]["runs"][-1]["id"], test_id)
        for invalid in [dict(baseline, run="missing"), dict(baseline, code_sha="wrong"),
                        dict(baseline, variant="other"), {"variant": "v2"}]:
            lock.write_text(json.dumps(invalid))
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, "TEST_DONE"):
                strategy_bundle("Test Model")

    def test_portfolio_requires_an_opened_desk_test(self):
        from lab.performance.native import book_bundle
        self.run_folder("train", "base", ["2018-01-01"], [0.1])
        with self.assertRaisesRegex(ValueError, "sealed"):
            book_bundle("Two sleeves", ["Test Model", "Other"], [], currency="USD")
        ident = self.run_folder("test", "base", ["2019-12-31"], [-0.01])
        (self.results / "TEST_DONE").write_text(json.dumps({"run": ident, "variant": "base"}))
        with self.assertRaisesRegex(ValueError, "TEST_DONE"):
            book_bundle("Two sleeves", ["Test Model", "Other"], [], currency="USD")

    def test_native_writer_protects_test_locks_saved_ledgers_and_imported_sources(self):
        from lab.performance.native import render_native
        ident = self.run_folder("train", "base", ["2018-01-01"], [0.01])
        source = self.root / "outside.csv"
        source.write_text("date,net\n2019-01-01,0.01\n")
        paths = [self.results / "TEST_DONE", self.results / ident / "summary.json", source]
        for path in paths:
            before = path.read_bytes() if path.exists() else None
            with self.subTest(path=path.name), self.assertRaisesRegex(ValueError, "output"):
                render_native(bundle(marked()), path, imports=[("Outside", source, "Carry")])
            self.assertEqual(path.read_bytes() if path.exists() else None, before)
        sessions = self.root / "exchange.json"
        sessions.write_text('["2019-01-01"]')
        with self.assertRaisesRegex(ValueError, "output"):
            render_native(bundle(marked()), sessions, session_dates=sessions)
        self.assertEqual(sessions.read_text(), '["2019-01-01"]')

    def test_sparse_later_run_replaces_only_its_actual_bars(self):
        from lab.performance.native import strategy_bundle
        days = ["2018-01-01", "2018-01-02", "2018-01-03"]
        self.run_folder("train", "base", days, [0.01, -0.50, 0.01])
        self.run_folder("train+validation", "base", [days[0], days[2]], [0.02, 0.03])
        series = strategy_bundle("Test Model", opening_capital=100)["series"][0]
        self.assertEqual(series["equity"], [100, 102, 52, 55])
        from lab import strategy_report
        output = self.root / "sessions.html"
        argv = ["strategy_report", "Test Model", "html", "--calendar", "weekday", "--output", str(output)]
        with patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()):
            runpy.run_path(strategy_report.__file__, run_name="__main__")
        self.assertIn('"periodsPerYear":252', output.read_text())

    def test_partial_cross_frequency_replacement_rejects_uncovered_old_pnl(self):
        from lab.performance.native import strategy_bundle
        self.run_folder("train", "base", ["2018-01-01"], [-0.5])
        hours = self.pd.date_range("2018-01-01", periods=24, freq="h")
        self.run_folder("train+validation", "base", hours.delete(12), [0.01] * 23, bar="h")
        with self.assertRaisesRegex(ValueError, "split|partial|overlap"):
            strategy_bundle("Test Model")
        self.run_folder("train+validation", "base", hours, [0.01] * 24, bar="h", stamp="20200201-000000")
        row = strategy_bundle("Test Model", opening_capital=100)["series"][0]
        self.assertEqual(len(row["times"]), 25)
        self.assertAlmostEqual(row["equity"][-1], 124)

    def test_opened_test_prior_close_fee_takes_precedence_and_prescore_zeros_are_trimmed(self):
        from lab import strategy_report
        from lab.performance.inputs import parse_time
        from lab.performance.native import strategy_bundle
        days = ["2019-12-27", "2019-12-28", "2019-12-29", "2019-12-30", "2019-12-31"]
        self.run_folder("validation", "base", days, [0, 0, 0, 0, 0.01])
        identified = self.run_folder("test", "base", [days[-1], "2020-01-01"], [-0.02, 0.01], cost=[-0.02, 0])
        (self.results / "TEST_DONE").write_text(json.dumps({"run": identified, "variant": "base",
                                                            "code_sha": "aaaa", "lab_sha": "bbbb"}))
        sources = strategy_report.list_runs(self.results)
        rows = [strategy_report.daily_of(run) for period in ("validation", "test") for run in sources if run["period"] == period]
        ledger = self.pd.concat(rows)
        ledger = ledger[~ledger.index.duplicated(keep="last")].sort_index()
        scored = ledger.loc[ledger["total"].ne(0).idxmax():]
        actual = strategy_bundle("Test Model", opening_capital=100)["series"][0]
        self.assertEqual(actual["equity"], [100, 98, 99])
        self.assertEqual(actual["equity"][1:], (100 + 100 * scored["total"].cumsum()).tolist())
        self.assertEqual(actual["times"], [parse_time("2019-12-31") - 1, parse_time("2020-01-01") - 1,
                                           parse_time("2020-01-02") - 1])
        self.assertEqual(actual["costs"]["total"], 2)
        self.assertEqual(actual["evidence"]["preScoreBarsRemoved"], 4)

    def test_book_rejects_empty_intraday_day_instead_of_crediting_an_upstream_zero(self):
        from lab.performance.native import book_bundle
        dates = self.pd.date_range("2020-01-01", periods=72, freq="h")
        observed = dates[:24].append(dates[48:])
        ident = self.run_folder("test", "base", observed, [0.001] * len(observed), bar="h")
        (self.results / "TEST_DONE").write_text(json.dumps({"run": ident, "variant": "base"}))
        with self.assertRaisesRegex(ValueError, r"2020-01-02.*(absent|missing|observed|zero)"):
            book_bundle("Book", ["Test Model", "Unused"], currency="USD")

    def test_book_rejects_partial_intraday_override_of_a_daily_contribution(self):
        from lab.performance.native import book_bundle
        self.run_folder("validation", "base", ["2019-12-31"], [-0.5])
        ident = self.run_folder("test", "base", self.pd.date_range("2019-12-31 23:00", periods=4, freq="h"),
                                [0.001] * 4, bar="h")
        (self.results / "TEST_DONE").write_text(json.dumps({"run": ident, "variant": "base"}))
        with self.assertRaisesRegex(ValueError, "2019-12-31.*partial daily overlap"):
            book_bundle("Book", ["Test Model", "Unused"], currency="USD")

    def weekday_imports(self, days):
        imports = []
        for name in ("Rates", "Equity"):
            path = self.root / (name + ".csv")
            pnl = [-0.01 if d.weekday() == 0 else 0.001 for d in days]
            self.pd.DataFrame({"date": days, "net": pnl}).to_csv(path, index=False)
            imports.append((name, str(path), name))
        return imports

    def browser_ratios(self, row):
        code = """
          const series = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
          const s = require(process.argv[1]).analyze(series);
          console.log(JSON.stringify({valid:s.meta.validReturns, neg:s.returns.values.filter(x => x < 0).length,
                                      gaps:s.meta.gaps, sharpe:s.summary.sharpe}));
        """
        return json.loads(subprocess.check_output(["node", "-e", code, str(ROOT / "lab/performance/metrics.js")],
                                                  input=json.dumps(row), text=True))

    @unittest.skipUnless(shutil.which("node"), "Node runs the browser return sampler")
    def test_native_weekday_book_includes_all_monday_losses_in_browser_sharpe(self):
        from lab.performance.native import book_bundle
        days = self.pd.bdate_range("2020-01-01", periods=340)
        imports = self.weekday_imports(days)
        options = dict(currency="USD", opening_date="2019-12-31", opening_capital=100)
        report = book_bundle("Weekday book", [], imports, **options)
        declared = book_bundle("Weekday book", [], imports, calendar="weekday", **options)
        for row, explicit in zip(report["series"], declared["series"]):
            self.assertEqual(row["equity"], explicit["equity"])
            self.assertEqual(row["periodsPerYear"], 252)
            self.assertEqual(row["evidence"]["calendar"]["nativePeriodsPerYear"], 365)
            self.assertIn("inferred", row["evidence"]["calendar"]["basis"].lower())
            browser = self.browser_ratios(row)
            returns = [b / a - 1 for a, b in zip(row["equity"], row["equity"][1:])]
            self.assertEqual((browser["valid"], browser["neg"], browser["gaps"]), (320, 64, []))
            self.assertAlmostEqual(browser["sharpe"], statistics.fmean(returns) / statistics.stdev(returns) * math.sqrt(252))
            self.assertAlmostEqual(browser["sharpe"], -4.2441266709, places=8)
        legacy_factor = book_bundle("Weekday book", [], imports, **options, session_dates={
            "sessionDates": report["series"][0]["sessionDates"], "periodsPerYear": 365})["series"][0]
        browser = self.browser_ratios(legacy_factor)
        self.assertEqual((browser["valid"], browser["neg"], browser["gaps"]), (320, 64, []))
        self.assertAlmostEqual(browser["sharpe"], -4.244126670882312 * math.sqrt(365 / 252), places=10)

    def test_declared_session_calendar_preserves_expected_but_missing_sessions_and_real_closures(self):
        from lab.performance.native import book_bundle
        exchange = self.pd.bdate_range("2019-01-01", "2021-12-31").difference(self.pd.to_datetime(["2020-05-04"]))
        raw = self.pd.bdate_range("2020-01-01", periods=340).difference(self.pd.to_datetime(["2020-05-04", "2020-05-05"]))
        imports = self.weekday_imports(raw)
        options = dict(currency="USD", opening_date="2019-12-31", opening_capital=100)
        dates = [d.date().isoformat() for d in exchange]
        path = self.root / "sessions.json"
        path.write_text(json.dumps({"sessionDates": dates, "periodsPerYear": 250}))
        custom = book_bundle("Book", [], imports, session_dates=path, **options)
        self.assertEqual(custom["series"][0]["sessionDates"], dates)
        self.assertEqual(custom["series"][0]["periodsPerYear"], 250)
        for row in custom["series"]:
            self.assertEqual(row["evidence"]["calendar"]["missingExpectedSessions"], 1)
            self.assertEqual(row["evidence"]["calendar"]["firstMissingSession"], "2020-05-05")
        if shutil.which("node"):
            gaps = self.browser_ratios(custom["series"][0])["gaps"]
            self.assertEqual([g["missingSessions"] for g in gaps], [1])
        assumed = book_bundle("Book", [], imports, **options)["series"][0]
        self.assertIn("2020-05-04", assumed["sessionDates"])
        self.assertIn("2020-05-05", assumed["sessionDates"])
        self.assertEqual(assumed["evidence"]["calendar"]["missingExpectedSessions"], 2)
        daily = book_bundle("Book", [], imports, calendar="daily", **options)["series"][0]
        self.assertEqual(daily["periodsPerYear"], 365)
        self.assertEqual(daily["equity"], assumed["equity"])
        self.assertGreater(daily["evidence"]["calendar"]["missingExpectedSessions"], 2)
        for bad in [list(reversed(dates)), [dates[0], dates[0]], ["2020-02-30"], []]:
            with self.subTest(bad=bad[:2]), self.assertRaisesRegex(ValueError, "session"):
                book_bundle("Book", [], imports, session_dates=bad, **options)
        with self.assertRaisesRegex(ValueError, "calendar"):
            book_bundle("Book", [], imports, calendar="weekday", session_dates=dates, **options)
        args = [sys.executable, "-m", "lab.book_report", "construct", "Book", "html", "--output", str(self.root / "book.html"),
                "--currency", "USD", "--opening-capital", "100", "--opening-date", "2019-12-31", "--session-dates", str(path)]
        for entry in imports:
            args.extend(["--import", *entry])
        run = subprocess.run(args, cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn('"periodsPerYear":250', (self.root / "book.html").read_text())

    def test_ambiguous_mixed_week_import_requires_the_expected_calendar(self):
        from lab.performance.native import book_bundle
        days = self.pd.date_range("2020-01-01", periods=340).delete(165)
        imports = self.weekday_imports(days)
        options = dict(currency="USD", opening_date="2019-12-31", opening_capital=100)
        with self.assertRaisesRegex(ValueError, "ambiguous.*calendar"):
            book_bundle("Book", [], imports, **options)
        reported = book_bundle("Book", [], imports, calendar="daily", **options)["series"][0]
        self.assertEqual(reported["periodsPerYear"], 365)
        self.assertEqual(reported["evidence"]["calendar"]["missingExpectedSessions"], 1)
        with self.assertRaisesRegex(ValueError, "nonzero.*session calendar"):
            book_bundle("Book", [], imports, calendar="weekday", **options)

    def test_weekday_native_ledger_infers_sessions_and_daily_native_ledger_keeps_365(self):
        from lab.performance.native import strategy_bundle
        weekdays = self.pd.bdate_range("2018-01-01", periods=340)
        pnl = [-0.01 if d.day_of_week == 0 else 0.001 for d in weekdays]
        self.run_folder("train+validation", "base", weekdays, pnl)
        row = strategy_bundle("Test Model", opening_capital=100)["series"][0]
        self.assertEqual(row["periodsPerYear"], 252)
        self.assertIn("inferred", row["evidence"]["calendar"]["basis"].lower())
        self.assertEqual(row["evidence"]["calendar"]["missingExpectedSessions"], 0)
        if shutil.which("node"):
            stats = self.browser_ratios(row)
            self.assertEqual((stats["valid"], stats["neg"]), (340, 68))
        daily = self.pd.date_range("2018-01-01", periods=340)
        self.run_folder("train+validation", "base", daily, [0.001] * len(daily), stamp="20200201-000000")
        complete = strategy_bundle("Test Model")["series"][0]
        self.assertEqual(complete["periodsPerYear"], 365)
        self.assertEqual(complete["evidence"]["calendar"]["name"], "daily")
        self.assertEqual(complete["evidence"]["calendar"]["missingExpectedSessions"], 0)

    def test_all_native_weekday_book_keeps_recorded_zero_and_counts_monday_losses(self):
        from lab.performance.native import book_bundle
        sources = self.root / "strategies"
        (sources / "second.py").write_text((sources / "model.py").read_text().replace("Test Model", "Second Model"))
        days = self.pd.bdate_range("2020-01-01", periods=340)
        pnl = [-0.01 if d.day_of_week == 0 else 0.001 for d in days]
        pnl[60] = 0  # Wednesday, a recorded zero contribution
        names = ["Test Model", "Second Model"]
        for name in names:
            ident = self.run_folder("test", "base", days, pnl, name=name)
            lock = self.results.parent / name.lower().replace(" ", "_") / "TEST_DONE"
            lock.write_text(json.dumps({"run": ident, "variant": "base"}))
        book, *members = book_bundle("Book", names, currency="USD")["series"]
        self.assertEqual(book["periodsPerYear"], 252)
        self.assertEqual(book["evidence"]["calendar"]["nativePeriodsPerYear"], 365)
        if shutil.which("node"):
            stats = self.browser_ratios(book)
            self.assertEqual((stats["valid"], stats["neg"]), (320, 64))
        for member in members:
            source = member["evidence"]["runs"][0]
            self.assertEqual(source["recordedUtcDays"], 340)
            self.assertEqual(source["recordedZeroNetDays"], 1)
            self.assertEqual(source["unrecordedUtcDays"], (days[-1] - days[0]).days + 1 - len(days))
            self.assertEqual(source["partialUtcDays"], [])

    def test_native_book_window_and_daily_pnl_match_the_upstream_all_candidate_construction(self):
        import numpy as np
        from lab import book_report
        from lab.performance.native import book_bundle

        days = self.pd.date_range("2020-01-02", periods=401)
        hours = self.pd.date_range("2020-01-01", periods=24 * 402, freq="h")
        self.run_folder("train", "base", ["2018-12-28", "2018-12-29", "2018-12-31"], [0, 0.001, 0.002])
        # An entry cost on the prior close overlaps train. desk_series uses the later scored run.
        self.run_folder("validation", "base", ["2018-12-31", "2019-12-30", "2019-12-31"], [-0.005, -0.012, 0.008])
        locked = self.run_folder("test", "base", hours, 0.00001 + 0.0001 * np.sin(np.arange(len(hours)) / 69), bar="h")
        (self.results / "TEST_DONE").write_text(json.dumps({"run": locked, "variant": "base", "code_sha": "aaaa",
                                                            "lab_sha": "bbbb"}))
        legs = {"Rates": np.sin(np.arange(401) / 7) * 0.001 + 0.0003,
                "Equity": np.cos(np.arange(401) / 19) * 0.007 + 0.0005}
        imports = []
        for name, values in legs.items():
            file = self.pd.DataFrame({"date": days, "net": values})
            if name == "Rates":
                path = self.root / (name + ".parquet")
                file.to_parquet(path, index=False)
            else:
                path = self.root / (name + ".csv")
                file.to_csv(path, index=False)
            imports.append((name, str(path), "Trend" if name == "Rates" else "Equity"))
        options = dict(currency="USD", opening_date="2020-01-01", opening_capital=100)
        report = book_bundle("Cross-asset", ["Test Model"], imports, **options)
        book = next(s for s in report["series"] if s["kind"] == "portfolio")
        members = [s for s in report["series"] if s["kind"] == "strategy"]
        self.assertEqual({s["name"] for s in members}, {"Test Model", *legs})
        self.assertNotIn("attribution", book["evidence"])
        self.assertNotIn("costs", book)
        self.assertNotIn("assetClass", book)
        self.assertIn("risk", book["evidence"]["holdingsBasis"].lower())
        self.assertIn("in-sample", book["evidence"]["method"].lower())
        self.assertIn("proposal", " ".join(book["notes"]).lower())
        captured = {}
        run = book_report.Book.run

        class CapturedBook(Exception):
            """Stop the legacy compute after its actual all-candidate calculation and before PDF statistics."""

        def observe(model, weights):
            pnl, _, multiplier = run(model, weights)
            captured.update(panel=model.N, weights=weights.to_dict(), pnl=pnl, multiplier=multiplier)
            raise CapturedBook

        with patch.object(book_report, "WORK_C", self.root / "construct"), patch.object(book_report.Book, "run", observe):
            with self.assertRaises(CapturedBook):
                book_report.construct_compute("Cross-asset", ["Test Model"], imports)
        self.assertEqual({h["id"]: h["weight"] for h in book["holdings"]}, captured["weights"])
        self.assertAlmostEqual(book["evidence"]["diversificationMultiplier"], captured["multiplier"])
        source = captured["pnl"]
        self.assertEqual(len(source), 381)
        dates = self.pd.to_datetime(book["times"][1:], unit="ms", utc=True).tz_localize(None).normalize()
        self.assertEqual(dates.tolist(), source.index.tolist())
        np.testing.assert_allclose(np.diff(book["equity"]) / 100, source, rtol=0, atol=1e-13)
        for s in members:
            alone = captured["panel"][s["name"]] * book_report.BOOK_VOL / book_report.STRAT_VOL
            self.assertEqual(s["times"], book["times"])
            np.testing.assert_allclose(np.diff(s["equity"]) / 100, alone, rtol=0, atol=1e-13)
        self.assertFalse(any(s["kind"] == "benchmark" for s in report["series"]))
        file = self.root / "native.html"
        args = [sys.executable, "-m", "lab.book_report", "construct", "Cross-asset", "html",
                "--output", str(file), "--currency", "USD", "--opening-date", "2020-01-01", "--opening-capital", "100"]
        for entry in imports:
            args.extend(["--import", *entry])
        result = subprocess.run(args, cwd=ROOT, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('"kind":"portfolio"', file.read_text())
