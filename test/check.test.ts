import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Bar } from "../src/core/types.ts";
import {
  completedBars, healthScore, parseAgentScores, parseRuleBook, runCheck, tickersFor, weekOf, type RuleBook, type TriggerRule,
} from "../src/core/check/engine.ts";
import { generateTopic, planAlerts, type CheckState } from "../src/core/check/notify.ts";

/** Weekday sessions starting 2026-08-03, one close per entry. */
function series(closes: number[], opts: { start?: string; volume?: number[]; opens?: number[] } = {}): Bar[] {
  const out: Bar[] = [];
  const d = new Date(`${opts.start ?? "2026-08-03"}T12:00:00Z`);
  for (let i = 0; i < closes.length; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const close = closes[i] as number;
    out.push({ date: d.toISOString().slice(0, 10), open: opts.opens?.[i] ?? close, high: close, low: close, close, volume: opts.volume?.[i] ?? 1000 });
    i++;
  }
  return out;
}
const flat = (n: number, v: number): number[] => Array.from({ length: n }, () => v);

function book(over: Partial<RuleBook> = {}): RuleBook {
  return {
    version: 1, nearStopPct: 3, context: ["SPY"], calendar: [], standingNotes: [],
    cycle: { name: "t", start: "2026-09-04", end: "2026-10-03", notional: 10000, cash: 9000, paper: true },
    positions: [{ ticker: "HII", shares: 10, fill: 100, fillDate: "2026-09-04", stop: 95 }],
    triggers: [],
    ...over,
  };
}
const trig = (t: Partial<TriggerRule>): TriggerRule => ({ id: "t1", ticker: "KTOS", kind: "ENTER", closeAbove: 50, ...t });

test("a trigger cannot fire before the plan existed (regression: July 'buys' sent on the first real run)", () => {
  // Above the level all through August, below it ever since the cycle started on 09-04.
  const closes = [...flat(24, 55), ...flat(6, 47)];
  const bars = { KTOS: series(closes), SPY: series(flat(30, 500)) };
  assert.ok((bars.KTOS[23] as Bar).date < "2026-09-04" && (bars.KTOS[24] as Bar).date >= "2026-09-04");
  const r = runCheck({ book: book({ positions: [], triggers: [trig({}), trig({ id: "r", kind: "REOPEN" })] }), bars, asOf: "2026-12-01", sessionComplete: false });
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.triggers.map((t) => t.state), ["WAITING", "WAITING"]);
});

test("stop: fires on the first CLOSE below the stop, with the paper exit at the next open", () => {
  // 25 sessions from 08-03 -> 09-04 is index 24. Then 09-08 (no holiday logic here: 09-07 is a weekday in this toy calendar).
  const closes = [...flat(25, 100), 97, 94, 93, 96];
  const opens = [...flat(25, 100), 97, 94, 92.5, 96];
  const bars = { HII: series(closes, { opens }), SPY: series(flat(29, 500)) };
  const last = bars.HII.at(-1) as Bar;
  const r = runCheck({ book: book(), bars, asOf: "2026-12-01", sessionComplete: false });
  const e = r.events.find((x) => x.kind === "STOP_HIT");
  assert.ok(e, "stop event");
  const hitDate = (bars.HII[26] as Bar).date;
  assert.equal(e.date, hitDate);
  assert.equal(e.key, `STOP_HIT:HII:${hitDate}`);
  assert.equal(e.level, 1);
  assert.match(e.text, /closed 94\.00 < stop 95\.00/);
  assert.match(e.text, /open 92\.50/); // next session's open
  const p = r.positions[0];
  assert.equal(p?.light, "RED");
  assert.equal(p?.health, 0);
  assert.equal(p?.value, 925); // marked at the paper exit, not at the later bounce
  assert.equal(r.lights.red, 1);
  assert.ok(last.close > 95, "a later bounce does not un-fire the stop");
});

test("stop: today's unfinished bar never fires a rule - a live price below the stop is only a heads-up", () => {
  const bars = { HII: series([...flat(25, 100), 99, 94]), SPY: series(flat(27, 500)) };
  const today = (bars.HII.at(-1) as Bar).date;
  const open = runCheck({ book: book(), bars, live: { HII: 94 }, asOf: today, sessionComplete: false });
  assert.equal(open.events.some((e) => e.kind === "STOP_HIT"), false);
  const hu = open.events.find((e) => e.kind === "HEADS_UP");
  assert.ok(hu && hu.level === 2 && /daily CLOSE/.test(hu.text));
  assert.equal(open.positions[0]?.light, "GREEN");
  const closed = runCheck({ book: book(), bars, asOf: today, sessionComplete: true });
  assert.equal(closed.events.filter((e) => e.kind === "STOP_HIT").length, 1);
  assert.equal(completedBars(bars.HII, today, false).length, 26);
  assert.equal(completedBars(bars.HII, today, true).length, 27);
});

test("near stop: yellow within 3% of the stop, alert key repeats weekly not daily", () => {
  const bars = { HII: series([...flat(25, 100), 97, 97.5]), SPY: series(flat(27, 500)) };
  const r = runCheck({ book: book(), bars, asOf: "2026-12-01", sessionComplete: false });
  const e = r.events.find((x) => x.kind === "NEAR_STOP");
  assert.ok(e);
  assert.equal(e.key, `NEAR_STOP:HII:${weekOf((bars.HII.at(-1) as Bar).date)}`);
  assert.equal(r.positions[0]?.light, "YELLOW");
  assert.equal(weekOf("2026-09-17"), "2026-09-14");
  assert.equal(weekOf("2026-09-14"), "2026-09-14");
  assert.equal(weekOf("2026-09-20"), "2026-09-14");
});

test("context leg: JPM exits when HYG closes below its prior 21-session low (the real 09-09 case)", () => {
  const hyg = series([...flat(10, 79.6), 79.10, ...flat(14, 79.5), 79.19, 79.12, 78.98, 78.62]);
  const jpm = series([...flat(25, 358), 358.64, 353.51, 354.71, 353.53], { opens: [...flat(28, 358), 352.9] });
  const b = book({ positions: [{ ticker: "JPM", shares: 1.3943, fill: 358.6, fillDate: "2026-09-04", stop: 349, legs: [{ type: "contextBelowPriorLow", ticker: "HYG", sessions: 21 }] }] });
  const r = runCheck({ book: b, bars: { JPM: jpm, HYG: hyg, SPY: series(flat(29, 500)) }, asOf: "2026-12-01", sessionComplete: false });
  const e = r.events.find((x) => x.kind === "EXIT_LEG");
  assert.ok(e, "leg fired");
  assert.equal(e.date, (hyg[27] as Bar).date); // the 78.98 close, not the 79.12 one
  assert.match(e.text, /HYG closed 78\.98 < its prior 21-session low close 79\.10/);
  assert.match(e.text, /open 352\.90/);
  assert.deepEqual(tickersFor(b).sort(), ["HYG", "JPM", "SPY"]);
});

test("triggers: close above fires once; notBefore, notAfter, voidOn, consecutive, volume, close-the-file, manual", () => {
  const base = [...flat(25, 45), 49, 51, 48];
  const run = (t: TriggerRule, closes = base, volume?: number[], asOf = "2026-12-01"): ReturnType<typeof runCheck> =>
    runCheck({ book: book({ positions: [{ ticker: "KTOS", shares: 1, fill: 45, fillDate: "2026-09-04", stop: 30 }], triggers: [t] }), bars: { KTOS: series(closes, { volume }), SPY: series(flat(28, 500)) }, asOf, sessionComplete: false });
  const dates = series(base).map((b) => b.date);

  const fired = run(trig({ size: "2.5%", stopIfFilled: 43.09 }));
  const ev = fired.events.find((e) => e.kind === "TRIGGER");
  assert.ok(ev && ev.level === 1 && ev.date === dates[26]);
  assert.match(ev.title, /^BUY \(enter\) KTOS 2\.5%/);
  assert.match(ev.text, /Stop if filled: close < 43\.09/);
  assert.equal(fired.triggers[0]?.state, "FIRED");
  assert.equal(fired.opportunity, 0, "a buy that fired months ago no longer counts as an opportunity");

  assert.equal(run(trig({ notBefore: dates[27] })).triggers[0]?.state, "WAITING", "the 51 close was before the rule went live");
  assert.equal(run(trig({ closeAbove: 60, notAfter: dates[26] })).triggers[0]?.state, "EXPIRED");
  assert.equal(run(trig({ consecutive: 2 })).triggers[0]?.state, "WAITING");
  assert.equal(run(trig({ consecutive: 2 }), [...flat(25, 45), 51, 52]).triggers[0]?.state, "FIRED");

  const vol = [...flat(26, 1000), 1100, 1000];
  assert.equal(run(trig({ volumeRatio: 1.2 }), base, vol).triggers[0]?.state, "WAITING", "above the level but on thin volume");
  assert.equal(run(trig({ volumeRatio: 1.2 }), base, [...flat(26, 1000), 1300, 1000]).triggers[0]?.state, "FIRED");

  const voided = run(trig({ kind: "ADD", voidIfCloseBelow: 50, voidOn: dates[25] }));
  assert.equal(voided.triggers[0]?.state, "VOID");
  assert.ok(voided.events.some((e) => e.kind === "TRIGGER_VOID"));
  assert.equal(run(trig({ kind: "ADD", voidIfCloseBelow: 50, voidOn: "2026-01-02" })).triggers[0]?.state, "FIRED", "void only reads the named day");

  const filed = run(trig({ kind: "REOPEN", closeAbove: 60, closeFileBelow: 48.5 }));
  assert.equal(filed.triggers[0]?.state, "FILE_CLOSED");
  const reopen = run(trig({ kind: "REOPEN" }));
  assert.equal(reopen.events.find((e) => e.kind === "REOPEN")?.level, 2, "a re-open is a heads-up, not a buy");
  assert.equal(run({ id: "m", ticker: "KTOS", kind: "REOPEN", manual: true }).triggers[0]?.state, "MANUAL");
});

test("an ADD rule on a name that has been stopped out is void - no buy alert after a sell", () => {
  const closes = [...flat(25, 100), 94, 96, 106];
  const b = book({ triggers: [{ id: "hii-add", ticker: "HII", kind: "ADD", closeAbove: 105 }] });
  const r = runCheck({ book: b, bars: { HII: series(closes), SPY: series(flat(28, 500)) }, asOf: "2026-12-01", sessionComplete: false });
  assert.equal(r.events.filter((e) => e.kind === "STOP_HIT").length, 1);
  assert.equal(r.events.some((e) => e.kind === "TRIGGER"), false);
  assert.equal(r.triggers[0]?.state, "VOID");
  assert.match(r.triggers[0]?.note ?? "", /exited/);
});

test("opportunity: 0 when nothing is close, rises with proximity, 100-ish on a fresh buy signal", () => {
  const mk = (last: number, asOf: string): number => {
    const closes = [...flat(27, 40), last];
    return runCheck({ book: book({ positions: [], triggers: [trig({})] }), bars: { KTOS: series(closes), SPY: series(flat(28, 500)) }, asOf, sessionComplete: false }).opportunity;
  };
  const lastDate = series(flat(28, 1)).at(-1)?.date as string;
  const next = new Date(`${lastDate}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
  const asOf = next.toISOString().slice(0, 10);
  assert.equal(mk(40, asOf), 0);            // 20% away
  const mid = mk(47.5, asOf);               // 5% away -> proximity 0.5
  assert.ok(mid > 30 && mid < 45, `mid ${mid}`);
  assert.ok(mk(49.9, asOf) > mid);
  assert.ok(mk(51, asOf) >= 70, "fired yesterday");
});

test("health score: full cushion + uptrend scores high, at the stop scores low", () => {
  const up = series(Array.from({ length: 30 }, (_, i) => 100 + i));
  assert.ok((healthScore(up, 100) ?? 0) >= 85);
  const atStop = series([...flat(25, 100), 99, 98, 97, 96, 95.5]);
  assert.ok((healthScore(atStop, 95) ?? 100) <= 25);
  assert.equal(healthScore([], 95), null);
});

test("alerts: only new events are sent, a flood is bundled, one summary per completed session", () => {
  const closes = [...flat(25, 100), 97, 94];
  const bars = { HII: series(closes), SPY: series(flat(27, 500)) };
  const today = (bars.HII.at(-1) as Bar).date;
  const r = runCheck({ book: book({ calendar: [{ date: today, text: "Review day." }] }), bars, asOf: today, sessionComplete: true });
  const empty: CheckState = { sent: {}, lastSummary: null, lastRun: null };
  const first = planAlerts(r, empty);
  assert.equal(first.alerts.filter((a) => a.priority === 4).length, 1);
  assert.equal(first.alerts[0]?.title, "SELL HII \u00b7 stop hit");
  assert.match(first.alerts[0]?.message ?? "", /^Closed 94\.00, under the 95\.00 stop \(.+\)\nSell 10 sh at the next open\nSince entry \u22126\.0%$/);
  assert.deepEqual(first.alerts[0]?.tags, ["red_circle"]);
  assert.ok(first.alerts.some((a) => /^Today \u00b7 /.test(a.title) && /Review day/.test(a.message)));
  assert.equal(first.summaryFor, today);
  const card = first.alerts.at(-1);
  assert.match(card?.title ?? "", /^Altovix \u00b7 Opportunity \d+ \u00b7 \w{3} \w{3} \d+$/);
  assert.match(card?.message ?? "", /\ud83d\udfe2 0 {3}\ud83d\udfe1 0 {3}\ud83d\udd34 1\nBook /);
  assert.match(card?.message ?? "", /Today: SELL HII$/);
  // Short enough for a lock screen.
  for (const a of first.alerts) { assert.ok(a.title.length <= 48, a.title); for (const l of a.message.split("\n")) assert.ok(l.length <= 90, l); }

  const state: CheckState = { sent: Object.fromEntries(first.keys.map((k) => [k, "x"])), lastSummary: today, lastRun: null };
  const second = planAlerts(r, state);
  assert.deepEqual(second.alerts, []);
  assert.deepEqual(second.keys, []);

  // Five positions stopping out at once -> one bundled alert, not five buzzes.
  const many = book({ positions: ["A", "B", "C", "D", "E"].map((t) => ({ ticker: t, shares: 1, fill: 100, fillDate: "2026-09-04", stop: 95 })) });
  const mbars = Object.fromEntries(["A", "B", "C", "D", "E", "SPY"].map((t) => [t, series(closes)]));
  const flood = planAlerts(runCheck({ book: many, bars: mbars, asOf: "2026-12-01", sessionComplete: false }), empty);
  assert.equal(flood.alerts.filter((a) => a.priority === 4).length, 1);
  assert.match(flood.alerts[0]?.title ?? "", /^5 trade signals/);
  assert.match(flood.alerts[0]?.message ?? "", /^SELL A \u00b7 stop hit\nClosed 94\.00/);
  assert.equal(flood.summaryFor, null, "no summary while the session is not complete");
});

test("alerts: a trade alert that no longer comes out of the rules is explicitly withdrawn, once", () => {
  const bars = { HII: series(flat(27, 100)), KTOS: series(flat(27, 47)), SPY: series(flat(27, 500)) };
  const r = runCheck({ book: book({ triggers: [trig({})] }), bars, asOf: "2026-12-01", sessionComplete: false });
  const state: CheckState = { sent: { "TRIGGER:t1:2026-07-01": "x", "REOPEN:gone:2026-06-22": "x", "NEAR_STOP:HII:2026-09-07": "x", "CALENDAR:2026-09-17": "x" }, lastSummary: null, lastRun: null };
  const plan = planAlerts(r, state);
  assert.deepEqual(plan.withdrawn.sort(), ["REOPEN:gone:2026-06-22", "TRIGGER:t1:2026-07-01"]);
  assert.equal(plan.alerts.length, 1);
  assert.match(plan.alerts[0]?.title ?? "", /^Correction \u00b7 ignore 2 earlier alerts$/);
  assert.match(plan.alerts[0]?.message ?? "", /BUY KTOS \(Jul 1\)/);
  assert.match(plan.alerts[0]?.message ?? "", /Back on the list: gone \(Jun 22\)/);
  // After the CLI drops the withdrawn keys, nothing more is sent.
  for (const k of plan.withdrawn) delete state.sent[k];
  assert.deepEqual(planAlerts(r, state).alerts, []);
});

test("a SELL for a lot that was then moved to `closed` is NOT withdrawn, and its add rule stays void", () => {
  const b = book({
    positions: [],
    triggers: [{ id: "hii-add", ticker: "HII", kind: "ADD", closeAbove: 99 }],
    closed: [{ ticker: "HII", shares: 10, fill: 100, fillDate: "2026-09-04", signalDate: "2026-09-08", exitDate: "2026-09-09", exitPrice: 92.5, reason: "stop" }],
  });
  const r = runCheck({ book: b, bars: { HII: series(flat(30, 100)), SPY: series(flat(30, 500)) }, asOf: "2026-12-01", sessionComplete: false });
  assert.equal(r.triggers[0]?.state, "VOID");
  assert.deepEqual(r.closed.map((l) => [l.ticker, l.pnlPct, l.proceeds]), [["HII", -7.5, 925]]);
  const plan = planAlerts(r, { sent: { "STOP_HIT:HII:2026-09-08": "x" }, lastSummary: null, lastRun: null });
  assert.deepEqual(plan.withdrawn, []);
  assert.deepEqual(plan.alerts, []);
});

test("agents' scores ride along on holdings, trades and the phone text - and are optional", () => {
  const agents = parseAgentScores(JSON.stringify({ asOf: "2026-09-04", scores: { hii: { score: 56.4, action: 52 }, KTOS: { score: 42.5 }, BAD: { score: 140 } } }));
  assert.deepEqual(Object.keys(agents.scores).sort(), ["HII", "KTOS"]);
  const b = book({ triggers: [trig({})] });
  const bars = { HII: series([...flat(25, 100), 94]), KTOS: series([...flat(25, 45), 51]), SPY: series(flat(26, 500)) };
  const r = runCheck({ book: b, agents, bars, asOf: "2026-12-01", sessionComplete: false });
  assert.equal(r.positions[0]?.agent?.score, 56.4);
  assert.equal(r.triggers[0]?.agent?.asOf, "2026-09-04");
  assert.equal(r.agentsAsOf, "2026-09-04");
  assert.ok(r.events.find((e) => e.kind === "STOP_HIT")?.phone?.lines.includes("Agents' score 56/100 (Sep 4)"));
  assert.ok(r.events.find((e) => e.kind === "TRIGGER")?.phone?.lines.includes("Agents' score 43/100 (Sep 4)"));
  const none = runCheck({ book: b, bars, asOf: "2026-12-01", sessionComplete: false });
  assert.equal(none.positions[0]?.agent, null);
  assert.equal(none.agentsAsOf, null);
  const real = parseAgentScores(readFileSync(new URL("../rules/scores.json", import.meta.url), "utf8"));
  assert.ok(Object.keys(real.scores).length >= 15 && real.scores["NPK"]?.score === 59.8);
});

test("rules/book.json: parses, adds up to the Book, and bad files are rejected", () => {
  const b = parseRuleBook(readFileSync(new URL("../rules/book.json", import.meta.url), "utf8"));
  assert.equal(b.positions.length + (b.closed ?? []).length, 12, "twelve lots were opened on 09-04");
  // Cash is what is left after every buy, plus what every closed lot brought back.
  const cost = [...b.positions, ...(b.closed ?? [])].reduce((s, p) => s + p.shares * p.fill, 0);
  const proceeds = (b.closed ?? []).reduce((s, l) => s + l.shares * l.exitPrice, 0);
  assert.ok(Math.abs(b.cycle.notional - cost + proceeds - b.cycle.cash) < 0.05, `cash ${b.cycle.cash} vs ${b.cycle.notional - cost + proceeds}`);
  for (const l of b.closed ?? []) assert.ok(l.exitDate > l.signalDate, `${l.ticker} exits after its signal`);
  for (const p of b.positions) assert.ok(p.stop < p.fill, `${p.ticker} stop below fill`);
  const t = tickersFor(b);
  for (const need of ["HYG", "SPY", "ITA", "KTOS", "AVAV", "DCO"]) assert.ok(t.includes(need), need);
  assert.throws(() => parseRuleBook(JSON.stringify({ cycle: { start: "2026-09-04" }, positions: [{ ticker: "X", shares: 1, fill: 10, stop: 100, fillDate: "2026-09-04" }], triggers: [] })), /typo/);
  assert.throws(() => parseRuleBook(JSON.stringify({ cycle: { start: "2026-09-04" }, positions: [], triggers: [{ id: "a", ticker: "X", kind: "ADD" }] })), /closeAbove/);
});

test("ntfy topic: typable, unguessable enough, never the same twice", () => {
  const a = generateTopic();
  assert.match(a, /^altovix-[a-z]+-[a-z]+-[a-z]+-\d{4}$/);
  assert.notEqual(a, generateTopic());
});
