"""Acceptance checks compare visible HTML with external monthly return fractions."""
import gzip
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.util import find_spec
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import unittest

from lab.performance import render_bundle
from lab.performance.verify_calendar import verify, verify_cells


class CalendarCheckTests(unittest.TestCase):
    def test_gain_loss_zero_gap_and_percent_rounding(self):
        expected = {"2025-01": .012345, "2025-02": -.05, "2025-03": 0.0, "2025-04": None}
        rows = [("2025-01", ".012345", "+1.23%"), ("2025-02", "-.05", "−5.00%"),
                ("2025-03", "0", "0.00%"), ("2025-04", None, "—")]
        self.assertEqual(verify_cells(rows, expected, "calendar", "trend"), 3)
        for invalid in (("2025-01", ".012345", "+"), ("2025-01", ".012345", "+0.01%"),
                        ("2025-01", ".01", "+1.23%"), ("2025-04", "0", "0.00%")):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                verify_cells([invalid, *rows[1:]], expected, "calendar", "trend")

    def test_overview_needs_recent_measured_months(self):
        source = {f"{year}-01": .04 for year in range(2010, 2020)}
        rows = [(month, ".04", "+4.00%") for month in source]
        self.assertEqual(verify_cells(rows[-4:], source, "overview", "carry"), 4)
        with self.assertRaisesRegex(ValueError, "missing expected month"):
            verify_cells(rows[:4], source, "overview", "carry")

    def test_nonzero_tiny_return_is_visible_at_the_printed_precision(self):
        source = {"2025-01": .000031}
        def check(label):
            return verify_cells([("2025-01", ".000031", label)], source, "calendar", "fund")
        self.assertEqual(check("+0.003%"), 1)
        for label in ("+0.00%", "+0.004%"):
            with self.subTest(label=label), self.assertRaises(ValueError):
                check(label)

    @unittest.skipUnless(find_spec("playwright"), "Hosted calendar verification needs Playwright")
    def test_large_compressed_response_matches_the_rendered_report(self):
        expected = {"test": {"2020-01": .05}}
        with TemporaryDirectory() as temp:
            html = Path(temp) / "report.html"
            render_bundle({"version": 1, "title": "Hosted calendar", "series": [{
                "id": "test", "name": "Test account", "kind": "strategy", "currency": "USD",
                "frequency": "daily", "periodsPerYear": 252,
                "times": [1577836800000, 1577923200000], "equity": [100, 105]}]}, html)
            # Long offline reports can exceed Chromium's resource-inspection cache.
            with html.open("ab") as f:
                f.write(b"<!--" + b" " * (16 * 1024 * 1024) + b"-->")
            body = gzip.compress(html.read_bytes(), compresslevel=1)

            class Handler(BaseHTTPRequestHandler):
                def do_GET(self):
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html")
                    self.send_header("Content-Encoding", "gzip")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)

                def log_message(self, *args):
                    pass

            with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
                thread = Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    url = f"http://127.0.0.1:{server.server_port}/report.html"
                    checked = verify(html, expected, url)
                    self.assertTrue(checked["served_bytes_verified"])
                    self.assertEqual(checked["visible_months_checked"], {"overview": 1, "calendar": 1})
                    with html.open("ab") as f:
                        f.write(b" ")
                    with self.assertRaisesRegex(ValueError, "specified HTML bytes"):
                        verify(html, expected, url)
                finally:
                    server.shutdown()
                    thread.join()
