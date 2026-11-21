"""Browser checks for the two activity plots on a shared time axis."""
from datetime import datetime
import os
from pathlib import Path
import re
import unittest

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None


def utc(label):
    return int(datetime.fromisoformat(label.replace("Z", "+00:00")).timestamp() * 1000)


@unittest.skipUnless(sync_playwright, "Playwright is required for chart geometry")
class ActivityChartTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        api = sync_playwright().start()
        cls.addClassCleanup(api.stop)
        cls.browser = api.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"))
        cls.addClassCleanup(cls.browser.close)
        cls.script = (Path(__file__).resolve().parents[1] / "lab/performance/charts.js").read_text()

    def setUp(self):
        self.page = self.browser.new_page(offline=True, viewport={"width": 1080, "height": 600})
        self.addCleanup(self.page.close)
        self.page.set_default_timeout(1700)
        self.page.set_content("""<style>
          #chart {width: 900px; margin: 70px 35px; position:relative; transform:scaleX(.86); transform-origin:left;}
          svg {display:block; width:100%} .chart-tip{position:absolute;pointer-events:none}
          </style><div id="chart"></div>""")
        self.page.add_script_tag(content=self.script)
        points = [("2024-01-07T23:00:00Z", 40), ("2024-01-08T04:00:00Z", 120),
                  ("2024-01-08T12:00:00Z", 240), ("2024-01-08T21:00:00Z", 100)]
        rows = [
            {"date": "2024-01-08", "active": 3, "overnight": 2, "closeTime": utc("2024-01-08T21:00:00Z"),
             "marginUsd": 80, "marginBasis": "broker_requirement",
             "intradayMargin": [{"time": utc(t), "marginUsd": v, "marginBasis": "broker_requirement"} for t, v in points]},
            {"date": "2024-01-09", "active": None, "overnight": None, "marginUsd": None, "marginBasis": "unknown"},
            {"date": "2024-01-11", "active": 1, "overnight": 1, "marginUsd": 90, "marginBasis": "schedule_scenario",
             "intradayMargin": [{"time": utc("2024-01-11T08:00:00Z"), "marginUsd": 360, "marginBasis": "schedule_scenario"}]},
            {"date": "2024-01-12", "active": 0, "overnight": 0, "marginUsd": 0, "marginBasis": "broker_requirement"},
        ]
        rows[0]["intradayMargin"][2]["contributors"] = [
            {"strategyId": "s2", "symbol": "FUT-H", "quantity": -1, "marginUsd": 63}]
        self.full = [points[0][0], "2024-01-12T23:59:59.999Z"]
        self.page.evaluate("""initialRows => {
          window.mountChart = (rows) => {
          window.picks=[]; window.windows=[];
          window.cursor = PerformanceCharts.activity(document.querySelector('#chart'), rows, {
            range:{from:'2024-01-08',to:'2024-01-12'}, color:b=>'navy', dash:b=>b==='schedule_scenario'?'2 4':'',
            intradayColor:b=>b==='schedule_scenario'?'orange':'green', intradayDash:b=>b==='schedule_scenario'?'3 5':'',
            describe:r=>['Held overnight '+r.overnight], select:(row,point)=>picks.push({day:row.date,point}),
            onZoom:r=>windows.push(r)
          });
          };
          mountChart(initialRows);
        }""", rows)

    def paths(self, track, basis=None):
        selector = f'path[data-track="{track}"]' + (f'[data-basis="{basis}"]' if basis else '')
        return self.page.locator(selector).evaluate_all("(els)=>els.map(e=>e.getAttribute('d'))")

    def coords(self, track, basis):
        paths = self.paths(track, basis)
        self.assertTrue(paths, f"No {track} path for {basis}")
        return [(float(x), float(y)) for x, y in re.findall(r"[ML]([\d.-]+)[ ,]([\d.-]+)", " ".join(paths))]

    def screen(self, x, y):
        pos = self.page.locator("svg").evaluate("(el, p) => {const v=new DOMPoint(...p).matrixTransform(el.getScreenCTM());return [v.x,v.y]}", [x, y])
        return tuple(pos)

    def limits(self):
        return self.page.locator("svg line[x2]").first.evaluate("el=>[+el.getAttribute('x1'),+el.getAttribute('x2')]")

    def test_timestamps_overnight_labels_one_usd_scale_and_gaps(self):
        intraday = self.coords("intraday", "broker_requirement")
        overnight = self.coords("margin", "broker_requirement")
        self.assertEqual(len(intraday), 4)
        self.assertAlmostEqual((intraday[1][0] - intraday[0][0]) / (intraday[2][0] - intraday[0][0]), 5 / 13, places=3)
        self.assertAlmostEqual(intraday[-1][0], overnight[0][0], places=2)
        # The 80 USD close is half way between the 40 and 120 USD intraday observations.
        self.assertAlmostEqual(overnight[0][1], (intraday[0][1] + intraday[1][1]) / 2, delta=.02)
        self.assertEqual(" ".join(self.paths("margin", "broker_requirement")).count("M"), 2)
        scenario = self.page.locator('path[data-track=intraday][data-basis=schedule_scenario]')
        self.assertEqual(scenario.get_attribute("stroke"), "orange")
        self.assertEqual(scenario.get_attribute("stroke-dasharray"), "3 5")
        # Same time, different intraday and close amounts. Pick the actual plotted amount.
        for point, kind, amount in [(intraday[-1], "intraday", 100), (overnight[0], "overnight", 80),
                                    (intraday[0], "intraday", 40), (overnight[-1], "overnight", 0)]:
            self.page.mouse.click(*self.screen(*point))
            selected = self.page.evaluate("picks.at(-1)")
            self.assertEqual((selected["point"]["kind"], selected["point"]["marginUsd"]), (kind, amount))
            if amount == 40:
                self.assertEqual(selected["day"], "2024-01-08")
            if amount == 0:
                self.assertIsNone(selected["point"]["time"])
                self.assertNotIn("00:00", self.page.locator(".chart-tip").inner_text())

    def test_wheel_preserves_cursor_time_and_rescales_both_tracks(self):
        left, right = self.limits()
        px, py = self.screen(left + .22 * (right - left), 85)
        before = [self.paths(k) for k in ("active", "intraday")]
        self.page.mouse.move(px, py)
        self.page.mouse.wheel(0, -180)
        self.page.wait_for_function("windows.length > 0")
        zoom = self.page.evaluate("windows.at(-1)")
        first, last = map(utc, self.full)
        anchor = first + .22 * (last - first)
        self.assertLess(zoom["to"] - zoom["from"], last - first)
        self.assertAlmostEqual((anchor - zoom["from"]) / (zoom["to"] - zoom["from"]), .22, delta=.003)
        self.assertNotEqual(before[0], self.paths("active"))
        self.assertNotEqual(before[1], self.paths("intraday"))
        self.page.locator("#chart").focus()
        self.page.keyboard.press("0")
        self.assertEqual(self.page.evaluate("windows.at(-1)"), {"from": first, "to": last})
        self.assertEqual(before, [self.paths(k) for k in ("active", "intraday")])

    def test_separate_overnight_scenario_draws_once_and_can_be_the_selected_peak(self):
        self.page.evaluate("mountChart", [
            {"date": "2024-01-08", "active": 2, "marginUsd": 20, "marginBasis": "broker_requirement",
             "overnightScenarioUsd": 45},
            {"date": "2024-01-09", "marginUsd": None, "marginBasis": "unknown", "overnightScenarioUsd": 120},
            {"date": "2024-01-10", "marginUsd": 90, "marginBasis": "schedule_scenario", "overnightScenarioUsd": 90},
            {"date": "2024-01-11", "marginUsd": None, "marginBasis": "unknown", "overnightScenarioUsd": 0},
        ])
        historic = self.coords("margin", "broker_requirement")
        scenario = self.coords("margin", "schedule_scenario")
        self.assertEqual((len(historic), len(scenario)), (1, 4))
        self.assertEqual(historic[0][0], scenario[0][0])
        self.assertEqual(self.page.locator('path[data-track=margin][data-basis=schedule_scenario]').get_attribute("stroke-dasharray"), "2 4")
        self.page.mouse.click(*self.screen(*scenario[0]))
        pick = self.page.evaluate("picks.at(-1).point")
        self.assertEqual((pick["kind"], pick["marginBasis"], pick["marginUsd"]), ("overnight", "schedule_scenario", 45))
        self.assertIsNone(pick["time"])
        self.page.mouse.click(*self.screen(*scenario[-1]))
        self.assertEqual(self.page.evaluate("picks.at(-1).point.marginUsd"), 0)
        self.page.mouse.move(*self.screen(scenario[0][0] - 2, 240))
        self.page.mouse.down()
        self.page.mouse.move(*self.screen(scenario[-1][0] + 2, 240), steps=5)
        self.page.mouse.up()
        pick = self.page.evaluate("picks.at(-1)")
        self.assertEqual((pick["day"], pick["point"]["marginUsd"]), ("2024-01-09", 120))
        self.assertEqual(pick["point"]["marginBasis"], "schedule_scenario")

    def test_unknown_counts_and_intraday_gaps(self):
        errors = []
        self.page.on("pageerror", lambda error: errors.append(str(error)))
        self.page.evaluate("mountChart", [
            {"date": "2024-01-08", "closeTime": utc("2024-01-08T21:00:00Z"), "intradayMargin": [
                {"time": utc("2024-01-08T14:00:00Z"), "marginUsd": 10, "marginBasis": "broker_requirement"},
                {"time": utc("2024-01-08T15:00:00Z"), "marginUsd": None, "marginBasis": "unknown"},
                {"time": utc("2024-01-08T21:00:00Z"), "marginUsd": 0, "marginBasis": "broker_requirement"},
            ]},
        ])
        recorded = self.coords("intraday", "broker_requirement")
        self.assertEqual(" ".join(self.paths("intraday", "broker_requirement")).count("M"), 2)
        self.page.mouse.move(*self.screen(recorded[-1][0], 100))
        self.page.mouse.click(*self.screen(recorded[-1][0], 100))
        self.assertEqual(self.page.evaluate("picks"), [])
        self.assertEqual(errors, [])

    def test_drag_selects_actual_peak_and_session_zoom_includes_previous_evening(self):
        points = self.coords("intraday", "broker_requirement")
        self.page.mouse.move(*self.screen(points[0][0], 220))
        self.page.mouse.down()
        self.page.mouse.move(*self.screen(points[-1][0] + 2, 220), steps=8)
        self.page.mouse.up()
        self.assertEqual(self.page.evaluate("picks.at(-1).point.marginUsd"), 240)
        self.assertEqual(self.page.evaluate("picks.at(-1).point.time"), utc("2024-01-08T12:00:00Z"))
        self.assertEqual(self.page.evaluate("picks.at(-1).point.contributors"),
                         [{"strategyId": "s2", "symbol": "FUT-H", "quantity": -1, "marginUsd": 63}])
        self.assertEqual(self.paths("intraday", "schedule_scenario"), [])
        self.page.evaluate("cursor.resetZoom();cursor.zoomToSession('2024-01-08')")
        zoom = self.page.evaluate("windows.at(-1)")
        self.assertLessEqual(zoom["from"], utc("2024-01-07T23:00:00Z"))
        self.assertGreaterEqual(zoom["to"], utc("2024-01-08T21:00:00Z"))
        self.assertEqual(len(self.coords("intraday", "broker_requirement")), 4)
        self.page.evaluate("cursor.resetZoom();cursor.showAt(3)")
        self.assertIn("Held overnight 0", self.page.locator(".chart-tip").inner_text())

    def test_drag_peak_uses_full_data_when_multiple_times_project_to_one_pixel(self):
        start = utc("2024-01-08T14:00:00Z")
        trail = [{"time": start + i * 100, "marginUsd": 321 if i == 37 else i % 8,
                  "marginBasis": "broker_requirement"} for i in range(100)]
        self.page.evaluate("mountChart", [{"date": "2024-01-08", "intradayMargin": trail}])
        display = self.coords("intraday", "broker_requirement")
        self.assertLess(len(display), len(trail))
        self.assertLess(display[-1][0] - display[0][0], 1)
        x = display[0][0]
        self.page.mouse.move(*self.screen(x - 6, 230))
        self.page.mouse.down()
        self.page.mouse.move(*self.screen(x + 6, 230), steps=4)
        self.page.mouse.up()
        point = self.page.evaluate("picks.at(-1).point")
        self.assertEqual((point["time"], point["marginUsd"]), (start + 3700, 321))

    def test_keyboard_range_selects_peak_and_reset_restores_full_view(self):
        self.page.locator("#chart").focus()
        for key in ("Home", "Shift+ArrowRight", "Shift+ArrowRight", "Enter"):
            self.page.keyboard.press(key)
        self.assertEqual(self.page.evaluate("picks.at(-1).point.marginUsd"), 240)
        self.page.keyboard.press("0")
        self.page.keyboard.press("End")
        self.page.keyboard.press("Enter")
        self.assertEqual(self.page.evaluate("picks.at(-1).point.marginUsd"), 0)
        self.page.keyboard.press("+")
        self.assertLess(self.page.evaluate("windows.at(-1).to - windows.at(-1).from"), utc(self.full[1]) - utc(self.full[0]))
        self.page.keyboard.press("-")
        self.assertEqual(self.page.evaluate("windows.at(-1)"),
                         {"from": utc(self.full[0]), "to": utc(self.full[1])})
        self.page.evaluate("cursor.hide()")
        self.assertTrue(self.page.locator(".chart-tip").is_hidden())
