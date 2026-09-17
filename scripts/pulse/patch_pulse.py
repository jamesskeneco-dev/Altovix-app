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

# 4. the tab bar: Home, Needs you, Search, Agents first; the old Desk button becomes "More" on phones and the
#    other old tabs hide behind it (pz-legacy-tab). Pulse is selected and Desk hidden at load.
def tab(name, label, path, extra=""):
    return (f'<button class="tab" role="tab" aria-selected="{"true" if name == "pulse" else "false"}" data-tab="{name}">'
            f'<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" '
            f'stroke-linejoin="round" aria-hidden="true">{path}</svg>{label}{extra}</button>')
NAV = ("<!--PZNAV-->"
       + tab("pulse", "HOME", '<path d="M4 11.2 12 4l8 7.2V19a1.5 1.5 0 0 1-1.5 1.5H15v-5.2a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5.2H5.5A1.5 1.5 0 0 1 4 19z"/>')
       + tab("needs", "NEEDS YOU", '<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9z"/><path d="M10 19a2 2 0 0 0 4 0"/>', ' <span class="pz-count" id="pz-needs-count"></span>')
       + tab("picks", "SEARCH", '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>')
       + tab("agents", "AGENTS", '<circle cx="9" cy="8.5" r="3.2"/><path d="M3 19.5c.6-3.2 3-5 6-5s5.4 1.800 6 5"/><circle cx="17.5" cy="9.500" r="2.500"/><path d="M17 14.600c2.200.200 3.600 1.700 4 4.400"/>')
       + "<!--/PZNAV-->")
NAV = NAV.replace("1.800", "1.8").replace("9.500", "9.5").replace("2.500", "2.5").replace("14.600", "14.6").replace(".200 3.600 1.700", ".2 3.6 1.7")
if "<!--PZNAV-->" in s:
    s = s[: s.index("<!--PZNAV-->")] + NAV + s[s.index("<!--/PZNAV-->") + len("<!--/PZNAV-->"):]
else:
    nav = '<nav class="tabs" role="tablist" aria-label="Terminal sections">'
    assert s.count(nav) == 1
    s = s.replace(nav, nav + NAV)
    desk_btn = '<button class="tab" role="tab" aria-selected="true" data-tab="desk">'
    assert s.count(desk_btn) == 1
    s = s.replace(desk_btn, desk_btn.replace('aria-selected="true"', 'aria-selected="false"'))
    desk_panel = '<section id="p-desk" role="tabpanel">'
    assert s.count(desk_panel) == 1
    s = s.replace(desk_panel, '<section id="p-desk" role="tabpanel" hidden>')
for name in ("lists", "committee", "calibration", "book"):
    s = re.sub(r'<button class="tab( desk-only)?" role="tab" aria-selected="false" data-tab="%s">' % name,
               lambda m: '<button class="tab%s pz-legacy-tab" role="tab" aria-selected="false" data-tab="%s">' % (m.group(1) or "", name), s)
s = re.sub(r'\[(?:"pulse", )?(?:"needs", "picks", "agents", )?"desk", "lists", "dash", "committee", "calibration", "book", "method"\]\.forEach\(function \(t\) \{',
           '["pulse", "needs", "picks", "agents", "desk", "lists", "dash", "committee", "calibration", "book", "method"].forEach(function (t) {', s)
assert '["pulse", "needs", "picks", "agents", "desk"' in s, "switchTab list not patched"

index.write_text(s, encoding="utf8")
print(f"patched {index} ({len(s):,} bytes)")
