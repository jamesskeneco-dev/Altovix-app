import type { Bar } from "../types.ts";

/**
 * The market check: pure rule evaluation over daily bars (+ an optional live price per ticker).
 *
 * Design rules, because this is the part that tells a person to trade:
 *  - Every rule fires on a COMPLETED daily close only. A live price can only produce a HEADS-UP.
 *  - Rules are evaluated over the whole history since the fill / rule start, not just "today",
 *    so a check that did not run (PC off, login expired) loses nothing: the next run reports
 *    what fired while it was away, with the date it fired.
 *  - Nothing here reads the clock, the network or the disk. `asOf` and `sessionComplete` come in.
 */

// ---------------------------------------------------------------------------
// Rule book (rules/book.json)

export interface ContextLeg {
  type: "contextBelowPriorLow";
  ticker: string;
  sessions: number;
  label?: string;
}

export interface PositionRule {
  ticker: string;
  shares: number;
  fill: number;
  fillDate: string;
  stop: number;
  sleeve?: string;
  legs?: ContextLeg[];
  notes?: string[];
}

export interface TriggerRule {
  id: string;
  ticker: string;
  kind: "ADD" | "ENTER" | "REOPEN";
  size?: string;
  closeAbove?: number;
  /** Day's volume must be at least this multiple of the prior 20-session average. */
  volumeRatio?: number;
  /** This many closes in a row above the level (default 1). */
  consecutive?: number;
  notBefore?: string;
  notAfter?: string;
  /** The rule is cancelled if the close on `voidOn` (or any close, when voidOn is absent) is below this. */
  voidIfCloseBelow?: number;
  voidOn?: string;
  /** REOPEN only: a close below this closes the file for good. */
  closeFileBelow?: number;
  stopIfFilled?: number;
  reviewIfUntriggeredBy?: string;
  /** Needs a human: the script shows the price and the note, never fires. */
  manual?: boolean;
  note?: string;
}

export interface RuleBook {
  version: number;
  updated?: string;
  cycle: { name: string; start: string; end: string; notional: number; cash: number; paper: boolean };
  nearStopPct: number;
  context: string[];
  positions: PositionRule[];
  triggers: TriggerRule[];
  calendar: Array<{ date: string; text: string }>;
  standingNotes?: string[];
  /** Lots that have been sold (kept for the record; their SELL alerts stay valid, nothing re-fires). */
  closed?: ClosedLot[];
}

export interface ClosedLot {
  ticker: string; shares: number; fill: number; fillDate: string;
  signalDate: string; exitDate: string; exitPrice: number; reason: string;
}

export function parseRuleBook(json: string): RuleBook {
  const b = JSON.parse(json) as Partial<RuleBook>;
  const fail = (m: string): never => { throw new Error(`rules/book.json: ${m}`); };
  if (!b.cycle || typeof b.cycle.start !== "string") fail("cycle.start is missing");
  if (!Array.isArray(b.positions)) fail("positions must be a list");
  if (!Array.isArray(b.triggers)) fail("triggers must be a list");
  for (const p of b.positions ?? []) {
    if (!p.ticker || !(p.shares > 0) || !(p.fill > 0) || !(p.stop > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(p.fillDate ?? "")) {
      fail(`position ${p.ticker ?? "?"} needs ticker, shares, fill, stop and fillDate (YYYY-MM-DD)`);
    }
    if (p.stop >= p.fill * 1.5) fail(`position ${p.ticker}: stop ${p.stop} is far above the fill ${p.fill} - typo?`);
  }
  const ids = new Set<string>();
  for (const t of b.triggers ?? []) {
    if (!t.id || !t.ticker || !t.kind) fail("every trigger needs id, ticker and kind");
    if (ids.has(t.id)) fail(`duplicate trigger id ${t.id}`);
    ids.add(t.id);
    if (!t.manual && !(typeof t.closeAbove === "number" && t.closeAbove > 0)) fail(`trigger ${t.id} needs closeAbove (or manual: true)`);
  }
  return {
    version: b.version ?? 1,
    updated: b.updated,
    cycle: b.cycle as RuleBook["cycle"],
    nearStopPct: b.nearStopPct ?? 3,
    context: (b.context ?? []).map((s) => s.toUpperCase()),
    positions: (b.positions ?? []).map((p) => ({ ...p, ticker: p.ticker.toUpperCase() })),
    triggers: (b.triggers ?? []).map((t) => ({ ...t, ticker: t.ticker.toUpperCase() })),
    calendar: b.calendar ?? [],
    standingNotes: b.standingNotes ?? [],
    closed: (b.closed ?? []).map((l) => ({ ...l, ticker: l.ticker.toUpperCase() })),
  };
}

/** Every ticker the check needs bars for. */
export function tickersFor(book: RuleBook): string[] {
  const s = new Set<string>();
  for (const p of book.positions) { s.add(p.ticker); for (const l of p.legs ?? []) s.add(l.ticker.toUpperCase()); }
  for (const t of book.triggers) s.add(t.ticker);
  for (const c of book.context) s.add(c);
  return [...s];
}

// ---------------------------------------------------------------------------
// Inputs and outputs

/** The agents' view of a name (rules/scores.json) - produced by the committee / CIO agent, never by this check. */
export interface AgentScore { score: number; action?: number; confidence?: number; stance?: string }
export interface AgentScores { asOf: string; source?: string; scores: Record<string, AgentScore> }
export type AgentView = (AgentScore & { asOf: string }) | null;

export function parseAgentScores(json: string): AgentScores {
  const j = JSON.parse(json) as Partial<AgentScores>;
  if (!j.scores || typeof j.asOf !== "string") throw new Error("rules/scores.json needs asOf and scores");
  const scores: Record<string, AgentScore> = {};
  for (const [k, v] of Object.entries(j.scores)) {
    if (typeof v?.score === "number" && v.score >= 0 && v.score <= 100) scores[k.toUpperCase()] = v;
  }
  return { asOf: j.asOf, source: j.source, scores };
}

export interface CheckInput {
  /** Optional: the agents' scores, attached to every holding and trade so the phone can show them. */
  agents?: AgentScores;
  book: RuleBook;
  /** Daily bars per ticker, oldest first. May include today's (possibly unfinished) bar. */
  bars: Record<string, Bar[]>;
  /** Live price per ticker (regular-session last where available). Optional. */
  live?: Record<string, number | null | undefined>;
  /** Today's New York trading date, YYYY-MM-DD. */
  asOf: string;
  /** True once today's regular session has closed - only then does today's bar count as a close. */
  sessionComplete: boolean;
}

export type EventKind =
  | "STOP_HIT" | "EXIT_LEG" | "NEAR_STOP" | "TRIGGER" | "REOPEN" | "FILE_CLOSED"
  | "TRIGGER_VOID" | "TRIGGER_REVIEW" | "HEADS_UP" | "CALENDAR";

export interface CheckEvent {
  /** Stable identity - an alert with a key that was already sent is not sent again. */
  key: string;
  kind: EventKind;
  ticker: string | null;
  /** The close that fired the rule (or asOf for heads-ups and calendar items). */
  date: string;
  /** 1 = act (a rule fired), 2 = pay attention, 3 = information. */
  level: 1 | 2 | 3;
  title: string;
  text: string;
  /** The same news, written for a lock screen: a short title and a few short lines. */
  phone?: { title: string; lines: string[] };
}

export type Light = "GREEN" | "YELLOW" | "RED";

export interface PositionStatus {
  ticker: string;
  light: Light;
  /** 0-100, price-based only: cushion to the stop, trend, short momentum. Not the 8-factor Altovix Score. */
  health: number | null;
  lastClose: number | null;
  lastCloseDate: string | null;
  live: number | null;
  stop: number;
  cushionPct: number | null;
  pnlPct: number | null;
  value: number | null;
  exit: { date: string; reason: string; paperExitDate: string | null; paperExitPrice: number | null } | null;
  notes: string[];
  agent: AgentView;
}

export interface TriggerStatus {
  id: string;
  ticker: string;
  kind: TriggerRule["kind"];
  state: "WAITING" | "NOT_LIVE_YET" | "FIRED" | "VOID" | "EXPIRED" | "FILE_CLOSED" | "MANUAL" | "NO_DATA";
  level: number | null;
  lastClose: number | null;
  /** How far the last close is below the level, in % of the level (negative = above). */
  gapPct: number | null;
  /** 0-1: 1 = at/through the level, 0 = 10% or more away. */
  proximity: number;
  firedOn: string | null;
  note: string | null;
  size: string | null;
  agent: AgentView;
}

export interface CheckResult {
  asOf: string;
  sessionComplete: boolean;
  /** The latest completed close the check could see across held names. */
  lastCloseDate: string | null;
  events: CheckEvent[];
  positions: PositionStatus[];
  triggers: TriggerStatus[];
  /** 0-100: how close the book is to having something to BUY. */
  opportunity: number;
  opportunityWhy: string;
  lights: { green: number; yellow: number; red: number };
  book: { value: number | null; cash: number; positionsValue: number | null; sinceStartPct: number | null; spySinceStartPct: number | null };
  context: Array<{ ticker: string; close: number | null; dayPct: number | null }>;
  missing: string[];
  closed: Array<ClosedLot & { pnlPct: number; proceeds: number }>;
  agentsAsOf: string | null;
}

// ---------------------------------------------------------------------------
// Helpers

const r2 = (n: number): number => Math.round(n * 100) / 100;
const pct = (a: number, b: number): number => (a / b - 1) * 100;
const money = (n: number): string => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Bars that count as closes: everything before today, plus today once the session is complete. */
export function completedBars(bars: Bar[] | undefined, asOf: string, sessionComplete: boolean): Bar[] {
  if (!bars) return [];
  return bars.filter((b) => b.date < asOf || (b.date === asOf && sessionComplete));
}

function avgVolumeBefore(bars: Bar[], index: number, n = 20): number | null {
  const vols: number[] = [];
  for (let i = index - 1; i >= 0 && vols.length < n; i--) {
    const v = bars[i]?.volume;
    if (typeof v === "number" && v > 0) vols.push(v);
  }
  if (vols.length < 5) return null;
  return vols.reduce((s, v) => s + v, 0) / vols.length;
}

function sma(bars: Bar[], n: number): number | null {
  if (bars.length < n) return null;
  let s = 0;
  for (const b of bars.slice(-n)) s += b.close;
  return s / n;
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** 2026-09-17 -> "Sep 17". */
export const day = (date: string): string => `${MONTHS[Number(date.slice(5, 7)) - 1] ?? "?"} ${Number(date.slice(8, 10))}`;
/** +4.3% / -12.4% with a real minus sign, for the phone. */
export const signed = (v: number, dp = 1): string => `${v >= 0 ? "+" : "\u2212"}${Math.abs(v).toFixed(dp)}%`;

/** Monday of the date's week - near-stop alerts repeat at most weekly, not daily. */
export function weekOf(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Price-based health, 0-100. 50% cushion to the stop, 25% trend vs the 20-day, 25% five-session momentum. */
export function healthScore(closes: Bar[], stop: number): number | null {
  const last = closes.at(-1);
  if (!last) return null;
  const cushion = pct(last.close, stop); // % above the stop
  const cushionScore = clamp01(cushion / 12); // 12% or more above the stop = full marks
  const ma = sma(closes, 20);
  const trendScore = ma === null ? 0.5 : clamp01(0.5 + pct(last.close, ma) / 10); // +/-5% around the 20-day
  const prior = closes.at(-6);
  const momScore = prior ? clamp01(0.5 + pct(last.close, prior.close) / 10) : 0.5;
  return Math.round(100 * (0.5 * cushionScore + 0.25 * trendScore + 0.25 * momScore));
}

const agentView = (input: CheckInput, ticker: string): AgentView => {
  const a = input.agents?.scores[ticker];
  return a && input.agents ? { ...a, asOf: input.agents.asOf } : null;
};
const agentLine = (a: AgentView): string => (a ? `Agents' score ${Math.round(a.score)}/100 (${day(a.asOf)})` : "");

// ---------------------------------------------------------------------------
// Positions

function evaluatePosition(p: PositionRule, input: CheckInput, events: CheckEvent[]): PositionStatus {
  const { book, asOf, sessionComplete } = input;
  const all = input.bars[p.ticker] ?? [];
  const closes = completedBars(all, asOf, sessionComplete);
  const since = closes.filter((b) => b.date >= p.fillDate);
  const last = closes.at(-1) ?? null;
  const live = input.live?.[p.ticker] ?? null;
  const notes = [...(p.notes ?? [])];

  // First close below the stop, or first session a context leg fired - whichever came first.
  let exit: PositionStatus["exit"] = null;
  const stopBar = since.find((b) => b.close < p.stop);
  if (stopBar) exit = { date: stopBar.date, reason: `closed ${money(stopBar.close)} < stop ${money(p.stop)}`, paperExitDate: null, paperExitPrice: null };
  let legKind: "STOP_HIT" | "EXIT_LEG" = "STOP_HIT";

  for (const leg of p.legs ?? []) {
    const ctx = completedBars(input.bars[leg.ticker.toUpperCase()], asOf, sessionComplete);
    if (ctx.length < leg.sessions + 1) { notes.push(`${leg.ticker} leg unchecked (needs ${leg.sessions + 1} sessions of data, have ${ctx.length}).`); continue; }
    for (let i = leg.sessions; i < ctx.length; i++) {
      const bar = ctx[i] as Bar;
      if (bar.date < p.fillDate) continue;
      let low = Infinity;
      for (let j = i - leg.sessions; j < i; j++) low = Math.min(low, (ctx[j] as Bar).close);
      if (bar.close < low) {
        if (!exit || bar.date < exit.date) {
          exit = { date: bar.date, reason: `${leg.ticker} closed ${money(bar.close)} < its prior ${leg.sessions}-session low close ${money(low)}`, paperExitDate: null, paperExitPrice: null };
          legKind = "EXIT_LEG";
        }
        break;
      }
    }
  }

  if (exit) {
    // Plan: exit at the next session's open.
    const next = all.find((b) => b.date > (exit as NonNullable<typeof exit>).date);
    if (next && next.open !== null) { exit.paperExitDate = next.date; exit.paperExitPrice = next.open; }
    const px = exit.paperExitPrice !== null
      ? `Paper exit: ${p.shares} sh at the ${exit.paperExitDate} open ${money(exit.paperExitPrice)} (${pct(exit.paperExitPrice, p.fill) >= 0 ? "+" : ""}${pct(exit.paperExitPrice, p.fill).toFixed(1)}% vs fill ${money(p.fill)}).`
      : "Plan says exit at the next open.";
    const sinceEntry = exit.paperExitPrice !== null ? pct(exit.paperExitPrice, p.fill) : last ? pct(last.close, p.fill) : null;
    events.push({
      phone: {
        title: `SELL ${p.ticker} \u00b7 ${legKind === "STOP_HIT" ? "stop hit" : "exit rule"}`,
        lines: [
          `${legKind === "STOP_HIT" ? `Closed ${money((stopBar as Bar).close)}, under the ${money(p.stop)} stop` : exit.reason.replace(" < its prior ", ", under its ").replace("-session low close", "-day low")} (${day(exit.date)})`,
          exit.paperExitPrice !== null ? `Paper exit ${day(exit.paperExitDate as string)} open ${money(exit.paperExitPrice)} \u00b7 ${p.shares} sh` : `Sell ${p.shares} sh at the next open`,
          sinceEntry !== null ? `Since entry ${signed(sinceEntry)}` : "",
          agentLine(agentView(input, p.ticker)),
        ].filter(Boolean),
      },
      key: `${legKind}:${p.ticker}:${exit.date}`, kind: legKind, ticker: p.ticker, date: exit.date, level: 1,
      title: `SELL ${p.ticker} - ${legKind === "STOP_HIT" ? "stop hit" : "exit rule fired"} (${exit.date})`,
      text: `${legKind === "STOP_HIT" ? `${p.ticker} ${exit.reason}` : `${p.ticker} exit rule: ${exit.reason}`} on ${exit.date}. ${px}`,
    });
  }

  const cushionPct = last ? r2(pct(last.close, p.stop)) : null;
  if (!exit && last && cushionPct !== null && cushionPct >= 0 && cushionPct <= book.nearStopPct) {
    events.push({
      phone: { title: `${p.ticker} is close to its stop`, lines: [`Closed ${money(last.close)} \u00b7 stop ${money(p.stop)} \u00b7 ${cushionPct.toFixed(1)}% cushion`, "No action unless it CLOSES below the stop."] },
      key: `NEAR_STOP:${p.ticker}:${weekOf(last.date)}`, kind: "NEAR_STOP", ticker: p.ticker, date: last.date, level: 2,
      title: `${p.ticker} is near its stop`,
      text: `${p.ticker} closed ${money(last.close)} on ${last.date}, ${cushionPct.toFixed(1)}% above its stop ${money(p.stop)}. No action - a close below the stop is the rule.`,
    });
  }
  if (!exit && !sessionComplete && typeof live === "number" && live < p.stop) {
    events.push({
      phone: { title: `Heads-up: ${p.ticker} is under its stop`, lines: [`Now ${money(live)} \u00b7 stop ${money(p.stop)}`, "Only the 4pm close counts. If it stays here you get a SELL alert after the bell."] },
      key: `HEADS_UP:${p.ticker}:${asOf}`, kind: "HEADS_UP", ticker: p.ticker, date: asOf, level: 2,
      title: `Heads-up: ${p.ticker} is trading below its stop`,
      text: `${p.ticker} is at ${money(live)}, below its stop ${money(p.stop)}. Nothing to do yet - the rule is the daily CLOSE. If it closes down here, the after-close check will say SELL.`,
    });
  }

  const mark = typeof live === "number" && !sessionComplete ? live : last?.close ?? null;
  const light: Light = exit ? "RED" : cushionPct !== null && cushionPct <= book.nearStopPct ? "YELLOW" : last ? "GREEN" : "YELLOW";
  if (!last) notes.push("No price data.");
  return {
    ticker: p.ticker, light,
    health: exit ? 0 : healthScore(closes, p.stop),
    lastClose: last?.close ?? null, lastCloseDate: last?.date ?? null, live: typeof live === "number" ? live : null,
    stop: p.stop, cushionPct,
    pnlPct: mark !== null ? r2(pct(exit?.paperExitPrice ?? mark, p.fill)) : null,
    value: mark !== null ? r2(p.shares * (exit?.paperExitPrice ?? mark)) : null,
    exit, notes, agent: agentView(input, p.ticker),
  };
}

// ---------------------------------------------------------------------------
// Triggers

/** `exitDate`: the day the held position's exit rule fired - an ADD to a name that has been sold is moot. */
function evaluateTrigger(t: TriggerRule, input: CheckInput, events: CheckEvent[], exitDate: string | null = null): TriggerStatus {
  const { asOf, sessionComplete } = input;
  const all = input.bars[t.ticker] ?? [];
  const closes = completedBars(all, asOf, sessionComplete);
  const last = closes.at(-1) ?? null;
  const level = t.closeAbove ?? null;
  const base: TriggerStatus = {
    id: t.id, ticker: t.ticker, kind: t.kind, state: "WAITING", level,
    lastClose: last?.close ?? null, gapPct: null, proximity: 0, firedOn: null, note: t.note ?? null,
    size: t.size ?? null, agent: agentView(input, t.ticker),
  };
  if (!last) return { ...base, state: "NO_DATA" };
  if (t.kind === "ADD" && !input.book.positions.some((p) => p.ticker === t.ticker)) {
    return { ...base, state: "VOID", note: "No open position to add to." };
  }
  if (t.manual || level === null) return { ...base, state: asOf < (t.notBefore ?? "") ? "NOT_LIVE_YET" : "MANUAL" };

  const gapPct = r2((level - last.close) / level * 100);
  const proximity = clamp01(1 - gapPct / 10);
  const verb = t.kind === "REOPEN" ? "RE-OPEN" : t.kind === "ENTER" ? "BUY (enter)" : "BUY (add)";
  const need = t.consecutive ?? 1;
  let run = 0;
  // A rule cannot fire before it existed. Without this, a level the stock traded above months
  // ago "fires" on the first run (2026-09-17: KTOS/CDRE/HII buys dated July were sent to the phone).
  const liveFrom = t.notBefore && t.notBefore > input.book.cycle.start ? t.notBefore : input.book.cycle.start;

  for (let i = 0; i < closes.length; i++) {
    const b = closes[i] as Bar;
    if (b.date < liveFrom) continue;
    if (t.notAfter && b.date > t.notAfter) break;
    if (t.kind === "ADD" && exitDate && b.date >= exitDate) break;

    if (typeof t.voidIfCloseBelow === "number" && (!t.voidOn || b.date === t.voidOn) && b.close < t.voidIfCloseBelow) {
      events.push({
        key: `TRIGGER_VOID:${t.id}:${b.date}`, kind: "TRIGGER_VOID", ticker: t.ticker, date: b.date, level: 3,
        title: `${t.ticker} add rule cancelled`,
        text: `${t.ticker} closed ${money(b.close)} on ${b.date}, below ${money(t.voidIfCloseBelow)} - the ${t.kind.toLowerCase()} rule (${t.id}) is void. ${t.note ?? ""}`.trim(),
      });
      return { ...base, state: "VOID", gapPct, proximity: 0, firedOn: b.date };
    }
    if (typeof t.closeFileBelow === "number" && b.close < t.closeFileBelow) {
      events.push({
        key: `FILE_CLOSED:${t.id}:${b.date}`, kind: "FILE_CLOSED", ticker: t.ticker, date: b.date, level: 3,
        title: `${t.ticker} file closed`,
        text: `${t.ticker} closed ${money(b.close)} on ${b.date}, below ${money(t.closeFileBelow)} - the plan closes the file on this name.`,
      });
      return { ...base, state: "FILE_CLOSED", gapPct, proximity: 0, firedOn: b.date };
    }

    let ok = b.close > level;
    if (ok && t.volumeRatio) {
      const avg = avgVolumeBefore(closes, i);
      ok = avg !== null && typeof b.volume === "number" && b.volume >= t.volumeRatio * avg;
    }
    run = ok ? run + 1 : 0;
    if (run >= need) {
      const how = [
        `closed ${money(b.close)} > ${money(level)}`,
        t.volumeRatio ? `on volume >= ${t.volumeRatio}x its 20-day average` : "",
        need > 1 ? `for ${need} closes in a row` : "",
      ].filter(Boolean).join(" ");
      events.push({
        phone: t.kind === "REOPEN"
          ? { title: `${t.ticker} is back on the list`, lines: [`Closed ${money(b.close)}, over ${money(level)} (${day(b.date)})`, "Not a buy yet - it has earned a fresh committee run.", t.note && !/not a buy/i.test(t.note) ? t.note : ""].filter(Boolean) }
          : { title: `BUY ${t.ticker}${t.size ? ` ${t.size}` : ""} \u00b7 trigger hit`, lines: [`Closed ${money(b.close)}, over ${money(level)} (${day(b.date)})`, `${t.kind === "ENTER" ? "Enter" : "Add"}${t.size ? ` ${t.size}` : ""} at the next open`, t.stopIfFilled ? `Stop once filled: close under ${money(t.stopIfFilled)}` : "", agentLine(agentView(input, t.ticker)), t.note ?? ""].filter(Boolean) },
        key: `${t.kind === "REOPEN" ? "REOPEN" : "TRIGGER"}:${t.id}:${b.date}`,
        kind: t.kind === "REOPEN" ? "REOPEN" : "TRIGGER", ticker: t.ticker, date: b.date, level: t.kind === "REOPEN" ? 2 : 1,
        title: `${verb} ${t.ticker}${t.size ? ` ${t.size}` : ""} - trigger fired (${b.date})`,
        text: `${t.ticker} ${how} on ${b.date}. Plan: ${t.kind === "REOPEN" ? "re-open the file (candidate for a committee run - not a buy yet)" : `${t.kind === "ENTER" ? "enter" : "add"}${t.size ? ` ${t.size}` : ""} at the next open`}.${t.stopIfFilled ? ` Stop if filled: close < ${money(t.stopIfFilled)}.` : ""}${t.note ? ` ${t.note}` : ""}`,
      });
      return { ...base, state: "FIRED", gapPct, proximity: 1, firedOn: b.date };
    }
  }

  if (t.kind === "ADD" && exitDate) return { ...base, state: "VOID", gapPct, proximity: 0, note: `Position exited ${exitDate} - nothing to add to.` };
  if (t.notAfter && asOf > t.notAfter) return { ...base, state: "EXPIRED", gapPct, proximity: 0 };
  if (t.notBefore && asOf < t.notBefore) return { ...base, state: "NOT_LIVE_YET", gapPct, proximity: proximity * 0.5 };
  if (t.reviewIfUntriggeredBy && asOf >= t.reviewIfUntriggeredBy) {
    events.push({
      key: `TRIGGER_REVIEW:${t.id}`, kind: "TRIGGER_REVIEW", ticker: t.ticker, date: asOf, level: 3,
      title: `${t.ticker} review`,
      text: `${t.ticker} has not triggered (${money(last.close)} vs ${money(level)}) by ${t.reviewIfUntriggeredBy} - the plan says review it.`,
    });
  }
  const live = input.live?.[t.ticker];
  if (!sessionComplete && typeof live === "number" && live > level && t.kind !== "REOPEN") {
    events.push({
      phone: { title: `Heads-up: ${t.ticker} is over its buy level`, lines: [`Now ${money(live)} \u00b7 level ${money(level)}`, "Only the 4pm close counts. If it holds you get a BUY alert after the bell."] },
      key: `HEADS_UP:${t.id}:${asOf}`, kind: "HEADS_UP", ticker: t.ticker, date: asOf, level: 2,
      title: `Heads-up: ${t.ticker} is above its buy level`,
      text: `${t.ticker} is at ${money(live)}, above its trigger ${money(level)}. Nothing to do yet - the rule is the daily CLOSE.`,
    });
  }
  return { ...base, gapPct, proximity };
}

// ---------------------------------------------------------------------------
// The check

export function runCheck(input: CheckInput): CheckResult {
  const { book, asOf, sessionComplete } = input;
  const events: CheckEvent[] = [];
  const positions = book.positions.map((p) => evaluatePosition(p, input, events));
  const exitOf = new Map(positions.map((p) => [p.ticker, p.exit?.date ?? null]));
  const triggers = book.triggers.map((t) => evaluateTrigger(t, input, events, exitOf.get(t.ticker) ?? null));

  for (const c of book.calendar) {
    if (c.date === asOf) events.push({ key: `CALENDAR:${c.date}`, kind: "CALENDAR", ticker: null, date: asOf, level: 3, title: "On the calendar today", text: c.text });
  }

  // Opportunity: how close the book is to a BUY. Buys (ADD/ENTER) count fully, re-opens at 60%.
  const scored = triggers
    .filter((t) => t.state === "WAITING" || t.state === "NOT_LIVE_YET" || (t.state === "FIRED" && t.firedOn !== null && t.firedOn >= recentCutoff(input)))
    .map((t) => ({ t, w: t.proximity * (t.kind === "REOPEN" ? 0.6 : 1) }))
    .sort((a, b) => b.w - a.w);
  const best = scored[0]?.w ?? 0;
  const top3 = scored.slice(0, 3);
  const avg3 = top3.length ? top3.reduce((s, x) => s + x.w, 0) / 3 : 0;
  const opportunity = Math.round(100 * (0.6 * best + 0.4 * avg3));
  const lead = scored[0]?.t;
  const opportunityWhy = !lead || best === 0
    ? "No buy trigger is within 10% of its level."
    : lead.state === "FIRED"
      ? (lead.kind === "REOPEN" ? `${lead.ticker} crossed its watch level on ${day(lead.firedOn ?? "")} - worth a fresh committee look.` : `${lead.ticker} buy trigger fired on ${day(lead.firedOn ?? "")}.`)
      : `Closest: ${lead.ticker} ${lead.lastClose !== null ? money(lead.lastClose) : "?"} vs ${lead.level !== null ? money(lead.level) : "?"} (${(lead.gapPct ?? 0).toFixed(1)}% away${lead.state === "NOT_LIVE_YET" ? ", rule not live yet" : ""}).`;

  const lights = { green: 0, yellow: 0, red: 0 };
  for (const p of positions) lights[p.light === "GREEN" ? "green" : p.light === "YELLOW" ? "yellow" : "red"]++;

  const values = positions.map((p) => p.value);
  const positionsValue = values.every((v): v is number => v !== null) ? r2(values.reduce((s, v) => s + v, 0)) : null;
  const bookValue = positionsValue !== null ? r2(positionsValue + book.cycle.cash) : null;
  const spy = completedBars(input.bars["SPY"], asOf, sessionComplete);
  const spyStart = spy.find((b) => b.date >= book.cycle.start);
  const spyLast = spy.at(-1);

  const context = book.context.map((ticker) => {
    const c = completedBars(input.bars[ticker], asOf, sessionComplete);
    const a = c.at(-1); const b = c.at(-2);
    return { ticker, close: a?.close ?? null, dayPct: a && b ? r2(pct(a.close, b.close)) : null };
  });

  const missing = tickersFor(book).filter((t) => !(input.bars[t]?.length));
  const lastCloseDate = positions.map((p) => p.lastCloseDate).filter((d): d is string => d !== null).sort().at(-1) ?? null;

  // Most urgent first, then oldest first (so a catch-up reads in order).
  events.sort((a, b) => a.level - b.level || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return {
    asOf, sessionComplete, lastCloseDate, events, positions, triggers, opportunity, opportunityWhy, lights,
    book: {
      value: bookValue, cash: book.cycle.cash, positionsValue,
      sinceStartPct: bookValue !== null ? r2(pct(bookValue, book.cycle.notional)) : null,
      spySinceStartPct: spyStart && spyLast ? r2(pct(spyLast.close, spyStart.close)) : null,
    },
    context, missing,
    closed: (book.closed ?? []).map((l) => ({ ...l, pnlPct: r2(pct(l.exitPrice, l.fill)), proceeds: r2(l.shares * l.exitPrice) })),
    agentsAsOf: input.agents?.asOf ?? null,
  };
}

/** A fired buy keeps the Opportunity score up for five calendar days, then drops out. */
function recentCutoff(input: CheckInput): string {
  const d = new Date(`${input.asOf}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 5);
  return d.toISOString().slice(0, 10);
}
