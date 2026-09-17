#!/usr/bin/env python3
"""Installs (or re-installs) the Pulse home screen into index.html.

index.html is a generated single file whose generator no longer exists, so Pulse lives here as
three source files (pulse.css / pulse.html / pulse.js) and this script splices them in between
marker comments. Safe to run again after editing any of them:  python scripts/pulse/patch_pulse.py
"""
import re, sys, pathlib

here = pathlib.Path(__file__).resolve().parent
root = here.parent.parent
index = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else root / "index.html"
s = index.read_text(encoding="utf8")
css, html, js = [(here / n).read_text(encoding="utf8").rstrip("\n") for n in ("pulse.css", "pulse.html", "pulse.js")]

def block(kind, body, open_, close):
    return f"{open_} PULSE:{kind}:START {close}\n{body}\n{open_} PULSE:{kind}:END {close}"

def splice(s, kind, body, open_, close, anchor, before=True):
    start, end = f"{open_} PULSE:{kind}:START {close}", f"{open_} PULSE:{kind}:END {close}"
    new = block(kind, body, open_, close)
    if start in s:
        return s[: s.index(start)] + new + s[s.index(end) + len(end):]
    i = s.rindex(anchor) if kind != "HTML" else s.index(anchor)
    return s[:i] + new + "\n" + s[i:] if before else s[: i + len(anchor)] + "\n" + new + s[i + len(anchor):]

# 1. styles: last thing in the <style> block so they win over the Desk theme
s = splice(s, "CSS", css, "/*", "*/", "</style>")
# 2. the panel: first panel inside <main>
s = splice(s, "HTML", html, "<!--", "-->", "  <!-- ================= TODAY ================= -->")
# 3. the script: its own <script>, last thing in <body>
s = splice(s, "JS", "<script>\n" + js + "\n</script>", "<!--", "-->", "</body>")

# 4. the tab button (first), Pulse selected and Desk hidden at load, and switchTab knows about it
TAB = ('<button class="tab" role="tab" aria-selected="true" data-tab="pulse"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
       'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11.2 12 4l8 7.2V19a1.5 1.5 0 0 1-1.5 1.5H15v-5.2a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5.2H5.5A1.5 1.5 0 0 1 4 19z"/></svg>PULSE</button>')
if 'data-tab="pulse"' not in s:
    nav = '<nav class="tabs" role="tablist" aria-label="Terminal sections">'
    assert s.count(nav) == 1
    s = s.replace(nav, nav + TAB)
    desk_btn = '<button class="tab" role="tab" aria-selected="true" data-tab="desk">'
    assert s.count(desk_btn) == 1
    s = s.replace(desk_btn, desk_btn.replace('aria-selected="true"', 'aria-selected="false"'))
    desk_panel = '<section id="p-desk" role="tabpanel">'
    assert s.count(desk_panel) == 1
    s = s.replace(desk_panel, '<section id="p-desk" role="tabpanel" hidden>')
old_list = '["desk", "lists", "dash", "committee", "calibration", "book", "method"].forEach(function (t) {'
if old_list in s:
    s = s.replace(old_list, '["pulse", "desk", "lists", "dash", "committee", "calibration", "book", "method"].forEach(function (t) {')
assert '["pulse", "desk"' in s, "switchTab list not patched"

index.write_text(s, encoding="utf8")
print(f"patched {index} ({len(s):,} bytes)")
