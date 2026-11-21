"""Portable, source-labelled session observations and position drill-down."""
import csv
import json
import tempfile
import unittest
from pathlib import Path

from lab.performance.activity import build_activity, load_activity_file, validate_activity
from lab.performance.build import render_bundle
from lab.performance.demo import demo_bundle
from lab.performance.evidence import build_manifest
from lab.performance.inputs import load_config, parse_time, validate_bundle


ROOT = Path(__file__).resolve().parents[1]
MONDAY, TUESDAY = "2024-03-11", "2024-03-12"


def sample(time, usd=None, basis="unknown"):
    return {"time": time, "marginUsd": usd, "marginBasis": basis}


def session(day, **fields):
    return {"date": day, **fields}


def compile_rows(*rows, **fields):
    return build_activity({"source": "Synthetic account", "rows": list(rows), **fields})["rows"]


class IntradayActivityTests(unittest.TestCase):
    def test_overnight_labels_absolute_instants_gaps_and_zero_survive_round_trip(self):
        first = "2024-03-10T18:00:00-04:00"
        later = "2024-03-11T11:00:00.125Z"
        tuesday = parse_time("2024-03-11T22:05:00Z")
        spec = {"source": "Synthetic", "rows": [
            session(MONDAY, intradayMargin=[sample(first, 1200, "schedule_scenario"), {"time": later}]),
            session(TUESDAY, intradayMargin=[sample(tuesday, 0, "broker_requirement")])
        ]}
        normalized = build_activity(spec)
        a, b = normalized["rows"]
        self.assertEqual(a["date"], MONDAY)
        self.assertEqual(a["intradayMargin"], [sample(parse_time(first), 1200, "schedule_scenario"),
                                               sample(parse_time(later))])
        self.assertEqual(b["intradayMargin"], [sample(tuesday, 0, "broker_requirement")])
        for row in (a, b):
            self.assertEqual((row["active"], row["overnight"], row["marginUsd"], row["marginBasis"]),
                             (None, None, None, "unknown"))
        self.assertEqual(build_activity(normalized), normalized)
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "sidecar.json"
            file.write_text(json.dumps(spec))
            self.assertEqual(load_activity_file(file), normalized)

    def test_no_samples_or_positions_are_inferred_from_an_overnight_snapshot(self):
        a, b = compile_rows(session(MONDAY, active=2, marginUsd=0, marginBasis="broker_requirement"),
                            session(TUESDAY, intradayMargin=[], activePositions=[]))
        self.assertNotIn("intradayMargin", a)
        self.assertNotIn("activePositions", a)
        self.assertEqual(b["intradayMargin"], [])
        self.assertEqual(b["activePositions"], [])
        self.assertIsNone(b["active"])

    def test_point_contributors_keep_observed_signed_exposure_and_independent_amounts(self):
        a = {"strategyId": "short", "symbol": "@ES", "quantity": -0.5, "marginUsd": 80}
        b = {"strategyId": "long", "symbol": "@ES", "account": "paper", "quantity": 0.25, "marginUsd": 30}
        point = dict(sample(MONDAY + "T14:00Z", 90, "schedule_scenario"), contributors=[a, b])
        spec = {"source": "Top contributors", "rows": [session(MONDAY, intradayMargin=[point])]}
        normalized = build_activity(spec)
        observed = normalized["rows"][0]["intradayMargin"][0]
        self.assertEqual(observed["contributors"], [a, b])
        self.assertEqual(observed["marginUsd"], 90)
        self.assertEqual(build_activity(normalized), normalized)
        for patch in ({"strategyId": ""}, {"symbol": None}, {"account": "  "}, {"quantity": None},
                      {"quantity": float("nan")}, {"marginUsd": False}, {"marginUsd": -1}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                compile_rows(session(MONDAY, intradayMargin=[dict(point, contributors=[dict(a, **patch)])]))

    def test_position_legs_remain_separate_before_netting_and_only_explicit_amounts_appear(self):
        legs = [{"date": MONDAY, "symbol": "ES", "account": "one", **entry} for entry in [
            {"strategyId": "long", "closeQty": 2, "heldDuring": True},
            {"strategyId": "short", "closeQty": -2, "marginUsd": 100, "marginBasis": "broker_requirement"},
            {"strategyId": "day", "heldDuring": True, "closeQty": 0},
            {"strategyId": "partial", "heldDuring": True},
            {"strategyId": "never", "heldDuring": False, "closeQty": 0}]]
        row, = compile_rows(positions=legs)
        positions = {p["strategyId"]: p for p in row["activePositions"]}
        self.assertEqual(set(positions), {"long", "short", "day", "partial"})
        self.assertEqual([positions[k].get("closeQty") for k in ("long", "short", "day", "partial")],
                         [2, -2, 0, None])
        self.assertNotIn("closeQty", positions["partial"])
        self.assertNotIn("marginUsd", positions["long"])
        self.assertEqual(positions["short"]["marginUsd"], 100)
        self.assertTrue(all(p["symbol"] == "ES" and p["account"] == "one" for p in positions.values()))
        self.assertIsNone(row["active"])
        self.assertIsNone(row["marginUsd"])

    def test_snapshot_csv_and_json_accept_the_same_optional_records(self):
        leg = {"symbol": "ES", "strategyId": "trend", "heldDuring": True}
        points = [sample("2024-03-10T23:00:00Z", 0, "schedule_scenario")]
        expected, = compile_rows(session(MONDAY, activePositions=[leg], intradayMargin=points, overnightScenarioUsd=0))
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / "sessions.csv"
            with file.open("w", newline="") as stream:
                writer = csv.writer(stream)
                writer.writerow(["date", "activePositions", "intradayMargin", "overnightScenarioUsd"])
                writer.writerow([MONDAY, json.dumps([leg]), json.dumps(points), 0])
            self.assertEqual(load_activity_file(file)["rows"], [expected])

    def test_explicit_allocations_can_extend_a_ledger_leg_but_cannot_contradict_it(self):
        ledger = [dict(date=MONDAY, account="desk", strategyId="long", symbol="ES", closeQty=2)]
        allocation = dict(strategyId="long", symbol="ES", marginUsd=40, marginBasis="schedule_scenario")
        row, = compile_rows(session(MONDAY, activePositions=[allocation]), positions=ledger)
        self.assertEqual(row["activePositions"], [dict(allocation, account="desk", closeQty=2)])
        self.assertIsNone(row["marginUsd"])
        with self.assertRaises(ValueError):
            compile_rows(session(MONDAY, activePositions=[dict(allocation, heldDuring=False)]), positions=ledger)

    def test_snapshot_position_details_and_allocations_do_not_create_historical_counts(self):
        leg = {"strategyId": "day", "symbol": "@ES", "heldDuring": True, "closeQty": 0,
               "marginUsd": 0, "marginBasis": "schedule_scenario"}
        row, = compile_rows(session(MONDAY, activePositions=[leg]))
        self.assertEqual(row["activePositions"], [leg])
        self.assertEqual([row[k] for k in ("active", "overnight", "marginUsd")], [None]*3)

    def test_independent_overnight_scenario_round_trips_with_simultaneous_historical_amount(self):
        spec = {"source": "Account and later schedule", "rows": [
            session(MONDAY, marginUsd=27, marginBasis="broker_requirement", overnightScenarioUsd=0),
            session(TUESDAY, metadata={"overnightScenarioUsd": 120, "rateDate": "2026-11-01"}),
            session("2024-03-13", overnightScenarioUsd=None),
            session("2024-03-14", marginUsd=50, marginBasis="schedule_scenario", overnightScenarioUsd=50)]}
        result = build_activity(spec)
        self.assertEqual([r["overnightScenarioUsd"] for r in result["rows"]], [0, 120, None, 50])
        self.assertEqual([r["marginUsd"] for r in result["rows"]], [27, None, None, 50])
        self.assertEqual(result["rows"][1]["metadata"], spec["rows"][1]["metadata"])
        self.assertEqual(build_activity(result), result)
        for invalid in (
            {"overnightScenarioUsd": -1}, {"overnightScenarioUsd": True}, {"overnightScenarioUsd": float("inf")},
            {"overnightScenarioUsd": 0, "metadata": {"overnightScenarioUsd": 2}},
            {"overnightScenarioUsd": 0, "marginUsd": 1, "marginBasis": "schedule_scenario"}
        ):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                compile_rows(session(MONDAY, **invalid))

    def test_each_session_owns_its_source_timestamps_and_validates_order(self):
        day = MONDAY + "T12:00:00Z"
        for invalid in (
            [session(MONDAY, intradayMargin=[sample(day), sample(day)])],
            [session(MONDAY, intradayMargin=[sample(day), sample("2024-03-11T11:59Z")])],
            [session(MONDAY, intradayMargin=[sample(day)]), session(TUESDAY, intradayMargin=[sample(day)])],
            [session(MONDAY, closeTime=day, intradayMargin=[sample("2024-03-11T13:00Z")])],
            *([session(MONDAY, intradayMargin=[sample(bad)])] for bad in
              (MONDAY, "2024-03-11T12:01", "2024-03-11T12:01:01.0001Z", True)),
            *([session(MONDAY, intradayMargin=[sample(day, v, basis)])] for v, basis in
              ((-1, "schedule_scenario"), (True, "schedule_estimate"), (0, "unknown"), (10, "typo"))),
            [session(MONDAY, activePositions=[{"symbol": "ES"}])],
            [session(MONDAY, activePositions=[{"symbol":"ES","strategyId":"a","closeQty":2,"heldDuring":False}])],
            [session(MONDAY, activePositions=[{"symbol":"ES","strategyId":"a","marginUsd":12}])]
        ):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                compile_rows(*invalid)

    def test_terminal_instant_keeps_observed_prefix_without_later_session_totals(self):
        t = parse_time(MONDAY + "T16:00:00Z")
        spec = {"source": "Synthetic", "rows": [session(MONDAY, active=9, overnight=5,
                marginUsd=1234, marginBasis="broker_requirement", closeTime=t+100,
                activePositions=[{"strategyId":"after","symbol":"ES"}],
                intradayMargin=[sample(t-1, 100, "broker_requirement"), sample(t, 75, "broker_requirement"),
                                sample(t+1, 250, "broker_requirement")])]}
        result = validate_activity(spec, t-1000, t+1000, t)["rows"]
        self.assertEqual(len(result), 1)
        row, = result
        self.assertEqual([p["time"] for p in row["intradayMargin"]], [t-1, t])
        self.assertEqual([row[k] for k in ("active","overnight","marginUsd")], [None]*3)
        self.assertNotIn("activePositions", row)
        self.assertNotIn("closeTime", row)

    def test_demo_and_portable_manifest_include_multisession_observations(self):
        demo = validate_bundle(demo_bundle())["series"][0]["activity"]["rows"]
        self.assertTrue(all(r.get("intradayMargin") for r in demo))
        self.assertTrue(all(len(r["intradayMargin"]) >= 2 for r in demo[1:]))
        for row in demo:
            self.assertEqual(len({p["strategyId"] for p in row["activePositions"]}), row["active"])
            self.assertEqual(row["intradayMargin"][-1]["marginUsd"], row["marginUsd"])
        portable = load_config(ROOT / "examples/performance/report.json")["series"][0]["activity"]["rows"]
        observed = [r for r in portable if r.get("intradayMargin")]
        self.assertGreaterEqual(len(observed), 2)
        self.assertTrue(any(p["time"] < parse_time(r["date"]) for r in observed for p in r["intradayMargin"]))
        self.assertTrue(any(p["marginBasis"] == "schedule_scenario" for r in observed for p in r["intradayMargin"]))

    def test_last_source_mark_can_be_the_terminal_mark(self):
        mark = parse_time(TUESDAY + "T14:00Z")
        activity = {"source": "Account", "rows": [session(TUESDAY, intradayMargin=[
            sample(mark, 0, "broker_requirement"), sample(mark+1, 500, "broker_requirement")])]}
        book = dict(kind="portfolio", id="p", name="Book", currency="USD", frequency="daily", periodsPerYear=252,
                    times=[mark-86_400_000, mark], equity=[100, 0], activity=activity)
        out = validate_bundle({"version": 1, "title": "Terminal", "series": [book]})
        self.assertEqual(out["series"][0]["activity"]["rows"][0]["intradayMargin"],
                         [sample(mark, 0, "broker_requirement")])
        self.assertEqual(validate_bundle(out), out)

    def test_overnight_session_prefix_keeps_its_later_trading_label_after_exhaustion(self):
        terminal = parse_time(MONDAY + "T23:00Z")
        activity = {"source": "Overnight", "rows": [session(TUESDAY, intradayMargin=[
            sample(terminal-100, 78, "broker_requirement"), sample(terminal+100, 65, "broker_requirement")])]}
        book = dict(kind="portfolio", id="p", name="Book", currency="USD", frequency="daily", periodsPerYear=252,
                    times=[terminal-1000, terminal, terminal+86_400_000], equity=[100, 0, 0], activity=activity)
        out = validate_bundle({"version": 1, "title": "Overnight", "series": [book]})
        row, = out["series"][0]["activity"]["rows"]
        self.assertEqual(row["date"], TUESDAY)
        self.assertEqual(row["intradayMargin"], [sample(terminal-100, 78, "broker_requirement")])
        self.assertEqual(validate_bundle(out), out)

    def test_a_later_schedule_close_never_counts_as_a_historical_requirement(self):
        times = [parse_time(d + "T21:00Z") for d in (MONDAY, TUESDAY)]
        book = dict(kind="portfolio", id="p", name="Book", currency="USD", frequency="daily", periodsPerYear=252,
                    times=times, equity=[100,102], activity={"source":"Example", "rows":[
                        session(MONDAY, marginUsd=800, marginBasis="schedule_scenario"),
                        session(TUESDAY, marginUsd=0, marginBasis="broker_requirement")]})
        with tempfile.TemporaryDirectory() as directory:
            html = render_bundle({"version":1,"title":"Activity","series":[book]}, Path(directory)/"report.html")
            evidence = build_manifest(html)["session_activity"]
        self.assertEqual(evidence["requirement_observations"], 1)
        self.assertEqual(evidence["scenario_observations"], 1)
        self.assertEqual(evidence["peak_requirement_by_basis"]["broker_requirement"], {"date": TUESDAY, "usd": 0})
        self.assertEqual(evidence["active_count_observations"], 0)


if __name__ == "__main__":
    unittest.main()
