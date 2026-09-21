import type { Candle, PairInfo, Ticker } from "../market/kraken.ts";
import { rsi, sma } from "../indicators/index.ts";

/**
 * The volatility scanner: which USD pairs are moving, on volume, from a base - the
 * candidates the committee gets to look at. Pure functions over (pair, ticker, candles);
 * no network, no model. The score is a ranking device, not a forecast: it says "look
 * here first", and the committee, then the guard, decide whether anything is bought.
 *
 * Design: reward volatility that is EXPANDING on VOLUME near a fresh HIGH, and penalise
 * what has already gone vertical (RSI > 85, +25% in a day) because that is where the
 * "very high upside" names give it all back. Excluded outright: stablecoins, wrapped
 * coins, fiat, anything below the liquidity floor.
 */

export type Setup = "BREAKOUT" | "MOMENTUM" | "VOL_EXPANSION" | "REVERSAL" | "NONE";

export interface ScanRow {
  symbol: string;
  altname: string;
  price: number;
  volume24hUsd: number;
  ret1d: number | null;
  ret7d: number | null;
  ret30d: number | null;
  atrPct14: number | null;
  /** ATR(14) / ATR(50): >1 means daily ranges are widening. */
  atrExpansion: number | null;
  /** Last 24h base volume / 20-day average daily volume. */
  volumeSurge: number | null;
  rsi14: number | null;
  /** Price vs the highest high of the prior 20 sessions (fraction; 0 = at the high, >0 = above it). */
  vsHigh20: number | null;
  /** Where price sits in the 30-day range: 0 = low, 1 = high. */
  rangePos30: number | null;
  drawdown90: number | null;
  bars: number;
  setup: Setup;
  score: number;
  reasons: string[];
  excluded: string | null;
}

export interface ScanInput {
  pair: PairInfo;
  ticker: Ticker;
  /** Daily candles, oldest first; the last one may be today's (still forming). */
  candles: Candle[];
}

export interface ScanRules {
  quote: string;
  excludeAssets: string[];
  blocklist: string[];
  minVolume24hUsd: number;
  minPriceUsd: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
/** Linear ramp: value at `lo` -> 0, at `hi` -> `points`, clamped. */
const ramp = (v: number | null, lo: number, hi: number, points: number): number =>
  v === null || !Number.isFinite(v) ? 0 : clamp((v - lo) / (hi - lo), 0, 1) * points;

export function trueRanges(c: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < c.length; i++) {
    const cur = c[i] as Candle;
    const prev = c[i - 1] as Candle;
    out.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)));
  }
  return out;
}

export function atr(c: Candle[], n: number): number | null {
  const tr = trueRanges(c);
  if (tr.length < n) return null;
  return sma(tr, n);
}

export function scanOne(input: ScanInput, rules: ScanRules): ScanRow {
  const { pair, ticker } = input;
  // Score on completed days: drop today's forming candle so a 3am reading equals a 3pm one.
  const completed = input.candles.length > 1 ? input.candles.slice(0, -1) : input.candles;
  const closes = completed.map((c) => c.close);
  const price = ticker.last;
  const volume24hUsd = ticker.volume24h * (Number.isFinite(ticker.vwap24h) && ticker.vwap24h > 0 ? ticker.vwap24h : price);
  const base = pair.base.toUpperCase();

  const row: ScanRow = {
    symbol: pair.symbol, altname: pair.altname, price, volume24hUsd,
    ret1d: null, ret7d: null, ret30d: null, atrPct14: null, atrExpansion: null, volumeSurge: null, rsi14: null,
    vsHigh20: null, rangePos30: null, drawdown90: null, bars: completed.length, setup: "NONE", score: 0, reasons: [], excluded: null,
  };

  if (pair.quote.toUpperCase() !== rules.quote.toUpperCase()) row.excluded = `quote ${pair.quote}`;
  else if (pair.status !== "online") row.excluded = `status ${pair.status}`;
  else if (rules.excludeAssets.includes(base)) row.excluded = "excluded asset";
  else if (rules.blocklist.includes(base) || rules.blocklist.includes(pair.symbol)) row.excluded = "blocklist";
  else if (/^[A-Z0-9]+(2L|2S|3L|3S|UP|DOWN|BULL|BEAR)$/.test(base)) row.excluded = "leveraged token";
  else if (!(volume24hUsd >= rules.minVolume24hUsd)) row.excluded = `24h volume $${Math.round(volume24hUsd).toLocaleString("en-US")} under floor`;
  else if (!(price >= rules.minPriceUsd)) row.excluded = "price under floor";
  else if (completed.length < 25) row.excluded = `only ${completed.length} daily bars`;
  if (row.excluded) return row;

  const at = (k: number): number | null => (closes.length > k ? (closes[closes.length - 1 - k] as number) : null);
  const lastClose = at(0) as number;
  row.ret1d = price / lastClose - 1;
  row.ret7d = at(7) !== null ? price / (at(7) as number) - 1 : null;
  row.ret30d = at(30) !== null ? price / (at(30) as number) - 1 : null;

  const atr14 = atr(completed, 14);
  const atr50 = atr(completed, 50);
  row.atrPct14 = atr14 !== null ? atr14 / price : null;
  row.atrExpansion = atr14 !== null && atr50 !== null && atr50 > 0 ? atr14 / atr50 : null;

  const vols = completed.slice(-20).map((c) => c.volume);
  const avgVol = vols.length === 20 ? vols.reduce((s, v) => s + v, 0) / 20 : null;
  row.volumeSurge = avgVol && avgVol > 0 ? ticker.volume24h / avgVol : null;

  row.rsi14 = rsi([...closes, price], 14);

  const high20 = Math.max(...completed.slice(-20).map((c) => c.high));
  row.vsHigh20 = high20 > 0 ? price / high20 - 1 : null;
  const w30 = completed.slice(-30);
  const lo30 = Math.min(...w30.map((c) => c.low));
  const hi30 = Math.max(...w30.map((c) => c.high));
  row.rangePos30 = hi30 > lo30 ? (price - lo30) / (hi30 - lo30) : null;
  const hi90 = Math.max(...completed.slice(-90).map((c) => c.high));
  row.drawdown90 = hi90 > 0 ? price / hi90 - 1 : null;

  // --- score -----------------------------------------------------------------
  let score = 0;
  const why: string[] = [];

  const sVol = ramp(row.atrPct14, 0.03, 0.14, 30);
  if (sVol > 0) { score += sVol; why.push(`ATR ${((row.atrPct14 ?? 0) * 100).toFixed(1)}%/day`); }
  const sExp = ramp(row.atrExpansion, 1.0, 2.0, 10);
  if (sExp > 0) { score += sExp; why.push(`ranges widening x${(row.atrExpansion ?? 0).toFixed(2)}`); }
  const sSurge = ramp(row.volumeSurge, 1.0, 4.0, 25);
  if (sSurge > 0) { score += sSurge; why.push(`volume x${(row.volumeSurge ?? 0).toFixed(1)} vs 20d`); }
  // Near or through the 20-day high, with a positive week behind it.
  if (row.vsHigh20 !== null && (row.ret7d ?? 0) > 0) {
    const sNear = ramp(row.vsHigh20, -0.10, 0, 15);
    if (sNear > 0) { score += sNear; why.push(`${row.vsHigh20 >= 0 ? "through" : `${Math.abs(row.vsHigh20 * 100).toFixed(1)}% under`} the 20d high`); }
    if (row.vsHigh20 > 0 && row.vsHigh20 < 0.15) { score += 10; why.push("fresh breakout"); }
  }
  if ((row.ret30d ?? 0) > 0) { score += 5; why.push(`+${((row.ret30d ?? 0) * 100).toFixed(0)}% on the month`); }
  const sLiq = ramp(Math.log10(Math.max(volume24hUsd, 1)), Math.log10(3e6), Math.log10(3e8), 10);
  score += sLiq;

  // Penalties: what has already gone vertical.
  if ((row.rsi14 ?? 0) > 85) { score -= 15; why.push(`RSI ${(row.rsi14 ?? 0).toFixed(0)} - parabolic`); }
  if ((row.ret1d ?? 0) > 0.25) { score -= 15; why.push(`+${((row.ret1d ?? 0) * 100).toFixed(0)}% today - chasing`); }
  if ((row.ret7d ?? 0) > 0.8) { score -= 10; why.push("already +80% on the week"); }
  if (row.vsHigh20 !== null && row.vsHigh20 >= 0.15) { score -= 10; why.push("far above its 20d high"); }
  if ((row.atrPct14 ?? 0) > 0.25) { score -= 10; why.push("ATR over 25%/day - untradeable with a 12% stop"); }

  row.score = Math.round(clamp(score, 0, 100));
  row.reasons = why;

  // --- setup label -------------------------------------------------------------
  const surge = (row.volumeSurge ?? 0) >= 1.5;
  if (row.vsHigh20 !== null && row.vsHigh20 > 0 && surge) row.setup = "BREAKOUT";
  else if ((row.drawdown90 ?? 0) < -0.4 && (row.ret7d ?? 0) > 0.1 && surge) row.setup = "REVERSAL";
  else if ((row.ret7d ?? 0) > 0.08 && (row.rangePos30 ?? 0) > 0.7) row.setup = "MOMENTUM";
  else if ((row.atrExpansion ?? 0) > 1.4 && surge) row.setup = "VOL_EXPANSION";
  return row;
}

export function scan(inputs: ScanInput[], rules: ScanRules): ScanRow[] {
  return inputs.map((i) => scanOne(i, rules)).sort((a, b) => {
    if (Boolean(a.excluded) !== Boolean(b.excluded)) return a.excluded ? 1 : -1;
    return b.score - a.score || b.volume24hUsd - a.volume24hUsd;
  });
}

/** One line per row, for the console and the phone. */
export function describe(r: ScanRow): string {
  const pct = (v: number | null): string => (v === null ? "n/a" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);
  if (r.excluded) return `${r.symbol.padEnd(10)} excluded: ${r.excluded}`;
  return `${r.symbol.padEnd(10)} ${String(r.score).padStart(3)}  ${r.setup.padEnd(13)} $${r.price < 1 ? r.price.toPrecision(4) : r.price.toFixed(2).padStart(9)}  1d ${pct(r.ret1d).padStart(7)}  7d ${pct(r.ret7d).padStart(7)}  ATR ${((r.atrPct14 ?? 0) * 100).toFixed(1)}%  vol x${(r.volumeSurge ?? 0).toFixed(1)}  $${(r.volume24hUsd / 1e6).toFixed(1)}M`;
}
