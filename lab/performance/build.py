"""Compose the local browser assets and validated data into one offline HTML file."""

import json
import os
import re
import tempfile
from pathlib import Path

from .inputs import validate_bundle
from .provenance import current_stamp, render_stamp


ASSET_DIR = Path(__file__).resolve().parent
SCRIPTS = ("metrics.js", "details.js", "charts.js", "glossary.js", "app.js")
STYLES = ("style.css", "glossary.css", "correlations.css")
THEME_SLOT = "<!--REPORT_THEME-->"
STYLE_SLOT = "<!--REPORT_STYLE-->"
DATA_SLOT = "<!--REPORT_DATA-->"
SCRIPT_SLOT = "<!--REPORT_SCRIPTS-->"
BUILD_SLOT = "<!--REPORT_BUILD-->"


def render_bundle(bundle, output, *, build_stamp=None):
    """Write one atomic v1 report. A fixed build stamp also reproduces its timestamp."""
    data = validate_bundle(bundle)
    template = (ASSET_DIR / "template.html").read_text(encoding="utf-8")
    # Older custom templates only have the original four slots.
    if BUILD_SLOT not in template:
        template = template.replace(DATA_SLOT, BUILD_SLOT + "\n" + DATA_SLOT)
    slots = (THEME_SLOT, STYLE_SLOT, DATA_SLOT, SCRIPT_SLOT, BUILD_SLOT)
    for slot in slots:
        if template.count(slot) != 1:
            raise ValueError(f"template.html requires exactly one {slot}")
    # Escape raw-text HTML delimiters. ASCII JSON also escapes U+2028/U+2029.
    payload = json.dumps(data, ensure_ascii=True, allow_nan=False, sort_keys=True, separators=(",", ":"))
    payload = payload.replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e")
    styles = ["<style>" + (ASSET_DIR / name).read_text(encoding="utf-8") + "</style>" for name in STYLES]
    theme = (ASSET_DIR / "theme.js").read_text(encoding="utf-8")
    scripts = ["<script>\n" + (ASSET_DIR / name).read_text(encoding="utf-8") + "\n</script>" for name in SCRIPTS]
    if build_stamp is None:
        build_stamp = current_stamp(ASSET_DIR, ("template.html", "theme.js", *STYLES, *SCRIPTS))
    values = {BUILD_SLOT: (render_stamp(build_stamp),), THEME_SLOT: ("<script>\n", theme, "\n</script>"), STYLE_SLOT: ("\n".join(styles),),
              DATA_SLOT: ('<script id="report-data" type="application/json">', payload, "</script>"),
              SCRIPT_SLOT: ("\n".join(scripts),)}
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as work:
        tmp = Path(work) / "report.html"
        with tmp.open("x", encoding="utf-8", newline="\n") as f:
            for part in re.split("(" + "|".join(map(re.escape, slots)) + ")", template):
                f.writelines(values.get(part, (part,)))
        if output.is_file():
            tmp.chmod(output.stat().st_mode & 0o777)
        os.replace(tmp, output)
    return output
