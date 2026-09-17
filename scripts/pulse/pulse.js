/* ============================ Altovix phone screens ============================
 * Four screens, fed by the status.json the PC market check publishes (branch "status"):
 *   Home      - book value, the Opportunity score, and every holding with its logo and score
 *   Needs you - what fired and what is close to firing (its own page, with a badge on the tab)
 *   Search    - a search box over every pick: holdings, buys, watch levels, sold and avoided names
 *   Agents    - each agent, what it does, and the latest thing it said
 * Committee runs and claims come from the app's own store (localStorage "altovix.v1", else the
 * seed shipped in the page). Plain ES5 like the rest of the page; no dependencies. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var HOME = $("pulse-root"), NEEDS = $("needs-root"), PICKS = $("picks-root"), AGENTS = $("agents-root");
  if (!HOME) return;
  var NEW_PANELS = ["p-pulse", "p-needs", "p-picks", "p-agents"];
  var CACHE_KEY = "altovix.pulse.v1";
  var DEFAULT_REPO = "jamesskeneco-dev/Altovix-app";
  /* company logos: one square PNG per ticker; a missing one falls back to the monogram underneath */
  var LOGOS = "https://cdn.alphavantage.co/logos/";
  var ui = { chip: "all", pick: "all", q: "", open: null };
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
      return '<div class="pz-row has-score">' + avatar(p.ticker, p.light) + '<div><div class="nm">' + esc(p.ticker) + '</div><div class="nm2">' + esc(nameOf(s, p.ticker) || (p.exit ? "Sell at the next open" : num(p.cushionPct, 1) + "% above stop")) + "</div></div>" +
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
      return '<div class="pz-need">' + (e.ticker ? avatar(e.ticker, null) : '<div class="cal">' + CAL + "</div>") + '<div><div class="hd">' + (e.ticker ? esc(e.ticker) : esc(shortDay(e.date))) + tag(label) + "</div>" +
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
      var open = ui.open === p.ticker, r = m.runs[p.ticker], j = r && r.outputs && r.outputs.journal, d = r && r.outputs && r.outputs.decision;
      var row = '<div class="pz-row has-score" data-pz-open="' + esc(p.ticker) + '">' + avatar(p.ticker, null) + '<div><div class="nm">' + esc(p.ticker) + tag(p.status) + '</div><div class="nm2">' + esc(nameOf(s, p.ticker) || p.sub) + "</div></div>" +
        '<div class="r">' + (p.price != null ? '<div class="px">$' + num(p.price) + "</div>" : "") + (p.pnl != null ? '<div class="ch">' + change(p.pnl) + "</div>" : "") + "</div>" + scoreRing(p.score ? p.score.v : null) + "</div>";
      if (!open) return row;
      var det = "";
      if (p.sub) det += "<div>" + esc(p.sub) + (p.also ? "<br>" + esc(p.also) : "") + "</div>";
      if (p.score) det += "<div><b>Score " + Math.round(p.score.v) + "</b> · " + esc(p.score.src) + (p.score.asOf ? ", " + esc(shortDay(p.score.asOf)) : "") + "</div>";
      if (d) det += "<div><b>Committee:</b> " + esc(d.action) + (d.sizePct ? " " + d.sizePct + "%" : "") + " · confidence " + Math.round((d.confidence || 0) * 100) + "% · " + esc(shortDay(r.asOf)) + "</div>";
      if (j && j.thesisOneLine) det += "<div>" + esc(j.thesisOneLine) + "</div>";
      if (!det) det = "<div>The agents have not looked at this one yet.</div>";
      return row + '<div class="pz-detail">' + det + "</div>";
    }).join("");
  }
  function renderPicks(s, m) {
    var counts = {}; m.picks.forEach(function (p) { counts[p.status] = (counts[p.status] || 0) + 1; });
    var chips = [["all", "All", m.picks.length], ["HOLDING", "Holding", counts.HOLDING || 0], ["BUY", "Buy", counts.BUY || 0], ["SELL", "Sell", counts.SELL || 0], ["WATCH", "Watch", counts.WATCH || 0], ["SOLD", "Sold", counts.SOLD || 0], ["AVOID", "Avoid", counts.AVOID || 0]];
    PICKS.innerHTML = '<label class="pz-search">' + SEARCH + '<input id="pz-q" type="search" inputmode="search" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Search a ticker or company" value="' + esc(ui.q) + '"></label>' +
      '<div class="pz-chips">' + chips.filter(function (c) { return c[0] === "all" || c[2]; }).map(function (c) { return '<button class="pz-chip" type="button" data-pz-pick="' + c[0] + '" aria-pressed="' + (ui.pick === c[0]) + '">' + c[1] + " <b>" + c[2] + "</b></button>"; }).join("") + "</div>" +
      '<div class="pz-colhead"><span>All picks</span><span>Score</span></div><div class="pz-rows" id="pz-pick-rows">' + pickRows(s, m) + "</div>";
  }

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
    var chip = e.target.closest("[data-pz-chip]"), pick = e.target.closest("[data-pz-pick]"), open = e.target.closest("[data-pz-open]"), act = e.target.closest("[data-pz]");
    if (chip) { ui.chip = chip.getAttribute("data-pz-chip"); render(last, lastFromCache); }
    else if (pick) { ui.pick = pick.getAttribute("data-pz-pick"); ui.open = null; render(last, lastFromCache); }
    else if (open) { var tk = open.getAttribute("data-pz-open"); ui.open = ui.open === tk ? null : tk; if (last) $("pz-pick-rows").innerHTML = pickRows(last, model(last)); }
    else if (act && act.getAttribute("data-pz") === "refresh") load();
  });
  /* typing must not rebuild the input (the keyboard would close): only the rows are redrawn */
  document.addEventListener("input", function (e) {
    if (e.target && e.target.id === "pz-q") { ui.q = e.target.value; ui.open = null; if (last) $("pz-pick-rows").innerHTML = pickRows(last, model(last)); }
  });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) load(); });
  window.altovixPulseReload = load;
  load();
})();
