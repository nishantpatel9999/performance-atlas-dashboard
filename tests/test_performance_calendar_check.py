"""Acceptance checks compare visible HTML with external monthly return fractions."""
import gzip
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.util import find_spec
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from unittest.mock import patch

from lab.performance import render_bundle
from lab.performance.verify_calendar import verify, verify_cells, verify_table


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

    def test_malformed_month_cannot_pass_as_an_empty_cell(self):
        for month in (None, "", "2025-13", "2025-1", "2025"):
            with self.subTest(month=month), self.assertRaisesRegex(ValueError, "identified month"):
                verify_cells([(month, None, "—")], {}, "calendar", "fund")

    def test_reader_checks_summary_placement_counts_and_source_returns(self):
        expected = {f"2023-{m:02}": v for m, v in enumerate([.1, -.1] + [0.] * 10, 1)}
        months, averages = [], []
        for i, (month, value) in enumerate(expected.items(), 1):
            cell = {"return": str(value), "label": f"{value:+.2%}"}
            months.append({**cell, "month": month, "coverage": "full"})
            averages.append({**cell, "monthAverage": str(i), "count": "1"})
        annual = {"yearReturn": "2023", "coverage": "full", "return": "-.01", "label": "-1.00%"}
        mean = {"yearAverage": "", "count": "1", "return": "-.01", "label": "-1.00%"}
        table = {"header": "Year return", "body": [{"heading": "2023", "cells": [*months, annual]}],
                 "footer": [{"heading": "Average", "cells": [*averages, mean]}]}
        history = [[] for _ in range(13)]
        self.assertEqual(verify_table(table, expected, "calendar", "fund", history), 12)
        self.assertEqual(verify_table(table, expected, "overview", "fund", history), 12)
        for cell, key, invalid in ((months[0], "month", None), (months[1], "yearReturn", "2023"),
                                   (annual, "yearReturn", "2024"), (annual, "return", "0"),
                                   (averages[0], "count", "0"), (averages[1], "return", ".1"),
                                   (averages[2], "monthAverage", "4"), (mean, "count", "2")):
            with self.subTest(key=key, invalid=invalid), patch.dict(cell, {key: invalid}):
                with self.assertRaises(ValueError):
                    verify_table(table, expected, "overview", "fund", history)

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
