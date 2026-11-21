"""Exercise a margin spike through the rendered chart and both evidence tables."""
import os
import re
import tempfile
import unittest
from pathlib import Path

from lab.performance import render_bundle

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None


@unittest.skipUnless(sync_playwright, "Install Playwright for browser checks")
class MarginDrilldownTests(unittest.TestCase):
    def test_pin_intraday_spike_uses_its_positions_and_preserves_the_close(self):
        day = 86_400_000
        t = 1_704_067_200_000  # 2024-01-01 UTC
        position = {"strategyId": "trend", "symbol": "FUT-H4", "quantity": 2, "marginUsd": 800}
        sample = {"time": t + 12 * 3_600_000, "marginUsd": 800, "marginBasis": "broker_requirement",
                  "contributors": [position]}
        rows = [
            {"date": "2024-01-01", "active": 1, "overnight": 0, "closeTime": t + 16*3_600_000,
             "marginUsd": 0, "marginBasis": "broker_requirement", "overnightScenarioUsd": 100,
             "activePositions": [{"strategyId": "trend", "symbol": "FUT-H4", "heldDuring": True, "closeQty": 0}],
             "intradayMargin": [sample, {"time": t + 16*3_600_000, "marginUsd": 0, "marginBasis": "broker_requirement"}]},
            {"date": "2024-01-02", "active": 0, "overnight": 0, "marginUsd": 0, "marginBasis": "broker_requirement"}
        ]
        account = {"id":"book", "name":"Example book", "kind":"portfolio", "currency":"USD", "frequency":"daily",
                   "periodsPerYear":365, "times":[t, t+day*2], "equity":[2000,2100],
                   "activity":{"source":"Synthetic account ledger", "rows":rows}}
        strategy = {k: v for k, v in account.items() if k != "activity"}
        strategy.update(id="trend", name="Trend strategy", kind="strategy")
        with tempfile.TemporaryDirectory() as folder, sync_playwright() as api:
            html = render_bundle({"version": 1, "title": "Margin check", "series": [account, strategy]},
                                 Path(folder) / "report.html")
            browser = api.chromium.launch(executable_path=os.getenv("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"))
            page = browser.new_page(viewport={"width":1400,"height":900},offline=True)
            errors=[];page.on("pageerror",lambda e:errors.append(str(e)))
            page.goto(html.as_uri()+"#activity")
            svg=page.locator("#activity-chart svg")
            path=svg.locator('path[data-track="intraday"][data-basis="broker_requirement"]')
            sx,sy=map(float,re.search(r"M([0-9.]+),([0-9.]+)",path.get_attribute("d")).groups())
            x,y=svg.evaluate("""(svg,pair) => {
                const pt=new DOMPoint(...pair).matrixTransform(svg.getScreenCTM()); return [pt.x,pt.y]
            }""",[sx,sy])
            page.mouse.click(x,y)
            details=page.locator("#activity-reading")
            self.assertEqual(page.locator("#activity-day").input_value(),"2024-01-01")
            table=details.locator("table").filter(has=page.get_by_role("columnheader",name="Quantity at this time"))
            self.assertIn("Trend strategy",table.inner_text())
            self.assertIn("FUT-H4",table.inner_text())
            self.assertIn("$800.00",table.inner_text())
            self.assertEqual(details.locator("dl > div").filter(has_text="Broker overnight margin").locator("dd").inner_text(), "$0.00")
            page.locator("#activity-zoom-day").click()
            self.assertIn("UTC",page.locator("#activity-zoom-range").inner_text())
            page.locator("#activity-zoom-reset").click()
            self.assertFalse(errors)
            browser.close()
