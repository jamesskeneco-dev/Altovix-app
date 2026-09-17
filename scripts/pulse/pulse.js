/* ============================ Pulse: the daily read ============================
 * Reads the status.json that the PC market check publishes (branch "status" of this repo)
 * and draws it, clean and simple: the book value and the Opportunity score up top, one
 * banner, a rail of what needs doing, then plain rows - Holdings / Next buys / Closed.
 * Plain ES5 like the rest of the page; no dependencies. */
(function () {
  "use strict";
  var ROOT = document.getElementById("pulse-root");
  var PANEL = document.getElementById("p-pulse");
  if (!ROOT || !PANEL) return;
  var CACHE_KEY = "altovix.pulse.v1";
  var DEFAULT_REPO = "jamesskeneco-dev/Altovix-app";
  /* company logos: one square PNG per ticker; a missing one falls back to the monogram underneath */
  var LOGOS = "https://cdn.alphavantage.co/logos/";
  var ui = { seg: "holdings", chip: "all" };
  var last = null, lastFromCache = false;

  /* the page chrome steps back while Pulse is showing */
  function syncChrome() { document.body.classList.toggle("pulse-on", !PANEL.hidden); }
  try { new MutationObserver(syncChrome).observe(PANEL, { attributes: true, attributeFilter: ["hidden"] }); } catch (e) {}
  syncChrome();

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
      "https://api.github.com/repos/" + r + "/contents/status.json?ref=status&t=" + Date.now()
    ];
  }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function num(v, dp) { return v == null ? "–" : Number(v).toLocaleString("en-US", { minimumFractionDigits: dp == null ? 2 : dp, maximumFractionDigits: dp == null ? 2 : dp }); }
  function pct(v, dp) { return v == null ? "–" : Math.abs(v).toFixed(dp == null ? 2 : dp) + "%"; }
  function change(v, dp) { return v == null ? '<span class="mute">–</span>' : '<span class="' + (v >= 0 ? "up" : "down") + '">' + (v >= 0 ? "▲ " : "▼ ") + pct(v, dp) + "</span>"; }
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function shortDay(d) { return d ? MON[Number(d.slice(5, 7)) - 1] + " " + Number(d.slice(8, 10)) : ""; }
  function clock(iso) { try { return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } }

  function ring(value, colour) {
    var r = 40, len = 2 * Math.PI * r, off = len * (1 - Math.max(0, Math.min(100, value || 0)) / 100);
    return '<svg viewBox="0 0 96 96" aria-hidden="true"><circle class="trk" cx="48" cy="48" r="' + r + '"/><circle class="arc" cx="48" cy="48" r="' + r + '" stroke="' + colour + '" stroke-dasharray="' + len.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '"/></svg>';
  }
  function band(v) {
    if (v >= 67) return { name: "Buy zone", colour: "var(--pz-up)" };
    if (v >= 34) return { name: "Warming up", colour: "var(--pz-warn)" };
    return { name: "Quiet", colour: "var(--pz-accent)" };
  }
  /* a calm, fixed colour per ticker (identity, not status) */
  var AV = ["#3B4CCA", "#7A3FC4", "#1F7A8C", "#B5523B", "#2E7D5B", "#8A6D1D", "#A23B72", "#44618B"];
  function avatar(tk, light) {
    var h = 0, i; for (i = 0; i < tk.length; i++) h = (h * 31 + tk.charCodeAt(i)) >>> 0;
    var ico = light === "GREEN" ? "good" : light === "YELLOW" ? "warn" : light === "RED" ? "crit" : null;
    return '<div class="pz-av" style="background:' + AV[h % AV.length] + '">' + esc(tk.slice(0, 4)) +
      '<img class="pz-logo" alt="" loading="lazy" referrerpolicy="no-referrer" src="' + LOGOS + encodeURIComponent(tk) + '.png" onerror="this.remove()">' +
      (ico ? '<span class="pz-badge"><i class="pz-ico ' + ico + '"></i></span>' : "") + "</div>";
  }
  function scoreRing(a) {
    if (!a) return '<div class="pz-sc none" title="Not scored by the agents yet"><b>\u2013</b></div>';
    var r = 19, len = 2 * Math.PI * r, off = len * (1 - Math.max(0, Math.min(100, a.score)) / 100);
    return '<div class="pz-sc"><svg viewBox="0 0 48 48" aria-hidden="true"><circle class="trk" cx="24" cy="24" r="' + r + '"/><circle class="arc" cx="24" cy="24" r="' + r + '" stroke-dasharray="' + len.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '"/></svg><b>' + Math.round(a.score) + "</b></div>";
  }

  function signalCard(e) {
    var sell = e.kind === "STOP_HIT" || e.kind === "EXIT_LEG", buy = e.kind === "TRIGGER";
    var cls = sell ? "t-sell" : buy ? "t-buy" : e.kind === "REOPEN" || e.kind === "HEADS_UP" ? "t-watch" : "t-note";
    var tag = sell ? "SELL" : buy ? "BUY" : e.kind === "REOPEN" ? "WATCH" : e.kind === "HEADS_UP" ? "HEADS-UP" : e.kind === "CALENDAR" ? "TODAY" : "NOTE";
    var lines = e.phone ? e.phone.lines : [e.text];
    var title = e.kind === "CALENDAR" ? "On the calendar" : (e.phone ? e.phone.title : e.title).replace(/^(SELL|BUY) /, "").replace(/^[A-Z.]+ · /, "");
    title = title.charAt(0).toUpperCase() + title.slice(1);
    return '<div class="pz-sig"><div class="top"><span class="pz-tag ' + cls + '">' + tag + "</span>" + (e.ticker ? '<span class="tk">' + esc(e.ticker) + "</span>" : "") + "</div>" +
      '<p class="big">' + esc(title) + "</p><p>" + lines.slice(0, 2).map(esc).join("<br>") + "</p></div>";
  }

  function holdingRow(p) {
    var sub = p.exit ? (p.exit.paperExitPrice != null ? "Sold " + shortDay(p.exit.paperExitDate) + " at " + num(p.exit.paperExitPrice) : "Sell at the next open")
      : p.cushionPct == null ? "No price" : num(p.cushionPct, 1) + "% above stop " + num(p.stop);
    return '<div class="pz-row">' + avatar(p.ticker, p.light) + '<div><div class="nm">' + esc(p.ticker) + (p.agent ? "<i>" + Math.round(p.agent.score) + "</i>" : "") + '</div><div class="pz-sub">' + esc(sub) + "</div></div>" +
      '<div class="r"><div class="px">$' + num(p.lastClose) + '</div><div class="ch">' + change(p.pnlPct) + "</div></div></div>";
  }
  /* action colours: SELL red, BUY green (blue for forex, where green/red already means price direction), WATCH yellow */
  function tradeRow(t) {
    var cls = t.action === "SELL" ? "t-sell" : t.action === "BUY" ? (t.asset === "forex" ? "t-buy t-fx" : "t-buy") : "t-watch";
    return '<div class="pz-row trade">' + avatar(t.ticker, null) + '<div><div class="nm">' + esc(t.ticker) + '<span class="pz-tag ' + cls + '">' + t.action + "</span></div>" +
      '<div class="pz-sub">' + esc(t.sub) + "</div></div>" + '<div class="r">' + scoreRing(t.agent) + "</div></div>";
  }
  function buildTrades(s, held, cut) {
    var out = [];
    held.forEach(function (p) {
      if (p.exit && p.exit.paperExitPrice == null) out.push({ rank: 0, prox: 1, ticker: p.ticker, action: "SELL", agent: p.agent, sub: "Stop hit " + shortDay(p.exit.date) + " \u00b7 sell at the next open" });
    });
    (s.triggers || []).forEach(function (t) {
      if (t.level == null) return;
      var buy = t.kind !== "REOPEN", fired = t.state === "FIRED" && t.firedOn >= cut;
      var waiting = (t.state === "WAITING" || t.state === "NOT_LIVE_YET") && t.lastClose != null;
      if (!fired && !waiting) return;
      var what = buy ? (t.kind === "ENTER" ? "Buy" : "Add") + (t.size ? " " + t.size : "") : "Watch";
      var sub = fired ? (buy ? what + " \u00b7 closed over $" + num(t.level) + " on " + shortDay(t.firedOn) : "Crossed $" + num(t.level) + " on " + shortDay(t.firedOn) + " \u00b7 agents to review")
        : what + " at $" + num(t.level) + " \u00b7 " + num(Math.max(0, t.gapPct || 0), 1) + "% away" + (t.state === "NOT_LIVE_YET" ? " \u00b7 not live yet" : "");
      out.push({ rank: buy ? (fired ? 1 : 2) : (fired ? 3 : 4), prox: t.proximity || 0, ticker: t.ticker, action: buy ? "BUY" : "WATCH", agent: t.agent, sub: sub });
    });
    return out.sort(function (a, b) { return a.rank - b.rank || b.prox - a.prox; });
  }
  function closedRow(l) {
    return '<div class="pz-row">' + avatar(l.ticker, null) + '<div><div class="nm">' + esc(l.ticker) + '</div><div class="pz-sub">Sold ' + esc(shortDay(l.exitDate)) + " at $" + num(l.exitPrice) + "</div></div>" +
      '<div class="r"><div class="px">$' + num(l.proceeds) + '</div><div class="ch">' + change(l.pnlPct) + "</div></div></div>";
  }

  function render(s, fromCache, problem) {
    last = s; lastFromCache = fromCache;
    if (!s) {
      ROOT.innerHTML = '<div class="pz-empty"><h2>No market check yet</h2><p>This screen fills in as soon as the check on your PC publishes its first result.' + (problem ? "<br><small>" + esc(problem) + "</small>" : "") + '</p><button type="button" data-pz="refresh">Try again</button></div>';
      return;
    }
    var bk = s.book || {}, b = band(s.opportunity || 0);
    var whole = bk.value == null ? "–" : Math.floor(bk.value).toLocaleString("en-US");
    var cents = bk.value == null ? "" : "." + (bk.value % 1).toFixed(2).slice(2);
    var edge = bk.sinceStartPct != null && bk.spySinceStartPct != null ? bk.sinceStartPct - bk.spySinceStartPct : null;
    var ageH = (Date.now() - new Date(s.generatedAt).getTime()) / 36e5, wd = new Date().getDay();
    var stale = ageH > 30 && !(wd === 0 || wd === 6 || (wd === 1 && ageH < 80));

    var held = (s.positions || []).slice().sort(function (x, y) {
      var o = { RED: 0, YELLOW: 1, GREEN: 2 };
      return (o[x.light] - o[y.light]) || ((y.pnlPct || 0) - (x.pnlPct || 0));
    });
    var cut = new Date(new Date(s.asOf + "T12:00:00Z").getTime() - 3 * 864e5).toISOString().slice(0, 10);
    var signals = (s.events || []).filter(function (e) {
      if (e.kind === "NEAR_STOP") return false;
      var unsold = (e.kind === "STOP_HIT" || e.kind === "EXIT_LEG") && held.some(function (p) { return p.ticker === e.ticker && p.exit && p.exit.paperExitPrice == null; });
      return unsold || e.date >= cut;
    });
    var trades = buildTrades(s, held, cut);
    var closed = s.closed || [];

    var h = "";
    h += '<div class="pz-head"><div><p class="pz-k">Book value</p><p class="pz-total">$' + whole + "<small>" + cents + "</small></p>" +
      '<p class="pz-delta">' + change(bk.sinceStartPct) + '<span class="mute">since Sep 4</span></p></div>' +
      '<button class="pz-score" type="button" data-pz="why" aria-label="Opportunity score ' + (s.opportunity || 0) + ' of 100"><div class="pz-ring">' + ring(s.opportunity || 0, b.colour) + "<b>" + (s.opportunity || 0) + "</b></div><span>Opportunity</span></button></div>";
    if (stale) h += '<div class="pz-stale">The last check ran ' + Math.round(ageH / 24) + " day(s) ago. Is the PC on, and is the weekly Schwab login current?</div>";
    h += '<div class="pz-banner"><div><h2>' + b.name + "</h2><p>" + esc(s.opportunityWhy || "") + '</p></div><span class="pz-dot" style="background:' + b.colour + '"></span></div>';

    h += '<div class="pz-h">Needs you' + (signals.length ? "<small>" + signals.length + "</small>" : "") + "</div>";
    h += signals.length ? '<div class="pz-rail">' + signals.map(signalCard).join("") + "</div>" : '<div class="pz-clear"><i class="pz-ico good"></i>All clear. No rule has fired.</div>';

    h += '<div class="pz-seg" role="tablist">' + [["holdings", "Holdings"], ["trades", "Trades"], ["closed", "Closed"]].map(function (x) {
      return '<button type="button" role="tab" data-pz-seg="' + x[0] + '" aria-selected="' + (ui.seg === x[0]) + '">' + x[1] + "</button>";
    }).join("") + "</div>";

    if (ui.seg === "holdings") {
      var L = s.lights || { green: 0, yellow: 0, red: 0 };
      h += '<div class="pz-chips">' + [["all", "All", held.length, ""], ["GREEN", "Healthy", L.green, "good"], ["YELLOW", "Near stop", L.yellow, "warn"], ["RED", "Exit", L.red, "crit"]].map(function (x) {
        return '<button class="pz-chip" type="button" data-pz-chip="' + x[0] + '" aria-pressed="' + (ui.chip === x[0]) + '">' + (x[3] ? '<i class="pz-ico ' + x[3] + '"></i>' : "") + x[1] + " <b>" + x[2] + "</b></button>";
      }).join("") + "</div>";
      var rows = held.filter(function (p) { return ui.chip === "all" || p.light === ui.chip; });
      h += '<div class="pz-rows">' + (rows.length ? rows.map(holdingRow).join("") : '<div class="pz-empty-row">None right now.</div>') + "</div>";
    } else if (ui.seg === "trades") {
      h += '<div class="pz-colhead"><span>Trade</span><span>Agents\u2019 score</span></div>';
      h += '<div class="pz-rows">' + (trades.length ? trades.map(tradeRow).join("") : '<div class="pz-empty-row">No trade is lined up.</div>') + "</div>";
    } else {
      h += '<div class="pz-rows">' + (closed.length ? closed.map(closedRow).join("") : '<div class="pz-empty-row">Nothing has been sold this cycle.</div>') + "</div>";
    }

    h += '<div class="pz-meta"><span>S&amp;P 500 ' + (bk.spySinceStartPct == null ? "–" : (bk.spySinceStartPct >= 0 ? "+" : "−") + pct(bk.spySinceStartPct)) + (edge == null ? "" : " · you are " + (edge >= 0 ? "ahead" : "behind") + " by " + Math.abs(edge).toFixed(2) + " pts") +
      "<br>Checked " + esc(shortDay(s.asOf)) + " " + esc(clock(s.generatedAt)) + (s.sessionComplete ? " · after the close" : "") + (fromCache ? " · saved copy" : "") + '</span><button type="button" data-pz="refresh">Refresh</button></div>';
    h += '<p class="pz-foot">Rules fire on the daily close; anything intraday is a heads-up only. The number beside a ticker is the agents\u2019 Altovix Score, 0\u2013100' + (s.agentsAsOf ? " (last scored " + esc(shortDay(s.agentsAsOf)) + ")" : "") + '. Prices: Schwab. Decision support, not investment advice.</p>';
    ROOT.innerHTML = h;
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
    var seg = e.target.closest("[data-pz-seg]"), chip = e.target.closest("[data-pz-chip]"), act = e.target.closest("[data-pz]");
    if (seg) { ui.seg = seg.getAttribute("data-pz-seg"); render(last, lastFromCache); }
    else if (chip) { ui.chip = chip.getAttribute("data-pz-chip"); render(last, lastFromCache); }
    else if (act && act.getAttribute("data-pz") === "refresh") load();
  });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) load(); });
  window.altovixPulseReload = load;
  load();
})();
