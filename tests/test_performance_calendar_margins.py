"""Browser checks for calendar returns and full-history averages on synthetic equity."""
from datetime import date, datetime, timedelta, timezone
import os
from pathlib import Path
import tempfile
import unittest

from lab.performance import render_bundle

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None


def timestamp(day):
    return int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp() * 1000)


def calendar_history():
    # Each pair is the January and February closing equity. Hold the February
    # value through December. The prior December close funds the January move.
    closes = {2019: (200, 100), 2020: (100, 100), 2021: (120, 120),
              2022: (132, 264), 2023: (290.4, 261.36), 2024: (392.04, None)}
    day = date(2018, 12, 31)
    times, equity = [timestamp(day)], [100]
    while day < date(2024, 1, 15):
        day += timedelta(days=1)
        # Remove one expected day in February and all June marks. July also
        # loses its opening boundary. This market has seven sessions per week.
        if day == date(2022, 2, 12) or (day.year, day.month) == (2022, 6):
            continue
        times.append(timestamp(day))
        equity.append(closes[day.year][0 if day.month == 1 else 1])
    return {"id": "account", "kind": "strategy", "name": "Account", "currency": "USD",
            "frequency": "daily", "periodsPerYear": 365, "times": times, "equity": equity}


@unittest.skipUnless(sync_playwright, "Install Playwright to run browser checks")
class CalendarMarginTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        folder = tempfile.TemporaryDirectory()
        cls.addClassCleanup(folder.cleanup)
        account = calendar_history()
        index = {**account, "id": "index", "name": "Short index history", "kind": "portfolio",
                 "currency": "INDEX", "times": [timestamp(date(2020, 1, d)) for d in (2, 3)],
                 "equity": [10, 25]}
        dest = Path(folder.name) / "calendar.html"
        render_bundle({"version": 1, "title": "Calendar fixture", "series": [account, index]}, dest)
        cls.url = dest.as_uri()
        api = sync_playwright().start()
        cls.addClassCleanup(api.stop)
        cls.browser = api.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"))
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.page = self.browser.new_page(viewport={"width": 1440, "height": 960}, offline=True)
        self.addCleanup(self.page.close)
        self.page.set_default_timeout(3500)
        self.page.goto(self.url)
        self.page.locator('#scope [data-kind="strategy"]').click()
        self.heat = self.page.locator(".heat")

    def view(self, name):
        if self.page.locator("#open-navigation").is_visible():
            self.page.locator("#open-navigation").click()
        self.page.locator(f'#navigation [data-view="{name}"]').click()

    def assert_structure(self, years):
        self.assertEqual(self.heat.locator("thead th").last.inner_text(), "Year return")
        rows = self.heat.locator("tbody tr")
        self.assertEqual(rows.locator("th").all_inner_texts(), list(map(str, years)))
        for row, year in zip(rows.all(), years):
            cells = row.locator("td")
            self.assertEqual(cells.evaluate_all("cs => cs.slice(0, -1).map(c => c.dataset.month)"),
                             [f"{year}-{month:02}" for month in range(1, 13)])
            self.assertEqual(cells.last.get_attribute("data-year-return"), str(year))
        footer = self.heat.locator("tfoot tr")
        self.assertEqual(footer.locator("th").inner_text(), "Average")
        cells = footer.locator("td")
        self.assertEqual(cells.evaluate_all("cs => cs.slice(0, -1).map(c => c.dataset.monthAverage)"),
                         list(map(str, range(1, 13))))
        self.assertIsNotNone(cells.last.get_attribute("data-year-average"))

    def assert_return(self, cell, expected):
        self.assertAlmostEqual(float(cell.get_attribute("data-return")), expected)
        label = cell.locator(".heat-value")
        self.assertTrue(label.is_visible())
        text = label.inner_text().replace("−", "-")
        self.assertTrue(text.endswith("%"), text)
        self.assertAlmostEqual(float(text[:-1]), expected * 100, delta=.0050001)

    def assert_amount(self, cell, amount):
        self.assertAlmostEqual(float(cell.get_attribute("data-amount")), amount)
        small = cell.locator("small")
        self.assertTrue(small.is_visible())
        first = cell.locator(".heat-value").bounding_box()
        self.assertGreaterEqual(small.bounding_box()["y"], first["y"] + first["height"] - 1)
        text = small.inner_text().replace("−", "-").replace(",", "")
        self.assertEqual(float(text.split()[0]), round(amount, 2))

    def assert_year(self, year, expected, coverage, amount=None):
        cell = self.heat.locator(f'tbody td[data-year-return="{year}"]')
        self.assert_return(cell, expected)
        self.assertEqual(cell.get_attribute("data-coverage"), coverage)
        if amount is not None:
            self.assert_amount(cell, amount)
        return cell

    def assert_average(self, selector, value, count, amount=None):
        cell = self.heat.locator("tfoot td" + selector)
        self.assertEqual(float(cell.get_attribute("data-count")), count)
        if count == 0:
            self.assertEqual(cell.inner_text().strip(), "—")
            self.assertIsNone(cell.get_attribute("data-return"))
        else:
            self.assert_return(cell, value)
            if amount is not None and cell.locator("small").count():
                self.assert_amount(cell, amount)

    def assert_account_averages(self):
        # 2024 January is partial. 2022 February has a measurable gain and a
        # missing day. Neither belongs in its month mean or the complete-year mean.
        self.assert_average('[data-month-average="1"]', (1 + 0 + .2 + .1 + .1) / 5, 5, 31.68)
        self.assert_average('[data-month-average="2"]', (-.5 + 0 + 0 - .1) / 4, 4, -32.26)
        for month in range(3, 13):
            self.assert_average(f'[data-month-average="{month}"]', 0, 4 if month in (6, 7) else 5, 0)
        self.assert_average("[data-year-average]", (0 + 0 + .2 - .01) / 4, 4, 4.34)

    def test_full_history_and_overview_cutoff(self):
        for view in ("overview", "calendar"):
            with self.subTest(view=view):
                self.view(view)
                self.assert_structure(range(2024, 2020 if view == "overview" else 2018, -1))
                self.assert_year(2024, .5, "partial")
                if view == "calendar":
                    self.assert_year(2019, 0, "full", 0)
                self.assert_year(2022, 1.2, "gap", 144 if view == "calendar" else None)
                # January +10% followed by February -10% loses 1% for the year.
                self.assert_year(2023, -.01, "full", -2.64 if view == "calendar" else None)
                self.assertEqual(self.heat.locator('[data-month="2022-06"]').inner_text(), "—")
                self.assert_account_averages()

    def test_filtered_endpoints_keep_original_averages(self):
        self.page.locator('[data-range="Custom"]').click()
        self.page.locator("#date-from").fill("2023-02-01")
        self.page.locator("#date-to").fill("2023-02-28")
        self.page.get_by_role("button", name="Apply settings").click()
        for view in ("overview", "calendar"):
            with self.subTest(view=view):
                self.view(view)
                self.assert_structure([2023])
                self.assert_year(2023, -.1, "partial", -29.04 if view == "calendar" else None)
                if view == "calendar":
                    panel = self.page.locator("section.panel").filter(
                        has=self.page.get_by_role("heading", name="Year-by-year performance", exact=True))
                    row = panel.locator("tbody tr").filter(has_text="2023")
                    label = row.locator("td").nth(2).inner_text().replace("−", "-")
                    self.assertEqual(float(label.removesuffix("%")), -10.)
                self.assert_account_averages()

    def test_index_portfolio_and_empty_averages_on_a_small_screen(self):
        self.page.locator('#scope [data-kind="portfolio"]').click()
        self.page.set_viewport_size({"width": 320, "height": 740})
        self.view("calendar")
        self.assert_structure([2020])
        cell = self.assert_year(2020, 1.5, "partial", 15)
        self.assertIn("index points", cell.get_attribute("aria-label").lower())
        for month in range(1, 13):
            self.assert_average(f'[data-month-average="{month}"]', None, 0)
        self.assert_average("[data-year-average]", None, 0)
        cell.scroll_into_view_if_needed()
        bounds = cell.bounding_box()
        self.assertGreaterEqual(bounds["x"], -1)
        self.assertLessEqual(bounds["x"] + bounds["width"], 321)
        self.assertLessEqual(self.page.evaluate("document.documentElement.scrollWidth"), 321)
