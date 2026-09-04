// Altovix — home-screen widget for Scriptable (iOS)
// Generated __GENERATED__ from the two committee plans. No network, no login:
// the plan data and the Altovix Capital logo are embedded below. Tapping the
// widget opens the live terminal.
//
// Install: App Store → "Scriptable" (free) → share this file to Scriptable → Add to My Scripts.
// Then long-press the home screen → + → Scriptable → pick a size → Add → long-press the
// widget → Edit Widget → Script: altovix-widget.
//
// Lock Screen (iOS 16+): add a Scriptable widget on the Lock Screen and pick this script.
// The circular one shows just the Altovix mark, like an app glyph; the rectangular one adds
// the regime and today's count; the inline one is a single line by the clock.
//
// Home Screen Parameter (Edit Widget → Parameter), space-separated, any order:
//   paper  white background, the logo exactly as drawn (default)
//   navy   reversed: white logo on Altovix navy
//   logo   just the logo, centred — a brand tile that opens the terminal
//   app    tapping opens the native Altovix app (altovix://today) instead of the web page
// (or change DEFAULT_THEME below).

const DEFAULT_THEME = "paper";

const DATA = __DATA__;

// ---------- brand (Altovix Capital mark + wordmark, PNG, transparent) ----------
const LOGO = {
  paper: { mark: "__MARK_ALPHA__", word: "__WORD_ALPHA__" },
  navy:  { mark: "__MARK_WHITE__", word: "__WORD_WHITE__" },
  markSize: [__MARK_W__, __MARK_H__],
  wordSize: [__WORD_W__, __WORD_H__],
};
function png(b64) { return Image.fromData(Data.fromBase64String(b64)); }

// ---------- helpers ----------
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DOWS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
function iso(d) { return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"); }
function parse(s) { const [y,m,d] = s.split("-").map(Number); return new Date(y, m-1, d); }
function shortDate(s) { const d = parse(s); return d.getDate() + " " + MONTHS[d.getMonth()]; }
function daysUntil(s) { return Math.round((parse(s) - parse(iso(new Date()))) / 86400000); }
function addDays(s, n) { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); }

const today = iso(new Date());
const fam = config.widgetFamily || "medium";
const params = String(args.widgetParameter || "").toLowerCase().split(/[\s,]+/).filter(Boolean);
const theme = params.includes("navy") ? "navy" : params.includes("paper") ? "paper" : DEFAULT_THEME;
const logoOnly = params.includes("logo");
const openApp = params.includes("app");        // native shell installed → deep link
const accessory = fam.startsWith("accessory");   // Lock Screen: the system renders it vibrant/monochrome

// Do now: dated tranches whose date has arrived (largest first)
const doNow = [];
for (const it of DATA.items) it.tr.forEach((t, i) => { if (t.date && t.date <= today) doNow.push({ it, t }); });
doNow.sort((a, b) => b.t.pct - a.t.pct);

// Watching: conditional tranches, re-open rules, stops
const watch = [];
for (const it of DATA.items) {
  for (const t of it.tr) if (!t.date && t.cond) watch.push({ s: it.s, w: "add " + t.pct + "% " + t.cond, k: 0 });
  if (it.a === "AVOID" && it.reopen) watch.push({ s: it.s, w: "re-open: " + it.reopen, k: 1 });
  if (it.a !== "AVOID" && it.stop) watch.push({ s: it.s, w: "exit " + it.stop, k: 2 });
}
watch.sort((a, b) => a.k - b.k || a.s.localeCompare(b.s));

// Coming up: next 30 days. Same-day reviews from both lists merge into one line;
// tranche entries are dropped because "Do now" already carries them.
const upcoming = [];
for (const e of DATA.events) {
  if (e.k === "tranche" || e.d < today || e.d > addDays(today, 30)) continue;
  const prev = upcoming.find(u => u.d === e.d && u.k === "review" && e.k === "review");
  if (prev) { prev.syms = prev.syms.concat(e.syms); prev.l = "Review " + prev.syms.join(", "); continue; }
  upcoming.push({ d: e.d, k: e.k, l: e.k === "review" ? "Review " + e.syms.join(", ") : e.l, syms: e.syms.slice() });
}
const dueNow = DATA.claimsDue.filter(c => c.d <= today).reduce((n, c) => n + c.n, 0);
const nextDue = DATA.claimsDue.find(c => c.d > today);

// ---------- palette (from the logo: navy #0D213D on white; slate #86929C) ----------
// Widgets cannot read the system appearance (Device.isUsingDarkAppearance is
// unsupported there), so the theme is a fixed choice: paper or navy.
const PALETTES = {
  paper: { bg: "#FFFFFF", ink: "#0D213D", muted: "#6B7A88", accent: "#1D5F52", gold: "#8A6012", neg: "#A2382C", line: "#DCE2E8" },
  navy:  { bg: "#0D213D", ink: "#F2F5F8", muted: "#9AAABB", accent: "#7FD1BC", gold: "#E2B65A", neg: "#EE9484", line: "#23374F" },
};
const C = {}; for (const k in PALETTES[theme]) C[k] = new Color(PALETTES[theme][k]);
const mono = (s) => Font.regularMonospacedSystemFont(s);
const bold = (s) => Font.boldSystemFont(s);
const reg = (s) => Font.systemFont(s);

const w = new ListWidget();
if (!accessory) w.backgroundColor = C.bg;
w.url = openApp ? "altovix://today" : DATA.url;
w.setPadding(10, 14, 8, 14);
const gap = fam === "medium" ? { sec: 4, after: 1, row: 1 } : { sec: 6, after: 2, row: 2 };
const tmr = parse(today); tmr.setDate(tmr.getDate() + 1); tmr.setHours(0, 5);
w.refreshAfterDate = tmr;

const white = Color.white();
function centred(img, wpt, hpt) {
  // an image centred in its own row
  const s = w.addStack(); s.centerAlignContent(); s.addSpacer();
  const i = s.addImage(img); i.imageSize = new Size(wpt, hpt); i.centerAlignImage();
  s.addSpacer();
  return i;
}
const markW = (hpt) => Math.round(hpt * LOGO.markSize[0] / LOGO.markSize[1]);
const wordW = (hpt) => Math.round(hpt * LOGO.wordSize[0] / LOGO.wordSize[1]);
const todo = doNow.length ? doNow.length + " to do" : "nothing due";
const grade = dueNow ? dueNow + " to grade" : nextDue ? "grade " + nextDue.n + " on " + shortDate(nextDue.d) : "";

if (fam === "accessoryCircular") {
  // Lock Screen glyph: just the mark on the standard circular background.
  w.addAccessoryWidgetBackground = true;
  w.setPadding(0, 0, 0, 0);
  w.addSpacer();
  centred(png(LOGO.navy.mark), markW(40), 40);
  w.addSpacer();
} else if (fam === "accessoryRectangular") {
  // Lock Screen rectangle (~160×72pt): mark, then wordmark / regime / today.
  w.setPadding(2, 2, 2, 2);
  const h = w.addStack(); h.centerAlignContent();
  const m = h.addImage(png(LOGO.navy.mark)); m.imageSize = new Size(markW(38), 38);
  h.addSpacer(8);
  const col = h.addStack(); col.layoutVertically();
  const wm = col.addImage(png(LOGO.navy.word)); wm.imageSize = new Size(wordW(8), 8);
  col.addSpacer(3);
  const l1 = col.addText(DATA.regime.label + " · " + Math.round(DATA.regime.conf * 100) + "%"); l1.font = bold(12); l1.textColor = white; l1.lineLimit = 1;
  col.addSpacer(1);
  const l2 = col.addText(todo + (grade ? " · " + grade : "")); l2.font = reg(11); l2.textColor = white; l2.lineLimit = 1;
  h.addSpacer();
} else if (fam === "accessoryInline") {
  // one line beside the clock
  w.setPadding(0, 0, 0, 0);
  const i = w.addImage(png(LOGO.navy.mark)); i.imageSize = new Size(markW(14), 14);
  const t = w.addText("Altovix · " + todo + " · " + DATA.regime.label + " " + Math.round(DATA.regime.conf * 100) + "%"); t.textColor = white;
} else if (logoOnly) {
  // Home Screen brand tile: the stacked lockup, centred; tapping opens the terminal.
  const mh = fam === "small" ? 56 : fam === "large" ? 96 : 64;
  const wh = fam === "small" ? 11 : fam === "large" ? 18 : 13;
  w.addSpacer();
  centred(png(LOGO[theme].mark), markW(mh), mh);
  w.addSpacer(fam === "small" ? 8 : 12);
  centred(png(LOGO[theme].word), wordW(wh), wh);
  w.addSpacer();
} else {
  // header: mark + wordmark on the left, date on the right
  const hd = w.addStack(); hd.centerAlignContent();
  const markPt = fam === "small" ? 18 : fam === "large" ? 26 : 22;   // mark height in points
  const wordPt = fam === "small" ? 7 : fam === "large" ? 11 : 9;     // wordmark cap height in points
  const mk = hd.addImage(png(LOGO[theme].mark));
  mk.imageSize = new Size(Math.round(markPt * LOGO.markSize[0] / LOGO.markSize[1]), markPt);
  hd.addSpacer(fam === "small" ? 6 : 8);
  const wm = hd.addImage(png(LOGO[theme].word));
  wm.imageSize = new Size(Math.round(wordPt * LOGO.wordSize[0] / LOGO.wordSize[1]), wordPt);
  hd.addSpacer();
  if (fam !== "small") { const dt = hd.addText(DOWS[parse(today).getDay()] + " " + shortDate(today)); dt.font = reg(11); dt.textColor = C.muted; }
  w.addSpacer(3);
  // regime line; on medium/large it also carries the grading date so no footer is needed
  const grading = dueNow ? dueNow + " claims to grade" : nextDue ? "grade " + nextDue.n + " claims " + shortDate(nextDue.d) : "";
  const rg = w.addText("REGIME " + DATA.regime.label + " · " + Math.round(DATA.regime.conf * 100) + "%" + (fam !== "small" && grading ? "  ·  " + grading : ""));
  rg.font = mono(fam === "small" ? 9 : 10); rg.textColor = dueNow ? C.gold : C.accent; rg.lineLimit = 1;

  function section(title) {
    w.addSpacer(gap.sec);
    const t = w.addText(title.toUpperCase()); t.font = bold(9); t.textColor = C.muted;
    w.addSpacer(gap.after);
  }
  function row(left, right, opts) {
    opts = opts || {};
    const st = w.addStack(); st.centerAlignContent();
    const a = st.addText(left); a.font = opts.mono ? mono(11) : bold(11); a.textColor = opts.color || C.ink; a.lineLimit = 1;
    if (opts.mid) { st.addSpacer(6); const m = st.addText(opts.mid); m.font = reg(11); m.textColor = C.muted; m.lineLimit = 1; }
    st.addSpacer();
    if (right !== undefined) { const b = st.addText(right); b.font = mono(11); b.textColor = opts.rightColor || C.ink; }
    w.addSpacer(gap.row);
  }

  if (fam === "small") {
    section(doNow.length ? "Do now" : "Next up");
    if (doNow.length) {
      for (const d of doNow.slice(0, 4)) row(d.it.a + " " + d.it.s, d.t.pct + "%");
      if (doNow.length > 4) { const m = w.addText("+" + (doNow.length - 4) + " more"); m.font = reg(10); m.textColor = C.muted; }
    } else if (upcoming.length) {
      const e = upcoming[0];
      const t = w.addText(shortDate(e.d) + " · " + e.l); t.font = reg(11); t.textColor = C.ink; t.lineLimit = 4;
    }
    w.addSpacer();
    if (nextDue) { const n = w.addText("Grade " + nextDue.n + " claims " + shortDate(nextDue.d)); n.font = mono(9); n.textColor = C.gold; }
  } else if (fam === "medium") {
    // 155pt tall on most phones: header, regime, three actions, the next event.
    section("Do now" + (doNow.length ? " · " + Math.min(3, doNow.length) + " of " + doNow.length : ""));
    if (doNow.length) {
      for (const d of doNow.slice(0, 3)) row(d.it.a + " " + d.it.s, d.t.pct + "%", { mid: d.it.list + (d.t.cond ? " · " + d.t.cond : "") });
    } else {
      const m = w.addText("Nothing due today."); m.font = reg(11); m.textColor = C.muted;
    }
    section("Coming up");
    for (const e of upcoming.slice(0, 1)) {
      const days = daysUntil(e.d);
      row(shortDate(e.d), days === 0 ? "today" : "in " + days + "d", { mid: e.l, mono: true, color: e.k === "calibration" ? C.gold : C.ink, rightColor: C.muted });
    }
    w.addSpacer();
  } else {
    // large (345pt): six actions, four watch rules, four upcoming dates.
    section("Do now" + (doNow.length ? " · " + doNow.length : ""));
    if (doNow.length) {
      for (const d of doNow.slice(0, 6)) row(d.it.a + " " + d.it.s, d.t.pct + "%", { mid: d.it.list + (d.t.cond ? " · " + d.t.cond : "") });
      if (doNow.length > 6) { const m = w.addText("+" + (doNow.length - 6) + " more in the terminal"); m.font = reg(10); m.textColor = C.muted; }
    } else {
      const m = w.addText("Nothing due today."); m.font = reg(11); m.textColor = C.muted;
    }
    section("Watching");
    for (const x of watch.filter(x => x.k < 2).slice(0, 4)) row(x.s, undefined, { mid: x.w, mono: true });
    section("Coming up");
    for (const e of upcoming.slice(0, 4)) {
      const days = daysUntil(e.d);
      row(shortDate(e.d), days === 0 ? "today" : "in " + days + "d", { mid: e.l, mono: true, color: e.k === "calibration" ? C.gold : C.ink, rightColor: C.muted });
    }
    w.addSpacer();
    const ft = w.addText("Tap to open the terminal"); ft.font = reg(9); ft.textColor = C.muted;
  }
}

if (config.runsInWidget) Script.setWidget(w);
else if (fam === "small") await w.presentSmall();
else if (fam === "large") await w.presentLarge();
else if (fam === "accessoryCircular") await w.presentAccessoryCircular();
else if (fam === "accessoryRectangular") await w.presentAccessoryRectangular();
else if (fam === "accessoryInline") await w.presentAccessoryInline();
else await w.presentMedium();
Script.complete();
