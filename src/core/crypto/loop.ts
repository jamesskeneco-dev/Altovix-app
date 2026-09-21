import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { LlmClient } from "../llm/types.ts";
import { runCommittee, type CommitteeRunResult } from "../committee/run.ts";
import type { DecisionOut } from "../agents/decision.ts";
import { upsertBars } from "../market/index.ts";
import {
  candlesToBars, roundPrice, volumeForUsd, type Candle, type ClosedOrder, type OrderRequest, type OrderResult, type PairInfo, type Ticker,
} from "../market/kraken.ts";
import { scan, type ScanRow } from "./scan.ts";
import {
  applyBuy, applySell, dayPnl, evaluateBuy, exitCheck, killSwitchOn, markHighWater, utcDay,
  type CryptoPosition, type CryptoRules, type CryptoState, type CryptoTradeRecord, type ExitReason,
} from "./guard.ts";
import { cryptoOperatorNotes } from "./committee.ts";

/**
 * One cycle of the crypto sleeve: mark positions -> protective exits -> scan -> committee on
 * the best few -> guarded entries. The exchange is an interface so the whole cycle runs in
 * tests against a fake; `src/cli/kraken.ts` wires the real one.
 *
 * Money only moves when rules.live is true AND the guard says yes AND Kraken accepts the
 * order. With live=false every order is still validated by Kraken (so a broken key, a
 * too-small size or a bad pair shows up now), and fills are simulated at the quoted price
 * into a separate paper state file. Nothing in live mode reads the paper file.
 */

export interface Exchange {
  pairs(): Promise<PairInfo[]>;
  tickers(altnames?: string[]): Promise<Ticker[]>;
  ohlc(altname: string, interval: 1440): Promise<Candle[]>;
  addOrder(req: OrderRequest): Promise<OrderResult>;
  queryOrders(txids: string[]): Promise<ClosedOrder[]>;
}

export interface CycleEvent {
  at: string;
  kind: "EXIT" | "ENTRY" | "VALIDATED" | "REFUSED" | "HALT" | "ERROR" | "INFO";
  symbol?: string;
  message: string;
  usd?: number;
  runId?: number;
}

export interface CycleResult {
  at: string;
  live: boolean;
  killSwitch: boolean;
  scanned: number;
  candidates: ScanRow[];
  events: CycleEvent[];
  committeeRuns: Array<{ symbol: string; runId: number; action: string | null; confidence: number | null; sizePct: number | null }>;
  state: CryptoState;
  marks: Record<string, number>;
  dayPnl: { realized: number; unrealized: number; total: number };
  summary: string;
}

export interface CycleOptions {
  conn: DatabaseSync;
  exchange: Exchange;
  rules: CryptoRules;
  state: CryptoState;
  llm?: LlmClient;
  now?: Date;
  /** Skip the committee (scan and manage exits only). */
  noCommittee?: boolean;
  /** How many top scanner rows to fetch daily candles for. */
  candlePool?: number;
  /** Lowest scanner score the committee is asked about. */
  minScanScore?: number;
  journalFile?: string | null;
  onEvent?: (e: CycleEvent) => void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runCycle(o: CycleOptions): Promise<CycleResult> {
  const now = o.now ?? new Date();
  const at = now.toISOString();
  const day = utcDay(at);
  const events: CycleEvent[] = [];
  const note = (e: Omit<CycleEvent, "at">): void => { const ev = { at, ...e }; events.push(ev); o.onEvent?.(ev); journal(o.journalFile, ev); };
  const sleep = o.sleep ?? defaultSleep;
  let state = structuredClone(o.state);
  const rules = o.rules;
  const kill = killSwitchOn(rules);
  if (kill) note({ kind: "INFO", message: `kill switch is on (${rules.killSwitchFile}) - no new entries; protective exits still run` });

  // A daily halt clears itself when the UTC day turns over.
  if (state.halted && utcDay(state.halted.at) !== day) { note({ kind: "INFO", message: `halt from ${state.halted.at} cleared (new UTC day)` }); state.halted = null; }

  // --- 1. market snapshot ---------------------------------------------------------
  const pairs = (await o.exchange.pairs()).filter((p) => p.quote.toUpperCase() === rules.quote.toUpperCase());
  const byAlt = new Map(pairs.map((p) => [p.altname, p] as const));
  const bySym = new Map(pairs.map((p) => [p.symbol, p] as const));
  const ticks = await o.exchange.tickers();
  const tickByAlt = new Map(ticks.map((t) => [t.altname, t] as const));

  const marks: Record<string, number> = {};
  for (const p of state.positions) {
    const t = tickByAlt.get(p.altname);
    if (t) marks[p.symbol] = t.last;
  }
  state = markHighWater(state, marks);

  // --- 2. protective exits ----------------------------------------------------------
  for (const pos of [...state.positions]) {
    const t = tickByAlt.get(pos.altname);
    const pair = byAlt.get(pos.altname);
    if (!t || !pair) { note({ kind: "ERROR", symbol: pos.symbol, message: `no quote for ${pos.altname} - cannot check its stop` }); continue; }
    const hit = exitCheck(pos, t.last, rules, now);
    if (!hit) continue;
    try {
      const filled = await sell(o.exchange, pair, pos, t, rules, hit.reason, sleep);
      note({ kind: rules.live ? "EXIT" : "VALIDATED", symbol: pos.symbol, usd: filled.usd, runId: pos.committeeRunId ?? undefined,
        message: `${hit.reason} ${pos.symbol}: ${rules.live ? "sold" : "would sell"} ${pos.volume} @ ~$${filled.price} (level $${hit.level.toPrecision(5)}), P&L $${(filled.usd - filled.fee - pos.avgCost * pos.volume).toFixed(2)}` });
      state = applySell(state, filled);
      delete marks[pos.symbol];
    } catch (err) {
      note({ kind: "ERROR", symbol: pos.symbol, message: `${hit.reason} exit for ${pos.symbol} failed: ${(err as Error).message}` });
    }
  }

  // --- 3. daily loss halt -----------------------------------------------------------
  let pnl = dayPnl(state, day, marks);
  if (!state.halted && pnl.total <= -rules.maxDailyLossUsd) {
    state.halted = { at, reason: `day P&L $${pnl.total.toFixed(2)} breached -$${rules.maxDailyLossUsd}` };
    note({ kind: "HALT", message: `HALTED: ${state.halted.reason}. No new buys until the next UTC day.` });
  }

  // --- 4. scan ------------------------------------------------------------------------
  const pool = o.candlePool ?? 40;
  const ranked = pairs
    .map((p) => ({ p, t: tickByAlt.get(p.altname) }))
    .filter((x): x is { p: PairInfo; t: Ticker } => Boolean(x.t))
    .map((x) => ({ ...x, usd: x.t.volume24h * (x.t.vwap24h > 0 ? x.t.vwap24h : x.t.last) }))
    .filter((x) => x.usd >= rules.minVolume24hUsd && !rules.excludeAssets.includes(x.p.base.toUpperCase()) && x.p.status === "online")
    .sort((a, b) => b.usd - a.usd)
    .slice(0, pool);

  const inputs = [];
  for (const x of ranked) {
    try {
      const candles = await o.exchange.ohlc(x.p.altname, 1440);
      inputs.push({ pair: x.p, ticker: x.t, candles });
    } catch (err) {
      note({ kind: "ERROR", symbol: x.p.symbol, message: `candles for ${x.p.altname}: ${(err as Error).message}` });
    }
  }
  const rows = scan(inputs, rules);
  const candles = new Map(inputs.map((i) => [i.pair.symbol, i.candles] as const));

  // --- 5. committee on the best few ---------------------------------------------------
  const committeeRuns: CycleResult["committeeRuns"] = [];
  const minScore = o.minScanScore ?? 45;
  const held = new Set(state.positions.map((p) => p.symbol));
  const shortlist = rows.filter((r) => !r.excluded && r.score >= minScore && !held.has(r.symbol)).slice(0, rules.maxCommitteeRunsPerCycle);

  if (!o.noCommittee && shortlist.length && !kill && !state.halted) {
    // Benchmarks first so relative strength has something to compare against.
    for (const b of ["BTC-USD", "ETH-USD"]) {
      const pair = bySym.get(b);
      if (!pair) continue;
      const c = candles.get(b) ?? (await o.exchange.ohlc(pair.altname, 1440).catch(() => [] as Candle[]));
      if (c.length) upsertBars(o.conn, b, candlesToBars(c, true), "kraken");
    }
    for (const row of shortlist) {
      const pair = bySym.get(row.symbol);
      const tick = tickByAlt.get(row.altname);
      const c = candles.get(row.symbol);
      if (!pair || !tick || !c) continue;
      upsertBars(o.conn, row.symbol, candlesToBars(c, true), "kraken");
      let res: CommitteeRunResult;
      try {
        res = await runCommittee(o.conn, row.symbol, {
          llm: o.llm, mandate: "NEW_POSITION", assetClass: "CRYPTO",
          asOf: candlesToBars(c, true).at(-1)?.date,
          operatorNotes: cryptoOperatorNotes(row, rules, state),
        });
      } catch (err) {
        note({ kind: "ERROR", symbol: row.symbol, message: `committee on ${row.symbol} failed: ${(err as Error).message}` });
        continue;
      }
      committeeRuns.push({ symbol: row.symbol, runId: res.runId, action: res.action, confidence: res.confidence, sizePct: res.sizePct });
      if (res.status !== "COMPLETE") { note({ kind: "ERROR", symbol: row.symbol, runId: res.runId, message: `run #${res.runId} on ${row.symbol} failed: ${res.error}` }); continue; }
      const decision = res.outputs.decision as DecisionOut | undefined;
      if (!decision || decision.action !== "BUY") { note({ kind: "INFO", symbol: row.symbol, runId: res.runId, message: `run #${res.runId}: ${decision?.action ?? "no decision"} ${row.symbol} (confidence ${decision?.confidence?.toFixed(2) ?? "n/a"})` }); continue; }

      const wantUsd = (decision.sizePct / 100) * rules.sleeveUsd;
      const verdict = evaluateBuy({ symbol: row.symbol, usd: wantUsd, confidence: decision.confidence, price: tick.ask, volume24hUsd: row.volume24hUsd }, rules, state, { now, marks, killSwitch: kill });
      if (!verdict.ok) { note({ kind: "REFUSED", symbol: row.symbol, runId: res.runId, message: `BUY ${row.symbol} refused by the guard: ${verdict.reasons.join("; ")}` }); continue; }

      try {
        const filled = await buy(o.exchange, pair, tick, verdict.usd, rules, sleep);
        if (!filled) { note({ kind: "REFUSED", symbol: row.symbol, runId: res.runId, message: `BUY ${row.symbol}: $${verdict.usd} is under Kraken's minimum for ${pair.altname} (min ${pair.orderMin} / $${pair.costMin})` }); continue; }
        filled.committeeRunId = res.runId;
        state = applyBuy(state, filled, rules, pair.altname, res.runId, decision.rationale);
        marks[row.symbol] = tick.last;
        note({ kind: rules.live ? "ENTRY" : "VALIDATED", symbol: row.symbol, usd: filled.usd, runId: res.runId,
          message: `${rules.live ? "BOUGHT" : "would buy"} ${filled.volume} ${row.symbol} @ ~$${filled.price} = $${filled.usd.toFixed(2)} (run #${res.runId}, conf ${decision.confidence.toFixed(2)}, setup ${row.setup})${verdict.reasons.length ? ` [${verdict.reasons.join("; ")}]` : ""}` });
      } catch (err) {
        note({ kind: "ERROR", symbol: row.symbol, runId: res.runId, message: `BUY ${row.symbol} failed at Kraken: ${(err as Error).message}` });
      }
    }
  } else if (!o.noCommittee && !shortlist.length) {
    note({ kind: "INFO", message: `no scanner row scored ${minScore}+ that is not already held - committee not convened` });
  }

  pnl = dayPnl(state, day, marks);
  state.lastCycleAt = at;
  const fired = events.filter((e) => e.kind === "ENTRY" || e.kind === "EXIT" || e.kind === "VALIDATED" || e.kind === "HALT");
  const summary = `${rules.live ? "LIVE" : "VALIDATE"} ${at.slice(0, 16)}Z: ${rows.filter((r) => !r.excluded).length} scanned, ${committeeRuns.length} committee run${committeeRuns.length === 1 ? "" : "s"}, ${fired.length} action${fired.length === 1 ? "" : "s"}; ${state.positions.length} open, day P&L $${pnl.total.toFixed(2)}`;
  state.lastCycleSummary = summary;

  return { at, live: rules.live, killSwitch: kill, scanned: rows.length, candidates: rows.slice(0, 15), events, committeeRuns, state, marks, dayPnl: pnl, summary };
}

// ---------------------------------------------------------------------------
// Orders

/** Limit-IOC just above the ask: fills like a market order but cannot chase more than the slippage cap. */
async function buy(ex: Exchange, pair: PairInfo, tick: Ticker, usd: number, rules: CryptoRules, sleep: (ms: number) => Promise<void>): Promise<CryptoTradeRecord | null> {
  const price = roundPrice(tick.ask * (1 + rules.entrySlippagePct), pair);
  const volume = volumeForUsd(usd, price, pair);
  if (volume === null) return null;
  const res = await ex.addOrder({ altname: pair.altname, side: "buy", ordertype: "limit", volume, price, timeinforce: "IOC", deadlineSeconds: 30, live: rules.live });
  const fill = rules.live ? await settle(ex, res.txids, sleep) : null;
  const filledVol = fill?.executed ?? volume;
  const avg = fill?.avgPrice ?? tick.ask;
  if (rules.live && filledVol <= 0) throw new Error(`IOC order ${res.txids.join(",")} did not fill (${res.description})`);
  return { at: new Date().toISOString(), symbol: pair.symbol, side: "BUY", volume: filledVol, price: avg, usd: filledVol * avg, fee: fill?.fee ?? 0, reason: "committee BUY", txids: res.txids, clientId: res.clientId, live: rules.live };
}

async function sell(ex: Exchange, pair: PairInfo, pos: CryptoPosition, tick: Ticker, rules: CryptoRules, reason: ExitReason, sleep: (ms: number) => Promise<void>): Promise<CryptoTradeRecord> {
  const res = await ex.addOrder({ altname: pair.altname, side: "sell", ordertype: "market", volume: pos.volume, deadlineSeconds: 30, live: rules.live });
  const fill = rules.live ? await settle(ex, res.txids, sleep) : null;
  const filledVol = fill?.executed ?? pos.volume;
  const avg = fill?.avgPrice ?? tick.bid;
  if (rules.live && filledVol <= 0) throw new Error(`market sell ${res.txids.join(",")} did not fill (${res.description})`);
  return { at: new Date().toISOString(), symbol: pair.symbol, side: "SELL", volume: filledVol, price: avg, usd: filledVol * avg, fee: fill?.fee ?? 0, reason, txids: res.txids, clientId: res.clientId, live: rules.live };
}

/** Poll a placed order until it is closed (IOC/market orders close within seconds). */
async function settle(ex: Exchange, txids: string[], sleep: (ms: number) => Promise<void>): Promise<ClosedOrder | null> {
  if (!txids.length) return null;
  for (let i = 0; i < 10; i++) {
    const orders = await ex.queryOrders(txids);
    const o = orders[0];
    if (o && (o.status === "closed" || o.status === "canceled" || o.status === "expired")) return o;
    await sleep(1000);
  }
  const last = (await ex.queryOrders(txids))[0];
  return last ?? null;
}

// ---------------------------------------------------------------------------
// Files

function journal(file: string | null | undefined, e: CycleEvent): void {
  if (!file) return;
  const path = resolve(process.cwd(), file);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(e) + "\n");
}

export interface CryptoStatus {
  generatedAt: string;
  mode: "LIVE" | "VALIDATE";
  killSwitch: boolean;
  halted: CryptoState["halted"];
  sleeveUsd: number;
  exposureUsd: number;
  dayPnl: CycleResult["dayPnl"];
  positions: Array<CryptoPosition & { mark: number | null; unrealizedUsd: number | null; unrealizedPct: number | null; trail: number }>;
  candidates: ScanRow[];
  events: CycleEvent[];
  committeeRuns: CycleResult["committeeRuns"];
  recentTrades: CryptoTradeRecord[];
  summary: string;
}

export function buildStatus(r: CycleResult, rules: CryptoRules): CryptoStatus {
  return {
    generatedAt: r.at,
    mode: r.live ? "LIVE" : "VALIDATE",
    killSwitch: r.killSwitch,
    halted: r.state.halted,
    sleeveUsd: rules.sleeveUsd,
    exposureUsd: r.state.positions.reduce((s, p) => s + p.costUsd, 0),
    dayPnl: r.dayPnl,
    positions: r.state.positions.map((p) => {
      const mark = r.marks[p.symbol] ?? null;
      return { ...p, mark, unrealizedUsd: mark === null ? null : (mark - p.avgCost) * p.volume, unrealizedPct: mark === null ? null : mark / p.avgCost - 1, trail: p.highWater * (1 - rules.trailPct) };
    }),
    candidates: r.candidates,
    events: r.events,
    committeeRuns: r.committeeRuns,
    recentTrades: r.state.trades.slice(-20).reverse(),
    summary: r.summary,
  };
}

export function writeStatus(status: CryptoStatus, file: string): void {
  const path = resolve(process.cwd(), file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(status, null, 2) + "\n");
}
