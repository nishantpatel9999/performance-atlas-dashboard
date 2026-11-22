"""Exercise the public release launcher using a synthetic GitHub repository."""
import base64
import hashlib
import io
import json
from contextlib import contextmanager, redirect_stderr, redirect_stdout
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts import atlas_release as release


def oid(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


class PublicChannel:
    """Return a different branch head on successive lookups. All responses are GET bytes."""
    heads = ["1" * 40, "2" * 40]
    dates = ["2025-12-31T23:59:00Z", "2026-01-02T01:00:00+02:00"]

    def __init__(self):
        self.urls = []
        self.lookups = 0
        self.responses = {}
        self.packages = {}
        for i, (sha, date) in enumerate(zip(self.heads, self.dates), 1):
            root, lab, package = [str(i + offset) * 40 for offset in (2, 4, 6)]
            commit = {"sha": sha, "tree": {"sha": root}, "committer": {"date": date}}
            self.responses[f"{release.API}/git/commits/{sha}"] = commit
            self.tree(root, [self.directory("lab", lab), self.directory("vault", "a" * 40)])
            self.tree(lab, [self.file(sha, "lab", "__init__.py", b""), self.directory("performance", package)])
            script = (
                "import json, pathlib, sys\n"
                "p = pathlib.Path\n"
                "marker = json.loads(p(__file__).with_name('_atlas_source.json').read_text())\n"
                "p(sys.argv[4]).write_text(json.dumps([marker, p(sys.argv[2]).read_text(), sys.executable]))\n"
            ).encode()
            entries = [self.file(sha, "lab/performance", "__init__.py", b""),
                       self.file(sha, "lab/performance", "__main__.py", script),
                       self.file(sha, "lab/performance", "app.js", sha.encode())]
            self.packages[sha] = entries
            self.tree(package, entries, recursive=True)
            skill = f"Exact skill for {sha}\n".encode()
            self.responses[f"{release.API}/contents/{release.SKILL}?ref={sha}"] = {
                "type": "file", "path": release.SKILL, "size": len(skill), "sha": oid(skill),
                "encoding": "base64", "content": base64.b64encode(skill).decode()}

    @staticmethod
    def directory(name, sha):
        return {"path": name, "sha": sha, "type": "tree", "mode": "040000"}

    def tree(self, sha, entries, recursive=False):
        url = f"{release.API}/git/trees/{sha}" + ("?recursive=1" if recursive else "")
        self.responses[url] = {"sha": sha, "tree": entries, "truncated": False}

    def file(self, revision, parent, name, data):
        self.responses[f"{release.RAW}/{revision}/{parent}/{name}"] = data
        return {"path": name, "type": "blob", "mode": "100644", "size": len(data), "sha": oid(data)}

    def read(self, url, limit):
        self.urls.append(url)
        if url == f"{release.API}/branches/codex%2Fperformance-report":
            i = self.lookups
            self.lookups += 1
            sha = self.heads[i]
            return json.dumps({"name": release.CHANNEL, "commit": {"sha": sha, "commit": {
                "committer": {"date": self.dates[i]}, "tree": {"sha": str(i + 3) * 40}}}}).encode()
        value = self.responses[url]
        data = value if isinstance(value, bytes) else json.dumps(value).encode()
        if len(data) > limit:
            raise ValueError("Response exceeds limit")
        return data


@contextmanager
def caller_project():
    old = Path.cwd()
    with tempfile.TemporaryDirectory() as temp:
        project = Path(temp)
        try:
            os.chdir(project)
            yield project
        finally:
            os.chdir(old)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.git = PublicChannel()
        mock = patch.object(release, "read_public", side_effect=self.git.read)
        self.network = mock.start()
        self.addCleanup(mock.stop)

    def invoke(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            status = release.main(list(args))
        return status, out.getvalue(), err.getvalue()

    def test_resolve_queries_again_and_uses_the_utc_committer_date(self):
        for sha, date in zip(self.git.heads, ["2025.12.31", "2026.01.01"]):
            status, output, error = self.invoke("resolve")
            self.assertEqual((status, error), (0, ""))
            result = json.loads(output)
            self.assertEqual(result["version"], date + "+" + sha[:12])
            self.assertEqual(result["revision"], sha)
            self.assertEqual(result["skill_url"], f"{release.RAW}/{sha}/{release.SKILL}")
        self.assertEqual(len(self.git.urls), 2)
        self.network.side_effect = OSError("offline")
        status, output, error = self.invoke("resolve")
        self.assertNotEqual(status, 0)
        self.assertEqual(output, "")
        self.assertIn("offline", error)

    def test_two_builds_pin_once_and_read_relative_paths_in_the_caller_directory(self):
        with caller_project() as project:
            Path("report input").write_text("synthetic input")
            # The project and an inherited PYTHONPATH each have an older lab.
            for root in (project, project / "old-imports"):
                (root / "lab").mkdir(parents=True)
                (root / "lab" / "__init__.py").write_text("STALE = True")
            # Without isolation Python runs this startup hook before the launcher
            # can put the pinned package first. lab then remains in sys.modules.
            (project / "old-imports" / "sitecustomize.py").write_text(
                "import lab\nfrom pathlib import Path\nPath('stale-startup').touch()\n")
            with patch.dict(os.environ, {"PYTHONPATH": str(project / "old-imports")}):
                for i, sha in enumerate(self.git.heads):
                    date = ["2025-12-31T23:59:00Z", "2026-01-01T23:00:00Z"][i]
                    self.git.urls.clear()
                    status, _, error = self.invoke("build", "--config", "report input", "--output", "results")
                    self.assertEqual((status, error), (0, ""))
                    marker, value, interpreter = json.loads(Path("results").read_text())
                    self.assertEqual(marker, {"revision": sha, "revision_utc": date})
                    self.assertEqual(value, "synthetic input")
                    self.assertEqual(interpreter, release.sys.executable)
                    self.assertEqual(self.git.lookups, i + 1)
                    raw = [u for u in self.git.urls if u.startswith(release.RAW)]
                    self.assertEqual(len(raw), 4)
                    self.assertTrue(all(f"/{sha}/lab/" in u for u in raw))
                    self.assertFalse(any("report input" in u or "results" in u for u in self.git.urls))
            self.assertFalse((project / "stale-startup").exists())

    def test_main_pin_builds_and_reproduces_evidence_without_a_skill_or_calendar_checker(self):
        sha = self.git.heads[1]
        del self.git.responses[f"{release.API}/contents/{release.SKILL}?ref={sha}"]
        evidence = (
            "import json, pathlib, sys\n"
            "p = pathlib.Path\n"
            "built, value, _ = json.loads(p(sys.argv[2]).read_text())\n"
            "source = json.loads(p(__file__).with_name('_atlas_source.json').read_text())\n"
            "assert built == source\n"
            "p(sys.argv[4]).write_text(source['revision'] + ' ' + value)\n"
        ).encode()
        self.git.packages[sha].append(self.git.file(sha, "lab/performance", "evidence.py", evidence))
        with caller_project():
            source, html, manifest = map(Path, ("local config", "report.html", "evidence.json"))
            source.write_text("synthetic main demo")
            for args in (("build", "--config", str(source), "--output", str(html)),
                         ("evidence", "--html", str(html), "--out", str(manifest))):
                status, _, error = self.invoke("--revision", sha, *args)
                self.assertEqual((status, error), (0, ""))
            self.assertEqual(manifest.read_text(), sha + " synthetic main demo")
        self.assertEqual(self.git.lookups, 0)
        self.assertEqual(self.git.urls.count(f"{release.API}/git/commits/{sha}"), 2)
        self.assertFalse(any(release.SKILL in url or "verify_calendar" in url for url in self.git.urls))

    def test_explicit_pin_selects_exact_skill_and_only_that_commit(self):
        sha = self.git.heads[1]
        status, output, error = self.invoke("--revision", sha, "skill")
        self.assertEqual((status, output, error), (0, f"Exact skill for {sha}\n", ""))
        self.assertEqual(self.git.lookups, 0)
        self.assertEqual(len(self.git.urls), 2)
        self.git.responses[f"{release.API}/git/commits/{sha}"]["sha"] = self.git.heads[0]
        self.assertNotEqual(self.invoke("--revision", sha, "resolve")[0], 0)

    def test_invalid_pin_and_failed_fetch_stop_before_launch(self):
        with patch.object(release.subprocess, "run") as child:
            self.assertNotEqual(self.invoke("--revision", "../main", "build")[0], 0)
            self.assertEqual(self.git.urls, [])
            sha = self.git.heads[0]
            self.git.responses[f"{release.RAW}/{sha}/lab/performance/app.js"] = b"!" * 40
            self.assertNotEqual(self.invoke("build")[0], 0)
            self.network.side_effect = OSError("network unavailable")
            self.assertNotEqual(self.invoke("build")[0], 0)
            child.assert_not_called()

    def test_rejects_unsafe_or_incomplete_package_trees(self):
        sha = self.git.heads[0]
        tree = self.git.responses[f"{release.API}/git/trees/{'7' * 40}?recursive=1"]
        with patch.object(release.subprocess, "run") as child:
            for change in ({"path": "../outside"}, {"path": "/absolute"}, {"path": r"..\outside"},
                           {"type": "blob", "mode": "120000"}, {"path": "_atlas_source.json"}):
                with self.subTest(change=change), patch.dict(self.git.packages[sha][-1], change):
                    self.assertNotEqual(self.invoke("--revision", sha, "build")[0], 0)
            with patch.dict(tree, {"truncated": True}):
                self.assertNotEqual(self.invoke("--revision", sha, "build")[0], 0)
            child.assert_not_called()

    def test_rejects_large_package_before_downloading_blobs(self):
        sha = self.git.heads[0]
        with patch.dict(self.git.packages[sha][-1], {"size": release.FILE_LIMIT + 1}):
            status, _, error = self.invoke("--revision", sha, "build")
        self.assertNotEqual(status, 0)
        self.assertIn("size", error)
        self.assertFalse(any(url.startswith(release.RAW) for url in self.git.urls))

    def test_batch_stages_once_per_invocation_and_stops_at_first_tool_failure(self):
        steps = [
            ["build", "--config", "source files/bundle.json", "--output", "report.html"],
            ["evidence", "--html", "report.html", "--series", "alpha; beta", "--out", "a.json"],
            ["evidence", "--html", "report.html", "--series", "alpha; beta", "--check", "a.json"],
            ["verify-calendar", "--html", "report.html", "--expected", "calendar.csv"],
        ]
        with caller_project() as project:
            plan = Path("settings") / "report steps.json"
            plan.parent.mkdir()
            plan.write_text(json.dumps(steps), encoding="utf-8")
            for invocation, failure in enumerate((0, 17)):
                with self.subTest(failure=failure):
                    sha = self.git.heads[invocation]
                    self.git.urls.clear()
                    runs, roots = [], set()

                    def execute(argv):
                        self.assertEqual(argv[:5], [release.sys.executable, "-I", "-B", "-c", release.RUN_MODULE])
                        root = Path(argv[5])
                        roots.add(root)
                        marker = json.loads((root / "lab/performance/_atlas_source.json").read_text())
                        self.assertEqual(marker["revision"], sha)
                        self.assertEqual(Path.cwd(), project.resolve())
                        runs.append(argv[6:])
                        status = failure if len(runs) == 3 else 0
                        return release.subprocess.CompletedProcess(argv, status)

                    with patch.object(release.subprocess, "run", side_effect=execute):
                        status, _, error = self.invoke("batch", str(plan))
                    self.assertEqual(status, failure, error)
                    expected = steps[:3] if failure else steps
                    self.assertEqual(runs, [[release.MODULES[s[0]], *s[1:]] for s in expected])
                    self.assertEqual(self.git.lookups, invocation + 1)
                    urls = self.git.urls
                    self.assertEqual(sum(u.startswith(release.API) for u in urls), 4)
                    self.assertEqual(sum(u.startswith(release.RAW + "/" + sha + "/") for u in urls), 4)
                    self.assertEqual(len(urls), len(set(urls)))
                    self.assertEqual(len(roots), 1)
                    self.assertFalse(roots.pop().exists())

    def test_batch_validates_the_whole_file_before_fetch_or_execution(self):
        with caller_project(), patch.object(release.subprocess, "run") as child:
            plan = Path("steps.json")
            for bad in (None, {}, [], "evidence", [["build"], "evidence"], [["build"], []],
                        [["build"], ["batch", "more.json"]], [["skill"]], [["sh", "-c", "echo"]],
                        [["build", 3]], [["build", "bad\0path"]]):
                with self.subTest(bad=bad):
                    plan.write_text(json.dumps(bad), encoding="utf-8")
                    self.assertNotEqual(self.invoke("batch", str(plan))[0], 0)
            plan.write_text("{", encoding="utf-8")
            self.assertNotEqual(self.invoke("batch", str(plan))[0], 0)
            for args in ((), ("missing.json",), ("a.json", "b.json")):
                self.assertNotEqual(self.invoke("batch", *args)[0], 0)
            self.assertEqual(self.git.urls, [])
            child.assert_not_called()

    def test_tools_keep_the_selected_module_arguments_and_exit_code(self):
        args = ["--html", "relative report.html", "--series", "synthetic"]
        for command, module in (("evidence", "lab.performance.evidence"),
                                ("verify-calendar", "lab.performance.verify_calendar")):
            with self.subTest(command=command), patch.object(release.subprocess, "run") as child:
                child.return_value.returncode = 7
                self.assertEqual(self.invoke("--revision", self.git.heads[0], command, *args)[0], 7)
                argv = child.call_args.args[0]
                self.assertEqual(argv[0], release.sys.executable)
                self.assertEqual(argv[-len(args)-1:], [module, *args])
                self.assertFalse(Path(argv[-len(args)-2]).exists())
