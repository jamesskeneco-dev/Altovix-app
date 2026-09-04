import type { DatabaseSync } from "node:sqlite";
import { all, one, run, tx } from "../db.ts";
import { config } from "../config.ts";
import { priceAsOf } from "../market/index.ts";
import { positions, cashBalance, netContributions } from "./lots.ts";

export interface Snapshot {
  date: string;
  cash: number;
  positions_value: number;
  total_value: number;
  net_contributions: number;
  twr_index: number;
}

/**
 * Time-weighted return, chain-linked daily and neutralised for deposits/withdrawals,
 * so the equity curve measures decisions rather than the size of the funding.
 *   r_t = (V_t - F_t) / V_{t-1} - 1
 */
export function takeSnapshot(conn: DatabaseSync, date: string): Snapshot {
  return tx(conn, () => {
    const held = positions(conn, date);
    const cash = cashBalance(conn, date);
    const positionsValue = held.reduce((s, p) => s + (p.marketValue ?? 0), 0);
    const total = cash + positionsValue;
    const contributions = netContributions(conn, date);

    const prev = one<Snapshot>(
      conn,
      `SELECT * FROM daily_snapshots WHERE date < ? ORDER BY date DESC LIMIT 1`,
      date,
    );

    let twr = 100;
    if (prev && prev.total_value > 0) {
      const flow = contributions - prev.net_contributions;
      const r = (total - flow) / prev.total_value - 1;
      twr = prev.twr_index * (1 + r);
    }

    run(
      conn,
      `INSERT INTO daily_snapshots (date, cash, positions_value, total_value, net_contributions, twr_index)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         cash=excluded.cash, positions_value=excluded.positions_value,
         total_value=excluded.total_value, net_contributions=excluded.net_contributions,
         twr_index=excluded.twr_index`,
      date, cash, positionsValue, total, contributions, twr,
    );

    run(conn, `DELETE FROM snapshot_holdings WHERE date = ?`, date);
    for (const p of held) {
      if (p.marketValue === null || p.lastPrice === null) continue;
      run(
        conn,
        `INSERT INTO snapshot_holdings (date, symbol, shares, price, value, weight)
         VALUES (?, ?, ?, ?, ?, ?)`,
        date, p.symbol, p.shares, p.lastPrice, p.marketValue, total > 0 ? p.marketValue / total : 0,
      );
    }

    snapshotBenchmarks(conn, date);
    return { date, cash, positions_value: positionsValue, total_value: total, net_contributions: contributions, twr_index: twr };
  });
}

/** Benchmarks are indexed from the first snapshot date so the curves start together. */
export function snapshotBenchmarks(conn: DatabaseSync, date: string): void {
  const inception = one<{ d: string }>(conn, `SELECT MIN(date) AS d FROM daily_snapshots`)?.d ?? date;
  for (const symbol of config.benchmarks) {
    const close = priceAsOf(conn, symbol, date);
    const base = priceAsOf(conn, symbol, inception);
    if (close === null || base === null || base === 0) continue;
    run(
      conn,
      `INSERT INTO benchmark_snapshots (date, symbol, close, twr_index) VALUES (?, ?, ?, ?)
       ON CONFLICT(date, symbol) DO UPDATE SET close=excluded.close, twr_index=excluded.twr_index`,
      date, symbol, close, (100 * close) / base,
    );
  }
}

/** Rebuild every snapshot from the first trading day forward. Use after backfilling prices. */
export function rebuildSnapshots(conn: DatabaseSync, from?: string): number {
  const start =
    from ??
    one<{ d: string }>(conn, `SELECT MIN(date) AS d FROM cash_ledger`)?.d ??
    null;
  if (!start) return 0;
  const dates = all<{ date: string }>(
    conn,
    `SELECT DISTINCT date FROM prices WHERE date >= ? ORDER BY date ASC`,
    start,
  );
  run(conn, `DELETE FROM daily_snapshots WHERE date >= ?`, start);
  run(conn, `DELETE FROM benchmark_snapshots WHERE date >= ?`, start);
  run(conn, `DELETE FROM snapshot_holdings WHERE date >= ?`, start);
  for (const d of dates) takeSnapshot(conn, d.date);
  return dates.length;
}

export function snapshots(conn: DatabaseSync, opts: { from?: string; to?: string } = {}): Snapshot[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.from) { clauses.push("date >= ?"); params.push(opts.from); }
  if (opts.to) { clauses.push("date <= ?"); params.push(opts.to); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return all<Snapshot>(conn, `SELECT * FROM daily_snapshots ${where} ORDER BY date ASC`, ...params);
}
