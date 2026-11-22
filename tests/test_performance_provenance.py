"""The report identifies its renderer independently of the input schema and observations."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lab.performance import build, evidence, provenance


SHA = "0123456789abcdef0123456789abcdef01234567"
REVISION_TIME = "2026-11-22T17:10:01Z"
BUILD_TIME = "2026-11-23T06:12:08Z"


class AtlasVersionTests(unittest.TestCase):
    def test_version_uses_the_utc_commit_date_and_distinguishes_same_day_updates(self):
        item = provenance.make_stamp(SHA, "2026-11-23T02:10:01+09:00", built_utc=BUILD_TIME)
        self.assertEqual(item["version"], "2026.11.22+0123456789ab")
        self.assertEqual(item["revision_utc"], REVISION_TIME)
        self.assertEqual(item["built_utc"], BUILD_TIME)
        newer = provenance.make_stamp("9" * 40, REVISION_TIME, built_utc=BUILD_TIME)
        self.assertNotEqual(newer["version"], item["version"])
        for revision, when in ((SHA[:12], REVISION_TIME), (SHA, "2026-11-22T09:10:01")):
            with self.subTest(revision=revision, when=when), self.assertRaises(ValueError):
                provenance.make_stamp(revision, when)

    def test_release_marker_and_offline_source_fingerprint(self):
        with tempfile.TemporaryDirectory() as work, patch.dict(os.environ, {"SOURCE_DATE_EPOCH": "0"}):
            folder = Path(work)
            asset = folder / "example.css"
            asset.write_text("first")
            with patch.object(provenance, "PACKAGE", folder):
                local = provenance.current_stamp(folder, [asset.name])
                self.assertIsNone(local["revision"])
                self.assertIsNone(local["revision_utc"])
                self.assertEqual(local["built_utc"], "1970-01-01T00:00:00Z")
                self.assertEqual(local["version"], "local+" + local["source_sha256"][:12])
                asset.write_text("second")
                self.assertNotEqual(provenance.current_stamp(folder, [asset.name])["version"], local["version"])
                marker = folder / "_atlas_source.json"
                marker.write_text(json.dumps({"revision": SHA, "revision_utc": REVISION_TIME}))
                self.assertEqual(provenance.current_stamp(folder, [asset.name])["revision"], SHA)
                marker.write_text("{}")
                with self.assertRaisesRegex(ValueError, "source receipt"):
                    provenance.current_stamp(folder, [asset.name])

    def test_dirty_or_unrelated_checkouts_cannot_claim_an_official_revision(self):
        from subprocess import CompletedProcess
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            package = root / "lab" / "performance"
            package.mkdir(parents=True)
            (root / ".git").touch()  # Synthetic marker. All Git operations are mocked.
            def git(command, **kwargs):
                op = command[3:]
                output = {"status": dirty, "remote": "origin" if len(op) == 1 else origin,
                          "for-each-ref": "refs/remotes/origin/codex/performance-report",
                          "log": SHA + "\n" + REVISION_TIME}[op[0]]
                return CompletedProcess(command, 0, output)
            with patch.object(provenance, "PACKAGE", package), patch("subprocess.run", side_effect=git):
                dirty, origin = "", "https://github.com/" + provenance.REPOSITORY + ".git"
                self.assertEqual(provenance._checkout_source()["revision"], SHA)
                dirty = "M lab/performance/build.py"
                self.assertIsNone(provenance._checkout_source())
                dirty, origin = "", "https://github.com/example/consumer.git"
                self.assertIsNone(provenance._checkout_source())

    def test_report_embeds_the_source_and_build_time_outside_financial_data(self):
        bundle = {"version": 1, "title": "Test", "series": [{
            "id": "s", "name": "Test", "kind": "strategy", "currency": "USD", "frequency": "daily",
            "periodsPerYear": 365, "times": [0, 86400000], "equity": [100, 101]}]}
        stamp = provenance.make_stamp(SHA, REVISION_TIME, built_utc=BUILD_TIME)
        with tempfile.TemporaryDirectory() as work:
            output = Path(work) / "report.html"
            build.render_bundle(bundle, output, build_stamp=stamp)
            first = output.read_text()
            data, digest, recorded = evidence._read_page(first)
            self.assertEqual(recorded, stamp)
            proof = evidence.build_manifest(output, "s")["provenance"]
            self.assertEqual(proof["report_build"], stamp)
            self.assertIn(f"--revision {SHA} evidence", proof["run_command"])
            self.assertEqual(data["version"], 1)
            self.assertNotIn("built_utc", data)
            self.assertIn(f"https://github.com/{provenance.REPOSITORY}/commit/{SHA}", first)
            self.assertIn(f'<time datetime="{BUILD_TIME}">', first)
            self.assertIn(f'Build details · {stamp["version"]}', first)
            other = provenance.make_stamp(SHA, REVISION_TIME, built_utc="2026-11-24T00:00:00Z")
            build.render_bundle(bundle, output, build_stamp=other)
            self.assertEqual(evidence._read_page(output.read_text()), (data, digest, other))
            with self.assertRaises(ValueError):
                build.render_bundle(bundle, output, build_stamp={**stamp, "version": "latest"})
            self.assertEqual(evidence._read_page(output.read_text())[2], other)

    def test_older_reports_have_no_invented_revision_and_duplicate_stamps_fail(self):
        data = '<script id="report-data" type="application/json">{"version":1}</script>'
        self.assertIsNone(evidence._read_page(data)[2])
        stamp = provenance.make_stamp(SHA, REVISION_TIME, built_utc=BUILD_TIME)
        markup = provenance.render_stamp(stamp)
        for page in (data + markup + markup, data + markup.replace(SHA[:12] + '"', 'incorrect"'),
                     data + markup.replace('id="atlas-build" type="application/json"',
                                           'id="atlas-build" type="text/javascript"')):
            with self.subTest(page=page[-100:]), self.assertRaises(ValueError):
                evidence._read_page(page)
