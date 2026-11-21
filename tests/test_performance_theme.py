"""Exercise the theme as a reader of a standalone, offline report."""
import os
import tempfile
import unittest
from pathlib import Path

from lab.performance import render_bundle
from lab.performance.demo import demo_bundle

try:
    from playwright.sync_api import expect, sync_playwright
except ImportError:
    sync_playwright = None


@unittest.skipUnless(sync_playwright, "Playwright is optional for browser verification")
class PerformanceThemeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        folder = tempfile.TemporaryDirectory()
        cls.addClassCleanup(folder.cleanup)
        report = render_bundle(demo_bundle(), Path(folder.name) / "atlas.html")
        cls.url = report.as_uri()
        api = sync_playwright().start()
        cls.addClassCleanup(api.stop)
        cls.browser = api.chromium.launch(executable_path=os.getenv("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"))
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.page = self.browser.new_page(viewport={"width": 320, "height": 740}, has_touch=True,
                                          color_scheme="light", offline=True)
        self.addCleanup(self.page.close)
        self.page.set_default_timeout(3000)
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.control = self.page.get_by_role("combobox", name="Report theme", exact=True)

    def tearDown(self):
        self.assertEqual(self.errors, [])

    def open_report(self):
        self.page.goto(self.url)
        self.assertEqual(self.control.count(), 1, "The report header needs a native theme menu")

    def canvas_color(self):
        return self.page.locator("body").evaluate("body => getComputedStyle(body).backgroundColor")

    def test_automatic_tracks_os_and_notifies_chart_listeners(self):
        self.open_report()
        expect(self.control).to_have_value("auto")
        page = self.page
        light = self.canvas_color()
        page.evaluate("""window.changes = [];
            window.addEventListener('atlas-themechange', event => changes.push({
                ...event.detail, canvas: getComputedStyle(document.body).backgroundColor
            }));""")
        for scheme in ("dark", "light"):
            page.emulate_media(color_scheme=scheme)
            page.wait_for_function("scheme => window.changes.at(-1)?.theme === scheme", arg=scheme)
            self.assertEqual(page.evaluate("changes.at(-1).mode"), "auto")
            self.assertEqual(page.evaluate("changes.at(-1).canvas"), self.canvas_color())
            self.assertEqual(self.canvas_color() == light, scheme == "light")
        expect(self.control).to_have_value("auto")

    def test_manual_modes_survive_system_changes_and_local_file_reload(self):
        self.open_report()
        light = self.canvas_color()
        for manual, opposite in (("dark", "light"), ("light", "dark")):
            with self.subTest(manual=manual):
                self.control.select_option(manual)
                color = self.canvas_color()
                self.assertEqual(color == light, manual == "light")
                self.page.emulate_media(color_scheme=manual)
                self.page.emulate_media(color_scheme=opposite)
                self.page.reload()
                expect(self.control).to_have_value(manual)
                self.assertEqual(self.canvas_color(), color)
        self.control.select_option("auto")
        self.page.reload()
        expect(self.control).to_have_value("auto")
        self.assertNotEqual(self.canvas_color(), light)

    def test_theme_works_when_file_storage_is_blocked(self):
        self.page.add_init_script("""Object.defineProperty(window, 'localStorage', {
            get() { throw new DOMException('Blocked for this origin', 'SecurityError'); }
        });""")
        self.open_report()
        light = self.canvas_color()
        self.control.select_option("dark")
        self.assertNotEqual(self.canvas_color(), light)
        self.page.reload()
        expect(self.control).to_have_value("auto")
        self.assertEqual(self.canvas_color(), light)

    def test_phone_header_has_separate_touch_targets_and_keyboard_access(self):
        self.open_report()
        page = self.page
        controls = page.locator(".topbar button:visible, .topbar select:visible")
        ids = controls.evaluate_all("nodes => nodes.map(el => el.id)")
        self.assertEqual(set(ids), {"open-navigation", "open-glossary", "open-settings", "export",
                                    self.control.get_attribute("id")})
        reached = []
        for _ in range(len(ids) + 2):  # Includes the skip link.
            page.keyboard.press("Tab")
            active = page.evaluate("document.activeElement.id")
            if active in ids:
                reached.append(active)
            if active == self.control.get_attribute("id"):
                page.keyboard.press("d")
                expect(self.control).to_have_value("dark")
        self.assertEqual(reached, ids)
        boxes = sorted((control.bounding_box() for control in controls.all()), key=lambda box: box["x"])
        end = 0
        for box in boxes:
            self.assertGreaterEqual(box["x"], end)
            self.assertGreaterEqual(min(box["width"], box["height"]), 40)
            end = box["x"] + box["width"]
        self.assertLessEqual(end, 320)
        self.assertLessEqual(page.locator("body").evaluate("el => el.scrollWidth"), 320)

    def assert_text_contrast(self, selector):
        # Canvas resolves both plain RGB and the CSS color-mix values used by the tables.
        contrasts = self.page.locator(selector).evaluate_all("""elements => {
            const ctx = document.createElement('canvas').getContext('2d', {willReadFrequently: true});
            function luminance(color) {
                ctx.fillStyle = color;
                ctx.fillRect(0, 0, 1, 1);
                const rgb = Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
                const [r, g, b] = rgb.map(byte => {
                    const c = byte / 255;
                    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
                });
                return 0.2126 * r + 0.7152 * g + 0.0722 * b;
            }
            return elements.map(el => {
                let bg = el;
                while (getComputedStyle(bg).backgroundColor === 'rgba(0, 0, 0, 0)') bg = bg.parentElement;
                const style = getComputedStyle(el);
                const fg = luminance(el instanceof SVGElement ? style.fill : style.color);
                const back = luminance(getComputedStyle(bg).backgroundColor);
                return [(Math.max(fg, back) + 0.05) / (Math.min(fg, back) + 0.05), el.textContent];
            });
        }""")
        self.assertTrue(contrasts, selector)
        ratio, label = min(contrasts)
        self.assertGreaterEqual(ratio, 4.5, f"{selector}: {label!r} has {ratio:.2f}:1 contrast")

    def test_chart_text_legends_and_table_colors_in_both_themes(self):
        self.page.set_viewport_size({"width": 1440, "height": 960})
        self.open_report()
        for mode in ("light", "dark"):
            with self.subTest(mode=mode):
                self.control.select_option(mode)
                self.page.locator('[data-view="overview"]').click()
                for selector in (".nav-link", ".kpi-value", ".legend-item", ".chart text", ".heat td",
                                 ".heat-scale span", ".rail-label"):
                    self.assert_text_contrast(selector)
                equity = self.page.locator("#equity-chart")
                stroke = equity.locator("path[stroke]").first.evaluate("el => getComputedStyle(el).stroke")
                legend = equity.locator("xpath=preceding-sibling::*[1]").locator(".legend-swatch").first
                self.assertEqual(legend.evaluate("el => getComputedStyle(el).backgroundColor"), stroke)
                self.page.locator('[data-view="compare"]').click()
                self.assert_text_contrast(".corr-value")


if __name__ == "__main__":
    unittest.main()
