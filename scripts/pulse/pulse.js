/* ============================ Altovix phone screens ============================
 * Four screens, fed by the status.json the PC market check publishes (branch "status"):
 *   Home      - book value, the Opportunity score, and every holding with its logo and score
 *   Needs you - what fired and what is close to firing (its own page, with a badge on the tab)
 *   Search    - a search box over every pick: holdings, buys, watch levels, sold and avoided names
 *   Agents    - each agent, what it does, and the latest thing it said
 * Tapping a company anywhere opens its own page: price, chart, the plan, the agents' score and
 * notes, your position, the numbers, and its history.
 * Committee runs and claims come from the app's own store (localStorage "altovix.v1", else the
 * seed shipped in the page). Plain ES5 like the rest of the page; no dependencies. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var HOME = $("pulse-root"), NEEDS = $("needs-root"), PICKS = $("picks-root"), AGENTS = $("agents-root"), SHEET = $("pz-sheet");
  if (!HOME || !SHEET) return;
  var NEW_PANELS = ["p-pulse", "p-needs", "p-picks", "p-agents"];
  var CACHE_KEY = "altovix.pulse.v1";
  var DEFAULT_REPO = "jamesskeneco-dev/Altovix-app";
  /* company logos: one square PNG per ticker; a missing one falls back to the monogram underneath */
  var LOGOS = "https://cdn.alphavantage.co/logos/";
  var ui = { chip: "all", pick: "all", q: "", stock: null, range: null, kind: "candle" };
  try { if (localStorage.getItem("altovix.pulse.kind") === "line") ui.kind = "line"; } catch (e) {}
  var last = null, lastFromCache = false;

  /* ---------- page chrome: navy while a new screen shows; old tabs live behind "More" ---------- */
  function syncChrome() {
    var onNew = NEW_PANELS.some(function (id) { var el = $(id); return el && !el.hidden; });
    document.body.classList.toggle("pulse-on", onNew);
    var strip = $("pz-legacy"); if (strip) strip.hidden = onNew;
    var more = document.querySelector('.tab[data-tab="desk"]');
    if (more && !onNew) more.setAttribute("aria-selected", "true");
  }
  try {
    var mo = new MutationObserver(syncChrome);
    Array.prototype.forEach.call(document.querySelectorAll('main [role="tabpanel"]'), function (el) { mo.observe(el, { attributes: true, attributeFilter: ["hidden"] }); });
  } catch (e) {}
  syncChrome();

  /* ---------- data ---------- */
  function repo() {
    var m = /^([^.]+)\.github\.io$/.exec(location.hostname);
    var seg = location.pathname.split("/").filter(Boolean)[0];
    return m && seg ? m[1] + "/" + seg : DEFAULT_REPO;
  }
  function sources() {
    var over = null;
    try { over = localStorage.getItem("altovix.pulse.url"); } catch (e) {}
    if (over) return [over];
    var r = repo();
    return [
      "https://raw.githubusercontent.com/" + r + "/status/status.json?t=" + Date.now(),
      "https://api.github.com/repos/" + r + "/contents/status.json?ref=status&t=" + Date.now(),
      "./status.json?t=" + Date.now() /* the copy that ships with the site: older, but always there */
    ];
  }
  function store() {
    var d = null;
    try { d = JSON.parse(localStorage.getItem("altovix.v1") || "null"); } catch (e) {}
    if (!d || !d.runs || !d.runs.length) { try { d = JSON.parse(($("altovix-seed") || {}).textContent || "null"); } catch (e2) {} }
    return { runs: (d && d.runs) || [], claims: (d && d.claims) || [] };
  }
  function latestRunBySymbol(runs) {
    var out = {};
    runs.forEach(function (r) { if (r.status === "COMPLETE" && (!out[r.symbol] || (r.ts || 0) > (out[r.symbol].ts || 0))) out[r.symbol] = r; });
    return out;
  }

  /* ---------- small helpers ---------- */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function num(v, dp) { return v == null ? "–" : Number(v).toLocaleString("en-US", { minimumFractionDigits: dp == null ? 2 : dp, maximumFractionDigits: dp == null ? 2 : dp }); }
  function pct(v, dp) { return v == null ? "–" : Math.abs(v).toFixed(dp == null ? 2 : dp) + "%"; }
  function change(v, dp) { return v == null ? '<span class="pz-mute">–</span>' : '<span class="' + (v >= 0 ? "pz-up" : "pz-down") + '">' + (v >= 0 ? "▲ " : "▼ ") + pct(v, dp) + "</span>"; }
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function shortDay(d) { return d ? MON[Number(d.slice(5, 7)) - 1] + " " + Number(d.slice(8, 10)) : ""; }
  function clock(iso) { try { return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } }
  function firstSentence(t, max) {
    t = String(t || "").replace(/\s+/g, " ").trim();
    var m = /^(.{40,}?[.!?])\s/.exec(t + " "), s = m ? m[1] : t;
    return s.length > (max || 170) ? s.slice(0, (max || 170) - 1).replace(/\s+\S*$/, "") + "…" : s;
  }
  function cleanName(n) {
    if (!n) return "";
    n = String(n).replace(/\s+(common stock|ordinary shares|class [a-c]|cl [a-c]|shs|adr)\b.*$/i, "").trim();
    if (n === n.toUpperCase()) n = n.toLowerCase().replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
    return n;
  }

  function ring(value, colour) {
    var r = 40, len = 2 * Math.PI * r, off = len * (1 - Math.max(0, Math.min(100, value || 0)) / 100);
    return '<svg viewBox="0 0 96 96" aria-hidden="true"><circle class="trk" cx="48" cy="48" r="' + r + '"/><circle class="arc" cx="48" cy="48" r="' + r + '" stroke="' + colour + '" stroke-dasharray="' + len.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '"/></svg>';
  }
  function band(v) {
    if (v >= 67) return { name: "Buy zone", colour: "var(--pz-up)" };
    if (v >= 34) return { name: "Warming up", colour: "var(--pz-warn)" };
    return { name: "Quiet", colour: "var(--pz-accent)" };
  }
  /* a calm, fixed colour per ticker (identity, not status) - only seen when a logo is missing */
  var AV = ["#3B4CCA", "#7A3FC4", "#1F7A8C", "#B5523B", "#2E7D5B", "#8A6D1D", "#A23B72", "#44618B"];
  function avatar(tk, light) {
    var h = 0, i; for (i = 0; i < tk.length; i++) h = (h * 31 + tk.charCodeAt(i)) >>> 0;
    var ico = light === "GREEN" ? "good" : light === "YELLOW" ? "warn" : light === "RED" ? "crit" : null;
    return '<div class="pz-av" style="background:' + AV[h % AV.length] + '">' + esc(tk.slice(0, 4)) +
      '<img class="pz-logo" alt="" loading="lazy" referrerpolicy="no-referrer" src="' + LOGOS + encodeURIComponent(tk) + '.png" onerror="this.remove()">' +
      (ico ? '<span class="pz-badge"><i class="pz-ico ' + ico + '"></i></span>' : "") + "</div>";
  }
  function scoreRing(score) {
    if (score == null) return '<div class="pz-sc none" title="Not scored by the agents yet"><b>–</b></div>';
    var r = 19, len = 2 * Math.PI * r, off = len * (1 - Math.max(0, Math.min(100, score)) / 100);
    return '<div class="pz-sc"><svg viewBox="0 0 48 48" aria-hidden="true"><circle class="trk" cx="24" cy="24" r="' + r + '"/><circle class="arc" cx="24" cy="24" r="' + r + '" stroke-dasharray="' + len.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '"/></svg><b>' + Math.round(score) + "</b></div>";
  }
  /* action colours: SELL red, BUY green (blue for forex, where green/red already means price direction), WATCH yellow */
  var TAG = { SELL: "t-sell", BUY: "t-buy", WATCH: "t-watch", HOLDING: "t-hold", SOLD: "t-grey", AVOID: "t-grey", TODAY: "t-note", "HEADS-UP": "t-watch", NOTE: "t-note" };
  function tag(label, asset) { return '<span class="pz-tag ' + (TAG[label] || "t-note") + (label === "BUY" && asset === "forex" ? " t-fx" : "") + '">' + label + "</span>"; }

  /* ---------- one model for all four screens ---------- */
  function model(s) {
    var st = store(), runs = latestRunBySymbol(st.runs);
    function scoreOf(tk, agent) {
      var a = agent || (s.agentScores && s.agentScores[tk]);
      if (a && a.score != null) return { v: a.score, src: "Altovix Score", asOf: (agent && agent.asOf) || s.agentsAsOf };
      var r = runs[tk], ai = r && r.outputs && r.outputs.journal && r.outputs.journal.aiScore;
      return ai != null ? { v: ai * 10, src: "committee score", asOf: r.asOf } : null;
    }
    var held = (s.positions || []).slice().sort(function (x, y) {
      var o = { RED: 0, YELLOW: 1, GREEN: 2 };
      return (o[x.light] - o[y.light]) || ((y.pnlPct || 0) - (x.pnlPct || 0));
    });
    var cut = new Date(new Date(s.asOf + "T12:00:00Z").getTime() - 3 * 864e5).toISOString().slice(0, 10);
    var needs = (s.events || []).filter(function (e) {
      var unsold = (e.kind === "STOP_HIT" || e.kind === "EXIT_LEG") && held.some(function (p) { return p.ticker === e.ticker && p.exit && p.exit.paperExitPrice == null; });
      return unsold || e.date >= cut;
    });

    /* every pick, one row per ticker: SELL > HOLDING > BUY > WATCH > SOLD > AVOID */
    var picks = {}, order = { SELL: 0, HOLDING: 1, BUY: 2, WATCH: 3, SOLD: 4, AVOID: 5 };
    function put(tk, status, sub, extra) {
      var cur = picks[tk];
      if (cur && order[cur.status] <= order[status]) return;
      picks[tk] = { ticker: tk, status: status, sub: sub, also: cur && cur.also, score: scoreOf(tk, extra && extra.agent), price: extra && extra.price, pnl: extra && extra.pnl };
    }
    held.forEach(function (p) {
      var due = p.exit && p.exit.paperExitPrice == null;
      put(p.ticker, due ? "SELL" : "HOLDING", due ? "Stop hit " + shortDay(p.exit.date) + " · sell at the next open" : (p.cushionPct == null ? "" : num(p.cushionPct, 1) + "% above stop $" + num(p.stop)), { agent: p.agent, price: p.lastClose, pnl: p.pnlPct });
    });
    (s.triggers || []).forEach(function (t) {
      if (t.level == null) return;
      var buy = t.kind !== "REOPEN", fired = t.state === "FIRED" && t.firedOn >= cut, waiting = (t.state === "WAITING" || t.state === "NOT_LIVE_YET") && t.lastClose != null;
      if (!fired && !waiting) return;
      var what = buy ? (t.kind === "ENTER" ? "Buy" : "Add") + (t.size ? " " + t.size : "") : "Watch";
      var sub = fired ? (buy ? what + " · closed over $" + num(t.level) + " on " + shortDay(t.firedOn) : "Crossed $" + num(t.level) + " on " + shortDay(t.firedOn) + " · agents to review")
        : what + " at $" + num(t.level) + " · " + num(Math.max(0, t.gapPct || 0), 1) + "% away" + (t.state === "NOT_LIVE_YET" ? " · not live yet" : "");
      if (picks[t.ticker] && picks[t.ticker].status === "HOLDING") { picks[t.ticker].also = sub; return; }
      put(t.ticker, buy ? "BUY" : "WATCH", sub, { agent: t.agent, price: t.lastClose });
    });
    (s.closed || []).forEach(function (l) { put(l.ticker, "SOLD", "Sold " + shortDay(l.exitDate) + " at $" + num(l.exitPrice), { pnl: l.pnlPct, price: l.exitPrice }); });
    Object.keys(s.agentScores || {}).forEach(function (tk) { if (!picks[tk]) put(tk, /avoid/i.test(s.agentScores[tk].stance || "") ? "AVOID" : "WATCH", s.agentScores[tk].stance || "", {}); });
    Object.keys(runs).forEach(function (tk) { if (!picks[tk] && runs[tk].action === "AVOID") put(tk, "AVOID", "Committee said avoid on " + shortDay(runs[tk].asOf), {}); });
    var list = Object.keys(picks).map(function (k) { return picks[k]; }).sort(function (a, b) { return (order[a.status] - order[b.status]) || ((b.score ? b.score.v : -1) - (a.score ? a.score.v : -1)); });
    return { held: held, needs: needs, picks: list, runs: runs, allRuns: st.runs, claims: st.claims, scoreOf: scoreOf };
  }
  function nameOf(s, tk) { return cleanName(s.names && s.names[tk]); }

  /* ---------- Home ---------- */
  function renderHome(s, m, fromCache) {
    var bk = s.book || {}, b = band(s.opportunity || 0);
    var whole = bk.value == null ? "–" : Math.floor(bk.value).toLocaleString("en-US");
    var cents = bk.value == null ? "" : "." + (bk.value % 1).toFixed(2).slice(2);
    var edge = bk.sinceStartPct != null && bk.spySinceStartPct != null ? bk.sinceStartPct - bk.spySinceStartPct : null;
    var ageH = (Date.now() - new Date(s.generatedAt).getTime()) / 36e5, wd = new Date().getDay();
    var stale = ageH > 30 && !(wd === 0 || wd === 6 || (wd === 1 && ageH < 80));
    var L = s.lights || { green: 0, yellow: 0, red: 0 };
    var h = "";
    h += '<div class="pz-head"><div><p class="pz-k">Book value</p><p class="pz-total">$' + whole + "<small>" + cents + "</small></p>" +
      '<p class="pz-delta">' + change(bk.sinceStartPct) + '<span class="pz-mute">since Sep 4</span></p></div>' +
      '<div class="pz-score" aria-label="Opportunity score ' + (s.opportunity || 0) + ' of 100"><div class="pz-ring">' + ring(s.opportunity || 0, b.colour) + "<b>" + (s.opportunity || 0) + "</b></div><span>Opportunity</span></div></div>";
    if (stale) h += '<div class="pz-stale">The last check ran ' + Math.round(ageH / 24) + " day(s) ago. Is the PC on, and is the weekly Schwab login current?</div>";
    h += '<div class="pz-banner"><div><h2>' + b.name + "</h2><p>" + esc(s.opportunityWhy || "") + '</p></div><span class="pz-dot" style="background:' + b.colour + '"></span></div>';
    h += '<div class="pz-h">Holdings<small>score</small></div>';
    h += '<div class="pz-chips">' + [["all", "All", m.held.length, ""], ["GREEN", "Healthy", L.green, "good"], ["YELLOW", "Near stop", L.yellow, "warn"], ["RED", "Exit", L.red, "crit"]].map(function (x) {
      return '<button class="pz-chip" type="button" data-pz-chip="' + x[0] + '" aria-pressed="' + (ui.chip === x[0]) + '">' + (x[3] ? '<i class="pz-ico ' + x[3] + '"></i>' : "") + x[1] + " <b>" + x[2] + "</b></button>";
    }).join("") + "</div>";
    var rows = m.held.filter(function (p) { return ui.chip === "all" || p.light === ui.chip; });
    h += '<div class="pz-rows">' + (rows.length ? rows.map(function (p) {
      var sc = m.scoreOf(p.ticker, p.agent);
      return '<div class="pz-row has-score" data-pz-stock="' + esc(p.ticker) + '">' + avatar(p.ticker, p.light) + '<div><div class="nm">' + esc(p.ticker) + '</div><div class="nm2">' + esc(nameOf(s, p.ticker) || (p.exit ? "Sell at the next open" : num(p.cushionPct, 1) + "% above stop")) + "</div></div>" +
        '<div class="r"><div class="px">$' + num(p.lastClose) + '</div><div class="ch">' + change(p.pnlPct) + "</div></div>" + scoreRing(sc ? sc.v : null) + "</div>";
    }).join("") : '<div class="pz-empty-row">None right now.</div>') + "</div>";
    h += '<div class="pz-meta"><span>S&amp;P 500 ' + (bk.spySinceStartPct == null ? "–" : (bk.spySinceStartPct >= 0 ? "+" : "−") + pct(bk.spySinceStartPct)) + (edge == null ? "" : " · you are " + (edge >= 0 ? "ahead" : "behind") + " by " + Math.abs(edge).toFixed(2) + " pts") +
      "<br>Checked " + esc(shortDay(s.asOf)) + " " + esc(clock(s.generatedAt)) + (s.sessionComplete ? " · after the close" : "") + (fromCache ? " · saved copy" : "") + '</span><button type="button" data-pz="refresh">Refresh</button></div>';
    h += '<p class="pz-foot">The ring beside each company is the agents’ score, 0–100' + (s.agentsAsOf ? " (last scored " + esc(shortDay(s.agentsAsOf)) + ")" : "") + ". Prices: Schwab. Decision support, not investment advice.</p>";
    HOME.innerHTML = h;
  }

  /* ---------- Needs you ---------- */
  var CAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';
  function renderNeeds(s, m) {
    var h = '<h1 class="pz-title">Needs you</h1><p class="pz-lede">What fired, and what is close to firing. Rules fire on the daily close.</p>';
    if (!m.needs.length) h += '<div class="pz-clear"><i class="pz-ico good"></i>All clear. No rule has fired.</div>';
    h += m.needs.map(function (e) {
      var sell = e.kind === "STOP_HIT" || e.kind === "EXIT_LEG", buy = e.kind === "TRIGGER";
      var label = sell ? "SELL" : buy ? "BUY" : e.kind === "REOPEN" || e.kind === "NEAR_STOP" ? "WATCH" : e.kind === "HEADS_UP" ? "HEADS-UP" : e.kind === "CALENDAR" ? "TODAY" : "NOTE";
      var lines = e.phone ? e.phone.lines : [e.text];
      var title = e.kind === "CALENDAR" ? "On the calendar" : (e.phone ? e.phone.title : e.title).replace(/^(SELL|BUY) /, "").replace(/^[A-Z.]+ · /, "");
      title = title.charAt(0).toUpperCase() + title.slice(1);
      return '<div class="pz-need"' + (e.ticker ? ' data-pz-stock="' + esc(e.ticker) + '"' : "") + ">" + (e.ticker ? avatar(e.ticker, null) : '<div class="cal">' + CAL + "</div>") + '<div><div class="hd">' + (e.ticker ? esc(e.ticker) : esc(shortDay(e.date))) + tag(label) + "</div>" +
        '<p class="big">' + esc(title) + "</p><p>" + lines.map(esc).join("<br>") + "</p></div></div>";
    }).join("");
    NEEDS.innerHTML = h;
    var n = m.needs.filter(function (e) { return e.level <= 2; }).length, badge = $("pz-needs-count");
    if (badge) badge.textContent = n ? String(n) : "";
  }

  /* ---------- Search: every pick ---------- */
  var SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>';
  function pickRows(s, m) {
    var q = ui.q.trim().toLowerCase();
    var rows = m.picks.filter(function (p) {
      if (ui.pick !== "all" && p.status !== ui.pick) return false;
      return !q || p.ticker.toLowerCase().indexOf(q) !== -1 || nameOf(s, p.ticker).toLowerCase().indexOf(q) !== -1;
    });
    if (!rows.length) return '<div class="pz-empty-row">No pick matches.</div>';
    return rows.map(function (p) {
      return '<div class="pz-row has-score" data-pz-stock="' + esc(p.ticker) + '">' + avatar(p.ticker, null) + '<div><div class="nm">' + esc(p.ticker) + tag(p.status) + '</div><div class="nm2">' + esc(nameOf(s, p.ticker) || p.sub) + "</div></div>" +
        '<div class="r">' + (p.price != null ? '<div class="px">$' + num(p.price) + "</div>" : "") + (p.pnl != null ? '<div class="ch">' + change(p.pnl) + "</div>" : "") + "</div>" + scoreRing(p.score ? p.score.v : null) + "</div>";
    }).join("");
  }
  function renderPicks(s, m) {
    var counts = {}; m.picks.forEach(function (p) { counts[p.status] = (counts[p.status] || 0) + 1; });
    var chips = [["all", "All", m.picks.length], ["HOLDING", "Holding", counts.HOLDING || 0], ["BUY", "Buy", counts.BUY || 0], ["SELL", "Sell", counts.SELL || 0], ["WATCH", "Watch", counts.WATCH || 0], ["SOLD", "Sold", counts.SOLD || 0], ["AVOID", "Avoid", counts.AVOID || 0]];
    PICKS.innerHTML = '<label class="pz-search">' + SEARCH + '<input id="pz-q" type="search" inputmode="search" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Search a ticker or company" value="' + esc(ui.q) + '"></label>' +
      '<div class="pz-chips">' + chips.filter(function (c) { return c[0] === "all" || c[2]; }).map(function (c) { return '<button class="pz-chip" type="button" data-pz-pick="' + c[0] + '" aria-pressed="' + (ui.pick === c[0]) + '">' + c[1] + " <b>" + c[2] + "</b></button>"; }).join("") + "</div>" +
      '<div class="pz-colhead"><span>All picks</span><span>Score</span></div><div class="pz-rows" id="pz-pick-rows">' + pickRows(s, m) + "</div>";
  }

  /* ---------- Stock page: everything about one company, opened by tapping it anywhere ---------- */
  var RANGES = [["1W", 5, "past week", false], ["1M", 21, "past month", false], ["3M", 63, "past 3 months", false], ["6M", 126, "past 6 months", false], ["1Y", 52, "past year", true]]; /* the year is drawn in weekly candles */
  var chart = null; /* what is on screen right now, for the crosshair */
  var KIND_CANDLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3v3M8 16v5M16 3v6M16 17v4"/><rect x="5.5" y="6" width="5" height="10" rx="1"/><rect x="13.5" y="9" width="5" height="8" rx="1"/></svg>';
  var KIND_LINE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-6 4 3 4-7 5 5"/></svg>';
  var BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>';
  function bigNum(v) {
    if (v == null) return "–";
    var a = Math.abs(v);
    return a >= 1e9 ? (v / 1e9).toFixed(2) + "B" : a >= 1e6 ? (v / 1e6).toFixed(a >= 1e8 ? 0 : 1) + "M" : a >= 1e4 ? (v / 1e3).toFixed(0) + "K" : num(v, 0);
  }
  function shares(v) { return v == null ? "–" : String(Math.round(v * 10000) / 10000); }
  function money(v) { return v == null ? "–" : (v < 0 ? "−$" : "$") + num(Math.abs(v)); }
  function fullDay(d) { return d ? shortDay(d) + (d.slice(0, 4) !== String(new Date().getFullYear()) ? ", " + d.slice(0, 4) : "") : ""; }
  /* candles for one ticker: daily or weekly, plus a candle for the session still running */
  function mondayOf(d) { var t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); }
  function candlesOf(s, tk, weekly, st) {
    var c = s.charts, cal = c && (weekly ? c.weeks : c.days), row = c && (weekly ? c.weekly : c.daily), out = [];
    row = row && row[tk]; if (!row || !cal) return out;
    var off = cal.length - row.length;
    row.forEach(function (k, i) { if (k) out.push({ d: cal[off + i], o: k[0], h: k[1], l: k[2], c: k[3], v: k[4] }); });
    if (st && st.live != null && out.length) {
      var o = st.open != null ? st.open : st.live, now = { d: s.asOf, live: true, o: o, h: Math.max(st.high != null ? st.high : o, o, st.live), l: Math.min(st.low != null ? st.low : o, o, st.live), c: st.live, v: st.volume || 0 };
      var lastC = out[out.length - 1];
      if (weekly && mondayOf(lastC.d) === mondayOf(s.asOf)) out[out.length - 1] = { d: s.asOf, live: true, o: lastC.o, h: Math.max(lastC.h, now.h), l: Math.min(lastC.l, now.l), c: now.c, v: lastC.v + now.v };
      else if (lastC.d < s.asOf) out.push(now);
    }
    return out;
  }
  function about(s, m, tk) {
    var pos = null, trg = [], lot = null, pick = null;
    (s.positions || []).forEach(function (p) { if (p.ticker === tk) pos = p; });
    (s.triggers || []).forEach(function (t) { if (t.ticker === tk) trg.push(t); });
    (s.closed || []).forEach(function (l) { if (l.ticker === tk) lot = l; });
    m.picks.forEach(function (p) { if (p.ticker === tk) pick = p; });
    return { pos: pos, trg: trg, lot: lot, pick: pick, st: (s.stats && s.stats[tk]) || null, run: m.runs[tk] || null,
      events: (s.events || []).filter(function (e) { return e.ticker === tk; }) };
  }
  function cell(k, v) { return v == null || v === "–" ? "" : '<div class="pz-cell"><span>' + k + "</span><b>" + v + "</b></div>"; }
  function para(title, text) {
    text = String(text || "").replace(/\s+/g, " ").trim();
    return text ? '<div class="pz-say"><h4>' + title + '</h4><p class="pz-clamp" data-pz-more>' + esc(text) + "</p></div>" : "";
  }
  function meter(frac, colour) { return '<div class="pz-meter"><i style="width:' + Math.round(Math.max(0, Math.min(1, frac)) * 100) + "%;background:" + colour + '"></i></div>'; }

  /* ---------- the chart: candles (or a line) on a grid, price scale on the right, dates underneath, volume below ---------- */
  var UPC = "#26A69A", DNC = "#EF5350";
  function niceStep(span, want) {
    var raw = span / want, mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), n = raw / mag;
    return (n <= 1.2 ? 1 : n <= 2.2 ? 2 : n <= 2.7 ? 2.5 : n <= 5.5 ? 5 : 10) * mag;
  }
  function axisNum(v, step) { return num(v, step >= 1 && v >= 100 ? 0 : step >= 0.1 ? (v >= 1000 ? 0 : v >= 100 ? 1 : 2) : 2); }
  function drawChart(cs, levels, weekly) {
    var W = Math.max(280, Math.min(560, SHEET.clientWidth || 393) - 8), H = 320, AX = 54, BOT = 22, TOP = 10;
    var pw = W - AX, ph = H - BOT, volH = Math.round(ph * 0.17), priceBot = ph - volH - 10, n = cs.length;
    var lo = Infinity, hi = -Infinity, vmax = 0, lastC = cs[n - 1];
    cs.forEach(function (k) { if (k.l < lo) lo = k.l; if (k.h > hi) hi = k.h; if (k.v > vmax) vmax = k.v; });
    levels = levels.filter(function (l) { return l.v != null && Math.abs(l.v / lastC.c - 1) <= 0.15; });
    levels.forEach(function (l) { if (l.v < lo) lo = l.v; if (l.v > hi) hi = l.v; });
    var pad = ((hi - lo) || hi * 0.02) * 0.06; lo -= pad; hi += pad;
    var step = pw / n, bw = Math.max(1, Math.min(14, step * 0.64));
    function X(i) { return step * (i + 0.5); }
    function Y(v) { return TOP + (1 - (v - lo) / (hi - lo)) * (priceBot - TOP); }
    function f(v) { return v.toFixed(1); }
    var g = "", i, k;

    /* your levels + the latest price become tags on the price scale; they push apart so they never overlap */
    var lastCol = lastC.c >= lastC.o ? UPC : DNC;
    var tags = levels.map(function (l) { return { v: l.v, col: l.col, label: l.label, dash: "5 4" }; });
    tags.push({ v: lastC.c, col: lastCol, label: null, dash: "1 3", last: true });
    tags.sort(function (a, b) { return b.v - a.v; });
    var prevY = -99, prevLabelY = -99;
    tags.forEach(function (tg) {
      tg.y = Y(tg.v); tg.ty = Math.max(tg.y, prevY + 17); prevY = tg.ty;
      if (tg.label) { tg.ly = tg.y - 5 - prevLabelY < 13 ? tg.y + 13 : tg.y - 5; prevLabelY = tg.ly; }
    });

    /* grid + price scale (a number that would sit under a tag is left out) */
    var ts = niceStep(hi - lo, 9), t0 = Math.ceil(lo / ts) * ts;
    for (var t = t0; t <= hi; t += ts) {
      var gy = Y(t), hidden = tags.some(function (tg) { return Math.abs(tg.ty - gy) < 15; });
      g += '<line class="grid" x1="0" x2="' + pw + '" y1="' + f(gy) + '" y2="' + f(gy) + '"/>' + (hidden || gy > priceBot + 4 ? "" : '<text class="ax" x="' + (pw + 8) + '" y="' + f(gy + 4) + '">' + axisNum(t, ts) + "</text>");
    }
    /* date scale: days for a week, weeks for a month, months beyond that */
    var lastLabelX = -99;
    for (i = 0; i < n; i++) {
      var d = cs[i].d, p = i ? cs[i - 1].d : null, label = null;
      if (!weekly && n <= 8) label = String(Number(d.slice(8, 10)));
      else if (!weekly && n <= 30) { if (!p || mondayOf(p) !== mondayOf(d)) label = shortDay(d); }
      else if (!p || p.slice(0, 7) !== d.slice(0, 7)) { if (p) label = d.slice(5, 7) === "01" ? d.slice(0, 4) : MON[Number(d.slice(5, 7)) - 1]; }
      if (label && X(i) - lastLabelX > 38 && X(i) > 14 && X(i) < pw - 10) { lastLabelX = X(i); g += '<line class="grid" x1="' + f(X(i)) + '" x2="' + f(X(i)) + '" y1="0" y2="' + ph + '"/><text class="ax mid" x="' + f(X(i)) + '" y="' + (H - 6) + '">' + label + "</text>"; }
    }
    g += '<line class="frame" x1="0" x2="' + W + '" y1="' + ph + '" y2="' + ph + '"/><line class="frame" x1="' + pw + '" x2="' + pw + '" y1="0" y2="' + ph + '"/>';

    /* volume */
    if (vmax > 0) for (i = 0; i < n; i++) { k = cs[i]; var vh = Math.max(1, k.v / vmax * volH); g += '<rect x="' + f(X(i) - bw / 2) + '" y="' + f(ph - vh) + '" width="' + f(bw) + '" height="' + f(vh) + '" fill="' + (k.c >= k.o ? UPC : DNC) + '" opacity=".32"/>'; }

    /* price: candles, or a line through the closes */
    var up = lastC.c >= (n > 1 ? cs[0].o : lastC.o);
    if (ui.kind === "line") {
      var path = cs.map(function (q, j) { return (j ? "L" : "M") + f(X(j)) + " " + f(Y(q.c)); }).join(""), col = up ? UPC : DNC;
      g += '<defs><linearGradient id="pz-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + col + '" stop-opacity=".28"/><stop offset="1" stop-color="' + col + '" stop-opacity="0"/></linearGradient></defs>' +
        '<path d="' + path + "L" + f(X(n - 1)) + " " + priceBot + "L" + f(X(0)) + " " + priceBot + 'Z" fill="url(#pz-fill)"/><path d="' + path + '" fill="none" stroke="' + col + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
    } else for (i = 0; i < n; i++) {
      k = cs[i]; var c = k.c >= k.o ? UPC : DNC, yo = Y(Math.max(k.o, k.c)), bh = Math.max(1, Math.abs(Y(k.o) - Y(k.c)));
      g += '<line x1="' + f(X(i)) + '" x2="' + f(X(i)) + '" y1="' + f(Y(k.h)) + '" y2="' + f(Y(k.l)) + '" stroke="' + c + '" stroke-width="1"/><rect x="' + f(X(i) - bw / 2) + '" y="' + f(yo) + '" width="' + f(bw) + '" height="' + f(bh) + '" fill="' + c + '"/>';
    }

    tags.forEach(function (tg) {
      g += '<line x1="0" x2="' + pw + '" y1="' + f(tg.y) + '" y2="' + f(tg.y) + '" stroke="' + tg.col + '" stroke-width="1" stroke-dasharray="' + tg.dash + '" opacity="' + (tg.last ? ".9" : ".8") + '"/>' +
        (tg.label ? '<text class="lv" x="6" y="' + f(tg.ly) + '" fill="' + tg.col + '">' + esc(tg.label) + "</text>" : "") +
        '<rect x="' + pw + '" y="' + f(tg.ty - 8) + '" width="' + AX + '" height="16" rx="2" fill="' + tg.col + '"/><text class="tag" x="' + (pw + 8) + '" y="' + f(tg.ty + 4) + '">' + num(tg.v) + "</text>";
    });

    /* crosshair (hidden until a finger or the mouse is on the chart) */
    g += '<g id="pz-x" visibility="hidden"><line id="pz-xv" class="xh" y1="0" y2="' + ph + '"/><line id="pz-xh" class="xh" x1="0" x2="' + pw + '"/>' +
      '<rect id="pz-xpr" x="' + pw + '" width="' + AX + '" height="16" rx="2" class="xt"/><text id="pz-xpt" class="tag" x="' + (pw + 8) + '"></text>' +
      '<rect id="pz-xdr" y="' + (ph + 2) + '" width="74" height="17" rx="2" class="xt"/><text id="pz-xdt" class="tag mid" y="' + (H - 7) + '"></text></g>';

    chart = { cs: cs, W: W, H: H, pw: pw, ph: ph, step: step, X: X, lo: lo, hi: hi, top: TOP, bot: priceBot, weekly: weekly };
    return '<div class="pz-legend" id="pz-leg">' + legend(cs, n - 1) + '</div><div class="pz-chart" id="pz-chart"><svg viewBox="0 0 ' + W + " " + H + '" width="100%" role="img" aria-label="Price chart">' + g + "</svg></div>";
  }
  function legend(cs, i) {
    var k = cs[i], base = i ? cs[i - 1].c : k.o, ch = k.c - base, col = k.c >= k.o ? UPC : DNC;
    function kv(a, v) { return "<span>" + a + '<b style="color:' + col + '">' + num(v) + "</b></span>"; }
    return kv("O", k.o) + kv("H", k.h) + kv("L", k.l) + kv("C", k.c) + '<span><b style="color:' + (ch >= 0 ? UPC : DNC) + '">' + (ch >= 0 ? "+" : "−") + num(Math.abs(ch)) + " (" + (ch >= 0 ? "+" : "−") + pct(base ? ch / base * 100 : 0) + ")</b></span>" + (k.v ? "<span>Vol<b>" + bigNum(k.v) + "</b></span>" : "");
  }

  function renderStock(s, m) {
    var tk = ui.stock, a = about(s, m, tk), st = a.st, pos = a.pos, pick = a.pick, keep = SHEET.scrollTop;
    var status = pick ? pick.status : pos ? "HOLDING" : "WATCH";
    var price = st ? (st.live != null ? st.live : st.close) : pos ? pos.lastClose : pick && pick.price;
    var daily = candlesOf(s, tk, false, st), weeklyC = candlesOf(s, tk, true, st), h = "";

    h += '<div class="pz-top"><button type="button" class="pz-back" data-pz="back" aria-label="Back">' + BACK + "</button><b>" + esc(tk) + "</b>" + tag(status) + "</div>";
    h += '<div class="pz-hero">' + avatar(tk, null) + '<div><p class="pz-co">' + esc(nameOf(s, tk) || tk) + '</p><p class="pz-px" id="pz-st-px">' + (price == null ? "–" : "$" + num(price)) + "</p></div></div>";

    /* ranges the data can honestly fill; "Since buy" when it is held */
    var ranges = [];
    RANGES.forEach(function (r) {
      var src = r[3] ? weeklyC : daily; if (src.length < r[1] * 0.9) return;
      var at = Math.max(0, src.length - r[1]);
      ranges.push({ id: r[0], label: r[0], words: r[2], weekly: r[3], cs: src.slice(at), base: at ? src[at - 1].c : src[at].o });
    });
    if (pos) {
      var wk = !daily.length || pos.fillDate < daily[0].d, srcB = wk ? weeklyC : daily, mine = srcB.filter(function (k) { return k.d >= pos.fillDate; });
      if (mine.length >= 2) ranges.push({ id: "BUY", label: "Since buy", words: "since you bought", weekly: wk, cs: mine, base: pos.fill });
    }
    var want = ui.range, cur = null;
    ranges.forEach(function (r) { if (r.id === want) cur = r; });
    if (!cur) ranges.forEach(function (r) { if (r.id === "3M") cur = r; });
    if (!cur) cur = ranges[ranges.length - 1] || null;
    var dayWord = st && st.live != null ? "today" : st && st.closeDate ? "on " + shortDay(st.closeDate) : "";
    var sub = (st && st.dayPct != null ? change(st.dayPct) + ' <span class="pz-mute">' + dayWord + "</span>" : "");
    if (cur) sub += (sub ? '<span class="pz-mute"> · </span>' : "") + change((cur.cs[cur.cs.length - 1].c / cur.base - 1) * 100) + ' <span class="pz-mute">' + cur.words + "</span>";
    h += '<p class="pz-sub2" id="pz-st-sub">' + (sub || '<span class="pz-mute">No price yet</span>') + "</p>";

    if (cur) {
      var levels = [];
      if (pos) { levels.push({ v: pos.stop, col: "#FF5C6C", label: "Stop" }); levels.push({ v: pos.fill, col: "#6B7190", label: "You paid" }); }
      a.trg.forEach(function (t) { if (t.level != null && (t.state === "WAITING" || t.state === "NOT_LIVE_YET")) levels.push({ v: t.level, col: t.kind === "REOPEN" ? "#C98A1B" : "#1F9D63", label: t.kind === "REOPEN" ? "Watch" : "Buy over" }); });
      h += drawChart(cur.cs, levels, cur.weekly);
      h += '<div class="pz-ranges">' + ranges.map(function (r) { return '<button type="button" data-pz-range="' + r.id + '" aria-pressed="' + (r === cur) + '">' + r.label + "</button>"; }).join("") +
        '<button type="button" class="kind" data-pz-kind aria-label="' + (ui.kind === "line" ? "Show candles" : "Show a line") + '">' + (ui.kind === "line" ? KIND_CANDLE : KIND_LINE) + "</button></div>";
    } else { chart = null; h += '<div class="pz-nochart">The chart arrives with the next check from your PC.</div>'; }

    /* the plan */
    var plan = "";
    if (pos && pos.exit && pos.exit.paperExitPrice == null) plan = "<p><b>Sell.</b> It closed at $" + num(pos.lastClose) + " on " + shortDay(pos.exit.date) + ", under your $" + num(pos.stop) + " stop. The plan is to sell all " + shares(pos.shares) + " shares at the next open.</p>";
    else if (pos) plan = "<p><b>Hold.</b> The plan sells it if it closes under <b>$" + num(pos.stop) + "</b>. It is " + (pos.cushionPct == null ? "–" : num(Math.max(0, pos.cushionPct), 1) + "%") + " above that now.</p>" + meter((pos.cushionPct || 0) / 15, pos.light === "YELLOW" ? "var(--pz-warn)" : "var(--pz-up)") + '<div class="pz-ends"><span>Stop</span><span>15% clear</span></div>';
    else if (a.lot) plan = "<p><b>Sold</b> " + shortDay(a.lot.exitDate) + " at $" + num(a.lot.exitPrice) + ", " + (a.lot.pnlPct >= 0 ? "up " : "down ") + pct(a.lot.pnlPct) + " on the trade. Bought " + shortDay(a.lot.fillDate) + " at $" + num(a.lot.fill) + ".</p>";
    a.trg.forEach(function (t) {
      if (t.level == null || t.state === "VOID" || t.state === "EXPIRED" || t.state === "FILE_CLOSED") return;
      var buy = t.kind !== "REOPEN", what = buy ? (t.kind === "ENTER" ? "Buy" : "Buy more") + (t.size ? " (" + esc(t.size) + " of the book)" : "") : "Look again";
      if (t.state === "FIRED") plan += "<p><b>" + (buy ? "Buy signal." : "Back on the list.") + "</b> It closed over $" + num(t.level) + " on " + shortDay(t.firedOn) + (buy ? "." : ". Not a buy yet: the agents review it first.") + "</p>";
      else plan += "<p><b>" + what + "</b> if it closes over <b>$" + num(t.level) + "</b>. " + (t.gapPct > 0 ? num(t.gapPct, 1) + "% away" : "At the level") + (t.state === "NOT_LIVE_YET" ? ", rule not live yet" : "") + ".</p>" + meter(t.proximity, buy ? "var(--pz-up)" : "var(--pz-warn)") + '<div class="pz-ends"><span>10% away</span><span>$' + num(t.level) + "</span></div>";
      if (t.note) plan += '<p class="pz-fine">' + esc(t.note) + "</p>";
    });
    if (pos && pos.notes) pos.notes.forEach(function (x) { plan += '<p class="pz-fine">' + esc(x) + "</p>"; });
    if (!plan && a.run && a.run.action === "AVOID") plan = "<p><b>Avoid.</b> The committee passed on it on " + shortDay(a.run.asOf) + ".</p>";
    if (!plan && pick && pick.sub) plan = "<p>" + esc(pick.sub) + "</p>";
    if (plan) h += '<div class="pz-card"><h3>The plan</h3>' + plan + "</div>";

    /* agents' score */
    var sc = m.scoreOf(tk, pos && pos.agent), ag = (pos && pos.agent) || (s.agentScores && s.agentScores[tk]) || null, d = a.run && a.run.outputs && a.run.outputs.decision;
    if (sc || d) {
      var old = sc && sc.asOf && (new Date(s.asOf) - new Date(sc.asOf)) / 864e5 > 7;
      h += '<div class="pz-card"><h3>Agents’ score</h3><div class="pz-agentsc">' + '<div class="pz-sc lg' + (sc ? "" : " none") + '">' + (sc ? scoreRing(sc.v).replace(/^<div class="pz-sc">|<\/div>$/g, "") : "<b>–</b>") + "</div><div>" +
        (sc ? '<p class="pz-scline"><b>' + Math.round(sc.v) + "</b> out of 100</p><p class=\"pz-fine\">" + esc(sc.src) + (sc.asOf ? " · scored " + esc(shortDay(sc.asOf)) : "") + (old ? " · getting old" : "") + "</p>" : '<p class="pz-fine">Not scored yet.</p>') +
        (ag && ag.stance ? '<p class="pz-stance">' + esc(ag.stance) + "</p>" : "") + (status === "SELL" && sc ? '<p class="pz-fine">Scored before the stop was hit. The stop rule wins.</p>' : "") + "</div></div>";
      if (ag && ag.action != null) h += '<div class="pz-bars"><span>Action</span>' + meter(ag.action / 100, "var(--pz-accent)") + "<b>" + Math.round(ag.action) + "</b><span>Confidence</span>" + meter((ag.confidence || 0) / 100, "var(--pz-accent)") + "<b>" + Math.round(ag.confidence || 0) + "</b></div>";
      if (d) h += '<p class="pz-call">Committee: <b>' + esc(d.action) + (d.sizePct ? " " + d.sizePct + "%" : "") + "</b> · " + Math.round((d.confidence || 0) * 100) + "% confident · " + esc(shortDay(a.run.asOf)) + "</p>";
      h += "</div>";
    }

    /* your position */
    if (pos) {
      var gain = pos.value != null ? pos.value - pos.shares * pos.fill : null;
      h += '<div class="pz-card"><h3>Your position</h3><div class="pz-grid">' + cell("Shares", shares(pos.shares)) + cell("Worth", money(pos.value)) + cell("You paid", "$" + num(pos.fill)) + cell("Bought", fullDay(pos.fillDate)) +
        cell("Gain / loss", gain == null ? null : '<em class="' + (gain >= 0 ? "pz-up" : "pz-down") + '">' + money(gain) + "</em>") + cell("Return", pos.pnlPct == null ? null : '<em class="' + (pos.pnlPct >= 0 ? "pz-up" : "pz-down") + '">' + (pos.pnlPct >= 0 ? "+" : "−") + pct(pos.pnlPct) + "</em>") + "</div></div>";
    }

    /* numbers */
    if (st) {
      var cells = cell("Open", st.open == null ? null : "$" + num(st.open)) + cell("Previous close", st.prevClose == null ? null : "$" + num(st.live != null ? st.close : st.prevClose)) + cell("Day high", st.high == null ? null : "$" + num(st.high)) + cell("Day low", st.low == null ? null : "$" + num(st.low)) +
        cell("Volume", st.volume == null ? null : bigNum(st.volume)) + cell("Average volume", st.avgVolume == null ? null : bigNum(st.avgVolume)) + cell("P/E ratio", st.pe == null ? null : num(st.pe, 1)) + cell("Earnings / share", st.eps == null ? null : money(st.eps)) + cell("Dividend yield", st.divYield == null ? null : num(st.divYield, 2) + "%");
      var yr = "";
      if (st.high52 != null && st.low52 != null && price != null && st.high52 > st.low52) {
        var f = Math.max(0, Math.min(1, (price - st.low52) / (st.high52 - st.low52)));
        yr = '<div class="pz-yr"><span>52-week range</span><div class="pz-yrbar"><i style="left:' + (f * 100).toFixed(1) + '%"></i></div><div class="pz-ends"><span>$' + num(st.low52) + "</span><span>" + num((1 - price / st.high52) * 100, 0) + "% under the high</span><span>$" + num(st.high52) + "</span></div></div>";
      }
      if (cells || yr) h += '<div class="pz-card"><h3>Numbers</h3>' + (cells ? '<div class="pz-grid">' + cells + "</div>" : "") + yr + "</div>";
    }

    /* what the agents said */
    var o = a.run && a.run.outputs;
    if (o) {
      var q = o.quant || {}, j = o.journal || {}, r = o.risk || {};
      var facts = cell("Trend", q.trend ? esc(String(q.trend).replace(/_/g, " ").toLowerCase()) : null) + cell("Setup quality", q.setupQuality != null ? esc(q.setupQuality) + " / 10" : null) + cell("Risk", j.riskScore != null ? esc(j.riskScore) + " / 10" : null) + cell("Time frame", d && d.horizonDays ? esc(d.horizonDays) + " days" : null);
      h += '<div class="pz-card"><h3>What the agents said<small>' + esc(fullDay(a.run.asOf)) + "</small></h3>" + (j.thesisOneLine ? '<p class="pz-lead">' + esc(j.thesisOneLine) + "</p>" : "") + (facts ? '<div class="pz-grid">' + facts + "</div>" : "") +
        para("Why own it", o.research && o.research.thesis) + para("The case against", o.bear && o.bear.strongestBearCase) + para("How they decided", d && d.rationale) + para("What would prove it wrong", j.whatWouldMakeThisWrong) + para("Exit rule", (d && d.exitRule) || j.exitRule) + "</div>";
    }

    /* history */
    var hist = a.events.map(function (e) { return { d: e.date, t: (e.phone ? e.phone.title : e.title), x: e.phone ? e.phone.lines[0] : e.text }; });
    if (a.lot) hist.push({ d: a.lot.exitDate, t: "Sold at $" + num(a.lot.exitPrice), x: (a.lot.pnlPct >= 0 ? "+" : "−") + pct(a.lot.pnlPct) + " on the trade" });
    if (pos) hist.push({ d: pos.fillDate, t: "Bought " + shares(pos.shares) + " shares", x: "At $" + num(pos.fill) });
    else if (a.lot) hist.push({ d: a.lot.fillDate, t: "Bought " + shares(a.lot.shares) + " shares", x: "At $" + num(a.lot.fill) });
    hist.sort(function (x, y) { return x.d < y.d ? 1 : x.d > y.d ? -1 : 0; });
    if (hist.length) h += '<div class="pz-card"><h3>History</h3>' + hist.map(function (x) { return '<div class="pz-hist"><span>' + esc(shortDay(x.d)) + "</span><div><b>" + esc(x.t) + "</b><p>" + esc(x.x) + "</p></div></div>"; }).join("") + "</div>";

    h += '<p class="pz-foot">Prices: Schwab, daily closes' + (st && st.live != null ? " plus the latest price" : "") + ". Checked " + esc(shortDay(s.asOf)) + " " + esc(clock(s.generatedAt)) + ". This is your own plan and your agents’ notes, not investment advice. Trades are placed by you, in Schwab.</p>";
    SHEET.innerHTML = '<div class="pz-sheet-in">' + h + "</div>";
    SHEET.scrollTop = keep;
  }
  function openStock(tk) {
    if (!last || !tk) return;
    ui.stock = tk; ui.range = null;
    SHEET.hidden = false; SHEET.scrollTop = 0;
    document.body.classList.add("pz-sheet-open");
    renderStock(last, model(last));
    try { history.pushState({ pzStock: tk }, ""); } catch (e) {}
  }
  function closeStock(viaHistory) {
    if (!ui.stock) return;
    ui.stock = null; chart = null;
    SHEET.hidden = true; SHEET.innerHTML = "";
    document.body.classList.remove("pz-sheet-open");
    if (!viaHistory) { try { if (history.state && history.state.pzStock) history.back(); } catch (e) {} }
  }
  window.addEventListener("popstate", function () { closeStock(true); });
  window.addEventListener("resize", function () { if (ui.stock && last) renderStock(last, model(last)); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeStock(false); });

  /* finger (or mouse) on the chart: a crosshair, the candle's numbers in the legend, price and date on the scales */
  function scrub(e) {
    var box = $("pz-chart"); if (!chart || !box) return;
    var r = box.firstChild.getBoundingClientRect(), sc = chart.W / r.width, n = chart.cs.length;
    var x = (e.clientX - r.left) * sc, y = Math.max(chart.top, Math.min(chart.bot, (e.clientY - r.top) * sc));
    var i = Math.max(0, Math.min(n - 1, Math.floor(x / chart.step))), k = chart.cs[i], cx = chart.X(i);
    var price = chart.hi - (y - chart.top) / (chart.bot - chart.top) * (chart.hi - chart.lo);
    $("pz-x").setAttribute("visibility", "visible");
    $("pz-xv").setAttribute("x1", cx); $("pz-xv").setAttribute("x2", cx);
    $("pz-xh").setAttribute("y1", y); $("pz-xh").setAttribute("y2", y);
    $("pz-xpr").setAttribute("y", y - 8); $("pz-xpt").setAttribute("y", y + 4); $("pz-xpt").textContent = num(price);
    var dx = Math.max(37, Math.min(chart.pw - 37, cx));
    $("pz-xdr").setAttribute("x", dx - 37); $("pz-xdt").setAttribute("x", dx);
    $("pz-xdt").textContent = k.live ? "Now" : (chart.weekly ? "Wk " : "") + shortDay(k.d) + " ’" + k.d.slice(2, 4);
    $("pz-leg").innerHTML = legend(chart.cs, i);
  }
  function unscrub() {
    var x = $("pz-x"); if (!x || !chart) return;
    x.setAttribute("visibility", "hidden"); $("pz-leg").innerHTML = legend(chart.cs, chart.cs.length - 1);
  }
  var scrubbing = false;
  SHEET.addEventListener("pointerdown", function (e) { if (e.target instanceof Element && e.target.closest("#pz-chart")) { scrubbing = true; scrub(e); } });
  SHEET.addEventListener("pointermove", function (e) { if (scrubbing || (e.pointerType === "mouse" && e.target instanceof Element && e.target.closest("#pz-chart"))) scrub(e); else if (e.pointerType === "mouse") unscrub(); });
  ["pointerup", "pointercancel", "pointerleave"].forEach(function (k) { SHEET.addEventListener(k, function () { scrubbing = false; unscrub(); }); });

  /* ---------- Agents ---------- */
  function ico(path) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + path + "</svg>"; }
  function renderAgents(s, m) {
    var runs = m.allRuns.filter(function (r) { return r.status === "COMPLETE"; }).sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    var newest = runs[0], o = (newest && newest.outputs) || {}, sym = newest ? newest.symbol : "";
    var per = {}; m.claims.forEach(function (c) { per[c.agent] = (per[c.agent] || 0) + 1; });
    var open = m.claims.filter(function (c) { return c.status === "OPEN"; }), nextDue = open.map(function (c) { return c.dueOn; }).sort()[0];
    var buys = runs.filter(function (r) { return r.action === "BUY"; }).length;
    var signals = m.needs.filter(function (e) { return e.level === 1; }).length;
    function claims(a) { return per[a] ? per[a] + " forecast" + (per[a] === 1 ? "" : "s") + " on record" : "no forecasts yet"; }
    var when = newest ? "Last committee run " + shortDay(newest.asOf) : "";
    var cards = [
      ["#3B4CCA", ico('<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>'), "Watcher", "on", "Checks every stop and buy level against Schwab prices, three times a trading day, and sends the alerts.",
        s.asOf ? "Checked <b>" + esc(shortDay(s.asOf)) + " " + esc(clock(s.generatedAt)) + "</b>: " + (s.positions || []).length + " holdings, " + (s.triggers || []).length + " levels. " + (signals ? "<b>" + signals + " trade signal" + (signals === 1 ? "" : "s") + "</b> waiting for you." : "Nothing needs you.") : "Waiting for its first published check.", "Runs on your PC"],
      ["#1F7A8C", ico('<path d="M3 17l5-5 4 3 8-8"/><path d="M15 7h5v5"/>'), "Regime", "", "Reads the whole market: risk-on, neutral or risk-off.",
        o.regime ? "<b>" + esc(o.regime.regime) + "</b>, " + Math.round((o.regime.confidence || 0) * 100) + "% confident; volatility " + esc(String(o.regime.volatilityRegime || "").toLowerCase()) + "." : "No read yet.", claims("regime")],
      ["#7A3FC4", ico('<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17M3.5 12h17"/>'), "Sector", "", "Finds which sectors are leading and which are fading.",
        o.sector && o.sector.leaders ? "Leaders: <b>" + o.sector.leaders.map(function (l) { return esc(l.etf); }).join(", ") + "</b>." + (o.sector.laggards && o.sector.laggards.length ? " Fading: " + o.sector.laggards.map(function (l) { return esc(l.etf); }).join(", ") + "." : "") : "No read yet.", claims("sector")],
      ["#2E7D5B", ico('<path d="M4 19h16M7 16V9M12 16V5M17 16v-5"/>'), "Quant", "", "Trend, momentum, volume and volatility, from the price data.",
        o.quant ? "On <b>" + esc(sym) + "</b>: trend " + esc(String(o.quant.trend || "").toLowerCase()) + ", setup " + esc(o.quant.setupQuality) + "/10." : "No read yet.", claims("quant")],
      ["#44618B", ico('<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 0-3 3z"/><path d="M9 9h6M9 13h6"/>'), "Research", "", "Writes the case for owning it: thesis, catalyst, exit.",
        o.research ? "On <b>" + esc(sym) + "</b>: " + esc(firstSentence(o.research.thesis)) : "No thesis yet.", claims("research")],
      ["#8A6D1D", ico('<path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z"/>'), "Risk", "", "Sizes the position and sets the stop. Can veto a trade.",
        o.risk ? "On <b>" + esc(sym) + "</b>: " + esc(String(o.risk.verdict || "").replace(/_/g, " ").toLowerCase()) + ", size " + esc(o.risk.recommendedSizePct) + "%, stop " + esc(o.risk.stopValue) + "." : "No read yet.", claims("risk")],
      ["#A23B72", ico('<path d="M12 9v4M12 17h.01"/><path d="M10.3 4.3 2.8 17.5a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z"/>'), "Bear", "", "Argues against every trade, on purpose.",
        o.bear ? "On <b>" + esc(sym) + "</b>: " + esc(firstSentence(o.bear.strongestBearCase)) : "No case yet.", claims("bear")],
      ["#5468FF", ico('<path d="M5 12l4.5 4.5L19 7"/>'), "Decision", "", "Weighs them all and makes the call: buy, hold, avoid, trim or sell.",
        newest ? "<b>" + buys + " buys, " + (runs.length - buys) + " passes</b> across " + runs.length + " names. Latest: " + esc(String(newest.action || "").toLowerCase()) + " " + esc(sym) + (newest.sizePct ? " " + newest.sizePct + "%" : "") + ", " + Math.round((newest.confidence || 0) * 100) + "% confident." : "No decisions yet.", claims("decision")],
      ["#B5523B", ico('<path d="M4 6h16M4 12h16M4 18h10"/>'), "Journal", "", "Keeps the record, so nothing can be quietly forgotten.",
        o.journal ? esc(firstSentence(o.journal.headline, 200)) : "Nothing logged yet.", m.allRuns.length + " runs logged"],
      ["#1F7A8C", ico('<circle cx="12" cy="12" r="8.5"/><path d="M12 12l4-2.5"/><path d="M12 3.5v2M20.5 12h-2M3.5 12h2"/>'), "Scorer", "", "Turns the agents’ work into the 0–100 score beside every company.",
        s.agentsAsOf ? "<b>" + Object.keys(s.agentScores || {}).length + " companies scored</b>, last on " + esc(shortDay(s.agentsAsOf)) + ". It has not re-scored since, so the scores are getting old." : "No scores yet.", "Eight factors, fixed weights"],
      ["#555A73", ico('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>'), "Scanner", "off", "Will score the wider market, plus forex and crypto, and alert you when a score crosses your buy or sell line.",
        "Not switched on yet. This is the next thing being built.", ""],
      ["#555A73", ico('<path d="M4 19V5M4 19h16"/><path d="M8 15l3-4 3 2 4-6"/>'), "Grader", "", "Checks every forecast against what actually happened, and grades each agent.",
        open.length ? "<b>" + open.length + " forecasts open.</b> First grading day: " + esc(shortDay(nextDue)) + "." : "Nothing to grade yet.", ""]
    ];
    AGENTS.innerHTML = '<h1 class="pz-title">Agents</h1><p class="pz-lede">Who is working for you, and the latest thing each one said.' + (when ? " " + esc(when) + "." : "") + "</p>" + cards.map(function (c) {
      return '<div class="pz-agent"><div class="ic" style="background:' + c[0] + '">' + c[1] + "</div><div><h3>" + c[2] + (c[3] === "on" ? '<small class="on">RUNNING</small>' : c[3] === "off" ? '<small class="off">NOT ON YET</small>' : "") + '</h3><p class="role">' + c[4] + '</p><p class="now">' + c[5] + "</p>" + (c[6] ? '<div class="meta">' + c[6] + "</div>" : "") + "</div></div>";
    }).join("");
  }

  /* ---------- render + load ---------- */
  function render(s, fromCache, problem) {
    last = s; lastFromCache = fromCache;
    if (!s) {
      var empty = '<div class="pz-empty"><h2>No market check yet</h2><p>This fills in as soon as the check on your PC publishes its first result.' + (problem ? "<br><small>" + esc(problem) + "</small>" : "") + '</p><button type="button" data-pz="refresh">Try again</button></div>';
      HOME.innerHTML = empty; NEEDS.innerHTML = empty; PICKS.innerHTML = empty;
      var st = store();
      renderAgents({ positions: [], triggers: [], agentScores: {} }, { allRuns: st.runs, claims: st.claims, needs: [] });
      return;
    }
    var m = model(s);
    renderHome(s, m, fromCache); renderNeeds(s, m); renderPicks(s, m); renderAgents(s, m);
    if (ui.stock) renderStock(s, m);
  }
  function load() {
    var cached = null;
    try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); } catch (e) {}
    if (cached) render(cached, true);
    var list = sources(), i = 0;
    (function next(problem) {
      if (i >= list.length) { if (!cached) render(null, false, problem); return; }
      var url = list[i++], api = url.indexOf("api.github.com") !== -1;
      fetch(url, { cache: "no-store", headers: api ? { Accept: "application/vnd.github.raw" } : {} })
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (s) {
          if (!s || !s.asOf || !s.positions) throw new Error("not a status file");
          try { localStorage.setItem(CACHE_KEY, JSON.stringify(s)); } catch (e) {}
          cached = s; render(s, false);
        })
        .catch(function (err) { next(String(err && err.message || err)); });
    })("");
  }

  document.addEventListener("click", function (e) {
    if (!(e.target instanceof Element)) return;
    var chip = e.target.closest("[data-pz-chip]"), pick = e.target.closest("[data-pz-pick]"), stock = e.target.closest("[data-pz-stock]"), act = e.target.closest("[data-pz]");
    var range = e.target.closest("[data-pz-range]"), more = e.target.closest("[data-pz-more]"), kind = e.target.closest("[data-pz-kind]");
    if (kind) { ui.kind = ui.kind === "line" ? "candle" : "line"; try { localStorage.setItem("altovix.pulse.kind", ui.kind); } catch (e2) {} if (last) renderStock(last, model(last)); }
    else if (range) { ui.range = range.getAttribute("data-pz-range"); if (last) renderStock(last, model(last)); }
    else if (more) more.classList.toggle("open");
    else if (act && act.getAttribute("data-pz") === "back") closeStock(false);
    else if (chip) { ui.chip = chip.getAttribute("data-pz-chip"); render(last, lastFromCache); }
    else if (pick) { ui.pick = pick.getAttribute("data-pz-pick"); render(last, lastFromCache); }
    else if (stock) openStock(stock.getAttribute("data-pz-stock"));
    else if (act && act.getAttribute("data-pz") === "refresh") load();
  });
  /* typing must not rebuild the input (the keyboard would close): only the rows are redrawn */
  document.addEventListener("input", function (e) {
    if (e.target && e.target.id === "pz-q") { ui.q = e.target.value; if (last) $("pz-pick-rows").innerHTML = pickRows(last, model(last)); }
  });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) load(); });
  window.altovixPulseReload = load;
  load();
})();
