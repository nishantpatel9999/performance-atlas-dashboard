"""Funding decisions must use the accounting basis supplied by the caller."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from lab.performance.inputs import equity_from_returns


class FundingTests(unittest.TestCase):
    def test_fixed_contributions_reach_zero_on_the_same_observation_at_any_scale(self):
        moves = [0.14, 0.01, -0.14, -0.01, -1, 0.50]
        for capital in (1, 100, 100_000):
            with self.subTest(capital=capital):
                path = equity_from_returns(moves, capital, "contributions")
                self.assertEqual(path[4], capital)
                self.assertEqual(path[5:], [0, 0])

    def test_small_positive_capital_and_terminal_debt_are_distinct(self):
        for capital in (1, 100_000):
            with self.subTest(capital=capital):
                solvent = equity_from_returns([1e-16, -1, 0.05], capital, "contributions")
                self.assertGreater(solvent[2], 0)
                self.assertAlmostEqual(solvent[3] / capital, 0.05 + 1e-16)
                failed = equity_from_returns([0.01, -1.02, 0.5], capital, "contributions")
                self.assertAlmostEqual(failed[2] / capital, -0.01)
                self.assertEqual(failed[3], failed[2])

    def test_offsetting_large_contributions_preserve_original_unspent_capital(self):
        self.assertEqual(equity_from_returns([1e16, -1e16, 0.05], 1, "contributions")[2:], [1.0, 1.05])

    def test_compounded_returns_continue_to_use_the_prior_mark(self):
        path = equity_from_returns([0.1, -0.1, -1, 0.1], 100, "returns")
        self.assertAlmostEqual(path[2], 99)
        self.assertEqual(path[3:], [0, 0])

class SourceProtectionTests(unittest.TestCase):
    def test_output_cannot_replace_any_manifest_input(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            series = {"id":"s", "name":"Sleeve", "kind":"strategy", "currency":"USD",
                      "frequency":"daily", "periodsPerYear":252, "csv":"marks.csv",
                      "tradesCsv":"closes.csv", "diagnostics":[{"name":"Exposure","unit":"%","csv":"exposure.csv"}]}
            sources = {
                "manifest.json": json.dumps({"series":[series]}),
                "marks.csv": "date,equity\n2020-01-01,100\n2020-01-02,102\n",
                "closes.csv": "time,pnl\n2020-01-02,2\n",
                "exposure.csv": "date,value\n2020-01-02,0.4\n",
            }
            for target in sources:
                with self.subTest(target=target):
                    for name,data in sources.items():
                        (root / name).write_text(data)
                    cmd = [sys.executable, "-m", "lab.performance", "--config", str(root / "manifest.json"),
                           "--output", str(root / target)]
                    result = subprocess.run(cmd, cwd=Path(__file__).resolve().parents[1], capture_output=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual((root / target).read_text(), sources[target])
