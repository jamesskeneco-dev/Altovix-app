import type { DatabaseSync } from "node:sqlite";
import { loadSeries } from "../market/index.ts";
import {
  sma, rsi, realizedVol, drawdown, momentum, simpleReturns, correlation, beta, trendSlope, last,
} from "./index.ts";

export interface SymbolFeatures {
  symbol: string;
  asOf: string | null;
  price: number | null;
  bars: number;
  ret1d: number | null;
  ret5d: number | null;
  ret21d: number | null;
  ret63d: number | null;
  ret126d: number | null;
  ret252d: number | null;
  sma50: number | null;
  sma200: number | null;
  pctVs50: number | null;
  pctVs200: number | null;
  goldenCross: boolean | null;
  rsi14: number | null;
  vol20: number | null;
  vol60: number | null;
  volRatio: number | null;      // short vol / long vol: >1 means volatility expanding
  maxDrawdown252: number | null;
  drawdownFromHigh: number | null;
  pctOf52wRange: number | null;
  trend63: number | null;
  avgVolume20: number | null;
  volumeSurge: number | null;   // latest volume / 20d average
}

export interface RelativeFeatures {
  vsSymbol: string;
  rs21: number | null;
  rs63: number | null;
  rs252: number | null;
  beta63: number | null;
  correlation63: number | null;
}

const pct = (a: number | null, b: number | null): number | null =>
  a === null || b === null || b === 0 ? null : a / b - 1;

export function symbolFeatures(conn: DatabaseSync, symbol: string, asOf: string): SymbolFeatures {
  const bars = loadSeries(conn, symbol, { to: asOf });
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume).filter((v): v is number => v !== null);
  const price = last(closes) ?? null;
  const window252 = closes.slice(-252);
  const dd = drawdown(window252);
  const hi = window252.length ? Math.max(...window252) : null;
  const lo = window252.length ? Math.min(...window252) : null;
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  const v20 = realizedVol(closes, 20);
  const v60 = realizedVol(closes, 60);
  const avgVol20 = volumes.length >= 20
    ? volumes.slice(-20).reduce((s, v) => s + v, 0) / 20
    : null;

  return {
    symbol: symbol.toUpperCase(),
    asOf: last(bars)?.date ?? null,
    price,
    bars: bars.length,
    ret1d: momentum(closes, 1),
    ret5d: momentum(closes, 5),
    ret21d: momentum(closes, 21),
    ret63d: momentum(closes, 63),
    ret126d: momentum(closes, 126),
    ret252d: momentum(closes, 252),
    sma50: s50,
    sma200: s200,
    pctVs50: pct(price, s50),
    pctVs200: pct(price, s200),
    goldenCross: s50 !== null && s200 !== null ? s50 > s200 : null,
    rsi14: rsi(closes, 14),
    vol20: v20,
    vol60: v60,
    volRatio: v20 !== null && v60 !== null && v60 !== 0 ? v20 / v60 : null,
    maxDrawdown252: window252.length ? dd.maxDrawdown : null,
    drawdownFromHigh: window252.length ? dd.currentDrawdown : null,
    pctOf52wRange: hi !== null && lo !== null && hi !== lo && price !== null
      ? (price - lo) / (hi - lo) : null,
    trend63: trendSlope(closes, 63),
    avgVolume20: avgVol20,
    volumeSurge: avgVol20 && avgVol20 > 0 && volumes.length
      ? (last(volumes) as number) / avgVol20 : null,
  };
}

export function relativeFeatures(
  conn: DatabaseSync,
  symbol: string,
  benchmark: string,
  asOf: string,
): RelativeFeatures {
  const a = loadSeries(conn, symbol, { to: asOf });
  const b = loadSeries(conn, benchmark, { to: asOf });
  const byDate = new Map(b.map((x) => [x.date, x.close] as const));
  const pairedA: number[] = [];
  const pairedB: number[] = [];
  for (const bar of a) {
    const bc = byDate.get(bar.date);
    if (bc !== undefined) { pairedA.push(bar.close); pairedB.push(bc); }
  }
  const rel = (n: number): number | null => {
    const ma = momentum(pairedA, n);
    const mb = momentum(pairedB, n);
    return ma === null || mb === null ? null : ma - mb;
  };
  const ra = simpleReturns(pairedA.slice(-64));
  const rb = simpleReturns(pairedB.slice(-64));
  return {
    vsSymbol: benchmark.toUpperCase(),
    rs21: rel(21),
    rs63: rel(63),
    rs252: rel(252),
    beta63: beta(ra, rb),
    correlation63: correlation(ra, rb),
  };
}

/** Round every number in a feature object so prompts stay compact and stable. */
export function round<T extends Record<string, unknown>>(obj: T, dp = 4): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === "number" && Number.isFinite(v)
      ? Number(v.toFixed(Math.abs(v) < 1 ? dp : 2))
      : v;
  }
  return out as T;
}
