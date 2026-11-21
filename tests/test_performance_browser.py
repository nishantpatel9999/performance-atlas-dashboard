"""Browser regression checks. Install Playwright and its Chromium browser to run."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None


@unittest.skipUnless(sync_playwright, "Playwright is optional for browser verification")
class ReportBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.directory.cleanup)
        report = Path(cls.directory.name) / "report.html"
        subprocess.run([sys.executable, "-m", "lab.performance", "--demo", "--output", str(report)],
                       check=True, cwd=Path(__file__).resolve().parents[1])
        cls.url = report.as_uri()
        api = sync_playwright().start()
        cls.addClassCleanup(api.stop)
        executable = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH")
        cls.browser = api.chromium.launch(executable_path=executable)
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.page = self.browser.new_page(viewport={"width": 1440, "height": 960})
        self.addCleanup(self.page.close)
        self.errors = []
        self.external = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("request", lambda req: self.external.append(req.url)
                     if req.url.startswith(("https:", "http:")) else None)
        self.page.goto(self.url)

    def tearDown(self):
        self.assertEqual(self.errors, [])
        self.assertEqual(self.external, [])

    def test_explores_both_scopes_and_all_views_offline(self):
        page = self.page
        self.assertIn("Portfolio overview", page.locator("h1").inner_text())
        self.assertGreater(page.locator("#equity-chart svg").count(), 0)
        page.get_by_role("button", name="Strategy", exact=True).click()
        self.assertIn("Strategy overview", page.locator("h1").inner_text())
        self.assertGreater(page.locator("#series-select option").count(), 1)
        page.locator("#series-select").select_option(index=1)
        for view, title in (("drawdowns", "Drawdowns"), ("rolling", "Rolling metrics"),
                            ("calendar", "Calendar returns"), ("trades", "Trades and costs"),
                            ("compare", "Comparisons"), ("evidence", "Evidence and methods")):
            page.locator(f'[data-view="{view}"]').click()
            self.assertEqual(page.locator("h1").inner_text(), title)
        page.locator('[data-view="overview"]').click()
        page.locator('[data-range="1Y"]').click()
        self.assertEqual(page.locator('[data-range="1Y"]').get_attribute("aria-pressed"), "true")
        with page.expect_download() as result:
            page.get_by_role("button", name="Export data").click()
        self.assertTrue(result.value.suggested_filename.endswith(".csv"))

    def test_filter_opens_a_strategy_from_the_comparison_scorecard(self):
        page = self.page
        page.locator('[data-view="compare"]').click()
        page.get_by_label("Find strategies").fill("carry")
        rows = page.locator("#score-rows tbody tr")
        self.assertEqual(rows.count(), 1)
        rows.first.get_by_role("button").click()
        self.assertEqual(page.locator("h1").inner_text(), "Strategy overview")
        self.assertIn("Carry", page.locator("#series-select option:checked").inner_text())

    def test_metric_explorer_exports_the_selected_measure(self):
        page = self.page
        page.locator('[data-view="explorer"]').click()
        page.locator("#explorer-metric").select_option("returns")
        self.assertEqual(page.locator("#explorer-chart svg").count(), 1)
        with page.expect_download() as result:
            page.get_by_role("button", name="Export data").click()
        rows = Path(result.value.path()).read_text().splitlines()
        self.assertIn("timestamp_utc,value", rows[0])
        self.assertIn("returns", result.value.suggested_filename)
        self.assertGreater(len(rows), 100)

    def test_indexed_chart_uses_the_same_opening_mark_as_headline_return(self):
        page = self.page
        page.locator('[data-range="1Y"]').click()
        chart = page.locator("#equity-chart")
        chart.focus()
        page.keyboard.press("End")
        indexed_end = float(chart.locator(".chart-tip span").inner_text().split()[-1].replace(",", ""))
        total = float(page.locator('[data-metric="totalReturn"] .kpi-value').inner_text().strip("+%"))
        self.assertAlmostEqual(indexed_end, 100 + total, delta=0.015)

    def test_full_source_cost_totals_do_not_create_gross_pnl_for_a_truncated_account(self):
        from lab.performance import render_bundle
        report = Path(self.directory.name) / "truncated.html"
        series = {"id":"sample", "name":"Test account", "kind":"strategy", "currency":"USD",
                  "frequency":"daily", "periodsPerYear":365, "times":[0,86400000,172800000],
                  "equity":[100,0,100], "accounting":"Net asset value", "costModel":"Source fees",
                  "costs":{"currency":"USD","total":55}, "evidence":{"sourceHorizon":{"start":0,"end":172800000}}}
        render_bundle({"version":1,"title":"Account limits","series":[series]}, report)
        self.page.goto(report.as_uri())
        self.page.locator('[data-view="trades"]').click()
        view = self.page.locator("#view").inner_text()
        self.assertIn("55.00 USD", view)
        self.assertNotIn("Before reported costs", view)

    def test_settings_and_mobile_navigation(self):
        page = self.page
        page.set_viewport_size({"width": 390, "height": 844})
        page.get_by_role("button", name="Report settings").click()
        page.get_by_label("Annual risk-free rate (%)").fill("2")
        page.get_by_role("button", name="Apply settings").click()
        page.get_by_role("button", name="Report settings").click()
        self.assertEqual(page.get_by_label("Annual risk-free rate (%)").input_value(), "2")
        page.keyboard.press("Escape")
        page.get_by_role("button", name="Open navigation").click()
        page.locator('[data-view="rolling"]').click()
        self.assertEqual(page.locator("h1").inner_text(), "Rolling metrics")
        self.assertLessEqual(page.locator("body").evaluate("e => e.scrollWidth"), 391)
        page.set_viewport_size({"width": 320, "height": 740})
        self.assertLessEqual(page.locator("body").evaluate("e => e.scrollWidth"), 321)


if __name__ == "__main__":
    unittest.main()
