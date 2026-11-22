"""Offline browser checks for the dictionary and its Atlas integration hooks."""
import os
import tempfile
import unittest
from pathlib import Path

from lab.performance import render_bundle
from lab.performance.demo import demo_bundle

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "lab/performance"
REPORT = {
    "glossary": {"Desk [A+]": "<em>Cash & fees</em> from the source."},
    "series": [
        {"id": "one", "name": "CAGR Income", "diagnostics": [
            {"name": "Settlement band", "description": "First account's settlement rule."}]},
        {"id": "two", "name": "Relative Value", "diagnostics": [
            {"name": "Settlement band", "description": "Second account's settlement rule."}]},
    ],
}


@unittest.skipUnless(sync_playwright, "browser verification requires local Playwright and Chromium")
class GlossaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        api = sync_playwright().start()
        cls.addClassCleanup(api.stop)
        cls.browser = api.chromium.launch(executable_path=os.getenv("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"))
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.context = self.browser.new_context(offline=True, has_touch=True, viewport={"width": 800, "height": 700})
        self.addCleanup(self.context.close)
        self.page = self.context.new_page()
        self.page.set_default_timeout(3000)
        self.errors = []
        self.page.on("pageerror", lambda exc: self.errors.append(str(exc)))
        self.external = []
        self.page.on("request", lambda req: self.external.append(req.url)
                     if req.url.startswith(("http:", "https:")) else None)
        self.page.set_content("""
            <header class="actions"><button id="open-glossary">Glossary</button></header>
            <main id="content"><div id="view">
              <h2>Annual growth (CAGR)</h2><p class="panel-sub">CVaR and VaR use returns.</p>
              <dl class="metric-list"><dt>Settlement band</dt><dd>12.5 USD</dd></dl>
              <p class="explain">Desk [A+] uses P&amp;L. See <code>raw_CAGR</code>.</p>
              <button data-series="one">CAGR Income</button>
              <div class="chart-legend">USD</div><div class="chart" tabindex="0"><svg><text>CAGR</text></svg></div>
              <div id="score-rows"></div></div></main>
            <dialog id="settings"><form><div class="dialog-header"><h2>Settings</h2></div>
            <label>Annual risk-free rate (%)<input id="setting-rf" type="number" value="2"></label>
            <label>Rolling window<select id="setting-months"><option>6 months</option></select></label>
            <div class="dialog-actions"></div></form></dialog>""")
        self.assertTrue((ASSETS / "glossary.js").is_file(), "the offline glossary script must exist")
        self.assertTrue((ASSETS / "glossary.css").is_file(), "the glossary needs its offline styles")
        self.page.add_script_tag(path=ASSETS / "glossary.js")
        self.page.add_style_tag(path=ASSETS / "glossary.css")
        self.page.evaluate("""report => {
            window.fixture = report;
            window.gloss = PerformanceGlossary.mount({report});
            gloss.refresh({series: report.series[0]});
        }""", REPORT)

    def tearDown(self):
        self.assertEqual(self.errors, [])
        self.assertEqual(self.external, [])

    def test_inline_mouse_keyboard_touch_and_preserved_text(self):
        p = self.page
        term = p.locator("h2 [data-atlas-term]").first
        term.hover()
        tip = p.get_by_role("tooltip")
        self.assertIn("annual", tip.inner_text().lower())
        tip.hover()
        self.assertTrue(tip.is_visible())
        p.keyboard.press("Escape")
        self.assertFalse(tip.is_visible())
        term.focus()
        p.keyboard.press("Enter")
        self.assertTrue(tip.is_visible())
        self.assertEqual(term.get_attribute("aria-describedby"), tip.get_attribute("id"))
        p.keyboard.press("ArrowRight")
        self.assertEqual(p.evaluate("document.activeElement.textContent"), "CVaR")
        p.keyboard.press("Escape")
        p.locator(".panel-sub [data-atlas-term]").first.tap()
        self.assertTrue(tip.is_visible())
        p.locator("header").tap(position={"x": 200, "y": 3})
        self.assertFalse(tip.is_visible())
        self.assertEqual(p.locator(".explain").text_content(), "Desk [A+] uses P&L. See raw_CAGR.")
        self.assertEqual(p.locator("code,dd,button[data-series],.chart-legend,.chart")
                         .locator("[data-atlas-term]").count(), 0)
        self.assertEqual(p.locator('[data-atlas-term][tabindex="0"]').count(), 1)

    def test_search_settings_sources_and_modal_focus(self):
        p = self.page
        opener = p.locator("#open-glossary")
        opener.click()
        dialog = p.get_by_role("dialog", name="Glossary")
        search = dialog.get_by_role("searchbox")
        self.assertTrue(search.evaluate("e => e === document.activeElement"))
        for term in ["CAGR", "VaR", "CVaR", "NAV", "FX", "USD", "P&L", "held overnight",
                     "active during session", "margin load", "overnight initial margin", "maintenance margin",
                     "required equity", "standalone estimate", "gain-to-pain", "trailing window",
                     "contract multiplier", "largest win share", "largest loss share", "cash P&L",
                     "log return", "HTML", "CSV", "JSON", "UTC", "YTD", "Monte Carlo"]:
            search.fill(term)
            with self.subTest(term=term):
                self.assertGreater(dialog.locator("dt").count(), 0)
        search.fill("Desk [A+]")
        self.assertIn("<em>Cash & fees</em>", dialog.locator("dd").first.text_content())
        self.assertEqual(dialog.locator("em").count(), 0)
        search.fill("zzzz-no-matching-term")
        self.assertEqual(dialog.locator("dt").count(), 0)
        p.keyboard.press("Escape")
        self.assertTrue(opener.evaluate("e => e === document.activeElement"))
        p.evaluate("document.querySelector('#settings').showModal()")
        rate = p.get_by_label("Annual risk-free rate (%)")
        rate.focus()
        self.assertTrue(p.locator("#settings [role=tooltip]").is_visible())
        rate.fill("3")
        p.keyboard.press("Escape")
        self.assertTrue(p.locator("#settings").is_visible())
        self.assertEqual(rate.input_value(), "3")
        p.locator("#settings").get_by_role("button", name="Glossary").click()
        search.fill("Rolling window")
        self.assertGreater(dialog.locator("dd").count(), 0)
        p.keyboard.press("Escape")
        self.assertTrue(p.locator("#settings").is_visible())

    def test_refresh_hash_scorecard_and_large_numeric_table(self):
        p = self.page
        first = p.locator("dt [data-atlas-term]").first
        first.hover()
        self.assertIn("First account", p.get_by_role("tooltip").inner_text())
        p.evaluate("""() => {
            const slot = document.getElementById('score-rows');
            slot.innerHTML = '<table><thead><tr><th>CAGR</th></tr></thead><tbody>' +
                '<tr><td>0.12 USD</td></tr>'.repeat(10000) + '</tbody></table>';
        }""")
        p.locator("#score-rows th [data-atlas-term]").wait_for()
        self.assertEqual(p.locator("tbody [data-atlas-term]").count(), 0)
        p.evaluate("gloss.refresh({series: fixture.series[1]})")
        p.locator("dt [data-atlas-term]").first.focus()
        self.assertIn("Second account", p.get_by_role("tooltip").inner_text())
        count = p.locator("[data-atlas-term]").count()
        p.evaluate("gloss.refresh({series: fixture.series[1]})")
        self.assertEqual(p.locator("[data-atlas-term]").count(), count)
        p.evaluate("location.hash = 'rolling'")
        p.wait_for_function("location.hash === '#rolling' && !document.querySelector('[role=tooltip]:not([hidden])')")
        p.evaluate("gloss.open('Settlement band')")
        self.assertIn("Second account", p.get_by_role("dialog", name="Glossary").inner_text())
        self.assertEqual(p.locator("dialog [data-atlas-term]").count(), 0)

    def test_dynamic_labels_protect_names_source_codes_and_longest_aliases(self):
        p = self.page
        p.evaluate("""() => {
            document.getElementById('view').insertAdjacentHTML('beforeend',
              '<p class="explain" id="prose">CAGR Income and Relative Value use CVaR, VaR and P&amp;L. ' +
              'raw_CAGR ABCVaR CVaR2 <a href="#notes">NAV</a> <code>USD</code></p>' +
              '<div id="correlation-tables"><h3 class="corr-detail-title">Comparisons for CAGR Income</h3>' +
              '<table class="corr-grid"><thead><tr><th>Strategy</th><th>CAGR Income</th></tr></thead></table>' +
              '<table class="corr-detail"><thead><tr><th>Peer</th><th>Shared intervals</th></tr></thead>' +
              '<tbody><tr><th scope="row">CAGR Income</th><td>12</td></tr></tbody></table></div>');
        }""")
        labels = p.locator("#prose [data-atlas-term]")
        labels.first.wait_for()
        self.assertEqual(labels.all_text_contents(), ["CVaR", "VaR", "P&L"])
        self.assertEqual(p.locator("#correlation-tables [data-atlas-term]").all_text_contents(),
                         ["Strategy", "Shared intervals"])
        labels.first.focus()
        self.assertIn("shortfall", p.get_by_role("tooltip").inner_text().lower())
        p.locator("#prose").evaluate("node => node.remove()")
        p.get_by_role("tooltip").wait_for(state="hidden")
        self.assertEqual(p.locator('[data-atlas-term][tabindex="0"]').count(), 1)

    def test_refresh_replaces_old_diagnostic_and_preserves_existing_descriptions(self):
        p = self.page
        p.evaluate("""() => {
            fixture.series[1].diagnostics.push({name:'First measure', unit:'contracts'});
            document.querySelector('dt').textContent = 'First measure and Settlement band';
            gloss.refresh({series: fixture.series[1]});
        }""")
        terms = p.locator("dt [data-atlas-term]")
        self.assertEqual(terms.all_text_contents(), ["First measure", "Settlement band"])
        terms.first.focus()
        self.assertIn("contracts", p.get_by_role("tooltip").inner_text())
        p.evaluate("gloss.refresh({series: fixture.series[0]})")
        self.assertEqual(terms.all_text_contents(), ["Settlement band"])
        self.assertEqual(p.locator("dt").first.text_content(), "First measure and Settlement band")
        p.evaluate("""() => {
            document.getElementById('setting-rf').setAttribute('aria-describedby', 'rate-note');
            document.getElementById('settings').showModal();
        }""")
        rate = p.locator("#setting-rf")
        rate.focus()
        tip = p.get_by_role("tooltip")
        self.assertIn(tip.get_attribute("id"), rate.get_attribute("aria-describedby").split())
        p.keyboard.press("Escape")
        self.assertEqual(rate.get_attribute("aria-describedby"), "rate-note")
        p.keyboard.press("Escape")
        self.assertFalse(p.locator("#settings").is_visible())

    def test_help_actions_preserve_heading_and_table_names(self):
        p = self.page
        p.evaluate("""() => {
            document.getElementById('view').insertAdjacentHTML('afterbegin',
              '<h1>Portfolio overview</h1><button data-kind="portfolio">Portfolio</button>' +
              '<button data-kind="strategy">Strategy</button><h3 aria-label="Source title">CAGR</h3>' +
              '<table><thead><tr><th>Measure</th><th>CAGR</th></tr></thead>' +
              '<tbody><tr><th scope="row">Gross profit</th><td>12 USD</td></tr>' +
              '<tr><td>Win rate</td><td>25%</td></tr></tbody></table>');
        }""")
        self.assertEqual(p.get_by_role("button", name="Portfolio", exact=True).count(), 1)
        title = p.get_by_role("heading", name="Portfolio overview", exact=True)
        help_button = title.get_by_role("button", name="Define Portfolio", exact=True)
        self.assertEqual(help_button.inner_text(), "Portfolio")
        help_button.hover()
        self.assertIn("investments", p.get_by_role("tooltip").inner_text())
        self.assertEqual(title.inner_text(), "Portfolio overview")
        self.assertEqual(p.get_by_role("heading", name="Source title", exact=True).count(), 1)
        for role, text in (("columnheader", "CAGR"), ("rowheader", "Gross profit"), ("cell", "Win rate")):
            with self.subTest(role=role):
                owner = p.get_by_role(role, name=text, exact=True)
                self.assertEqual(owner.get_by_role("button", name="Define " + text, exact=True).count(), 1)
        # Chromium exposes the dt name to assistive technology. Playwright's term locator omits it.
        session = self.context.new_cdp_session(p)
        self.addCleanup(session.detach)
        nodes = session.send("Accessibility.getFullAXTree")["nodes"]
        self.assertIn(("term", "Settlement band"),
                      [(n["role"]["value"], n.get("name", {}).get("value")) for n in nodes])
        p.locator("h1").evaluate("el => el.textContent = 'Strategy overview'")
        self.assertEqual(p.get_by_role("heading", name="Strategy overview", exact=True)
                         .get_by_role("button", name="Define Strategy", exact=True).count(), 1)
        self.assertEqual(p.get_by_role("button", name="Strategy", exact=True).count(), 1)
        p.locator("h1").evaluate("el => el.textContent = 'Overview'")
        self.assertEqual(p.get_by_role("heading", name="Overview", exact=True).count(), 1)

    def test_legends_and_ranges_offer_definitions_without_new_controls(self):
        p = self.page
        p.evaluate("""() => {
            const legend = document.querySelector('.chart-legend');
            legend.innerHTML = ['Underwater', 'Held overnight', 'CAGR Income', 'Desk [A+]']
                .map(term => '<span class="legend-item"><i></i>' + term + '</span>').join('');
            document.getElementById('view').insertAdjacentHTML('beforeend',
                '<div id="ranges">' + ['YTD', '1Y', '3Y', '5Y'].map(term =>
                  '<button data-range="' + term + '">' + term + '</button>').join('') + '</div>');
        }""")
        items = p.locator(".legend-item")
        self.assertIn("running equity high", items.nth(0).get_attribute("title") or "")
        self.assertIn("session close", items.nth(1).get_attribute("title") or "")
        self.assertIsNone(items.nth(2).get_attribute("title"))
        self.assertIn("<em>Cash & fees</em>", items.nth(3).get_attribute("title") or "")
        for name, meaning in (("YTD", "Year to date"), ("1Y", "one-year"),
                              ("3Y", "three-year"), ("5Y", "five-year")):
            with self.subTest(name=name):
                control = p.get_by_role("button", name=name, exact=True)
                self.assertIn(meaning, control.get_attribute("title") or "")
                self.assertEqual(control.inner_text(), name)
        self.assertEqual(p.locator(".chart-legend, #ranges, .chart").locator("[data-atlas-term]").count(), 0)
        self.assertEqual(items.evaluate_all("els => els.map(el => el.tabIndex)"), [-1] * 4)
        items.first.evaluate("el => el.textContent = 'CAGR Income'")
        self.assertIsNone(items.first.get_attribute("title"))
        p.locator("h2 [data-atlas-term]").first.focus()
        p.keyboard.press("Enter")
        self.assertTrue(p.get_by_role("tooltip").is_visible())

    def test_generated_mobile_report_opens_offline_and_keeps_interactive_controls(self):
        p = self.page
        p.set_viewport_size({"width": 320, "height": 640})
        times = [1704067200000, 1704153600000]
        common = dict(kind="strategy", currency="USD", frequency="daily", periodsPerYear=365,
                      times=times, equity=[100, 105])
        series = []
        for s in REPORT["series"]:
            series.append({**common, **s, "diagnostics": [
                {**d, "unit": "USD", "times": times, "values": [3, 4]} for d in s["diagnostics"]]})
        with tempfile.TemporaryDirectory() as directory:
            report = render_bundle(dict(version=1, title="Offline glossary", series=series,
                                        glossary=REPORT["glossary"]), Path(directory) / "local report.html")
            p.goto(report.as_uri())
            opener = p.get_by_role("button", name="Open glossary", exact=True)
            opener.tap()
            dialog = p.get_by_role("dialog", name="Glossary")
            search = dialog.get_by_role("searchbox")
            search.fill("Desk [A+]")
            self.assertIn("<em>Cash & fees</em>", dialog.locator("dd").inner_text())
            dialog.get_by_role("button", name="Close glossary").tap()
            self.assertTrue(opener.evaluate("el => el === document.activeElement"))
            p.get_by_role("button", name="Open navigation").tap()
            p.locator('[data-view="explorer"]').tap()
            p.locator("#series-picker-trigger").tap()
            p.locator('#series-options button[data-value="two"]').tap()
            term = p.get_by_role("heading", name="Settlement band").locator("[data-atlas-term]")
            term.tap()
            tip = p.get_by_role("tooltip")
            self.assertIn("Second account", tip.inner_text())
            bounds = tip.bounding_box()
            self.assertGreaterEqual(min(bounds["x"], bounds["y"]), 0)
            self.assertLessEqual(bounds["x"] + bounds["width"], 320)
            self.assertLessEqual(bounds["y"] + bounds["height"], 640)
            p.keyboard.press("Escape")
            self.assertTrue(p.locator("#explorer-chart-source-0 svg").is_visible())
            self.assertTrue(p.locator("#explorer-chart-returns svg").is_visible())
            self.assertLessEqual(p.locator("body").evaluate("el => el.scrollWidth"), 320)

    def test_generated_desktop_scope_actions_legends_and_range_clicks(self):
        p = self.page
        p.set_viewport_size({"width": 1440, "height": 960})
        bundle = demo_bundle()
        book = next(s for s in bundle["series"] if s["kind"] == "portfolio")
        book["name"] = "CAGR"
        with tempfile.TemporaryDirectory() as directory:
            report = render_bundle(bundle, Path(directory) / "atlas.html")
            p.goto(report.as_uri())
            for scope in ("Portfolio", "Strategy", "Portfolio"):
                control = p.get_by_role("button", name=scope, exact=True)
                self.assertEqual(control.count(), 1)
                control.click()
                heading = p.get_by_role("heading", name=scope + " overview", exact=True)
                self.assertEqual(heading.get_by_role("button", name="Define " + scope, exact=True).count(), 1)
            equity_legend = p.locator("#equity-chart").locator("xpath=preceding-sibling::*[1]").locator(".legend-item")
            self.assertEqual(equity_legend.inner_text(), "CAGR")
            self.assertIsNone(equity_legend.get_attribute("title"))
            underwater = p.locator(".legend-item").filter(has_text="Underwater")
            self.assertIn("running equity high", underwater.get_attribute("title"))
            ytd = p.get_by_role("button", name="YTD", exact=True)
            self.assertIn("Year to date", ytd.get_attribute("title"))
            ytd.click()
            self.assertEqual(ytd.get_attribute("aria-pressed"), "true")
            p.locator('[data-view="activity"]').click()
            overnight = p.locator(".legend-item").filter(has_text="Held overnight")
            self.assertIn("session close", overnight.get_attribute("title"))
            self.assertEqual(p.locator(".chart, .chart-legend, #ranges").locator("[data-atlas-term]").count(), 0)
