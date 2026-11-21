"""Historical portfolio activity and overnight USD margin regression tests."""

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from lab.performance.activity import load_activity_file
from lab.performance.inputs import load_config, parse_time, validate_bundle


ROOT = Path(__file__).resolve().parents[1]
A, B, C, D = "2020-01-02", "2020-01-03", "2020-01-06", "2020-01-07"


def report(activity, **changes):
    series = dict({"id": "book", "name": "Book", "kind": "portfolio", "currency": "EUR",
                   "frequency": "daily", "periodsPerYear": 252, "times": list(map(parse_time, (A, B, C, D))),
                   "equity": [100, 102, 98, 101], "activity": activity}, **changes)
    return {"title": "Report", "version": 1, "series": [series]}


def position(day, strategy, qty, symbol="X", account="main", **more):
    return dict(date=day, account=account, strategyId=strategy, symbol=symbol, closeQty=qty, **more)


def rule(ident="base", **changes):
    return dict({"id": ident, "symbol": "X", "validFrom": A, "validTo": D, "side": "long",
                 "method": "per_contract", "rate": 10, "currency": "USD"}, **changes)


def ledger(positions, **more):
    return dict({"source": "Closing ledger", "positions": positions, "rules": [rule()],
                 "marginModel": "simple_net", "intradayComplete": True, "closeComplete": True}, **more)


def rows(spec, **changes):
    return validate_bundle(report(spec, **changes))["series"][0]["activity"]["rows"]


class ActivityTests(unittest.TestCase):
    def test_authoritative_rows_keep_session_labels_independent_gaps_and_zero(self):
        spec = {"source": "Broker export", "sessionDates": [A, B, C, D], "metadata": {"accounting": "broker close"},
                "rows": [{"date": A, "active": 3, "marginUsd": 350, "marginBasis": "required_equity"},
                         {"date": C, "active": 2, "overnight": 0, "marginUsd": 0, "marginBasis": "broker_requirement"},
                         {"date": D, "overnight": 2, "gaps": {"active": "Intraday file is absent."}}]}
        source = report(spec)
        expected = copy.deepcopy(source)
        normalized = validate_bundle(source)
        activity = normalized["series"][0]["activity"]
        self.assertEqual(source, expected)
        self.assertEqual(normalized, validate_bundle(normalized))
        self.assertEqual(activity["source"], spec["source"])
        self.assertEqual(activity["metadata"], spec["metadata"])
        a, b, c, d = activity["rows"]
        self.assertEqual([x["date"] for x in activity["rows"]], [A, B, C, D])
        self.assertEqual((a["active"], a["overnight"], a["marginUsd"], a["marginBasis"]), (3, None, 350, "required_equity"))
        self.assertEqual(set(a["gaps"]), {"overnight"})
        self.assertEqual((b["active"], b["overnight"], b["marginUsd"], b["marginBasis"]), (None, None, None, "unknown"))
        self.assertEqual(set(b["gaps"]), {"active", "overnight", "marginUsd"})
        self.assertEqual((c["active"], c["overnight"], c["marginUsd"]), (2, 0, 0))
        self.assertEqual(d["gaps"]["active"], "Intraday file is absent.")
        self.assertIsNone(d["marginUsd"])

    def test_counts_before_margin_netting_handle_intraday_exits_and_duplicate_strategies(self):
        positions = [position(A, "trend", 2), position(A, "carry", -2), position(A, "day", 0, heldDuring=True),
                     position(A, "trend", 1, "Y"), position(A, "never", 0, heldDuring=False),
                     position(B, "same", 1), position(B, "same", None, "Y", heldDuring=True),
                     position(C, "flat", 0), position(D, "missing-close", None, heldDuring=True)]
        result = rows(ledger(positions, rules=[rule(), rule("y", symbol="Y")]))
        self.assertEqual((result[0]["active"], result[0]["overnight"], result[0]["marginUsd"]), (3, 2, 10))
        self.assertEqual((result[1]["active"], result[1]["overnight"], result[1]["marginUsd"]), (1, 1, None))
        self.assertEqual((result[2]["active"], result[2]["overnight"], result[2]["marginUsd"]), (None, 0, 0))
        self.assertEqual((result[3]["active"], result[3]["overnight"], result[3]["marginUsd"]), (1, None, None))

    def test_empty_partial_and_attested_flat_sessions_differ(self):
        result = rows(ledger([position(A, "day", 0, heldDuring=True)],
                             rows=[{"date": B}, {"date": C, "intradayComplete": True, "closeComplete": True},
                                   {"date": D, "closeComplete": True, "active": 3}]))
        self.assertEqual([(r["active"], r["overnight"], r["marginUsd"]) for r in result],
                         [(1, 0, 0), (None, None, None), (0, 0, 0), (3, 0, 0)])
        row = rows(ledger([position(A, "day", 1)], intradayComplete=False, closeComplete=False))[0]
        self.assertEqual((row["active"], row["overnight"], row["marginUsd"]), (None, None, None))

    def test_schedule_uses_net_side_account_and_inclusive_historical_bounds(self):
        positions = [position(d, "buy", 1) for d in (A, B, C, D)]
        positions += [position(A, "sell", -4), position(A, "buy", 2, account="other")]
        rates = [rule("first", validTo=B, rate=15), rule("second", validFrom=C, validTo=C, rate=25),
                 rule("short", side="short", rate=7)]
        results = rows(ledger(positions, rules=rates))
        self.assertEqual([r["marginUsd"] for r in results], [51, 15, 25, None])
        self.assertEqual(results[0]["marginBasis"], "schedule_estimate")
        components = results[0]["marginDetails"]["components"]
        self.assertEqual([(c["account"], c["netQty"], c["ruleId"]) for c in components], [("main", -3, "short"), ("other", 2, "first")])
        self.assertIn("rule", results[3]["gaps"]["marginUsd"].lower())

    def test_notional_uses_multiplier_exact_day_fx_and_exposes_inputs(self):
        pos = [position(day, "a", 2, product="Index", price=120, currency="EUR") for day in (A, B, C)]
        pos.append(position(D, "a", 2, product="Index", currency="EUR"))
        product = rule("index", method="notional_fraction", rate=0.15, currency="EUR", product="Index", multiplier=5)
        del product["symbol"]
        spec = ledger(pos, rules=[product], fx=[{"date": B, "currency": "EUR", "usdPerUnit": 1.25},
                                               {"date": D, "currency": "EUR", "usdPerUnit": 1.30}])
        a, b, c, d = rows(spec)
        self.assertEqual([r["marginUsd"] for r in (a, b, c, d)], [None, 225.0, None, None])
        detail = b["marginDetails"]["components"][0]
        self.assertEqual((detail["price"], detail["multiplier"], detail["usdPerUnit"], detail["currency"]), (120, 5, 1.25, "EUR"))
        self.assertIn("FX", a["gaps"]["marginUsd"])
        self.assertIn("FX", c["gaps"]["marginUsd"])
        self.assertIn("price", d["gaps"]["marginUsd"])

    def test_unsupported_offsets_and_incomplete_evidence_stay_unknown(self):
        pos = [position(A, "x", 1), position(A, "y", -1, "Y"), position(B, "x", 1, complex=True),
               position(C, "x", 1, offsetGroup="pair"), position(D, "x", None, heldDuring=True)]
        result = rows(ledger(pos, rules=[rule(), rule("y-short", symbol="Y", side="short")]))
        for row in result:
            self.assertIsNone(row["marginUsd"])
            self.assertTrue(row["gaps"]["marginUsd"])
        self.assertEqual([(x["active"], x["overnight"]) for x in result[:3]], [(2, 2), (1, 1), (1, 1)])
        direct = rows(ledger(pos, rows=[{"date": B, "marginUsd": 80, "marginBasis": "broker_requirement"}]))
        self.assertEqual((direct[1]["marginUsd"], direct[1]["marginBasis"]), (80, "broker_requirement"))
        self.assertIsNone(rows(ledger([position(A, "x", 0, heldDuring=False)], marginModel="broker_only"))[0]["marginUsd"])

    def test_complete_account_totals_override_complex_ledger_without_cross_account_netting(self):
        totals = [{"date": day, "account": "first", "marginUsd": 70, "marginBasis": "broker_requirement"} for day in (A, B, C)]
        totals += [{"date": A, "account": "second", "marginUsd": 30, "marginBasis": "broker_requirement"},
                   {"date": C, "account": "second", "marginUsd": 30, "marginBasis": "required_equity"}]
        result = rows(ledger([position(A, "a", 1, account="first", complex=True)], accountIds=["first", "second"], accountTotals=totals))
        self.assertEqual((result[0]["marginUsd"], result[0]["marginBasis"]), (100, "broker_requirement"))
        self.assertEqual((result[1]["marginUsd"], result[2]["marginUsd"]), (None, None))
        self.assertIn("second", result[1]["gaps"]["marginUsd"])
        self.assertIn("basis", result[2]["gaps"]["marginUsd"])

    def test_fractional_offsets_and_rule_ambiguity_never_create_spurious_margin(self):
        pos = [position(A, "a", 0.1), position(A, "b", 0.2), position(A, "c", -0.3), position(B, "b", 2)]
        rows_ = rows(ledger(pos, rules=[rule("one"), rule("two", validFrom=B, validTo=B)]))
        self.assertEqual((rows_[0]["overnight"], rows_[0]["marginUsd"]), (3, 0))
        self.assertIsNone(rows_[1]["marginUsd"])
        self.assertIn("ambiguous", rows_[1]["gaps"]["marginUsd"].lower())

    def test_scoped_rules_fall_back_only_outside_their_effective_window(self):
        product = rule("product", product="Index", rate=2)
        del product["symbol"]
        local_product = dict(product, id="local-product", account="main", rate=3, validFrom=B, validTo=C)
        local_symbol = rule("local-symbol", account="main", validFrom=C, validTo=C, rate=4)
        pos = [position(d, "s", 1, product="Index", multiplier=100) for d in (A, B, C, D)]
        result = rows(ledger(pos, rules=[product, rule(validTo=C), local_product, local_symbol]))
        self.assertEqual([r["marginUsd"] for r in result], [10, 3, 4, 2])
        self.assertEqual([r["marginDetails"]["components"][0]["ruleId"] for r in result],
                         ["base", "local-product", "local-symbol", "product"])

    def test_unknown_schedule_method_and_precomputed_estimate_yield_to_broker_evidence(self):
        complex_rule = rule(method="portfolio_risk_scenarios")
        del complex_rule["rate"], complex_rule["currency"]
        days = [{"date": d, "marginUsd": 5, "marginBasis": "schedule_estimate"} for d in (A, B, C)]
        totals = [{"date": B, "account": "main", "marginUsd": 32, "marginBasis": "required_equity"}]
        result = rows(ledger([position(d, "x", 1) for d in (A, B, C)], rows=days, rules=[complex_rule],
                             accountIds=["main"], accountTotals=totals))
        self.assertEqual([r["marginUsd"] for r in result], [None, 32, None])
        self.assertIn("unsupported", result[0]["gaps"]["marginUsd"].lower())
        self.assertEqual(result[1]["marginBasis"], "required_equity")
        self.assertEqual([r["overnight"] for r in result], [1, 1, 1])
        self.assertIsNone(rows({"source": "Source", "rows": days, "marginModel": "complex"})[0]["marginUsd"])

    def test_incomplete_rule_and_blank_fx_leave_only_affected_margin_unknown(self):
        spec = ledger([position(d, "a", 1) for d in (A, B, C, D)],
                      rules=[rule("early", validTo=B, rate=None), rule("late", validFrom=C, currency="EUR")],
                      rows=[{"date": B, "marginUsd": 73, "marginBasis": "broker_requirement"}],
                      fx=[{"date": C, "currency": "EUR", "usdPerUnit": None}, {"date": D, "currency": "EUR", "usdPerUnit": 1.2}])
        result = rows(spec)
        self.assertEqual([r["marginUsd"] for r in result], [None, 73, None, 12])
        self.assertIn("rate", result[0]["gaps"]["marginUsd"])
        self.assertIn("FX", result[2]["gaps"]["marginUsd"])
        self.assertTrue(all((r["active"], r["overnight"]) == (1, 1) for r in result))

    def test_empty_position_flags_alone_are_not_evidence_and_do_not_leak_into_payload(self):
        value = rows({"source": "Source", "rows": [{"date": A, "closeComplete": True, "intradayComplete": True}]})[0]
        self.assertNotIn("intradayComplete", value)
        self.assertNotIn("closeComplete", value)
        self.assertEqual((value["active"], value["overnight"], value["marginUsd"]), (None, None, None))

    def test_invalid_counts_inconsistent_ledgers_schedules_and_dates_fail_validation(self):
        bad = [{"rows": [{"date": A, "active": True}]}, {"rows": [{"date": A, "overnight": 1.5}]},
               {"rows": [{"date": A, "active": 1, "overnight": 2}]}, {"rows": [{"date": A, "marginUsd": 0}]},
               {"rows": [{"date": A, "marginUsd": -2, "marginBasis": "broker_requirement"}]},
               {"rows": [{"date": A, "marginUsd": float("inf"), "marginBasis": "broker_requirement"}]},
               {"rows": [{"date": A}, {"date": A}]}, {"rows": [{"date": "2020-02-30"}]},
               {"positions": [position(A, "a", 2, heldDuring=False)]}, {"positions": [position(A, "a", 1)] * 2},
               {"rules": [rule(validFrom=C, validTo=B)]}, {"rules": [rule(symbol="*")]},
               {"rules": [rule(rate=-0.1)]}, {"rules": [rule(side="both")]},
               {"positions": [position(A, "a", 1)], "rows": [{"date": A, "overnight": 0}]},
               {"positions": [position(A, "a", None)], "closeComplete": True,
                "rows": [{"date": A, "overnight": 2}]},
               {"fx": [{"date": A, "currency": "EUR", "usdPerUnit": 0}]}]
        for fields in bad:
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                rows(dict(source="Source", **fields))
        with self.assertRaisesRegex(ValueError, "portfolio"):
            rows({"source": "Source", "rows": []}, kind="strategy")
        with self.assertRaisesRegex(ValueError, "outside"):
            rows({"source": "Source", "rows": [{"date": "2019-12-31"}]})

    def test_broker_day_and_exact_close_time_at_exhaustion(self):
        history = {"source": "Closing file", "timeZone": "America/New_York",
                   "rows": [{"date": A, "active": 1}, {"date": B, "active": 1, "closeTime": B + "T21:00:00Z"},
                            {"date": C, "active": 2}]}
        times = list(map(parse_time, ("2020-01-03T01:00:00Z", B + "T20:00:00Z", D + "T00:00:00Z")))
        result = rows(history, times=times, equity=[100, -5, 110])
        self.assertEqual([r["date"] for r in result], [A])
        with self.assertRaisesRegex(ValueError, "outside"):
            rows({"source": "Source", "timeZone": "UTC", "rows": [{"date": "2050-01-01", "closeTime": B}]})

    def test_csv_does_not_round_missing_risk_into_a_zero_or_an_integer_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "source.csv"
            for data in [f"date,active\n{A},1.00000000000000001\n",
                         f"date,marginUsd,marginBasis\n{A},1e-400,broker_requirement\n"]:
                path.write_text(data)
                with self.subTest(data=data), self.assertRaises(ValueError):
                    load_activity_file(path)

    def test_json_underflow_cannot_turn_a_reported_requirement_into_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "book.json"
            activity = {"source": "Statement", "rows": [{"date": A, "marginUsd": "amount", "marginBasis": "required_equity"}]}
            for read, payload in [(load_activity_file, activity), (load_config, report(activity))]:
                path.write_text(json.dumps(payload).replace('"amount"', '1e-400'))
                with self.subTest(loader=read.__name__), self.assertRaises(ValueError):
                    read(path)

    def test_sidecars_and_each_activity_csv_are_portable_and_protected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data = root / "data"
            data.mkdir()
            files = {"days.csv": "date,active,overnight,marginUsd,marginBasis\n" + A + ",,,,\n",
                     "positions.csv": f"date,account,strategyId,symbol,closeQty,heldDuring\n{A},main,trend,X,2,true\n",
                     "rates.csv": f"id,symbol,validFrom,validTo,side,method,rate,currency\nx,X,{A},{D},long,per_contract,12,EUR\n",
                     "fx.csv": f"date,currency,usdPerUnit\n{A},EUR,1.25\n",
                     "totals.csv": "date,account,marginUsd,marginBasis\n"}
            for name, content in files.items():
                (data / name).write_text(content)
            sidecar = data / "activity.json"
            sidecar.write_text(json.dumps(dict(source="Account", csv="days.csv", positionsCsv="positions.csv", rulesCsv="rates.csv",
                                               fxCsv="fx.csv", accountTotalsCsv="totals.csv", marginModel="simple_net",
                                               intradayComplete=True, closeComplete=True)))
            series = report({})["series"][0]
            del series["activity"]
            series["activityFile"] = "data/activity.json"
            config = root / "report.json"
            config.write_text(json.dumps({"series": [series]}))
            activity = load_activity_file(sidecar)
            self.assertEqual(activity["rows"][0]["marginUsd"], 30)
            self.assertEqual(activity, load_config(config)["series"][0]["activity"])
            inline = json.loads(sidecar.read_text())
            for key in ("csv", "positionsCsv", "rulesCsv", "fxCsv", "accountTotalsCsv"):
                inline[key] = "data/" + inline[key]
            inline_config = root / "inline.json"
            inline_config.write_text(json.dumps(report(inline)))
            self.assertEqual(activity, load_config(inline_config)["series"][0]["activity"])
            for input_path in [sidecar, *(data / name for name in files)]:
                before = input_path.read_bytes()
                with self.subTest(path=input_path.name), self.assertRaisesRegex(ValueError, "output"):
                    load_config(config, output=input_path)
                self.assertEqual(before, input_path.read_bytes())
            alias = root / "output.html"
            alias.symlink_to(data / "rates.csv")
            with self.assertRaisesRegex(ValueError, "output"):
                load_config(inline_config, output=alias)
            series["activity"] = inline
            config.write_text(json.dumps({"series": [series]}))
            with self.assertRaisesRegex(ValueError, "either activity or activityFile"):
                load_config(config)
            snapshot = data / "standalone.csv"
            snapshot.write_text(f"date,active,overnight,marginUsd,marginBasis\n{A},4,,,unknown\n")
            imported = load_activity_file(snapshot, session_dates=[A, B])
            self.assertEqual([r["active"] for r in imported["rows"]], [4, None])
            with self.assertRaisesRegex(ValueError, "output"):
                load_activity_file(snapshot, output=snapshot)

    def test_stdlib_cli_embeds_portfolio_sidecar(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "close.csv").write_text(f"date,marginUsd,marginBasis\n{A},30,broker_requirement\n")
            bundle = report(None)
            del bundle["series"][0]["activity"]
            bundle["series"][0]["activityFile"] = "close.csv"
            config = root / "report.json"
            config.write_text(json.dumps(bundle))
            cli = subprocess.run([sys.executable, "-B", "-S", "-m", "lab.performance", "--config", str(config),
                                  "--output", str(root / "report.html")], cwd=ROOT, text=True, capture_output=True)
            self.assertEqual(cli.returncode, 0, cli.stderr)
            self.assertIn('"marginUsd":30', (root / "report.html").read_text())
