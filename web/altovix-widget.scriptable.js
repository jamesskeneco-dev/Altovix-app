// Altovix — home-screen widget for Scriptable (iOS)
// Generated 2026-09-04 from the two committee plans. No network, no login:
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

const DATA = {"generated":"2026-09-04","url":"https://jamesskeneco-dev.github.io/Altovix-app/","regime":{"label":"NEUTRAL","conf":0.58},"claimsDue":[{"d":"2026-09-18","n":2},{"d":"2026-10-03","n":60},{"d":"2026-11-02","n":83},{"d":"2026-12-01","n":48}],"items":[{"s":"JPM","a":"BUY","list":"Blue chips","size":9,"conf":0.57,"stop":"close < $349, or HYG closes below its 21-day low","reopen":null,"tr":[{"pct":5,"date":"2026-09-04","label":"Tranche 1","cond":null},{"pct":4,"date":"2026-09-17","label":"After FOMC","cond":null}]},{"s":"MSFT","a":"BUY","list":"Blue chips","size":6,"conf":0.55,"stop":"close < $480","reopen":null,"tr":[{"pct":3,"date":"2026-09-04","label":"Tranche 1","cond":null},{"pct":3,"date":"2026-09-17","label":"After FOMC","cond":"or on a pullback toward $495, whichever comes first"}]},{"s":"XOM","a":"BUY","list":"Blue chips","size":5,"conf":0.54,"stop":"close < $152.50, or WTI closes below $80","reopen":null,"tr":[{"pct":5,"date":"2026-09-04","label":"Full size","cond":null}]},{"s":"NVDA","a":"BUY","list":"Blue chips","size":3,"conf":0.54,"stop":"close < $209","reopen":null,"tr":[{"pct":1.5,"date":"2026-09-04","label":"Tranche 1","cond":null},{"pct":1.5,"date":"2026-09-17","label":"After FOMC","cond":"or on a close above $230.47 with volume > 1.2x average"}]},{"s":"GOOGL","a":"BUY","list":"Blue chips","size":4,"conf":0.52,"stop":"6% below entry (about $322)","reopen":null,"tr":[{"pct":2,"date":"2026-09-04","label":"Tranche 1","cond":null},{"pct":2,"date":null,"label":"Second half","cond":"only on a daily close above the 50-day at $348.67"}]},{"s":"META","a":"BUY","list":"Blue chips","size":4,"conf":0.53,"stop":"close < $570","reopen":null,"tr":[{"pct":2,"date":null,"label":"First half","cond":"on a pullback to about $590, or a close back above $600 after one"},{"pct":2,"date":null,"label":"Second half","cond":"only after ten sessions holding above $594"}]},{"s":"AMZN","a":"AVOID","list":"Blue chips","size":0,"conf":0.55,"stop":null,"reopen":"a close above $272 with volume > 1.2x average, or after late-October earnings","tr":[]},{"s":"LLY","a":"AVOID","list":"Blue chips","size":0,"conf":0.52,"stop":null,"reopen":"a close above $1,191 (50-day) with volume > 1.2x average","tr":[]},{"s":"COST","a":"AVOID","list":"Blue chips","size":0,"conf":0.57,"stop":null,"reopen":"after the Sep 24 print - a held gap-up, or a close above $944 on volume","tr":[]},{"s":"CAT","a":"AVOID","list":"Blue chips","size":0,"conf":0.55,"stop":null,"reopen":"two consecutive closes above $842, or after October earnings","tr":[]},{"s":"NPK","a":"BUY","list":"Defense","size":4,"conf":0.57,"stop":"close < $133.59 (50-day)","reopen":null,"tr":[{"pct":2,"date":"2026-09-04","label":"Tranche 1","cond":"limit orders only - 90K shares a day"},{"pct":2,"date":"2026-09-17","label":"After FOMC","cond":"limit orders only"}]},{"s":"HII","a":"BUY","list":"Defense","size":6,"conf":0.55,"stop":"close < $278 (pre-gap level)","reopen":null,"tr":[{"pct":3,"date":"2026-09-04","label":"Tranche 1","cond":null},{"pct":3,"date":"2026-09-17","label":"After FOMC","cond":"or on a close back above the 50-day at $297.17, whichever first"}]},{"s":"RGR","a":"BUY","list":"Defense","size":6,"conf":0.54,"stop":"close < $35.50 (under the two-month box)","reopen":null,"tr":[{"pct":3,"date":"2026-09-04","label":"Tranche 1","cond":null},{"pct":3,"date":"2026-09-17","label":"After FOMC","cond":null}]},{"s":"BWXT","a":"BUY","list":"Defense","size":3.5,"conf":0.54,"stop":"close < $147","reopen":null,"tr":[{"pct":2,"date":"2026-09-04","label":"On the double bottom","cond":null},{"pct":1.5,"date":null,"label":"After investor day","cond":"only if it closes above $172.07 within three sessions of Sep 29"}]},{"s":"CDRE","a":"BUY","list":"Defense","size":3,"conf":0.53,"stop":"close < $27.36","reopen":null,"tr":[{"pct":1.5,"date":"2026-09-04","label":"Tranche 1","cond":null},{"pct":1.5,"date":null,"label":"Second half","cond":"only on a close above the 50-day at $30.84"}]},{"s":"KTOS","a":"BUY","list":"Defense","size":2.5,"conf":0.51,"stop":"close < $43.09 (52-week low)","reopen":null,"tr":[{"pct":2.5,"date":null,"label":"Conditional entry","cond":"only on a daily close above the 50-day at $52.30; review if untriggered in 15 sessions"}]},{"s":"RCAT","a":"BUY","list":"Defense","size":1,"conf":0.5,"stop":"close < $7.35","reopen":null,"tr":[{"pct":1,"date":"2026-09-04","label":"Full 1% - never added to","cond":null}]},{"s":"AVAV","a":"AVOID","list":"Defense","size":0,"conf":0.5,"stop":null,"reopen":"after the Sep 9 print, on a daily close above the 50-day at $158.80; a post-print close below $140.62 closes the file","tr":[]},{"s":"KRMN","a":"AVOID","list":"Defense","size":0,"conf":0.5,"stop":null,"reopen":"after Sep 14, on the first higher low above $39.75; any CFO-related disclosure closes the file","tr":[]},{"s":"MRCY","a":"AVOID","list":"Defense","size":0,"conf":0.55,"stop":null,"reopen":"a close above $92 with volume > 1.2x average - the first higher high since the print","tr":[]}],"events":[{"d":"2026-09-04","k":"event","l":"August jobs report, 8:30 ET - tranche 1 after the print","syms":[],"list":"Blue chips"},{"d":"2026-09-04","k":"tranche","l":"Tranche 1: NPK 2% (limit), HII 3%, RGR 3%, BWXT 2%, CDRE 1.5%, RCAT 1%","syms":["NPK","HII","RGR","BWXT","CDRE","RCAT"],"list":"Defense"},{"d":"2026-09-09","k":"event","l":"AeroVironment earnings - not held; watch for a close above $158.80 or below $140.62","syms":["AVAV"],"list":"Defense"},{"d":"2026-09-10","k":"event","l":"August CPI (approx.) - regime flips RISK_OFF if core is 0.4% m/m or higher","syms":[],"list":"Blue chips"},{"d":"2026-09-14","k":"event","l":"Karman CFO handover - if clean, start watching for the first higher low above $39.75","syms":["KRMN"],"list":"Defense"},{"d":"2026-09-16","k":"event","l":"FOMC decision (assumed Sep 15-16 meeting - confirm). Second tranches the day after.","syms":["JPM","MSFT","NVDA"],"list":"Blue chips"},{"d":"2026-09-18","k":"review","l":"First review","syms":["JPM","MSFT","XOM","NVDA","META"],"list":"Blue chips"},{"d":"2026-09-18","k":"review","l":"Review","syms":["NPK","HII","BWXT"],"list":"Defense"},{"d":"2026-09-24","k":"event","l":"Costco earnings - not held; watch the reaction for three sessions","syms":["COST"],"list":"Blue chips"},{"d":"2026-09-25","k":"review","l":"Second review","syms":["GOOGL","COST"],"list":"Blue chips"},{"d":"2026-09-25","k":"review","l":"Review - did KTOS's 50-day trigger fire?","syms":["RGR","CDRE","KTOS"],"list":"Defense"},{"d":"2026-09-29","k":"event","l":"BWXT investor day - second tranche only on a close above $172.07 within three sessions","syms":["BWXT"],"list":"Defense"},{"d":"2026-10-01","k":"event","l":"FY2027 begins under a continuing resolution - new-start names (KTOS, AVAV, RCAT) feel this first","syms":["KTOS","AVAV","RCAT"],"list":"Defense"},{"d":"2026-10-02","k":"review","l":"Review","syms":["LLY"],"list":"Blue chips"},{"d":"2026-10-02","k":"review","l":"Review","syms":["RCAT","MRCY"],"list":"Defense"},{"d":"2026-10-03","k":"calibration","l":"Calibration day - the 21-day claims come due. Grade them.","syms":[],"list":"Blue chips"},{"d":"2026-10-13","k":"event","l":"JPMorgan earnings","syms":["JPM"],"list":"Blue chips"},{"d":"2026-10-16","k":"review","l":"Review","syms":["CAT"],"list":"Blue chips"},{"d":"2026-10-30","k":"review","l":"Review after late-October earnings","syms":["AMZN"],"list":"Blue chips"}]};

// ---------- brand (Altovix Capital mark + wordmark, PNG, transparent) ----------
const LOGO = {
  paper: { mark: "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", word: "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" },
  navy:  { mark: "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", word: "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" },
  markSize: [168, 158],
  wordSize: [600, 75],
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
