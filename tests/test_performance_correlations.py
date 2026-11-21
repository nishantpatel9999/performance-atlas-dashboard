"""Exercise the strategy correlation controls in a local, offline report."""
import os
import tempfile
import unittest
from pathlib import Path

from lab.performance import render_bundle

try:
    from playwright.sync_api import Error as PlaywrightError, sync_playwright
except ImportError:
    sync_playwright = None


DAY = 86_400_000
START = 1_704_067_200_000


def strategy(ident, name, gains=(0.125, -0.25, 0.25, -0.125), **extra):
    nav = [128]
    for gain in gains:
        nav.append(nav[-1] * (1 + gain))
    return dict({"id": ident, "name": name, "kind": "strategy", "currency": "USD",
                 "frequency": "daily", "periodsPerYear": 365, "equity": nav,
                 "times": [START + i * DAY for i in range(len(nav))]}, **extra)


@unittest.skipUnless(sync_playwright, "Playwright is optional for browser tests")
class CorrelationBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(directory.cleanup)
        cls.directory = Path(directory.name)
        api = sync_playwright().start()
        cls.addClassCleanup(api.stop)
        executable = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH")
        try:
            cls.browser = api.chromium.launch(executable_path=executable)
        except PlaywrightError as err:
            if executable or "Executable doesn't exist" not in str(err):
                raise
            cls.browser = api.chromium.launch(channel="chrome")
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.context = self.browser.new_context(offline=True, has_touch=True, viewport={"width": 1280, "height": 900})
        self.addCleanup(self.context.close)
        self.page = self.context.new_page()
        self.page.set_default_timeout(2500)
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))

    def tearDown(self):
        self.assertEqual(self.errors, [])

    def open_report(self, entries):
        path = render_bundle({"version": 1, "title": "Correlation test", "series": entries},
                             self.directory / (self._testMethodName + ".html"))
        self.page.goto(path.as_uri())
        self.page.locator('[data-view="compare"]').click()
        return self.page.locator("#strategy-correlations")

    def test_selected_strategy_beyond_first_page_stays_in_matrix_and_keyboard_selection_retains_focus(self):
        strategies = [strategy(f"s{i}", f"Strategy {i:02d}") for i in range(52)]
        box = self.open_report(strategies)
        self.page.locator("#series-select").select_option("s51")
        focus = box.get_by_label("Focus strategy", exact=True)
        self.assertEqual(focus.input_value(), "s51")
        self.assertEqual(box.locator("thead [scope=col][data-focused]").inner_text(), "Strategy 51")
        self.assertEqual(box.locator("tbody [scope=row][data-focused]").inner_text(), "Strategy 51")
        self.assertEqual(box.get_by_role("table", name="Strategy return correlations").locator("tbody tr").count(), 6)
        box.locator("summary").focus()
        self.page.keyboard.press("Enter")
        add = box.get_by_role("checkbox", name="Strategy 44", exact=True)
        add.focus()
        self.page.keyboard.press("Space")
        self.assertTrue(add.is_checked())
        self.assertTrue(add.evaluate("e => e === document.activeElement"))
        focus.focus()
        self.page.keyboard.press("s")  # Native select type-ahead moves to the next strategy.
        self.assertNotEqual(focus.input_value(), "s51")
        self.assertEqual(box.locator("thead [data-focused]").count(), 1)
        self.assertIn("N", box.get_by_role("table", name="Strategy return correlations").inner_text())

    def test_several_books_offer_only_actual_memberships_and_leave_the_universe_explicit(self):
        a, b, c = strategy("a", "Alpha"), strategy("b", "Bravo"), strategy("c", "Charlie")
        p = dict(a, id="p", kind="portfolio", name="AB book", holdings=[
            {"id": "a", "weight": 0.5}, {"id": "b", "weight": 0.5}])
        q = dict(a, id="q", kind="portfolio", name="AC book", evidence={
            "attribution": {"basis": "funded_equity", "members": ["a", "c"]}})
        box = self.open_report([p, q, a, b, c])
        self.page.locator('[data-kind="strategy"]').click()
        group = box.get_by_label("Comparison group")
        self.assertEqual(group.input_value(), "")
        self.assertEqual(group.locator("option").count(), 3)
        group.select_option("q")
        names = box.get_by_role("table", name="Strategy return correlations").locator("tbody th").all_text_contents()
        self.assertEqual(names, ["Alpha", "Charlie"])

    def test_individual_checkboxes_allow_the_entire_group_and_keep_the_active_strategy(self):
        box = self.open_report([strategy(f"s{i}", f"Strategy {i:02d}") for i in range(15)])
        box.locator("summary").click()
        for i in range(6, 15):
            box.get_by_role("checkbox", name=f"Strategy {i:02d}", exact=True).check()
        active = box.get_by_role("checkbox", name="Strategy 00", exact=True)
        self.assertTrue(active.is_checked() and active.is_disabled())
        grid = box.get_by_role("table", name="Strategy return correlations")
        self.assertEqual(grid.locator("tbody tr").count(), 15)
        box.get_by_role("checkbox", name="Strategy 01", exact=True).uncheck()
        self.assertEqual(grid.locator("tbody tr").count(), 14)

    def test_show_all_and_focus_reuse_one_matrix_for_every_peer_in_the_selected_group(self):
        self.page.add_init_script("""window.matrixRuns = [];
            Object.defineProperty(window, 'PerformanceDetails', {configurable:true, set(api) {
                Object.defineProperty(window, 'PerformanceDetails', {value:{...api, correlationMatrix(all, opts) {
                    window.matrixRuns.push(opts.ids.length);
                    return api.correlationMatrix(all, opts);
                }}});
            }});""")
        strategies = [strategy(f"s{i}", f"Strategy {i:02d}") for i in range(58)]
        book = dict(strategies[0], id="p", kind="portfolio", name="Member book",
                    holdings=[{"id": s["id"], "weight": 1 / 54} for s in strategies[:54]])
        box = self.open_report([book, *strategies])
        grid = box.get_by_role("table", name="Strategy return correlations")
        focus = box.get_by_label("Focus strategy", exact=True)
        self.assertEqual(self.page.evaluate("window.matrixRuns"), [6])
        box.get_by_role("button", name="Show all strategies", exact=True).click()
        self.assertEqual(grid.locator("tbody tr").count(), 54)
        self.assertEqual(grid.locator("tbody td").count(), 54 ** 2)
        self.assertEqual(self.page.evaluate("window.matrixRuns"), [6, 54])
        self.page.evaluate("window.originalGrid = document.querySelector('.corr-grid')")
        focus.select_option("s53")
        self.assertTrue(grid.evaluate("e => e === window.originalGrid"))
        self.assertEqual(box.get_by_role("table", name="Comparisons for Strategy 53").locator("tbody tr").count(), 53)
        self.assertEqual(self.page.evaluate("window.matrixRuns"), [6, 54])
        region = box.get_by_role("region", name="Scrollable correlation matrix")
        self.assertTrue(region.evaluate("e => e.clientHeight < e.scrollHeight && e.clientWidth < e.scrollWidth"))
        self.assertTrue(region.evaluate("e => e.scrollTop > 0 && e.scrollLeft > 0"))
        self.page.locator("#peer-select").select_option("s2")
        self.assertEqual(self.page.evaluate("window.matrixRuns"), [6, 54])
        box.get_by_label("Comparison group", exact=True).select_option(label="All report strategies (58)")
        self.assertEqual(grid.locator("tbody tr").count(), 6)
        focus.select_option("s57")
        self.assertEqual(grid.locator("tbody tr").count(), 58)
        self.assertEqual(box.get_by_role("table", name="Comparisons for Strategy 57").locator("tbody tr").count(), 57)
        self.assertEqual(self.page.evaluate("window.matrixRuns"), [6, 54, 6, 58])
        box.get_by_role("button", name="Reset selection", exact=True).click()
        self.assertEqual(grid.locator("tbody tr").count(), 6)

    def test_resizing_redraws_charts_without_replacing_the_focused_matrix_control(self):
        box = self.open_report([strategy("a", "Alpha"), strategy("b", "Bravo")])
        control = box.get_by_label("Focus strategy")
        control.focus()
        self.page.evaluate("""() => {
            window.originalControl = document.activeElement;
            window.originalChart = document.querySelector('#peer-chart svg');
        }""")
        self.page.set_viewport_size({"width": 980, "height": 780})
        self.page.wait_for_function("window.originalChart && !window.originalChart.isConnected")
        self.assertTrue(control.evaluate("el => el === window.originalControl && el === document.activeElement"))

    def test_member_scope_and_explicit_universe_keep_distinct_populations(self):
        a, b, outside = strategy("a", "First"), strategy("b", "Second"), strategy("c", "Outside")
        book = dict(a, id="p", kind="portfolio", name="Fund", holdings=[
            {"id": "a", "weight": 1}, {"id": "b", "weight": -0.2}, {"id": "c", "weight": 0}])
        box = self.open_report([book, a, b, outside])
        group = box.get_by_label("Comparison group", exact=True)
        self.assertEqual(group.input_value(), "p")
        self.assertEqual(box.locator("th[scope=row]").all_text_contents()[:2], ["First", "Second"])
        self.assertNotIn("Outside", box.get_by_role("table", name="Strategy return correlations").inner_text())
        group.select_option(label="All report strategies (3)")
        self.assertIn("Outside", box.get_by_role("table", name="Strategy return correlations").inner_text())
        self.page.locator('[data-kind="strategy"]').click()
        self.assertEqual(group.input_value(), "p")
        self.page.locator("#series-select").select_option("c")
        self.assertEqual(box.get_by_label("Focus strategy").input_value(), "c")
        self.assertNotIn("Fund", box.locator("select#correlation-group option").all_text_contents())

    def test_date_cut_updates_signed_values_counts_and_visible_reasons_on_touch(self):
        a = strategy("a", "Alpha")
        b = strategy("b", "Inverse", (-0.125, 0.25, -0.25, 0.125))
        flat = strategy("flat", "Constant sleeve", (0, 0, 0, 0))
        euro = strategy("eu", "Euro", currency="EUR")
        box = self.open_report([a, b, flat, euro])
        self.page.set_viewport_size({"width": 390, "height": 844})
        focused = box.get_by_role("table", name="Comparisons for Alpha")
        inverse = focused.get_by_role("row").filter(has_text="Inverse")
        self.assertIn("−1.00", inverse.inner_text())
        self.assertEqual(inverse.get_by_role("cell").nth(1).inner_text(), "4")
        self.assertIn("constant", focused.get_by_role("row").filter(has_text="Constant sleeve").inner_text().lower())
        self.assertIn("currency", focused.get_by_role("row").filter(has_text="Euro").inner_text().lower())
        self.page.locator('[data-range="Custom"]').tap()
        self.page.locator("#date-from").fill("2024-01-04")
        self.page.locator("#date-to").fill("2024-01-04")
        self.page.get_by_role("button", name="Apply settings").tap()
        self.assertEqual(inverse.get_by_role("cell").nth(1).inner_text(), "1")
        self.assertIn("two shared", inverse.inner_text().lower())
        box.locator("summary").tap()
        box.get_by_role("checkbox", name="Euro").tap()
        self.assertFalse(box.get_by_role("checkbox", name="Euro").is_checked())
        self.assertLessEqual(self.page.locator("body").evaluate("e => e.scrollWidth"), 391)

    def test_single_strategy_and_undeclared_membership_have_explicit_empty_states(self):
        a = strategy("only", "Only strategy")
        box = self.open_report([a, dict(a, kind="benchmark", id="ref")])
        self.assertIn("one strategy", box.inner_text().lower())
        self.assertEqual(box.get_by_role("table").count(), 0)
        self.open_report([dict(a, id="p", kind="portfolio", name="Unnamed members"),
                          a, strategy("another", "Another")])
        self.assertIn("member", box.inner_text().lower())
        self.assertEqual(box.get_by_role("table").count(), 0)
        box.get_by_label("Comparison group").select_option(label="All report strategies (2)")
        self.assertEqual(box.get_by_role("table", name="Strategy return correlations").count(), 1)
