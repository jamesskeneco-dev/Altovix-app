#!/usr/bin/env python3
"""Speed patches for index.html (the generated single file whose generator is gone).

Idempotent, like patch_pulse.py — run it again after any change:  python scripts/pulse/patch_fast.py

What it does:
  1. Moves the shipped committee data (the 550 KB #altovix-seed JSON) out of the page into ./seed.json.
     The page keeps only a SEED_VERSION; mergeSeed() fetches seed.json once per device per version.
  2. Draws the old Desk/Lists/Committee/Grades/Book screens lazily (idle time, or first tap), so the
     phone screens paint first.
  3. Makes the Google Fonts stylesheet non-blocking (the phone screens use the system font anyway).
  4. Adds preconnects for the status feed and the logo CDN.
  5. Adds the "new version ready" pill that sw.js triggers after it fetched a newer page in the background.
  6. localSave() tells the phone screens when the store changed (they cache their parsed copy).
"""
import json, re, sys, pathlib

here = pathlib.Path(__file__).resolve().parent
root = here.parent.parent
index = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else root / "index.html"
seed_path = index.parent / "seed.json"
s = index.read_text(encoding="utf8")
changed = []

def once(marker, fn):
    global s
    if marker in s:
        return
    s2 = fn(s)
    assert s2 != s, "patch produced no change: " + marker
    assert marker in s2, "marker missing after patch: " + marker
    s = s2
    changed.append(marker)

# ---- 1. the seed leaves the page -------------------------------------------------------------
m = re.search(r'<script type="application/json" id="altovix-seed">(.*?)</script>\n?', s, re.S)
if m:
    seed = json.loads(m.group(1))
    version = str(seed.get("generated") or seed.get("version") or "1")
    seed_path.write_text(json.dumps(seed, separators=(",", ":"), ensure_ascii=False), encoding="utf8")
    s = s[: m.start()] + s[m.end():]
    changed.append("seed.json written (%s bytes, version %s)" % (f"{seed_path.stat().st_size:,}", version))
else:
    mv = re.search(r'var SEED_VERSION = "([^"]+)"', s)
    version = mv.group(1) if mv else "1"

def patch_merge(s):
    a = s.index("  function mergeSeed() {")
    b = s.index("  /* ============================ model: bring your own key", a)
    new = '''  /* FAST:seed — the shipped data lives in ./seed.json (fetched once per device per version), not in the page */
  var SEED_VERSION = "%s";
  function applySeed(seed) {
    var added = 0, have = {};
    state.runs.forEach(function (r) { have[r.id] = 1; });
    (seed.runs || []).forEach(function (r) { if (!have[r.id]) { state.runs.push(r); added++; } });
    have = {};
    state.claims.forEach(function (c) { have[c.id] = 1; });
    (seed.claims || []).forEach(function (c) { if (!have[c.id]) { state.claims.push(c); added++; } });
    (seed.plans || []).forEach(function (p) {
      var at = -1;
      state.plans.forEach(function (x, i) { if (x.id === p.id) at = i; });
      if (at < 0) { state.plans.push(p); added++; }
      else if ((p.version || 0) > (state.plans[at].version || 0)) { state.plans[at] = p; added++; }
    });
    // shipped Book entries (the paper book) and marks: added once, never re-applied
    have = {};
    state.trades.forEach(function (t) { have[t.id] = 1; });
    (seed.trades || []).forEach(function (t) { if (!have[t.id]) { state.trades.push(t); added++; } });
    Object.keys(seed.marks || {}).forEach(function (s) { if (state.marks[s] == null) { state.marks[s] = seed.marks[s]; added++; } });
    state.trades.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    state.runs.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    state.claims.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    state.plans.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    if (added) localSave();
    return added;
  }
  // On each launch anything new in the shipped set is added; nothing already on the device is ever
  // overwritten. The fetch only happens when the device has nothing yet or the shipped version changed.
  function mergeSeed(done) {
    var el = document.getElementById("altovix-seed"), added = 0;
    if (el) { try { added = applySeed(JSON.parse(el.textContent)); } catch (e) {} if (done) done(added); return added; }
    var have = null;
    try { have = localStorage.getItem("altovix.seedv"); } catch (e) {}
    if (have === SEED_VERSION && state.runs.length) { if (done) done(0); return 0; }
    fetch("./seed.json?v=" + encodeURIComponent(SEED_VERSION))
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (seed) {
        added = applySeed(seed);
        try { localStorage.setItem("altovix.seedv", SEED_VERSION); } catch (e) {}
        if (added) renderAll();
        if (done) done(added);
      })
      .catch(function () { if (done) done(0); });
    return 0;
  }

''' % version
    return s[:a] + new + s[b:]
once("FAST:seed", patch_merge)

# the two callers that expect the merge to have happened before they speak
once("FAST:reset", lambda s: s.replace(
    '''    mergeSeed(); localSave(); renderAll();
    $("s-bstatus").textContent = "Reset. " + state.runs.length + " runs and " + state.claims.length + " claims restored from the shipped data.";''',
    '''    localSave(); renderAll(); /* FAST:reset */
    $("s-bstatus").textContent = "Reset. Fetching the shipped runs, claims and plans…";
    mergeSeed(function () { localSave(); renderAll(); $("s-bstatus").textContent = "Reset. " + state.runs.length + " runs and " + state.claims.length + " claims restored from the shipped data."; });'''))
once("FAST:restore", lambda s: s.replace(
    '''    localSave();
    mergeSeed();
    renderAll();
  }''',
    '''    localSave();
    renderAll(); /* FAST:restore */
    mergeSeed(function (n) { if (n) renderAll(); });
  }'''))

# ---- 2. the old screens draw lazily ----------------------------------------------------------
once("FAST:legacy", lambda s: s.replace(
    '''  function renderAll() {
    renderToday(); renderLists(); renderDash(); renderCommitteeList(); renderCalibration(); renderBook(); renderDesk();
  }''',
    '''  /* FAST:legacy — the Desk-era screens are drawn in idle time or on the first tap, not before the phone screens */
  var legacyReady = false;
  function renderAll() {
    legacyReady = true;
    renderToday(); renderLists(); renderDash(); renderCommitteeList(); renderCalibration(); renderBook(); renderDesk();
  }
  function ensureLegacy() { if (!legacyReady) renderAll(); }
  function scheduleLegacy() { (window.requestIdleCallback || function (f) { setTimeout(f, 300); })(ensureLegacy); }
  var LEGACY_TABS = ["desk", "lists", "dash", "committee", "calibration", "book", "method"];'''))
once("FAST:switch", lambda s: s.replace(
    '''  function switchTab(name) {
''',
    '''  function switchTab(name) {
    if (LEGACY_TABS.indexOf(name) !== -1) ensureLegacy(); /* FAST:switch */
'''))
once("FAST:connect", lambda s: s.replace(
    '''    refreshRunButton();
    renderBanner();
    renderAll();
  }''',
    '''    refreshRunButton();
    renderBanner();
    if (legacyReady) renderAll(); /* FAST:connect */
  }'''))
once("FAST:init", lambda s: s.replace(
    '''  renderMethod();
  renderBanner();
  renderAll();
  $("foot").innerHTML =''',
    '''  renderMethod();
  renderBanner();
  scheduleLegacy(); /* FAST:init */
  $("foot").innerHTML ='''))

# ---- 6. the store tells the phone screens when it changed ------------------------------------
once("FAST:save", lambda s: s.replace(
    '''    try { localStorage.setItem("altovix.v1", JSON.stringify({ trades: state.trades, marks: state.marks, runs: state.runs, claims: state.claims, plans: state.plans, done: state.done })); } catch (e) {}
  }''',
    '''    try { localStorage.setItem("altovix.v1", JSON.stringify({ trades: state.trades, marks: state.marks, runs: state.runs, claims: state.claims, plans: state.plans, done: state.done })); } catch (e) {}
    try { document.dispatchEvent(new CustomEvent("altovix:data")); } catch (e) {} /* FAST:save */
  }'''))

# ---- 3 + 4. head: fonts never block, preconnects for the feed and the logos --------------------
def patch_fonts(s):
    m = re.search(r'<link rel="stylesheet" href="(https://fonts\.googleapis\.com/css2\?[^"]+)"\s*>', s)
    assert m, "fonts link not found"
    href = m.group(1)
    new = ('<link rel="stylesheet" href="%s" media="print" onload="this.media=\'all\'"><!-- FAST:fonts: non-blocking; the phone screens use the system font -->\n'
           '<noscript><link rel="stylesheet" href="%s"></noscript>' % (href, href))
    return s[: m.start()] + new + s[m.end():]
once("FAST:fonts", patch_fonts)
once("FAST:preconnect", lambda s: s.replace(
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://raw.githubusercontent.com" crossorigin><!-- FAST:preconnect -->\n'
    '<link rel="preconnect" href="https://cdn.alphavantage.co">\n'
    '<link rel="preconnect" href="https://fonts.googleapis.com">'))

# ---- 5. the "new version ready" pill ---------------------------------------------------------
once("FAST:update", lambda s: s.replace(
    '''  if ("serviceWorker" in navigator && location.protocol === "https:") {
    try { navigator.serviceWorker.register("./sw.js").catch(function () {}); } catch (e) {}
  }''',
    '''  if ("serviceWorker" in navigator && location.protocol === "https:") {
    /* FAST:update — the worker serves the cached page at once and fetches the live one behind it; when that
       differs it says so, and one tap reloads into the new build (the next launch would get it anyway) */
    try {
      navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).catch(function () {});
      navigator.serviceWorker.addEventListener("message", function (e) {
        if (!e.data || e.data.type !== "altovix:update" || document.getElementById("upd-pill")) return;
        var b = document.createElement("button");
        b.id = "upd-pill"; b.type = "button"; b.className = "upd-pill"; b.textContent = "Update ready · tap to reload";
        b.addEventListener("click", function () { location.reload(); });
        document.body.appendChild(b);
      });
      navigator.serviceWorker.ready.then(function () { if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: "altovix:check" }); });
    } catch (e) {}
  }'''))
once("FAST:updcss", lambda s: s.replace(
    "</style>\n</head>",
    ".upd-pill{position:fixed; bottom:calc(env(safe-area-inset-bottom) + 86px); left:50%; transform:translateX(-50%); z-index:400; white-space:nowrap; border:none; background:#5468FF; color:#fff; font:600 13px -apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif; padding:10px 16px; border-radius:99px; box-shadow:0 10px 28px -6px rgba(0,0,0,.6); cursor:pointer; animation:upd-in .3s ease-out} /* FAST:updcss */\n"
    "@keyframes upd-in{from{transform:translate(-50%,14px); opacity:0} to{transform:translateX(-50%); opacity:1}}\n"
    "</style>\n</head>", 1))

# version label
s2 = re.sub(r'var APP_VERSION = "1\.1\.\d+ · 2026-09-04";', 'var APP_VERSION = "1.2.0 · 2026-09-26";', s)
if s2 != s:
    s = s2; changed.append("APP_VERSION 1.2.0")

index.write_text(s, encoding="utf8")
print("patched %s (%s bytes)%s" % (index, f"{len(s.encode('utf8')):,}", (": " + ", ".join(changed)) if changed else " — nothing to do"))
