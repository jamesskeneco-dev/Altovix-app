import type { DatabaseSync } from "node:sqlite";
import { all } from "../db.ts";
import { config } from "../config.ts";
import {
  simpleReturns, stdev, sharpe, sortino, drawdown, cumulativeReturn, annualize, TRADING_DAYS,
  correlation, beta as betaOf,
} from "../indicators/index.ts";
import { snapshots } from "./snapshot.ts";

export interface PerformanceStats {
  from: string | null;
  to: string | null;
  days: number;
  totalReturn: number | null;
  annualizedReturn: number | null;
  volatility: number | null;
  sharpe: number | null;
  sortino: number | null;
  maxDrawdown: number | null;
  currentDrawdown: number | null;
  bestDay: number | null;
  worstDay: number | null;
  winRateDays: number | null;
}

export interface BenchmarkComparison extends PerformanceStats {
  symbol: string;
  excessReturn: number | null;
  beta: number | null;
  correlation: number | null;
  trackingError: number | null;
  informationRatio: number | null;
}

function statsFromIndex(index: number[], dates: string[], rf: number): PerformanceStats {
  if (index.length < 2) {
    return {
      from: dates[0] ?? null, to: dates[dates.length - 1] ?? null, days: index.length,
      totalReturn: null, annualizedReturn: null, volatility: null, sharpe: null, sortino: null,
      maxDrawdown: null, currentDrawdown: null, bestDay: null, worstDay: null, winRateDays: null,
    };
  }
  const rets = simpleReturns(index);
  const total = cumulativeReturn(rets);
  const dd = drawdown(index);
  const wins = rets.filter((r) => r > 0).length;
  return {
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
    days: index.length,
    totalReturn: total,
    annualizedReturn: annualize(total, rets.length),
    volatility: stdev(rets) * Math.sqrt(TRADING_DAYS),
    sharpe: sharpe(rets, rf),
    sortino: sortino(rets, rf),
    maxDrawdown: dd.maxDrawdown,
    currentDrawdown: dd.currentDrawdown,
    bestDay: Math.max(...rets),
    worstDay: Math.min(...rets),
    winRateDays: rets.length ? wins / rets.length : null,
  };
}

export function performance(
  conn: DatabaseSync,
  opts: { from?: string; to?: string; riskFreeAnnual?: number } = {},
): PerformanceStats {
  const snaps = snapshots(conn, opts);
  return statsFromIndex(snaps.map((s) => s.twr_index), snaps.map((s) => s.date), opts.riskFreeAnnual ?? 0);
}

export function benchmarkComparison(
  conn: DatabaseSync,
  opts: { from?: string; to?: string; riskFreeAnnual?: number } = {},
): BenchmarkComparison[] {
  const rf = opts.riskFreeAnnual ?? 0;
  const snaps = snapshots(conn, opts);
  const port = performance(conn, opts);
  const portByDate = new Map(snaps.map((s) => [s.date, s.twr_index] as const));

  return config.benchmarks.map((symbol): BenchmarkComparison => {
    const rows = all<{ date: string; twr_index: number }>(
      conn,
      `SELECT date, twr_index FROM benchmark_snapshots WHERE symbol = ? ORDER BY date ASC`,
      symbol,
    ).filter((r) => portByDate.has(r.date));

    const stats = statsFromIndex(rows.map((r) => r.twr_index), rows.map((r) => r.date), rf);
    const benchRets = simpleReturns(rows.map((r) => r.twr_index));
    const portRets = simpleReturns(rows.map((r) => portByDate.get(r.date) as number));
    const active = portRets.map((r, i) => r - (benchRets[i] ?? 0));
    const te = active.length > 1 ? stdev(active) * Math.sqrt(TRADING_DAYS) : null;

    return {
      ...stats,
      symbol,
      excessReturn:
        port.totalReturn !== null && stats.totalReturn !== null ? port.totalReturn - stats.totalReturn : null,
      beta: betaOf(portRets, benchRets),
      correlation: correlation(portRets, benchRets),
      trackingError: te,
      informationRatio:
        te && te !== 0 ? (annualize(cumulativeReturn(active), active.length) ?? 0) / te : null,
    };
  });
}

export interface TradeStats {
  closedTrades: number;
  winners: number;
  losers: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  realizedPnl: number;
}

/** Win rate measured on closed tax lots, which is the honest unit for a lot-based book. */
export function tradeStats(conn: DatabaseSync, opts: { from?: string; to?: string } = {}): TradeStats {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.from) { clauses.push("close_date >= ?"); params.push(opts.from); }
  if (opts.to) { clauses.push("close_date <= ?"); params.push(opts.to); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = all<{ realized_pnl: number }>(conn, `SELECT realized_pnl FROM lot_closures ${where}`, ...params);

  const wins = rows.filter((r) => r.realized_pnl > 0).map((r) => r.realized_pnl);
  const losses = rows.filter((r) => r.realized_pnl < 0).map((r) => r.realized_pnl);
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const grossWin = sum(wins);
  const grossLoss = Math.abs(sum(losses));

  return {
    closedTrades: rows.length,
    winners: wins.length,
    losers: losses.length,
    winRate: rows.length ? wins.length / rows.length : null,
    avgWin: wins.length ? grossWin / wins.length : null,
    avgLoss: losses.length ? sum(losses) / losses.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancy: rows.length ? (grossWin - grossLoss) / rows.length : null,
    realizedPnl: grossWin - grossLoss,
  };
}
