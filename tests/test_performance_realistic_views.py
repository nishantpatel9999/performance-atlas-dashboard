"""Reader regressions with synthetic source records. All browser requests stay offline."""

import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from lab.performance import render_bundle

try:
    from playwright.sync_api import Error as PlaywrightError, sync_playwright
except ImportError:
    sync_playwright = None


DAY = 86_400_000
START = int(datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)


def series(ident, kind="strategy", **fields):
    return {
        "id": ident, "name": ident, "kind": kind, "currency": "USD",
        "frequency": "daily", "periodsPerYear": 365,
        "times": [START + i * DAY for i in range(5)],
        "equity": [100, 102, 99, 105, 110],
        "source": "Synthetic records", **fields,
    }


@unittest.skipUnless(sync_playwright, "Playwright is optional for browser verification")
class RealisticViewsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        folder = tempfile.TemporaryDirectory()
        cls.addClassCleanup(folder.cleanup)
        cls.root = Path(folder.name)
        api = sync_playwright().start()
        cls.addClassCleanup(api.stop)
        executable = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH")
        try:
            cls.browser = api.chromium.launch(executable_path=executable)
        except PlaywrightError as exc:
            if executable or "Executable doesn't exist" not in str(exc):
                raise
            cls.browser = api.chromium.launch(channel="chrome")
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.page = self.browser.new_page(offline=True, service_workers="block")
        self.addCleanup(self.page.close)
        self.errors = []
        self.remote = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("request", lambda r: self.remote.append(r.url)
                     if r.url.startswith(("http:", "https:")) else None)
        self.page.set_default_timeout(2500)

    def tearDown(self):
        self.assertEqual(self.errors, [])
        self.assertEqual(self.remote, [])

    def open(self, *entries):
        path = render_bundle({"version": 1, "title": "Synthetic reading test", "series": list(entries)},
                             self.root / (self._testMethodName + ".html"))
        self.page.goto(path.as_uri())

    def view(self, name):
        if self.page.locator("#open-navigation").is_visible():
            self.page.locator("#open-navigation").click()
        self.page.locator(f'#navigation [data-view="{name}"]').click()

    def dates(self, first, last):
        self.page.locator('[data-range="Custom"]').click()
        self.page.locator("#date-from").fill(first)
        self.page.locator("#date-to").fill(last)
        self.page.get_by_role("button", name="Apply settings").click()

    def panel(self, title):
        return self.page.locator("section.panel").filter(
            has=self.page.get_by_role("heading", name=title, exact=True))

    def test_undated_source_summary_precedes_any_trade_charts_and_keeps_its_units(self):
        self.open(series("Undated", tradeSummary={"count": 16, "win_rate": 0.375, "note": "source-defined"},
                         costs={"currency": "EUR", "commission_total": 12.5, "slippage_total": 0,
                                "participation": 0.015},
                         evidence={"tradeCoverage": "partial", "sourceHorizon": {"start": START, "end": START + 4 * DAY}}))
        self.view("trades")
        self.dates("2024-01-03", "2024-01-04")
        headings = self.page.locator("#view h2").all_inner_texts()
        self.assertEqual(headings[0], "Source trade summary")
        self.assertNotIn("Holding times", headings)
        self.assertNotIn("Trade P&L in closing order", headings)
        summary = self.panel("Source trade summary").inner_text()
        for value in ("16", "37.5%", "source-defined", "01 Jan 2024", "05 Jan 2024"):
            self.assertIn(value, summary)
        costs = self.panel("Execution costs").inner_text()
        for value in ("12.50 EUR", "0.00 EUR", "0.0150"):
            self.assertIn(value, costs)
        self.assertNotIn("0.0150 EUR", costs)
        self.assertIn("03 Jan 2024", self.page.locator("#view").inner_text())

    def test_truncated_ledger_distinguishes_selected_rows_source_count_and_unknown_sides(self):
        self.open(series("Short path", equity=[100, 104, 0, 112, 116],
                         trades=[{"time": START + i * DAY, "pnl": i} for i in (1, 2, 3, 4)],
                         tradeSummary={"closedTrades": 7}, costs={"currency": "USD", "total": 5},
                         accounting="Net equity", costModel="Synthetic fees",
                         evidence={"tradeCoverage": "partial", "sourceHorizon": {"start": START, "end": START + 4 * DAY}}))
        self.view("trades")
        text = self.page.locator("#view").inner_text()
        self.assertIn("2 of 7", text)
        self.assertIn("05 Jan 2024", self.panel("Source trade summary").inner_text())
        self.assertNotIn("Before reported costs", text)
        table = self.panel("Closed trades by side").locator("table")
        self.assertEqual(table.locator("thead th").all_inner_texts(), ["Measure", "All"])
        self.assertIn("3.00 USD", table.get_by_role("row").filter(has_text="Net P&L").inner_text())
        self.dates("2024-01-01", "2024-01-01")
        text = self.page.locator("#view").inner_text().lower()
        self.assertIn("partial", text)
        self.assertIn("unknown", text)
        self.assertNotIn("0.00 usd", text)
        self.view("evidence")
        basis = self.panel("Source and assumptions").inner_text()
        self.assertIn("03 Jan 2024", basis)
        self.assertIn("05 Jan 2024", basis)

    def test_source_count_mismatch_limits_streaks_even_without_a_coverage_flag(self):
        self.open(series("Incomplete", trades=[{"time": START + DAY, "pnl": 8, "side": "long"}],
                         tradeSummary={"count": 3}))
        self.view("trades")
        self.assertIn("1 of 3", self.page.locator("#view").inner_text())
        streak = self.panel("Trade quality").locator("dt").filter(has_text="streak").locator("+ dd")
        self.assertNotIn("1", streak.inner_text())
        self.dates("2024-01-04", "2024-01-05")
        self.assertNotIn("0.00 USD", self.page.locator("#view").inner_text())

    def test_complete_zero_close_range_retains_a_real_zero(self):
        self.open(series("Complete", trades=[{"time": START + DAY, "pnl": 0, "side": "short"}],
                         evidence={"tradeCoverage": "complete"}))
        self.view("trades")
        self.dates("2024-01-04", "2024-01-05")
        row = self.panel("Closed trades by side").get_by_role("row").filter(has_text="Net P&L")
        self.assertIn("0.00 USD", row.inner_text())

    def test_conflicting_source_count_is_reported_without_treating_it_as_a_subset(self):
        self.open(series("Count conflict", trades=[{"time": START + i * DAY, "pnl": i} for i in (1, 2, 3)],
                         tradeSummary={"closedTrades": 2}))
        self.view("trades")
        text = self.page.locator("#view").inner_text()
        self.assertNotIn("3 of 2", text)
        self.assertIn("3 dated closes", text)
        self.assertIn("2 source closes", text)
        streak = self.panel("Trade quality").locator("dt", has_text="streak").locator("+ dd")
        self.assertEqual(streak.inner_text(), "—")

    def test_paper_attribution_explains_selected_equity_and_unavailable_risk(self):
        evidence = {
            "holdingsBasis": "Synthetic risk budgets",
            "attribution": {"basis": "paper_additive"},
            "paperContributions": {
                "unit": "fraction of opening paper index", "dates": ["2024-01-01", "2024-01-02"],
                "byMember": {"alpha": [0.12, -0.04], "beta": [-0.02, -0.01]},
            },
        }
        self.open(series("paper", "portfolio", times=[START, START + DAY - 1, START + 2 * DAY - 1],
                         equity=[100000, 110000, 105000], evidence=evidence,
                         holdings=[{"id": "alpha", "weight": 0.99}, {"id": "beta", "weight": 0.01}]),
                  series("alpha", name="Alpha"), series("beta", name="Beta"))
        self.view("compare")
        panel = self.panel("Portfolio attribution")
        self.assertIn("paper P&L", panel.inner_text())
        self.assertIn("opening equity", panel.inner_text())
        row = panel.get_by_role("row").filter(has_text="Alpha")
        self.assertEqual(row.get_by_role("cell").nth(1).inner_text(), "+8.00%")
        self.assertIn("variance", panel.inner_text())
        self.assertIn("2", panel.locator(".panel-sub").inner_text())
        self.assertIn("risk budgets", self.panel("Construction weights").inner_text())
        self.dates("2024-01-02", "2024-01-02")
        self.assertEqual(row.get_by_role("cell").nth(1).inner_text(), "-3.64%")
        self.assertEqual(row.get_by_role("cell").nth(2).inner_text(), "—")
        for value in ("01 Jan 2024", "02 Jan 2024", "-4.55%"):
            self.assertIn(value, panel.locator(".panel-sub").inner_text())
        self.assertIn("Risk shares unavailable", panel.inner_text())
        self.assertIn("-0.91%", panel.get_by_role("row").filter(has_text="Beta").inner_text())

    def test_peer_selection_distinguishes_assignment_choice_and_dates_on_mobile(self):
        ref = "Synthetic reference " + "long label " * 10
        self.page.set_viewport_size({"width": 320, "height": 740})
        self.open(series("Book", "portfolio", benchmarkId="ref"), series("Independent"),
                  series("ref", "benchmark", name=ref, notes=["Unfunded price proxy."],
                         times=[START + DAY, START + 2 * DAY, START + 3 * DAY], equity=[100, 103, 98]))
        self.view("compare")
        self.assertEqual(self.page.locator("#peer-select").input_value(), "ref")
        self.assertLessEqual(self.page.evaluate("document.documentElement.scrollWidth"), 320)
        text = self.page.locator("#view").inner_text()
        self.assertIn("Source benchmark", text)
        self.assertIn("Unfunded price proxy.", text)
        self.assertIn("02 Jan 2024", self.panel("Relative performance").inner_text())
        self.page.locator('[data-kind="strategy"]').click()
        self.assertEqual(self.page.locator("#peer-select").input_value(), "")
        self.assertIn("No source benchmark", self.page.locator("#view").inner_text())
        self.page.locator("#peer-select").select_option("ref")
        self.assertTrue(self.page.locator("#peer-chart svg").is_visible())
        self.assertIn("No source benchmark", self.page.locator("#view").inner_text())
        self.assertIn("Unfunded price proxy.", self.page.locator("#view").inner_text())

    def test_comparison_discloses_display_units_return_currency_and_date_labels(self):
        self.open(series("Cash account", benchmarkId="ref", evidence={"markTimeBasis": "date_label"}),
                  series("ref", "benchmark", currency="INDEX", evidence={"returnCurrency": "USD"}))
        self.view("compare")
        chart = self.panel("Indexed comparison").inner_text()
        self.assertIn("Display units", chart)
        self.assertIn("INDEX", chart)
        self.assertIn("return currency", chart)
        self.assertIn("date labels", chart)
        self.assertNotIn("source currency (USD and INDEX)", chart)

    def test_evidence_opens_actual_result_records_and_distinguishes_requested_dates_from_opening_mark(self):
        test = {"label": "Synthetic shuffle", "status": "computed", "metrics": {"test_stat": 0.61234},
                "seed": 0, "settings": {"samples": 27}, "source_data": "Simulated closes"}
        for results in ([{**test, "family": "shuffle"}], {"shuffle": {"results": [test]}}):
            with self.subTest(container=type(results).__name__):
                self.open(series("Account", evidence={"results": results}))
                self.view("evidence")
                self.dates("2024-01-03", "2024-01-04")
                source = self.panel("Source and assumptions").inner_text()
                self.assertIn("Source benchmark", source)
                self.assertIn("None assigned", source)
                basis = self.panel("Measurement basis").inner_text()
                for val in ("03 Jan 2024", "04 Jan 2024", "02 Jan 2024"):
                    self.assertIn(val, basis)
                tests = self.panel("Research tests")
                self.assertNotIn("See source evidence", tests.inner_text())
                self.assertIn("Synthetic shuffle", tests.inner_text())
                record = tests.locator("details").filter(has=self.page.locator("summary", has_text="Synthetic shuffle"))
                record.locator("summary").press("Enter")
                for val in ("0.61234", "27", "Simulated closes"):
                    self.assertIn(val, record.inner_text())
                self.assertTrue(self.page.locator("details:not([open]) > summary", has_text="Calculation conventions").is_visible())

    def test_book_scorecard_identifies_the_report_universe_and_selected_close_dates(self):
        self.open(series("Member book", "portfolio", holdings=[{"id": "Member", "weight": 1}]),
                  series("Member"), series("Outside"))
        self.view("compare")
        self.dates("2024-01-03", "2024-01-04")
        scorecard = self.panel("Strategy scorecard")
        caption = scorecard.locator(".panel-sub").inner_text()
        for text in ("All report strategies", "03 Jan 2024", "04 Jan 2024"):
            self.assertIn(text, caption)
        self.assertIn("02 Jan 2024", scorecard.get_by_role("row").filter(has_text="Outside").inner_text())
        scorecard.get_by_role("button", name="Outside", exact=True).click()
        self.assertEqual(self.page.locator("h1").inner_text(), "Strategy overview")

    def test_large_episode_table_pages_without_dropping_or_reordering_episodes(self):
        sizes = [0.01 + i / 2000 for i in range(27)]
        marks = [100]
        for i, size in enumerate(sizes):
            marks.extend([marks[-1] * (1 - size), 101 + i])
        self.open(series("Drawdowns", times=[START + i * DAY for i in range(len(marks))], equity=marks))
        self.view("drawdowns")
        panel = self.panel("Drawdown episodes")
        rows = panel.locator("tbody tr")
        self.assertLess(rows.count(), len(sizes))
        visited = []
        forward = panel.get_by_role("button", name="Next episodes")
        while True:
            visited.extend(rows.all_inner_texts())
            if forward.is_disabled():
                break
            forward.click()
            self.assertLessEqual(len(visited), len(sizes))
        self.assertEqual(len(visited), len(set(visited)))
        self.assertEqual(len(visited), len(sizes))
        self.assertIn("-2.3%", visited[0])
        self.assertIn("-1.0%", visited[-1])
        panel.get_by_role("button", name="Previous episodes").click()
        self.assertFalse(forward.is_disabled())

    def test_explorer_shows_every_series_and_diagnostic_in_both_scopes(self):
        times = [START + i * DAY for i in range(760)]
        equity = [100 + i * 0.03 + i % 7 for i in range(len(times))]
        history = {"times": times, "equity": equity}
        extra = {"name": "Spread & carry", "unit": "bp", "description": "Measured at the source.",
                 "times": times[:5], "values": [-2, None, 0, 5, None]}
        book = series("Synthetic book", "portfolio", **history, diagnostics=[extra])
        account = series("Synthetic sleeve", **history, diagnostics=[
            extra, {"name": "Flat rate", "unit": "%", "times": times[:2], "values": [0.25, 0.25]}])
        self.open(book, account)
        self.view("explorer")
        for scope, expected_cards in (("portfolio", 10), ("strategy", 11)):
            self.page.locator(f'[data-kind="{scope}"]').click()
            grid = self.page.locator("#explorer-grid")
            self.assertEqual(grid.locator("section.panel").count(), expected_cards)
            self.assertEqual(self.page.locator("#explorer-metric").count(), 0)
            self.assertEqual(self.page.locator("#view select").count(), 1)
            for ident in ("source-0", "returns", "underwater", "maximum-drawdown", "rolling-sharpe",
                          "rolling-sortino", "rolling-calmar", "rolling-volatility", "rolling-maxDrawdown", "rolling-return"):
                self.assertEqual(grid.locator(f"#explorer-chart-{ident} svg").count(), 1, ident)
                self.assertEqual(grid.locator(f"#explorer-distribution-{ident} svg").count(), 1, ident)
            card = self.panel("Spread & carry")
            self.assertIn("04 Jan 2024", card.inner_text())
            self.assertIn("5.00 bp", card.inner_text())
            self.assertEqual(card.locator("dt", has_text="Missing").locator("+ dd").inner_text(), "2")
            bars = card.locator("rect[tabindex]")
            self.assertEqual(bars.count(), 18)
            counts = [int(bar.get_attribute("aria-label").split(" · ")[-1].split()[0]) for bar in bars.all()]
            self.assertEqual(sum(counts), 3)
            self.page.locator("#rolling-window").select_option("12")
            self.assertIn("12-month", self.panel("Rolling Sharpe").inner_text())
            self.assertIn("5.00 bp", card.inner_text())
        self.assertIn("25.00%", self.panel("Flat rate").inner_text())
        self.assertEqual(self.page.locator("#explorer-distribution-source-1 rect[tabindex]").count(), 1)
        self.page.set_viewport_size({"width": 320, "height": 740})
        self.page.wait_for_function(
            "document.querySelector('#explorer-grid section:nth-child(2)').offsetTop > "
            "document.querySelector('#explorer-grid section').offsetTop")
        self.assertLessEqual(self.page.evaluate("document.documentElement.scrollWidth"), 320)
        self.assertGreater(self.page.locator("#explorer-chart-source-0 svg").bounding_box()["width"], 240)

    def test_explorer_keeps_empty_metrics_and_a_diagnostic_between_equity_marks(self):
        self.open(series("Sparse marks", times=[START, START + 4 * DAY], equity=[100, 110], diagnostics=[
            {"name": "Timed reading", "unit": "%", "times": [START + i * DAY for i in (1, 2, 3)],
             "values": [0, None, 0.12]}]))
        self.view("explorer")
        self.dates("2024-01-02", "2024-01-03")
        self.assertEqual(self.page.locator("#explorer-grid section.panel").count(), 10)
        obs = self.panel("Timed reading")
        self.assertIn("0.00%", obs.inner_text())
        for key in ("Recorded", "Missing"):
            self.assertEqual(obs.locator("dt", has_text=key).locator("+ dd").inner_text(), "1")
        self.assertIn("02 Jan 2024", obs.inner_text())
        rolling = self.panel("Rolling Sharpe")
        self.assertEqual(rolling.locator("svg[role=img]").count(), 0)
        self.assertIn("—", rolling.inner_text())
        self.dates("2024-01-05", "2024-01-05")
        self.assertEqual(obs.locator("svg[role=img]").count(), 0)
        self.assertEqual(obs.locator("dt", has_text="Recorded").locator("+ dd").inner_text(), "0")

    def test_source_unit_remains_visible_without_clipping_chart_ticks_on_mobile(self):
        self.page.set_viewport_size({"width": 320, "height": 740})
        self.open(series("Sleeve", diagnostics=[{
            "name": "Fill volume", "unit": "contracts per session",
            "times": [START, START + DAY, START + 2 * DAY], "values": [100, 500, 200],
        }]))
        self.view("explorer")
        card = self.panel("Fill volume")
        self.assertEqual(card.locator("figure").count(), 2)
        for figure in card.locator("figure").all():
            self.assertIn("contracts per session", figure.locator("figcaption").inner_text())
            self.assertTrue(figure.locator("svg text").evaluate_all(
                "ticks => ticks.length > 0 && ticks.every(t => t.getBoundingClientRect().left >= 0 "
                "&& t.getBoundingClientRect().right <= 320)"))
        timeline = self.page.locator("#explorer-chart-source-0")
        timeline.focus()
        self.page.keyboard.press("End")
        self.assertIn("200.00 contracts per session", timeline.locator(".chart-tip").inner_text())
