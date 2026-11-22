"""Exercise the shared series picker with real touch input and desktop controls."""
import os
from pathlib import Path
import tempfile
import unittest

from lab.performance import render_bundle

try:
    from playwright.sync_api import expect, sync_playwright
except ImportError:
    sync_playwright = None


@unittest.skipUnless(sync_playwright, "Install Playwright to exercise the report in a browser")
class SeriesPickerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        folder = tempfile.TemporaryDirectory()
        cls.addClassCleanup(folder.cleanup)
        series = [
            {"id": f"{kind}-{i}", "name": f"{kind.title()} {i} · Long name for a small screen",
             "kind": kind, "currency": "USD", "frequency": "daily", "periodsPerYear": 252,
             "times": [0, 86400000, 172800000], "equity": [100, 101, 102 + i]}
            for kind, n in (("portfolio", 2), ("strategy", 32)) for i in range(n)
        ]
        report = Path(folder.name) / "report.html"
        render_bundle({"version": 1, "title": "Picker test", "series": series}, report)
        cls.url = report.as_uri() + "#calendar"
        playwright = sync_playwright().start()
        cls.playwright = playwright
        cls.addClassCleanup(playwright.stop)
        cls.browser = playwright.chromium.launch(
            executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"))
        cls.addClassCleanup(cls.browser.close)

    def page(self, width, height, touch=False):
        context = self.browser.new_context(viewport={"width": width, "height": height},
                                           is_mobile=touch, has_touch=touch)
        self.addCleanup(context.close)
        page = context.new_page()
        page.set_default_timeout(5000)
        page.goto(self.url)
        page.locator('[data-kind="strategy"]').click()
        return page

    def test_swipe_then_choose_preserves_calendar_and_focus(self):
        page = self.page(390, 664, touch=True)
        trigger = page.locator("#series-picker-trigger")
        dialog = page.locator("#series-picker")
        choices = dialog.locator("#series-options")
        trigger.tap()
        expect(dialog).to_be_visible()
        expect(page.locator("#series-select")).to_be_hidden()
        expect(choices.get_by_role("button")).to_have_count(32)
        expect(choices.locator('[aria-current="true"]')).to_have_attribute("data-value", "strategy-0")
        self.assertTrue(dialog.evaluate("""e => {
            const r = e.getBoundingClientRect();
            return r.left >= 0 && r.right <= visualViewport.width &&
                   r.top >= 0 && r.bottom <= visualViewport.height;
        }"""))
        box = choices.bounding_box()
        self.assertGreater(choices.evaluate("e => e.scrollHeight - e.clientHeight"), 0)
        background = page.evaluate("window.scrollY")
        session = page.context.new_cdp_session(page)
        x = box["x"] + box["width"] / 2
        for _ in range(12):
            before = choices.evaluate("e => e.scrollTop")
            if choices.evaluate("e => e.scrollHeight - e.clientHeight - e.scrollTop < 2"):
                break
            for step in range(9):
                y = box["y"] + box["height"] * (0.85 - 0.7 * step / 8)
                session.send("Input.dispatchTouchEvent", {
                    "type": "touchStart" if step == 0 else "touchMove",
                    "touchPoints": [{"x": x, "y": y}]})
            session.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
            page.wait_for_function("before => document.querySelector('#series-options').scrollTop > before", arg=before)
        self.assertTrue(choices.evaluate("e => e.scrollHeight - e.clientHeight - e.scrollTop < 2"))
        self.assertEqual(page.evaluate("window.scrollY"), background)
        choices.get_by_role("button").last.tap()
        expect(dialog).to_be_hidden()
        expect(trigger).to_be_focused()
        expect(trigger).to_contain_text("Strategy 31")
        expect(page.locator("#series-select")).to_have_value("strategy-31")
        expect(page.locator("h1")).to_have_text("Calendar returns")
        self.assertTrue(page.url.endswith("#calendar"))
        trigger.tap()
        expect(choices.locator('[aria-current="true"]')).to_be_in_viewport()
        page.locator("#series-picker-close").tap()
        expect(page.locator("#series-select")).to_have_value("strategy-31")
        page.locator('[data-kind="portfolio"]').tap()
        trigger.tap()
        expect(choices.get_by_role("button")).to_have_count(2)

    def test_webkit_landscape_reopens_at_the_selected_strategy(self):
        webkit = self.playwright.webkit
        if not Path(webkit.executable_path).is_file():
            self.skipTest("Install Playwright WebKit to check the phone layout")
        browser = webkit.launch()
        self.addCleanup(browser.close)
        page = browser.new_page(viewport={"width": 844, "height": 390}, has_touch=True, is_mobile=True)
        page.goto(self.url)
        page.locator('[data-kind="strategy"]').tap()
        trigger = page.locator("#series-picker-trigger")
        trigger.tap()
        choices = page.locator("#series-options")
        last = choices.get_by_role("button").last
        last.scroll_into_view_if_needed()
        self.assertGreater(choices.evaluate("e => e.scrollTop"), 0)
        last.tap()
        expect(trigger).to_contain_text("Strategy 31")
        trigger.tap()
        expect(choices.locator('[aria-current="true"]')).to_be_in_viewport()
        page.locator("#series-picker-close").tap()
        expect(trigger).to_be_focused()
        expect(page.locator("h1")).to_have_text("Calendar returns")

    def test_short_viewport_keyboard_cancel_and_desktop_fallback(self):
        page = self.page(360, 320)
        trigger = page.locator("#series-picker-trigger")
        choices = page.locator("#series-options")
        trigger.click()
        page.keyboard.press("End")
        expect(choices.get_by_role("button").last).to_be_focused()
        expect(choices.get_by_role("button").last).to_be_in_viewport()
        expect(page.locator("#series-picker-close")).to_be_in_viewport()
        page.keyboard.press("Escape")
        expect(trigger).to_be_focused()
        expect(page.locator("#series-select")).to_have_value("strategy-0")
        trigger.click()
        page.set_viewport_size({"width": 1280, "height": 900})
        expect(page.locator("#series-picker")).to_be_hidden()
        expect(trigger).to_be_hidden()
        select = page.locator("#series-select")
        expect(select).to_be_visible()
        select.select_option("strategy-31")
        expect(select).to_have_value("strategy-31")
        expect(page.locator("h1")).to_have_text("Calendar returns")


if __name__ == "__main__":
    unittest.main()
