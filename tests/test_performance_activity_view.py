"""Check the session chart against individual daily records, including intraday exits."""
import csv
import os
import tempfile
import unittest
from pathlib import Path

from lab.performance import render_bundle
from lab.performance.demo import demo_bundle

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None


class DemoActivityTests(unittest.TestCase):
    def test_demo_counts_open_sleeves_and_closes_the_account(self):
        portfolio = demo_bundle()["series"][0]
        rows = portfolio["activity"]["rows"]
        self.assertEqual(len(rows), len(portfolio["times"]))
        self.assertEqual(rows[0]["active"], 0)
        self.assertEqual(rows[-1]["overnight"], 0)
        self.assertEqual(rows[-1]["marginUsd"], 0)
        self.assertGreater(len({r["active"] for r in rows[1:-1]}), 1)
        self.assertTrue(any(r["active"] > r["overnight"] for r in rows))
        for r, exposure in zip(rows, portfolio["diagnostics"][0]["values"], strict=True):
            self.assertTrue(0 <= r["overnight"] <= r["active"] <= 4)
            self.assertEqual(r["overnight"] == 0, exposure == 0)
            self.assertEqual(r["marginUsd"] == 0, exposure == 0)


@unittest.skipUnless(sync_playwright, "Playwright is optional for browser verification")
class DailyChartTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        folder = tempfile.TemporaryDirectory()
        cls.addClassCleanup(folder.cleanup)
        cls.root = Path(folder.name)
        cls.bundle = demo_bundle()
        cls.report = render_bundle(cls.bundle, cls.root / "demo.html")
        api = sync_playwright().start()
        cls.addClassCleanup(api.stop)
        cls.browser = api.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"))
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.page = self.browser.new_page(offline=True)
        self.addCleanup(self.page.close)
        self.page.set_default_timeout(2500)

    def test_chart_cursor_and_csv_agree_on_the_last_date_in_a_filtered_year(self):
        p = self.page
        p.goto(self.report.as_uri())
        p.locator('[data-view="activity"]').click()
        p.locator('[data-range="1Y"]').click()
        chart = p.locator("#activity-chart")
        chart.focus()
        p.keyboard.press("End")
        lines = chart.locator(".chart-tip").inner_text()
        self.assertIn("2025", lines)
        self.assertIn("Held overnight", lines)
        self.assertIn("$0.00", lines)
        p.keyboard.press("ArrowLeft")
        self.assertNotEqual(chart.locator(".chart-tip").inner_text(), lines)
        with p.expect_download() as download:
            p.get_by_role("button", name="Export data").click()
        with Path(download.value.path()).open() as source:
            exported = list(csv.DictReader(source))
        self.assertGreater(len(exported), 200)
        self.assertLess(len(exported), 300)
        self.assertEqual(exported[-1]["session_date"], "2025-12-31")
        self.assertEqual(float(exported[-1]["overnight_requirement_usd"]), 0)
        self.assertGreater(float(exported[-2]["overnight_requirement_usd"]), 0)

    def test_worked_example_separates_estimates_missing_fx_and_broker_equity(self):
        from lab.performance.inputs import load_config
        source = Path(__file__).resolve().parents[1] / "examples/performance/report.json"
        report = render_bundle(load_config(source), self.root / "monthly.html")
        p = self.page
        p.goto(report.as_uri())
        p.locator('[data-view="activity"]').click()
        day = p.get_by_label("Inspect trading day")
        day.fill("2023-12-22")
        reading = p.locator("#activity-reading")
        self.assertIn("$318.00", reading.inner_text())
        reading.get_by_text("Requirement breakdown").click()
        self.assertIn("cad-contract", reading.inner_text())
        self.assertIn("0.75 USD/CAD", reading.inner_text())
        self.assertIn("$150.00", reading.inner_text())
        p.get_by_label("Next trading day").click()
        self.assertEqual(day.input_value(), "2023-12-26")
        self.assertIn("FX", reading.inner_text())
        self.assertNotIn("$0.00", reading.inner_text())
        day.fill("2023-12-28")
        self.assertIn("Broker required equity", reading.inner_text())
        self.assertIn("$1,600.00", reading.inner_text())
        # Portfolio equity is recorded only at month-end, outside this session window.
        p.get_by_role("button", name="Report settings").click()
        p.locator("#date-from").fill("2023-12-26")
        p.locator("#date-to").fill("2023-12-27")
        p.get_by_role("button", name="Apply settings").click()
        self.assertEqual(day.input_value(), "2023-12-27")
        with p.expect_download() as download:
            p.get_by_role("button", name="Export data").click()
        with Path(download.value.path()).open() as stream:
            values = list(csv.DictReader(stream))
        self.assertEqual([r["overnight_requirement_usd"] for r in values], ["", "1200"])
        self.assertEqual([r["requirement_basis"] for r in values], ["unknown", "broker_requirement"])

    def test_count_is_unavailable_without_positions_or_daily_summaries(self):
        data = demo_bundle()
        del data["series"][0]["activity"]
        target = render_bundle(data, self.root / "nav-only.html")
        p = self.page
        p.goto(target.as_uri())
        p.locator('[data-view="activity"]').click()
        self.assertIn("daily position", p.locator("#view").inner_text().lower())
        self.assertEqual(p.locator("#activity-chart svg").count(), 0)
        self.assertTrue(p.get_by_role("button", name="Export data").is_disabled())
