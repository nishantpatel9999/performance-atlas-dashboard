"""Exercise the supplemental metrics through the offline report's date controls."""
import calendar
import csv
from datetime import datetime, timezone
import os
from pathlib import Path
import tempfile
import unittest

from lab.performance import render_bundle

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None


@unittest.skipUnless(sync_playwright, "Install Playwright to run browser checks")
class SupplementBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(directory.cleanup)
        dates = []
        for i in range(25):
            year, month = 2023 + i // 12, 1 + i % 12
            date = datetime(year, month, calendar.monthrange(year, month)[1], 16, tzinfo=timezone.utc)
            dates.append(int(date.timestamp() * 1000))
        values = [100 + 2 * i for i in range(25)]
        values[2] = 96
        account = {"id": "s", "name": "Test account", "kind": "strategy", "frequency": "monthly",
                   "periodsPerYear": 12, "times": dates, "equity": values, "currency": "USD",
                   "trades": [{"time": dates[1], "pnl": 8, "side": "long"},
                              {"time": dates[2], "pnl": -4, "side": "short"},
                              {"time": dates[3], "pnl": 2}]}
        index = {**account, "id": "index", "name": "Test index", "currency": "INDEX",
                 "trades": [{"time": dates[2], "pnl": -2, "side": "short"}]}
        history = {**account, "id": "many", "name": "Long ledger", "equity": [v * 1000000 for v in values],
                   "trades": [{"time": dates[5] + i, "pnl": i % 3 - 1} for i in range(125)]}
        dest = Path(directory.name) / "metrics.html"
        render_bundle({"version": 1, "title": "Metrics fixture", "series": [account, index, history]}, dest)
        cls.url = dest.as_uri()
        api = sync_playwright().start()
        cls.addClassCleanup(api.stop)
        cls.browser = api.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"))
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.page = self.browser.new_page()
        self.addCleanup(self.page.close)
        self.page.set_default_timeout(3500)
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.goto(self.url)

    def tearDown(self):
        self.assertEqual(self.errors, [])

    def view(self, name):
        self.page.locator(f'[data-view="{name}"]').click()

    def test_monthly_percentages_are_visible_in_both_views_and_exported(self):
        for view in ("overview", "calendar"):
            self.view(view)
            heat = self.page.locator(".heat")
            self.assertEqual(heat.locator("thead th").all_text_contents()[1:4], ["Jan", "Feb", "Mar"])
            row = heat.locator("tr").filter(has=self.page.get_by_role("rowheader", name="2023"))
            self.assertEqual(row.locator("td").nth(0).inner_text().strip(), "—")
            for index, expected in ((1, "+2.00%"), (2, "-5.88%")):
                cell = row.locator("td").nth(index)
                self.assertEqual(cell.inner_text().splitlines()[0], expected)
                self.assertIn(expected, cell.get_attribute("aria-label"))
        with self.page.expect_download() as handle:
            self.page.locator("#export").click()
        with handle.value.path().open() as stream:
            reader = csv.DictReader(stream)
            self.assertEqual(reader.fieldnames, ["month", "return_pct", "equity_change", "unit",
                                                "coverage", "opening_utc", "closing_utc"])
            rows = list(reader)
            exported = {r["month"]: r for r in rows}
        self.assertEqual(len(rows), len(exported))
        for month in exported:
            self.assertRegex(month, r"^\d{4}-(0[1-9]|1[0-2])$")
        self.assertIn("-monthly-", handle.value.suggested_filename)
        self.assertAlmostEqual(float(exported["2023-03"]["return_pct"]), (96 / 102 - 1) * 100)
        self.assertEqual(float(exported["2023-03"]["equity_change"]), -6)
        self.assertEqual(exported["2023-03"]["unit"], "USD")
        self.assertNotIn("2022-12", exported)

    def test_profile_and_rolling_denominators(self):
        self.assertTrue(self.page.get_by_text("Gain-to-pain ratio", exact=True).is_visible())
        self.assertTrue(self.page.get_by_text("Cumulative log return", exact=True).is_visible())
        self.view("rolling")
        self.page.locator("#rolling-window").select_option("18")
        panel = self.page.locator("section.panel").filter(has=self.page.get_by_role("heading", name="Profitable rolling windows"))
        row = panel.get_by_role("row").filter(has_text="18 months")
        self.assertIn("7 / 7", row.inner_text())
        self.assertIn("100.0%", row.inner_text())

    def test_trade_chronology_and_monthly_amounts_follow_one_date_selection(self):
        self.view("trades")
        table = self.page.locator("table").filter(has=self.page.get_by_role("columnheader", name="Long", exact=True))
        self.assertEqual(table.get_by_role("columnheader").all_text_contents(), ["Measure", "All", "Long", "Short"])
        self.assertIn("6.00 USD", table.get_by_role("row").filter(has_text="Net P&L").inner_text())
        bars = self.page.locator("#trade-chronology rect[tabindex]")
        self.assertEqual(bars.count(), 3)
        self.assertEqual(bars.first.get_attribute("fill"), "var(--gain)")
        self.assertEqual(bars.nth(1).get_attribute("fill"), "var(--loss)")
        self.page.locator('[data-range="Custom"]').click()
        self.page.locator("#date-from").fill("2023-03-01")
        self.page.locator("#date-to").fill("2023-03-31")
        self.page.get_by_role("button", name="Apply settings").click()
        self.assertEqual(bars.count(), 1)
        self.assertIn("-4.00 USD", table.get_by_role("row").filter(has_text="Net P&L").inner_text())
        self.view("calendar")
        cell = self.page.locator(".heat tbody td[data-month][data-tip]")
        self.assertEqual(cell.count(), 1)
        self.assertIn("-6.00", cell.inner_text())
        self.assertIn("USD", cell.get_attribute("aria-label"))
        self.assertIn("-5.88%", cell.get_attribute("aria-label"))
        self.page.locator("#series-select").select_option("index")
        self.assertIn("index points", self.page.locator(".heat tbody td[data-month][data-tip]").first.get_attribute("aria-label"))
        self.view("trades")
        self.assertIn("-2.00 index points", table.get_by_role("row").filter(has_text="Net P&L").inner_text())

    def test_long_ledger_labels_the_displayed_trades_and_preserves_the_full_count(self):
        self.page.locator("#series-select").select_option("many")
        self.view("trades")
        bars = self.page.locator("#trade-chronology rect[tabindex]")
        self.assertEqual(bars.count(), 120)
        self.assertTrue(bars.first.get_attribute("aria-label").startswith("Trade 6 ·"))
        self.assertTrue(bars.last.get_attribute("aria-label").startswith("Trade 125 ·"))
        self.assertIn("latest 120 of 125", self.page.locator("#view").inner_text())

    def test_monthly_amounts_fit_their_cells_on_a_small_screen(self):
        self.page.locator("#series-select").select_option("many")
        self.view("calendar")
        self.page.set_viewport_size({"width": 320, "height": 740})
        cells = self.page.locator(".heat tbody td[data-month][data-tip] small")
        self.assertGreater(cells.count(), 12)
        self.assertTrue(cells.evaluate_all(
            "labels => labels.every(el => el.getBoundingClientRect().width <= el.parentElement.clientWidth + 1)"
        ))
        self.assertLessEqual(self.page.locator("body").evaluate("el => el.scrollWidth"), 321)
