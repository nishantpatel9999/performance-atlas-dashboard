#!/usr/bin/env python3
"""Resolve a public Performance Atlas release and run its tools in the caller's directory."""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
from http.client import HTTPException
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.parse import quote
from urllib.request import Request, urlopen


REPOSITORY = "nishantpatel9999/performance-atlas-dashboard"
CHANNEL = "codex/performance-report"
SKILL = ".agents/skills/performance-atlas-report/SKILL.md"
API = f"https://api.github.com/repos/{REPOSITORY}"
RAW = f"https://raw.githubusercontent.com/{REPOSITORY}"
MODULES = {"build": "lab.performance", "evidence": "lab.performance.evidence",
           "verify-calendar": "lab.performance.verify_calendar"}
METADATA_LIMIT = 4 * 1024 * 1024
FILE_LIMIT = 8 * 1024 * 1024
PACKAGE_LIMIT = 32 * 1024 * 1024
FILE_COUNT_LIMIT = 128
MARKER = "_atlas_source.json"


def read_public(url, limit):
    request = Request(url, headers={"User-Agent": "performance-atlas-release/1", "Cache-Control": "no-cache"})
    with urlopen(request, timeout=20) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Public release response exceeds its size limit")
    return data


def metadata(path):
    return json.loads(read_public(f"{API}/{path}", METADATA_LIMIT))


def git_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F]{40}", value):
        raise ValueError("Expected a full 40-character hexadecimal Git object ID")
    return value.lower()


def resolve(revision):
    if revision is None:
        branch = metadata("branches/" + quote(CHANNEL, safe=""))
        if branch["name"] != CHANNEL:
            raise ValueError("GitHub returned a different release channel")
        head = branch["commit"]
        revision, commit = git_id(head["sha"]), head["commit"]
    else:
        revision = git_id(revision)
        commit = metadata(f"git/commits/{revision}")
        if git_id(commit["sha"]) != revision:
            raise ValueError("GitHub returned a different commit")
    time = datetime.fromisoformat(commit["committer"]["date"].replace("Z", "+00:00"))
    if time.tzinfo is None:
        raise ValueError("Git commit timestamp has no UTC offset")
    utc = time.astimezone(timezone.utc)
    return {"repository": REPOSITORY, "channel": CHANNEL, "revision": revision,
            "revision_utc": utc.isoformat().replace("+00:00", "Z"),
            "version": f"{utc:%Y.%m.%d}+{revision[:12]}", "skill_url": f"{RAW}/{revision}/{SKILL}",
            "tree": git_id(commit["tree"]["sha"])}


def tree(sha, recursive=False):
    value = metadata(f"git/trees/{git_id(sha)}" + ("?recursive=1" if recursive else ""))
    if value["sha"] != sha or value["truncated"] is not False:
        raise ValueError("GitHub returned an incomplete or mismatched Git tree")
    return value["tree"]


def entry(entries, name, kind):
    matches = [e for e in entries if e["path"] == name and e["type"] == kind]
    if len(matches) != 1:
        raise ValueError(f"Release is missing a unique {kind} named {name}")
    return matches[0]


def safe_path(name):
    # These names must be safe on both POSIX and Windows, independent of the host.
    parts = name.split("/")
    for part in parts:
        if (not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]*", part) or part.endswith(".")
                or re.fullmatch(r"(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])", part.split(".")[0])):
            raise ValueError(f"Unsafe release path {name!r}")
    return name


def checked_blob(data, item):
    size = item["size"]
    if type(size) is not int or size < 0 or size != len(data):
        raise ValueError(f"Size mismatch for {item['path']}")
    digest = hashlib.sha1(b"blob " + str(size).encode() + b"\0" + data).hexdigest()
    if digest != git_id(item["sha"]):
        raise ValueError(f"Git blob mismatch for {item['path']}")
    return data


def skill_text(revision):
    item = metadata(f"contents/{SKILL}?ref={revision}")
    if item["type"] != "file" or item["path"] != SKILL or item["encoding"] != "base64":
        raise ValueError("Invalid skill response")
    data = base64.b64decode("".join(item["content"].split()), validate=True)
    return checked_blob(data, item).decode("utf-8")


def materialize(release, directory):
    # Only traverse the two package ancestors and the performance subtree.
    # Raw downloads are pinned by commit and checked against its Git blob IDs.
    lab = entry(tree(release["tree"]), "lab", "tree")
    children = tree(lab["sha"])
    package = entry(children, "performance", "tree")
    entries = tree(package["sha"], recursive=True)
    files = [("lab/__init__.py", entry(children, "__init__.py", "blob"))]
    seen = {MARKER.casefold()}
    for item in entries:
        name = safe_path(item["path"])
        key = name.casefold()
        if key in seen or key.startswith(MARKER.casefold() + "/"):
            raise ValueError(f"Duplicate or reserved release path {name!r}")
        seen.add(key)
        if item["type"] == "tree" and item["mode"] == "040000":
            continue
        files.append(("lab/performance/" + name, item))
    if len(files) > FILE_COUNT_LIMIT:
        raise ValueError("Release package exceeds the file count limit")
    total = 0
    for path, item in files:
        size = item.get("size")
        if item["type"] != "blob" or item["mode"] not in ("100644", "100755"):
            raise ValueError(f"Expected a regular file at {path}")
        if type(size) is not int or not 0 <= size <= FILE_LIMIT:
            raise ValueError(f"Invalid release file size at {path}")
        total += size
    if total > PACKAGE_LIMIT:
        raise ValueError("Release package exceeds its total size limit")
    for path, item in files:
        data = read_public(f"{RAW}/{release['revision']}/{quote(path)}", item["size"])
        verified = checked_blob(data, item)
        destination = directory / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open("xb") as stream:
            stream.write(verified)
    marker = {key: release[key] for key in ("revision", "revision_utc")}
    with (directory / "lab" / "performance" / MARKER).open("x", encoding="utf-8") as stream:
        json.dump(marker, stream)


# -I excludes the caller's directory and PYTHONPATH from module resolution.
# The child retains the caller's cwd for config, CSV, HTML and evidence paths.
RUN_MODULE = """import runpy, sys
sys.path.insert(0, sys.argv.pop(1))
runpy.run_module(sys.argv.pop(1), run_name="__main__", alter_sys=True)
"""


def read_steps(arguments):
    if len(arguments) != 1:
        raise ValueError("batch requires one STEPS.json file")
    steps = json.loads(Path(arguments[0]).read_text(encoding="utf-8-sig"))
    if not isinstance(steps, list) or not steps:
        raise ValueError("Expected a nonempty JSON array of batch steps")
    for number, step in enumerate(steps, 1):
        if (not isinstance(step, list) or not step
                or not all(isinstance(arg, str) and "\0" not in arg for arg in step)):
            raise ValueError(f"Batch step {number} must be a nonempty list of string arguments without NUL")
        if step[0] not in MODULES:
            raise ValueError(f"Batch step {number} must start with build, evidence, or verify-calendar")
    return steps


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", metavar="FULL_SHA", help="reuse an exact release commit")
    parser.add_argument("command", choices=("resolve", "skill", "batch", *MODULES))
    parser.add_argument("arguments", nargs=argparse.REMAINDER, help="a STEPS.json file for batch, or arguments for the selected tool")
    args = parser.parse_args(argv)
    if args.command in ("resolve", "skill") and args.arguments:
        parser.error(f"{args.command} takes no tool arguments")
    try:
        steps = read_steps(args.arguments) if args.command == "batch" else [[args.command, *args.arguments]]
        release = resolve(args.revision)
        if args.command == "resolve":
            print(json.dumps(release, indent=2))
            return 0
        if args.command == "skill":
            sys.stdout.write(skill_text(release["revision"]))
            return 0
        with tempfile.TemporaryDirectory(prefix="atlas-release-") as temp:
            materialize(release, Path(temp))
            interpreter = [sys.executable, "-I", "-B", "-c", RUN_MODULE, temp]
            for number, (tool, *arguments) in enumerate(steps, 1):
                status = subprocess.run([*interpreter, MODULES[tool], *arguments]).returncode
                if status:
                    if args.command == "batch":
                        print(f"Batch step {number} ({tool}) exited with status {status}", file=sys.stderr)
                    return status
            return 0
    except (OSError, HTTPException, ValueError, KeyError, TypeError) as exc:
        print(f"Atlas release failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
