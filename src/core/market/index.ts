import type { DatabaseSync } from "node:sqlite";
import type { Bar } from "../types.ts";
import { config } from "../config.ts";
import { all, one, run, tx } from "../db.ts";
import type { PriceProvider } from "./types.ts";
import { stooq } from "./stooq.ts";
import { yahoo } from "./yahoo.ts";
import { csvProvider } from "./csv.ts";

export { stooq, yahoo, csvProvider };
export type { PriceProvider };

const PROVIDERS: Record<string, PriceProvider> = {
  stooq,
  yahoo,
  csv: csvProvider,
};

export function getProvider(name: string = config.marketProvider): PriceProvider {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`unknown market provider: ${name}`);
  return p;
}

/** Provider order: the configured one first, then the others as fallbacks. */
export function providerChain(preferred: string = config.marketProvider): PriceProvider[] {
  const order = [preferred, ...Object.keys(PROVIDERS).filter((k) => k !== preferred)];
  return order.map((k) => PROVIDERS[k]).filter((p): p is PriceProvider => Boolean(p));
}

export interface IngestResult {
  symbol: string;
  provider: string | null;
  rows: number;
  firstDate: string | null;
  lastDate: string | null;
  error: string | null;
}

export async function ingestSymbol(
  conn: DatabaseSync,
  symbol: string,
  opts: { from?: string; provider?: string } = {},
): Promise<IngestResult> {
  const sym = symbol.toUpperCase();
  const errors: string[] = [];
  for (const provider of providerChain(opts.provider)) {
    try {
      const bars = await provider.fetchDaily(sym, opts.from);
      const written = upsertBars(conn, sym, bars, provider.name);
      return {
        symbol: sym,
        provider: provider.name,
        rows: written,
        firstDate: bars[0]?.date ?? null,
        lastDate: bars[bars.length - 1]?.date ?? null,
        error: null,
      };
    } catch (err) {
      errors.push(`${provider.name}: ${(err as Error).message}`);
    }
  }
  return { symbol: sym, provider: null, rows: 0, firstDate: null, lastDate: null, error: errors.join(" | ") };
}

export function upsertBars(conn: DatabaseSync, symbol: string, bars: Bar[], source: string): number {
  return tx(conn, () => {
    run(conn, `INSERT OR IGNORE INTO symbols (symbol) VALUES (?)`, symbol);
    const stmt = conn.prepare(
      `INSERT INTO prices (symbol, date, open, high, low, close, volume, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol, date) DO UPDATE SET
         open=excluded.open, high=excluded.high, low=excluded.low,
         close=excluded.close, volume=excluded.volume, source=excluded.source`,
    );
    let n = 0;
    for (const b of bars) {
      stmt.run(symbol, b.date, b.open, b.high, b.low, b.close, b.volume, source);
      n++;
    }
    return n;
  });
}

export function loadSeries(
  conn: DatabaseSync,
  symbol: string,
  opts: { from?: string; to?: string; limit?: number } = {},
): Bar[] {
  const clauses = ["symbol = ?"];
  const params: unknown[] = [symbol.toUpperCase()];
  if (opts.from) { clauses.push("date >= ?"); params.push(opts.from); }
  if (opts.to) { clauses.push("date <= ?"); params.push(opts.to); }
  const rows = all<Bar>(
    conn,
    `SELECT date, open, high, low, close, volume FROM prices
     WHERE ${clauses.join(" AND ")} ORDER BY date ASC`,
    ...params,
  );
  return opts.limit && rows.length > opts.limit ? rows.slice(-opts.limit) : rows;
}

export function loadCloses(
  conn: DatabaseSync,
  symbol: string,
  opts: { from?: string; to?: string; limit?: number } = {},
): number[] {
  return loadSeries(conn, symbol, opts).map((b) => b.close);
}

/** Last close at or before `asOf`. Handles weekends, holidays and stale feeds. */
export function priceAsOf(conn: DatabaseSync, symbol: string, asOf: string): number | null {
  const row = one<{ close: number }>(
    conn,
    `SELECT close FROM prices WHERE symbol = ? AND date <= ? ORDER BY date DESC LIMIT 1`,
    symbol.toUpperCase(),
    asOf,
  );
  return row?.close ?? null;
}

export function dateAsOf(conn: DatabaseSync, symbol: string, asOf: string): string | null {
  const row = one<{ date: string }>(
    conn,
    `SELECT date FROM prices WHERE symbol = ? AND date <= ? ORDER BY date DESC LIMIT 1`,
    symbol.toUpperCase(),
    asOf,
  );
  return row?.date ?? null;
}

/** First close at or after `date` - used when resolving a claim on its horizon. */
export function priceOnOrAfter(conn: DatabaseSync, symbol: string, date: string): { date: string; close: number } | null {
  return (
    one<{ date: string; close: number }>(
      conn,
      `SELECT date, close FROM prices WHERE symbol = ? AND date >= ? ORDER BY date ASC LIMIT 1`,
      symbol.toUpperCase(),
      date,
    ) ?? null
  );
}

export function latestDate(conn: DatabaseSync, symbol?: string): string | null {
  const row = symbol
    ? one<{ d: string }>(conn, `SELECT MAX(date) AS d FROM prices WHERE symbol = ?`, symbol.toUpperCase())
    : one<{ d: string }>(conn, `SELECT MAX(date) AS d FROM prices`);
  return row?.d ?? null;
}

export function trackedSymbols(conn: DatabaseSync): string[] {
  return all<{ symbol: string }>(conn, `SELECT symbol FROM symbols ORDER BY symbol`).map((r) => r.symbol);
}
