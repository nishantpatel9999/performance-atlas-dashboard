"""Acceptance checks compare visible HTML with external monthly return fractions."""
import unittest

from lab.performance.verify_calendar import verify_cells


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
