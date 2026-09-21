import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The crypto sleeve's hard limits and its memory.
 *
 * `rules/crypto.json` is the ceiling; `data/crypto-state.json` is what has happened under it.
 * `evaluate()` is a pure function of (proposed order, rules, state, clock) -> allowed or not,
 * with every reason listed. It is the only gate between "the committee said BUY" and an
 * order that spends real money, so it is unit-tested to the edge (test/crypto.test.ts).
 */

export interface CryptoRules {
  version: number;
  updated?: string;
  notes?: string[];
  /** false: validate every order with Kraken, send nothing. */
  live: boolean;
  /** The most the sleeve may hold in open positions, USD at cost. */
  sleeveUsd: number;
  maxOrderUsd: number;
  maxPositionUsd: number;
  maxPositions: number;
  /** Realised + unrealised loss over the current UTC day that halts new buys. */
  maxDailyLossUsd: number;
  maxDailyBuys: number;
  maxCommitteeRunsPerCycle: number;
  /** Decision agent confidence below this never trades. */
  minConfidence: number;
  /** Hours after any trade in a pair before it may be entered again. */
  cooldownHours: number;
  stopPct: number;
  takeProfitPct: number;
  trailPct: number;
  maxHoldDays: number;
  /** Entry limit orders sit this far above the ask (IOC), capping slippage. */
  entrySlippagePct: number;
  minVolume24hUsd: number;
  minPriceUsd: number;
  quote: string;
  excludeAssets: string[];
  blocklist: string[];
  watchOnly: string[];
  killSwitchFile: string;
}

export interface CryptoPosition {
  symbol: string;
  altname: string;
  volume: number;
  avgCost: number;
  costUsd: number;
  openedAt: string;
  /** Highest price seen since entry - the trailing stop hangs off it. */
  highWater: number;
  stop: number;
  takeProfit: number;
  committeeRunId: number | null;
  entryTxids: string[];
  entryClientId: string;
  thesis: string;
}

export interface CryptoTradeRecord {
  at: string;
  symbol: string;
  side: "BUY" | "SELL";
  volume: number;
  price: number;
  usd: number;
  fee: number;
  reason: string;
  txids: string[];
  clientId: string;
  live: boolean;
  /** Realised P&L in USD for a SELL, net of the entry cost. */
  realized?: number;
  committeeRunId?: number | null;
}

export interface CryptoState {
  version: 1;
  positions: CryptoPosition[];
  trades: CryptoTradeRecord[];
  /** UTC day -> figures, so a daily-loss halt resets at midnight UTC and not before. */
  days: Record<string, { buys: number; sells: number; realized: number; fees: number }>;
  /** Pair -> ISO time of the last trade in it (cooldown). */
  lastTradeAt: Record<string, string>;
  halted: { at: string; reason: string } | null;
  lastCycleAt: string | null;
  lastCycleSummary: string | null;
}

export const EMPTY_STATE: CryptoState = { version: 1, positions: [], trades: [], days: {}, lastTradeAt: {}, halted: null, lastCycleAt: null, lastCycleSummary: null };

const DEFAULTS: CryptoRules = {
  version: 1, live: false, sleeveUsd: 400, maxOrderUsd: 100, maxPositionUsd: 120, maxPositions: 4,
  maxDailyLossUsd: 40, maxDailyBuys: 4, maxCommitteeRunsPerCycle: 2, minConfidence: 0.58, cooldownHours: 12,
  stopPct: 0.12, takeProfitPct: 0.40, trailPct: 0.15, maxHoldDays: 21, entrySlippagePct: 0.004,
  minVolume24hUsd: 3_000_000, minPriceUsd: 0.0005, quote: "USD", excludeAssets: [], blocklist: [], watchOnly: [],
  killSwitchFile: "./data/crypto-KILL",
};

export function parseRules(json: string): CryptoRules {
  const raw = JSON.parse(json) as Partial<CryptoRules>;
  const r: CryptoRules = { ...DEFAULTS, ...raw, excludeAssets: (raw.excludeAssets ?? []).map((a) => a.toUpperCase()), blocklist: (raw.blocklist ?? []).map((a) => a.toUpperCase()), watchOnly: (raw.watchOnly ?? []).map((a) => a.toUpperCase()) };
  const positive = ["sleeveUsd", "maxOrderUsd", "maxPositionUsd", "maxPositions", "maxDailyLossUsd", "maxDailyBuys", "stopPct", "takeProfitPct", "trailPct", "maxHoldDays", "minVolume24hUsd"] as const;
  for (const k of positive) if (!(Number(r[k]) > 0)) throw new Error(`rules/crypto.json: ${k} must be a positive number`);
  if (r.maxOrderUsd > r.sleeveUsd) throw new Error("rules/crypto.json: maxOrderUsd cannot exceed sleeveUsd");
  if (r.maxPositionUsd > r.sleeveUsd) throw new Error("rules/crypto.json: maxPositionUsd cannot exceed sleeveUsd");
  if (!(r.minConfidence >= 0.5 && r.minConfidence <= 1)) throw new Error("rules/crypto.json: minConfidence must be between 0.5 and 1");
  if (!(r.stopPct < 1 && r.trailPct < 1)) throw new Error("rules/crypto.json: stopPct and trailPct are fractions (0.12 = 12%)");
  if (typeof r.live !== "boolean") throw new Error("rules/crypto.json: live must be true or false");
  return r;
}

export function loadRules(file: string): CryptoRules {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) throw new Error(`${file} not found`);
  return parseRules(readFileSync(path, "utf8"));
}

export function readState(file: string): CryptoState {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return structuredClone(EMPTY_STATE);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<CryptoState>;
  return { ...structuredClone(EMPTY_STATE), ...raw, version: 1 };
}

export function writeState(state: CryptoState, file: string): void {
  const path = resolve(process.cwd(), file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

export function killSwitchOn(rules: CryptoRules): boolean {
  return existsSync(resolve(process.cwd(), rules.killSwitchFile));
}

export const utcDay = (iso: string): string => iso.slice(0, 10);

export function dayFigures(state: CryptoState, day: string): { buys: number; sells: number; realized: number; fees: number } {
  return state.days[day] ?? { buys: 0, sells: 0, realized: 0, fees: 0 };
}

export function exposureUsd(state: CryptoState): number {
  return state.positions.reduce((s, p) => s + p.costUsd, 0);
}

/** Today's realised P&L plus the unrealised P&L of open positions at the given marks. */
export function dayPnl(state: CryptoState, day: string, marks: Record<string, number>): { realized: number; unrealized: number; total: number } {
  const realized = dayFigures(state, day).realized;
  let unrealized = 0;
  for (const p of state.positions) {
    const mark = marks[p.symbol];
    if (mark !== undefined) unrealized += (mark - p.avgCost) * p.volume;
  }
  return { realized, unrealized, total: realized + unrealized };
}

export interface ProposedBuy {
  symbol: string;
  usd: number;
  confidence: number;
  price: number;
  volume24hUsd: number;
}

export interface Verdict { ok: boolean; reasons: string[]; usd: number }

/**
 * May this BUY go out? Returns the (possibly reduced) size and every reason it was cut or
 * refused. `now` is injectable so the tests can move the clock.
 */
export function evaluateBuy(
  p: ProposedBuy, rules: CryptoRules, state: CryptoState,
  opts: { now?: Date; marks?: Record<string, number>; killSwitch?: boolean } = {},
): Verdict {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const day = utcDay(nowIso);
  const reasons: string[] = [];
  const refuse = (why: string): Verdict => ({ ok: false, reasons: [...reasons, why], usd: 0 });
  const base = p.symbol.split("-")[0] ?? p.symbol;

  if (opts.killSwitch ?? killSwitchOn(rules)) return refuse(`kill switch is on (${rules.killSwitchFile})`);
  if (state.halted) return refuse(`sleeve halted ${state.halted.at}: ${state.halted.reason}`);
  if (rules.blocklist.includes(base) || rules.blocklist.includes(p.symbol)) return refuse(`${p.symbol} is on the blocklist`);
  if (rules.watchOnly.includes(base) || rules.watchOnly.includes(p.symbol)) return refuse(`${p.symbol} is watch-only`);
  if (rules.excludeAssets.includes(base)) return refuse(`${base} is an excluded asset (stablecoin / wrapped / fiat)`);
  if (!(p.confidence >= rules.minConfidence)) return refuse(`confidence ${p.confidence.toFixed(2)} < minConfidence ${rules.minConfidence}`);
  if (!(p.volume24hUsd >= rules.minVolume24hUsd)) return refuse(`24h volume $${Math.round(p.volume24hUsd).toLocaleString("en-US")} < $${rules.minVolume24hUsd.toLocaleString("en-US")}`);
  if (!(p.price >= rules.minPriceUsd)) return refuse(`price ${p.price} < minPriceUsd ${rules.minPriceUsd}`);

  const figures = dayFigures(state, day);
  if (figures.buys >= rules.maxDailyBuys) return refuse(`${figures.buys} buys already today (maxDailyBuys ${rules.maxDailyBuys})`);

  const pnl = dayPnl(state, day, opts.marks ?? {});
  if (pnl.total <= -rules.maxDailyLossUsd) return refuse(`day P&L $${pnl.total.toFixed(2)} is at or past -$${rules.maxDailyLossUsd} (maxDailyLossUsd)`);

  const last = state.lastTradeAt[p.symbol];
  if (last) {
    const hours = (now.getTime() - new Date(last).getTime()) / 3_600_000;
    if (hours < rules.cooldownHours) return refuse(`${p.symbol} traded ${hours.toFixed(1)}h ago (cooldown ${rules.cooldownHours}h)`);
  }

  const existing = state.positions.find((x) => x.symbol === p.symbol);
  if (!existing && state.positions.length >= rules.maxPositions) return refuse(`${state.positions.length} positions open (maxPositions ${rules.maxPositions})`);

  let usd = p.usd;
  if (usd > rules.maxOrderUsd) { reasons.push(`size cut to maxOrderUsd $${rules.maxOrderUsd}`); usd = rules.maxOrderUsd; }
  const roomInPosition = rules.maxPositionUsd - (existing?.costUsd ?? 0);
  if (usd > roomInPosition) { reasons.push(`size cut to $${roomInPosition.toFixed(2)} by maxPositionUsd`); usd = roomInPosition; }
  const roomInSleeve = rules.sleeveUsd - exposureUsd(state);
  if (usd > roomInSleeve) { reasons.push(`size cut to $${roomInSleeve.toFixed(2)} by sleeveUsd`); usd = roomInSleeve; }
  if (usd < 5) return refuse(`no room: $${usd.toFixed(2)} left after the caps`);
  return { ok: true, reasons, usd: Math.floor(usd * 100) / 100 };
}

export type ExitReason = "STOP" | "TRAIL" | "TAKE_PROFIT" | "MAX_HOLD" | "COMMITTEE_SELL" | "MANUAL";

/** Which protective exit, if any, a position has hit at this price and time. */
export function exitCheck(pos: CryptoPosition, price: number, rules: CryptoRules, now = new Date()): { reason: ExitReason; level: number } | null {
  if (price <= pos.stop) return { reason: "STOP", level: pos.stop };
  const trail = pos.highWater * (1 - rules.trailPct);
  // The trail only matters once it sits above the entry stop; before that the stop is the stop.
  if (trail > pos.stop && price <= trail) return { reason: "TRAIL", level: trail };
  if (price >= pos.takeProfit) return { reason: "TAKE_PROFIT", level: pos.takeProfit };
  const days = (now.getTime() - new Date(pos.openedAt).getTime()) / 86_400_000;
  if (days >= rules.maxHoldDays) return { reason: "MAX_HOLD", level: price };
  return null;
}

/** Apply a filled BUY to the state (new position or add). */
export function applyBuy(state: CryptoState, rec: CryptoTradeRecord, rules: CryptoRules, altname: string, committeeRunId: number | null, thesis: string): CryptoState {
  const s = structuredClone(state);
  const day = utcDay(rec.at);
  const f = dayFigures(s, day);
  s.days[day] = { ...f, buys: f.buys + 1, fees: f.fees + rec.fee };
  s.lastTradeAt[rec.symbol] = rec.at;
  s.trades.push(rec);
  const existing = s.positions.find((p) => p.symbol === rec.symbol);
  if (existing) {
    const totalCost = existing.costUsd + rec.usd + rec.fee;
    const totalVol = existing.volume + rec.volume;
    existing.volume = totalVol;
    existing.costUsd = totalCost;
    existing.avgCost = totalCost / totalVol;
    existing.stop = existing.avgCost * (1 - rules.stopPct);
    existing.takeProfit = existing.avgCost * (1 + rules.takeProfitPct);
    existing.entryTxids.push(...rec.txids);
  } else {
    const avg = (rec.usd + rec.fee) / rec.volume;
    s.positions.push({
      symbol: rec.symbol, altname, volume: rec.volume, avgCost: avg, costUsd: rec.usd + rec.fee, openedAt: rec.at,
      highWater: rec.price, stop: avg * (1 - rules.stopPct), takeProfit: avg * (1 + rules.takeProfitPct),
      committeeRunId, entryTxids: [...rec.txids], entryClientId: rec.clientId, thesis,
    });
  }
  return s;
}

/** Apply a filled SELL (whole position) to the state and book the realised P&L. */
export function applySell(state: CryptoState, rec: CryptoTradeRecord): CryptoState {
  const s = structuredClone(state);
  const idx = s.positions.findIndex((p) => p.symbol === rec.symbol);
  const pos = idx >= 0 ? s.positions[idx] as CryptoPosition : null;
  const realized = pos ? rec.usd - rec.fee - pos.avgCost * rec.volume : rec.usd - rec.fee;
  const day = utcDay(rec.at);
  const f = dayFigures(s, day);
  s.days[day] = { ...f, sells: f.sells + 1, realized: f.realized + realized, fees: f.fees + rec.fee };
  s.lastTradeAt[rec.symbol] = rec.at;
  s.trades.push({ ...rec, realized });
  if (pos) {
    const remaining = pos.volume - rec.volume;
    if (remaining <= pos.volume * 0.005) s.positions.splice(idx, 1);
    else { pos.volume = remaining; pos.costUsd = pos.avgCost * remaining; }
  }
  return s;
}

/** Ratchet the high-water mark up; never down. */
export function markHighWater(state: CryptoState, marks: Record<string, number>): CryptoState {
  const s = structuredClone(state);
  for (const p of s.positions) {
    const m = marks[p.symbol];
    if (m !== undefined && m > p.highWater) p.highWater = m;
  }
  return s;
}
