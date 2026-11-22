"""Identify the Atlas code used for a report, independently of its financial data."""

import hashlib
import html
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path


REPOSITORY = "nishantpatel9999/performance-atlas-dashboard"
CHANNEL = "codex/performance-report"
PACKAGE = Path(__file__).resolve().parent
IDENTITY = {"schema": 1, "skill": "performance-atlas-report", "repository": REPOSITORY, "channel": CHANNEL}


def _utc(value):
    if not isinstance(value, str):
        raise ValueError("Atlas dates must include a time and a UTC offset")
    try:
        stamp = datetime.fromisoformat(value)
        if stamp.utcoffset() is None:
            raise ValueError
        return stamp.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    except (ValueError, OverflowError) as exc:
        raise ValueError(f"Invalid timestamp with UTC offset: {value!r}") from exc


def _build_time(value):
    if value is not None:
        return _utc(value)
    epoch = os.environ.get("SOURCE_DATE_EPOCH")
    if epoch is None:
        stamp = datetime.now(timezone.utc)
    else:
        try:
            stamp = datetime.fromtimestamp(int(epoch), timezone.utc)
        except (ValueError, OverflowError, OSError) as exc:
            raise ValueError("SOURCE_DATE_EPOCH must be a representable Unix time in seconds") from exc
    return stamp.isoformat(timespec="seconds").replace("+00:00", "Z")


def make_stamp(revision, revision_utc, *, built_utc=None):
    """Use the full commit and its committer time from one resolved GitHub response."""
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("The Atlas revision must be a full 40-character Git commit")
    published = _utc(revision_utc)
    version = published[:10].replace("-", ".") + "+" + revision[:12]
    return {**IDENTITY, "version": version, "revision": revision, "revision_utc": published,
            "built_utc": _build_time(built_utc)}


def _local_stamp(digest, built_utc=None):
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("A local Atlas build requires a SHA-256 source fingerprint")
    return {**IDENTITY, "version": "local+" + digest[:12], "revision": None, "revision_utc": None,
            "source_sha256": digest, "built_utc": _build_time(built_utc)}


def validate_stamp(stamp):
    if not isinstance(stamp, dict) or type(stamp.get("schema")) is not int or not stamp.get("built_utc"):
        raise ValueError("Invalid atlas-build metadata")
    if stamp.get("revision") is None:
        expected = _local_stamp(stamp.get("source_sha256"), stamp["built_utc"])
    else:
        expected = make_stamp(stamp["revision"], stamp.get("revision_utc"), built_utc=stamp["built_utc"])
    if stamp != expected:
        raise ValueError("The Atlas version, source and UTC dates must agree in atlas-build")
    return expected


def _checkout_source():
    """Recognize an unmodified, published checkout of Atlas without contacting a remote."""
    root = PACKAGE.parent.parent
    if PACKAGE != root / "lab" / "performance" or not (root / ".git").exists():
        return None

    def git(*args):
        result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True,
                                check=True, timeout=5)
        return result.stdout.strip()

    origins = {f"https://github.com/{REPOSITORY}", f"git@github.com:{REPOSITORY}",
               f"ssh://git@github.com/{REPOSITORY}"}
    try:
        if git("status", "--porcelain", "--", "lab", ".agents/skills/performance-atlas-report", "scripts/atlas_release.py"):
            return None
        for remote in git("remote").splitlines():
            if git("remote", "get-url", remote).rstrip("/").removesuffix(".git") not in origins:
                continue
            refs = git("for-each-ref", "--contains=HEAD", "--format=%(refname)",
                       f"refs/remotes/{remote}/{CHANNEL}", f"refs/remotes/{remote}/main")
            if refs:
                revision, published = git("log", "-1", "--format=%H%n%cI").splitlines()
                return make_stamp(revision, published)
    except (OSError, subprocess.SubprocessError):
        pass
    return None


def current_stamp(asset_dir, asset_names):
    """Use the launcher's release receipt, a clean Atlas checkout, or the actual local source."""
    if asset_dir == PACKAGE:
        marker = PACKAGE / "_atlas_source.json"
        if marker.is_file():
            source = json.loads(marker.read_text(encoding="utf-8"))
            if not isinstance(source, dict) or set(source) != {"revision", "revision_utc"}:
                raise ValueError("Invalid Atlas source receipt in _atlas_source.json")
            return make_stamp(source["revision"], source["revision_utc"])
        checked_out = _checkout_source()
        if checked_out:
            return checked_out
    files = {name: asset_dir / name for name in asset_names}
    files.update({path.name: path for path in PACKAGE.glob("*.py")})
    if PACKAGE.parts[-2:] == ("lab", "performance"):
        root = PACKAGE.parent.parent
        for name in (".agents/skills/performance-atlas-report/SKILL.md", "scripts/atlas_release.py"):
            path = root / name
            if path.is_file():
                files[name] = path
    source = hashlib.sha256()
    for name, path in sorted(files.items()):
        source.update(name.encode("utf-8") + b"\0" + hashlib.sha256(path.read_bytes()).digest())
    return _local_stamp(source.hexdigest())


def render_stamp(stamp):
    """Produce an offline-readable disclosure and an independent machine-readable record."""
    item = validate_stamp(stamp)
    record = json.dumps(item, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    version = html.escape(item["version"])

    def moment(value):
        text = value.replace("T", " ").replace("Z", " UTC")
        return f'<time datetime="{value}">{text}</time>'

    if item["revision"]:
        revision = item["revision"]
        address = f"https://github.com/{REPOSITORY}/commit/{revision}"
        source = (f'<dt>Source updated</dt><dd>{moment(item["revision_utc"])}</dd>'
                  f'<dt>Git commit</dt><dd><a href="{address}"><code>{revision}</code></a></dd>')
    else:
        source = (f'<dt>Source</dt><dd>Local source fingerprint</dd>'
                  f'<dt>SHA-256</dt><dd><code>{item["source_sha256"]}</code></dd>')
    return (f'<details id="atlas-build-info"><summary>Build details · {version}</summary><dl>'
            f'<dt>Skill version</dt><dd>{version}</dd>{source}'
            f'<dt>Report built</dt><dd>{moment(item["built_utc"])}</dd></dl></details>'
            f'<script id="atlas-build" type="application/json">{record}</script>')
