"""Offline Chromium checks for the count axis in report histograms."""

import json
import math
import os
import re
import unittest

from lab.performance.build import ASSET_DIR, DATA_SLOT, SCRIPTS, STYLES

try:
    from playwright.sync_api import Error as PlaywrightError, sync_playwright
except ImportError:
    sync_playwright = None


@unittest.skipUnless(sync_playwright, "Playwright is required for the histogram browser check")
class HistogramAxisTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
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
        self.page = self.browser.new_page(offline=True, service_workers="block",
                                          viewport={"width": 1440, "height": 900})
        self.addCleanup(self.page.close)
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.set_default_timeout(4000)

    def tearDown(self):
        self.assertEqual(self.errors, [])

    def count_chart(self, counts):
        self.page.set_content('<div class="chart" id="chart" style="width: 640px"></div>')
        self.page.add_style_tag(path=str(ASSET_DIR / "style.css"))
        self.page.add_script_tag(path=str(ASSET_DIR / "charts.js"))
        host = self.page.locator("#chart")
        host.evaluate("""(host, counts) => window.PerformanceCharts.bars(host,
            counts.map((value, i) => ({label: "Bin " + i, value, detail: value + " observations"})),
            {countScale: "auto", title: "Observation counts"})""", counts)
        return host

    def bars(self, host):
        result = []
        for label, height in host.locator("rect[tabindex]").evaluate_all(
            """bars => bars.map(bar => [bar.getAttribute("aria-label"), Number(bar.getAttribute("height"))])"""
        ):
            match = re.search(r"([\d,]+) observations$", label)
            self.assertIsNotNone(match, label)
            self.assertTrue(math.isfinite(height))
            result.append((int(match[1].replace(",", "")), height))
        return result

    def test_balanced_counts_start_linear_and_zero_bins_have_no_height(self):
        host = self.count_chart([0, 2, 4, 5, 4])
        self.assertEqual(host.get_attribute("data-count-scale"), "linear")
        bars = self.bars(host)
        self.assertEqual([n for n, _ in bars], [0, 2, 4, 5, 4])
        self.assertEqual(bars[0][1], 0)
        self.assertAlmostEqual(bars[1][1] / bars[2][1], 0.5)
        control = host.get_by_role("button", name="Log count axis")
        control.press("Space")
        self.assertEqual(control.get_attribute("aria-pressed"), "true")
        logarithmic = self.bars(host)
        self.assertEqual(logarithmic[0][1], 0)
        self.assertAlmostEqual(logarithmic[1][1] / logarithmic[2][1], math.log1p(2) / math.log1p(4))
        control.press("Enter")
        self.assertEqual(self.bars(host), bars)

    def test_all_zero_counts_remain_readable_on_both_scales(self):
        host = self.count_chart([0, 0, 0])
        for scale in ("linear", "log"):
            with self.subTest(scale=scale):
                self.assertEqual(host.get_attribute("data-count-scale"), scale)
                self.assertEqual(self.bars(host), [(0, 0)] * 3)
                host.locator("rect[tabindex]").first.focus()
                self.assertEqual(host.locator(".chart-tip span").inner_text(), "0 observations")
                self.assertTrue(host.locator(".chart-tip").is_visible())
                self.assertIn("0", host.locator('svg text[text-anchor="end"]').all_text_contents())
                if scale == "linear":
                    host.get_by_role("button", name="Log count axis").click()

    def open_report(self, series):
        payload = json.dumps({"version": 1, "title": "Histogram smoke test", "series": [series]})
        template = (ASSET_DIR / "template.html").read_text()
        self.page.set_content(template.replace(DATA_SLOT, '<script type="application/json" id="report-data">'
                                               + payload + '</script>'))
        for name in STYLES:
            self.page.add_style_tag(path=str(ASSET_DIR / name))
        for name in ("theme.js", *SCRIPTS):
            self.page.add_script_tag(path=str(ASSET_DIR / name))

    def check_outcome_distribution(self, view, chart_id):
        pnl = [-100, *[0] * 100, 100]
        times = [1704067200000 + i * 86400000 for i in range(len(pnl) + 1)]
        equity = [100_000]
        for value in pnl:
            equity.append(equity[-1] + value)
        self.open_report({"id": "strategy", "name": "Sparse trade outcomes", "kind": "strategy",
                          "currency": "USD", "frequency": "daily", "periodsPerYear": 365,
                          "times": times, "equity": equity,
                          "trades": [{"time": t, "pnl": v} for t, v in zip(times[1:], pnl, strict=True)]})
        self.page.locator(f'#navigation [data-view="{view}"]').click()
        host = self.page.locator("#" + chart_id)
        host.locator("svg").wait_for()
        self.assertEqual(host.get_attribute("data-count-scale"), "log")
        bins = self.bars(host)
        counts = [n for n, _ in bins]
        self.assertIn(0, counts)
        self.assertEqual(sorted(n for n in counts if n), [1, 1, 100])
        control = host.get_by_role("button", name="Log count axis")
        for scale in ("log", "linear"):
            with self.subTest(scale=scale):
                self.assertEqual(host.get_attribute("data-count-scale"), scale)
                self.assertEqual(control.get_attribute("aria-pressed"), str(scale == "log").lower())
                shown = self.bars(host)
                self.assertEqual([n for n, _ in shown], counts)
                self.assertTrue(all(height == 0 for n, height in shown if n == 0))
                host.locator("rect[tabindex]").nth(counts.index(0)).focus()
                self.assertEqual(host.locator(".chart-tip span").inner_text(), "0 observations")
                control.press("Enter")
        self.assertEqual(self.bars(host), bins)

    def test_trade_outcomes_use_count_scale(self):
        self.check_outcome_distribution("trades", "trade-hist")

    def test_drawdown_return_distribution_uses_count_scale(self):
        self.check_outcome_distribution("drawdowns", "risk-distribution")

    def test_explorer_keeps_sparse_open_pnl_counts_when_scale_changes(self):
        values = [-10.0, *[0.0] * 1000, 20.0, 20.0, None, None, None]
        times = [1704067200000 + i * 86400000 for i in range(len(values))]
        series = {"id": "test-strategy", "name": "Synthetic strategy", "kind": "strategy",
                  "currency": "USD", "frequency": "daily", "periodsPerYear": 365,
                  "times": times, "equity": [100_000.0] * len(times),
                  "diagnostics": [{"name": "Open trade P&L", "unit": "USD", "times": times, "values": values}]}
        self.open_report(series)
        self.page.locator('#navigation [data-view="explorer"]').click()
        host = self.page.locator("#explorer-distribution-source-0")
        host.locator("svg").wait_for()
        self.assertEqual(host.get_attribute("data-count-scale"), "log")
        self.assertEqual(host.get_by_role("button").get_attribute("aria-pressed"), "true")
        bins = self.bars(host)
        counts = [n for n, _ in bins]
        self.assertEqual(sorted(counts), [0] * 15 + [1, 2, 1000])
        self.assertTrue(all(height == 0 for n, height in bins if n == 0))
        height = dict(bins)
        self.assertAlmostEqual(height[1] / height[1000], math.log1p(1) / math.log1p(1000))
        ticks = host.locator('svg text[text-anchor="end"]').all_text_contents()
        self.assertEqual([int(t.replace(",", "")) for t in ticks], [0, 1, 10, 100, 1000])
        host.locator("rect[tabindex]").nth(counts.index(1000)).focus()
        self.assertEqual(host.locator(".chart-tip span").inner_text(), "1,000 observations")
        host.get_by_role("button").press("Enter")
        self.assertEqual(host.get_attribute("data-count-scale"), "linear")
        self.assertEqual(host.get_by_role("button").get_attribute("aria-pressed"), "false")
        linear = self.bars(host)
        self.assertEqual([n for n, _ in linear], counts)
        self.assertTrue(all(h == 0 for n, h in linear if n == 0))
        self.assertLess(dict(linear)[1], height[1])
        host.get_by_role("button").press("Space")
        self.assertEqual(self.bars(host), bins)
