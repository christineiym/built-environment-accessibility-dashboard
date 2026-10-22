#!/usr/bin/env python3
"""Rebuild reports/index.html from the .html reports in this directory.

Each report is listed with its <title> (or an override below) and the date it
was first committed to git; reports not yet committed use their file mtime.

Usage: python3 reports/build_index.py
"""
import html
import re
import subprocess
from datetime import datetime
from pathlib import Path

REPORTS_DIR = Path(__file__).resolve().parent
BASE_URL = "https://christineiym.com/built-environment-accessibility-dashboard/reports/"

# Pinned above the table rather than listed in it.
PINNED = {"change_vs_mapcompletion_rules.html": "How grading works"}

# Labels for the index where the report's own <title> is too terse.
TITLE_OVERRIDES = {
    "edgecases_round1_cnn.html": "Multi-city map-completion &amp; change detection on reviewed tiles",
    "mapcompletion_gpt56_vs_cnn.html": "Toppenish (&amp; Anacortes) map completion &mdash; gpt-5.6 vs the CNN",
    "line_overlap_changes.html": "Line overlap grading of multi-city changes",
    "line_overlap_mapcompletion.html": "Line overlap grading of multi-city map completion &mdash; gpt-5.6",
}

TITLE_RE = re.compile(r"<title>(.*?)</title>", re.IGNORECASE | re.DOTALL)


def report_title(path):
    if path.name in TITLE_OVERRIDES:
        return TITLE_OVERRIDES[path.name]
    with path.open(encoding="utf-8", errors="replace") as f:
        match = TITLE_RE.search(f.read(64 * 1024))
    # Titles are already HTML-escaped in the source, so keep them verbatim.
    return " ".join(match.group(1).split()) if match else html.escape(path.stem)


def added_date(path):
    out = subprocess.run(
        ["git", "log", "--diff-filter=A", "--format=%at", "--", path.name],
        cwd=REPORTS_DIR, capture_output=True, text=True,
    ).stdout.split()
    timestamp = int(out[-1]) if out else path.stat().st_mtime
    return datetime.fromtimestamp(timestamp)


def main():
    reports = sorted(
        (p for p in REPORTS_DIR.glob("*.html") if p.name != "index.html" and p.name not in PINNED),
        key=lambda p: (added_date(p), p.name),
    )
    pinned = "\n".join(
        f'<p><a href="{BASE_URL}{name}">{label}</a></p>'
        for name, label in PINNED.items() if (REPORTS_DIR / name).exists()
    )
    rows = "\n".join(
        f'    <tr><td><a href="{BASE_URL}{p.name}">{report_title(p)}</a></td>'
        f'<td class="added">{added_date(p):%Y-%m-%d %H:%M}</td></tr>'
        for p in reports
    )
    (REPORTS_DIR / "index.html").write_text(f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reports</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 52rem; margin: 2.5rem auto; padding: 0 1rem; }}
  h1 {{ font-size: 1.4rem; margin-bottom: 1rem; }}
  table {{ width: 100%; border-collapse: collapse; }}
  th, td {{ text-align: left; padding: .5rem .75rem; border-bottom: 1px solid color-mix(in srgb, currentColor 18%, transparent); }}
  th {{ font-weight: 600; }}
  td.added {{ white-space: nowrap; font-variant-numeric: tabular-nums; opacity: .75; }}
  a {{ color: #2a78d6; }}
</style>
</head>
<body>
<h1>Reports</h1>
{pinned}
<table>
  <thead>
    <tr><th>Report</th><th>Added</th></tr>
  </thead>
  <tbody>
{rows}
  </tbody>
</table>
</body>
</html>
""", encoding="utf-8")
    print(f"Wrote index.html with {len(reports)} reports")


if __name__ == "__main__":
    main()
