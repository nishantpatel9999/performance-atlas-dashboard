"""Checks for the portable full-history evidence manifest."""

import hashlib
import importlib.util
import json
import math
import os
import statistics
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from lab.performance import evidence
from lab.performance.build import render_bundle


DAY = 86_400_000
ROOT = Path(__file__).resolve().parents[1]


def marked(**extra):
    return {"id": "curve", "name": "Example account", "kind": "strategy", "currency": "USD",
            "times": [0, DAY, DAY + 1, 2 * DAY, 3 * DAY], "equity": [100, 120, 90, 105, 98],
            "frequency": "daily", "periodsPerYear": 365, **extra}


def report(directory, *series):
    return render_bundle({"version": 1, "title": "Illustration", "series": list(series)}, directory / "report.html")


class SourceEvidenceTests(unittest.TestCase):
    def test_reads_only_inert_json_and_rejects_ambiguous_data(self):
        start = '<script id="report-data" type="application/json">'
        source = start + '{"version":1,"title":"A &amp; B","series":[]}</script>'
        bundle, digest = evidence.read_payload(source)
        self.assertEqual(bundle["title"], "A &amp; B")
        self.assertEqual(len(digest), 64)
        for invalid in (
            source + source,
            source.replace('type="application/json"', 'type="text/javascript"'),
            source.replace('"version":1', '"version":2,"version":1'),
            source.replace('"series":[]', '"series":[NaN]'),
        ):
            with self.subTest(invalid=invalid[:100]), self.assertRaises(ValueError):
                evidence.read_payload(invalid)

    def test_external_source_requires_the_digest_bound_to_the_series(self):
        record = {"baseline": {"status": "observed"}, "families": ["costs"], "results": []}
        raw = json.dumps(record).encode()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "source.json"
            path.write_bytes(raw)
            binding = {"sourceManifest": {"sha256": hashlib.sha256(raw).hexdigest()}}
            self.assertEqual(evidence.read_source_manifest(path, binding), record)
            with self.assertRaisesRegex(ValueError, "sha256|SHA-256"):
                evidence.read_source_manifest(path, {})
            path.write_bytes(raw + b"\n")
            with self.assertRaisesRegex(ValueError, "sha256|SHA-256"):
                evidence.read_source_manifest(path, binding)

    def test_external_results_attach_without_mutation_and_keep_the_source_verdict(self):
        result = {"family": "costs", "settings": {"multiplier": 2}, "seed": 0,
                  "source_data": "fill ledger", "cost_model": "double fees", "status": "failed",
                  "metrics": {"total_return": -0.08, "max_drawdown": -0.19, "sharpe": -0.4}}
        source = {"baseline": {"settings": {"rules": "enter on previous close"}, "seed": 0,
                               "source_data": "fills", "cost_model": "recorded fees", "status": "run",
                               "cagr": 9}, "families": ["costs"], "results": [result]}
        original = marked(evidence={"runId": "sample"})
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            src = folder / "source.json"
            src.write_text(json.dumps(source))
            linked = evidence.attach_source_manifest(original, src)
            self.assertEqual(original["evidence"], {"runId": "sample"})
            self.assertEqual(linked["evidence"]["results"], [result])
            obj = evidence.build_manifest(report(folder, linked), source_manifest=src)
        self.assertNotEqual(obj["baseline"]["cagr"], 9)
        self.assertEqual(obj["source_run"]["baseline"]["cagr"], 9)
        self.assertEqual(obj["baseline"]["cost_model"], "recorded fees")
        self.assertEqual(obj["results"][0], result)
        self.assertEqual(obj["provenance"]["seeds"], 0)
        self.assertEqual(obj["source_evidence"]["sourceManifest"]["file"], "source.json")

    def test_incomplete_research_claim_is_rejected(self):
        record = {"family": "costs", "settings": {"multiplier": 2}, "seed": 0,
                  "source_data": "fills", "cost_model": "double fees", "status": "passed"}
        with self.assertRaisesRegex(ValueError, "outcome"):
            evidence._test_records({}, {"results": [record]}, {}, None)


class ManifestTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.folder = Path(temp.name)

    def test_computes_original_mark_loss_and_distinguishes_missing_evidence_from_zero(self):
        obj = evidence.build_manifest(report(self.folder, marked(holdings=[{"id": "cash", "weight": 1}])))
        self.assertAlmostEqual(obj["baseline"]["max_drawdown"], -0.25)
        self.assertAlmostEqual(obj["baseline"]["total_return"], -0.02)
        self.assertEqual(obj["sampling"]["valid_period_returns"], 3)
        self.assertEqual(obj["series"]["equity"], [100, 120, 90, 105, 98])
        self.assertEqual(len(obj["coverage"]), 79)
        for key in ("costs.commission_total", "trades.count", "provenance.seeds",
                    "exposure.avg_gross_exposure", "benchmark.total_return"):
            self.assertEqual(obj["coverage"][key]["status"], "not_available")
        self.assertTrue(all(row["status"] == "not_run" for row in obj["results"]))

    def test_monthly_risk_does_not_fill_daily_fields_or_unaligned_benchmark_totals(self):
        asset = marked(frequency="monthly", periodsPerYear=12, times=[0, 31 * DAY, 60 * DAY],
                       equity=[100, 90, 110], benchmarkId="index")
        index = marked(id="index", kind="benchmark", frequency="monthly", periodsPerYear=12,
                       times=[0, 31 * DAY, 61 * DAY], equity=[100, 93, 112])
        obj = evidence.build_manifest(report(self.folder, index, asset))
        self.assertEqual(obj["identity"]["series_id"], "curve")
        self.assertEqual(obj["coverage"]["risk.var_95_daily"]["status"], "not_available")
        self.assertEqual(obj["coverage"]["benchmark.total_return"]["status"], "not_available")

    def test_terminal_mark_preserves_debt_and_keeps_source_totals_out_of_window_measures(self):
        series = marked(equity=[100, 120, -9, 105, 98], costs={"commissions": 4},
                        tradeSummary={"closedTrades": 3}, evidence={"exposure": {"avg_gross_exposure": 2}})
        obj = evidence.build_manifest(report(self.folder, series))
        self.assertEqual(obj["series"]["equity"], [100, 120, -9])
        self.assertAlmostEqual(obj["baseline"]["max_drawdown"], -1.075)
        self.assertFalse(obj["source_horizon_matches"])
        self.assertEqual(obj["source_accounts"]["costs"]["commissions"], 4)
        self.assertEqual(obj["coverage"]["costs.commission_total"]["status"], "not_available")
        self.assertEqual(obj["coverage"]["exposure.avg_gross_exposure"]["status"], "not_available")
        self.assertEqual(obj["coverage"]["trades.count"]["status"], "not_available")

    def test_dated_trade_results_reconcile_and_full_sources_stay_labeled(self):
        pnl = [7, -2, 1, 0]
        series = marked(trades=[{"time": t, "pnl": x} for t, x in zip([0, DAY, 2 * DAY, 3 * DAY], pnl)],
                        tradeSummary={"closedTrades": 4}, costs={"commissions": 0},
                        evidence={"exposure": {"avg_gross_exposure": 1.2, "avg_net_exposure": -0.25}})
        obj = evidence.build_manifest(report(self.folder, series))
        self.assertEqual(obj["trades"]["count"], 4)
        self.assertEqual(obj["costs"]["commission_total"], 0)
        self.assertEqual(obj["exposure"]["avg_gross_exposure"], 1.2)
        self.assertEqual(obj["source_accounts"]["exposure"]["avg_net_exposure"], -0.25)
        row = next(x for x in obj["results"] if x["family"] == "winner_removal")
        self.assertEqual(row["metrics"]["baseline"]["net_pnl"], 6)
        self.assertEqual(row["metrics"]["remaining"]["net_pnl"], -1)
        self.assertEqual(row["removed_source_indices"], [0])
        self.assertNotIn("sharpe", row["metrics"]["remaining"])
        partial = marked(trades=series["trades"][:1], tradeSummary={"closedTrades": 4})
        obj = evidence.build_manifest(report(self.folder, partial))
        self.assertEqual(obj["trades"]["count"], 4)
        self.assertTrue(obj["trade_scope"]["partial_ledger"])
        self.assertEqual(obj["coverage"]["trades.profit_factor"]["status"], "not_available")

    def test_exposure_uses_aligned_measurements_and_keeps_net_exposure_signed(self):
        times = marked()["times"]
        gross = {"name": "Gross exposure", "unit": "%", "times": times, "values": [0, 1, 2, 0, 1]}
        net = {"name": "Net exposure", "unit": "%", "times": times, "values": [0, -1, 1, 0, -1]}
        obj = evidence.build_manifest(report(self.folder, marked(diagnostics=[gross, net])))
        self.assertEqual(obj["exposure"]["max_gross_exposure"], 2)
        self.assertEqual(obj["exposure"]["avg_gross_exposure"], 0.8)
        self.assertEqual(obj["exposure"]["avg_net_exposure"], -0.2)
        self.assertEqual(obj["exposure"]["time_in_market_pct"], 0.5)
        gross = dict(gross, values=[0, 1, None, 0, 1])
        obj = evidence.build_manifest(report(self.folder, marked(diagnostics=[gross])))
        self.assertEqual(obj["coverage"]["exposure.avg_gross_exposure"]["status"], "not_available")

    def test_external_costs_keep_their_original_horizon_and_units(self):
        series = marked(costs={"total": 7, "commission": 3, "currency": "EUR"},
                        evidence={"sourceHorizon": {"start": 1, "end": 3 * DAY}})
        obj = evidence.build_manifest(report(self.folder, series))
        self.assertFalse(obj["source_horizon_matches"])
        self.assertEqual(obj["source_accounts"]["costs"]["commission"], 3)
        self.assertEqual(obj["coverage"]["costs.commission_total"]["status"], "not_available")
        obj = evidence.build_manifest(report(self.folder, marked(costs=series["costs"])))
        self.assertEqual(obj["coverage"]["costs.commission_total"]["status"], "not_available")

    def test_cli_reproduces_manifest_and_detects_changed_report_bytes(self):
        html = report(self.folder, marked())
        command = [sys.executable, "-B", "-m", "lab.performance.evidence", "--html", str(html)]
        subprocess.run(command, cwd=ROOT, capture_output=True, check=True)
        manifest = self.folder / "research_tests/manifest.json"
        subprocess.run([*command, "--check", str(manifest)], cwd=ROOT, capture_output=True, check=True)
        before = manifest.read_bytes()
        html.write_bytes(html.read_bytes() + b"\n")
        stale = subprocess.run([*command, "--check", str(manifest)], cwd=ROOT, text=True, capture_output=True)
        self.assertNotEqual(stale.returncode, 0)
        self.assertIn("differs", stale.stderr)
        self.assertEqual(manifest.read_bytes(), before)


@unittest.skipUnless(os.environ.get("REPORT_PREFLIGHT"), "Set REPORT_PREFLIGHT for the independent document check")
class ReportDocumentTests(unittest.TestCase):
    def test_all_synthetic_series_reconcile_and_pass_the_document_gate(self):
        from lab.performance.demo import demo_bundle

        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            existing = os.environ.get("PERFORMANCE_REPORT_HTML")
            html = Path(existing).resolve() if existing else render_bundle(demo_bundle(), folder / "report.html")
            bundle, _ = evidence.read_payload(html.read_text())
            receipt = {"html_sha256": hashlib.sha256(html.read_bytes()).hexdigest(), "checks": []}
            for series in bundle["series"]:
                with self.subTest(series=series["id"]):
                    manifest = evidence.build_manifest(html, series["id"])
                    self.assertEqual(manifest["series"]["equity"], series["equity"])
                    times, values = series["times"], series["equity"]
                    peak, drawdown = values[0], 0
                    closes = {}
                    for t, value in zip(times, values, strict=True):
                        peak = max(peak, value)
                        drawdown = min(drawdown, value / peak - 1)
                        closes[t // DAY] = value
                    nav = list(closes.values())
                    rates = [b / a - 1 for a, b in zip(nav, nav[1:])]
                    growth = values[-1] / values[0]
                    expected = {"cagr": growth ** (365.25 * DAY / (times[-1] - times[0])) - 1,
                                "max_drawdown": drawdown, "total_return": growth - 1,
                                "sharpe": statistics.fmean(rates) / statistics.stdev(rates) * math.sqrt(series["periodsPerYear"])}
                    for key, value in expected.items():
                        self.assertAlmostEqual(manifest["baseline"][key], value, places=10, msg=key)
                    out = folder / "manifest.json"
                    out.write_text(json.dumps(manifest, allow_nan=False))
                    checked = subprocess.run([sys.executable, "-B", os.environ["REPORT_PREFLIGHT"], str(out),
                                              "--html", str(html)], capture_output=True, text=True)
                    self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
                    result = json.loads(checked.stdout)
                    self.assertTrue(result["manifest_report"]["coverage"]["checked"])
                    statuses = [entry["status"] for entry in manifest["coverage"].values()]
                    receipt["checks"].append({"id": series["id"], "marks": len(times), "direct_preflight": result["valid"],
                                              "computed": statuses.count("computed"), "unavailable": statuses.count("not_available"),
                                              "all_equity_marks_match": True, "independent_metrics_match": list(expected)})
            destination = os.environ.get("PERFORMANCE_SERIES_RECEIPT")
            if destination:
                Path(destination).write_text(json.dumps(receipt, indent=2) + "\n")

    def test_synthetic_report_source_and_rendered_views(self):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            self.skipTest("Install Playwright to inspect rendered views")
        from lab.performance.demo import demo_bundle

        validator = Path(os.environ["REPORT_PREFLIGHT"]).resolve()
        spec = importlib.util.spec_from_file_location("document_preflight", validator)
        checker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(checker)
        with tempfile.TemporaryDirectory() as tmp, sync_playwright() as api:
            folder = Path(tmp)
            existing = os.environ.get("PERFORMANCE_REPORT_HTML")
            html = Path(existing).resolve() if existing else render_bundle(demo_bundle(), folder / "report.html")
            manifest = evidence.build_manifest(html)
            source = folder / "manifest.json"
            source.write_text(json.dumps(manifest, allow_nan=False))
            direct = subprocess.run([sys.executable, "-B", str(validator), str(source), "--html", str(html)],
                                    capture_output=True, text=True)
            self.assertEqual(direct.returncode, 0, direct.stdout + direct.stderr)
            receipt = {"html_sha256": hashlib.sha256(html.read_bytes()).hexdigest(),
                       "source_html": json.loads(direct.stdout)["html_report"], "views": {}}
            browser = api.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"))
            try:
                page = browser.new_page(offline=True, service_workers="block")
                page.goto(html.as_uri())
                page.wait_for_selector("#equity-chart svg")
                links = page.locator("#navigation [data-view]")
                for name in links.evaluate_all("(links) => links.map(e => e.dataset.view)"):
                    page.locator(f'#navigation [data-view="{name}"]').click()
                    result = checker.validate_html(page.content())
                    charts = {}
                    for key, chart in manifest.get("visuals", {}).items():
                        if chart["view"] == name:
                            selector = chart["selector"] + (" [data-tip]" if key == "monthly_heatmap" else " svg")
                            charts[key] = page.locator(selector).count() > 0
                    receipt["views"][name] = {"tables": result["tables_checked"], "decision_first": result["decision_first"],
                                              "errors": result["errors"], "charts": charts}
            finally:
                browser.close()
            destination = os.environ.get("PERFORMANCE_VIEW_RECEIPT")
            if destination:
                Path(destination).write_text(json.dumps(receipt, indent=2) + "\n")
            self.assertTrue({"overview", "calendar", "trades", "compare", "evidence"} <= receipt["views"].keys())
            for name, view in receipt["views"].items():
                with self.subTest(view=name):
                    self.assertFalse(view["errors"], view["errors"])
                    self.assertTrue(all(view["charts"].values()), view["charts"])


if __name__ == "__main__":
    unittest.main()
