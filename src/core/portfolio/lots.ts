import type { DatabaseSync } from "node:sqlite";
import type { Lot, Position, Side, Term, Trade } from "../types.ts";
import { all, one, run, tx } from "../db.ts";
import { priceAsOf } from "../market/index.ts";

export type LotMethod = "FIFO" | "HIFO" | "LIFO";

export interface TradeInput {
  date: string;
  symbol: string;
  side: Side;
  shares: number;
  price: number;
  fees?: number;
  thesis?: string | null;
  exitRule?: string | null;
  committeeRunId?: number | null;
  method?: LotMethod;
  /** Permit the buy to overdraw cash. Off by default: a cash account cannot spend what it has not got. */
  allowMargin?: boolean;
}

export interface TradeResult {
  tradeId: number;
  lotId?: number;
  closures: Array<{ lotId: number; shares: number; realizedPnl: number; term: Term; holdingDays: number }>;
  cashDelta: number;
}

export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** A holding period must exceed one year to be long-term. */
export function termFor(holdingDays: number): Term {
  return holdingDays > 365 ? "LONG" : "SHORT";
}

export function recordTrade(conn: DatabaseSync, input: TradeInput): TradeResult {
  const symbol = input.symbol.toUpperCase();
  const fees = input.fees ?? 0;
  if (input.shares <= 0) throw new Error("shares must be positive");
  if (input.price < 0) throw new Error("price must be non-negative");

  return tx(conn, () => {
    run(conn, `INSERT OR IGNORE INTO symbols (symbol) VALUES (?)`, symbol);
    const { lastInsertRowid: tradeId } = run(
      conn,
      `INSERT INTO trades (date, symbol, side, shares, price, fees, thesis, exit_rule, committee_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.date, symbol, input.side, input.shares, input.price, fees,
      input.thesis ?? null, input.exitRule ?? null, input.committeeRunId ?? null,
    );

    if (input.side === "BUY") {
      const cost = input.shares * input.price + fees;
      if (!input.allowMargin) {
        const available = cashBalance(conn, input.date);
        if (cost > available + 1e-9) {
          throw new Error(
            `insufficient cash for ${input.shares} ${symbol} @ ${input.price}: ` +
            `needs ${cost.toFixed(2)}, available ${available.toFixed(2)} on ${input.date}. ` +
            `Deposit first, or pass allowMargin if this account really is on margin.`,
          );
        }
      }
      const costPerShare = input.price + fees / input.shares;
      const { lastInsertRowid: lotId } = run(
        conn,
        `INSERT INTO lots (symbol, open_trade_id, open_date, shares_opened, shares_remaining, cost_per_share)
         VALUES (?, ?, ?, ?, ?, ?)`,
        symbol, tradeId, input.date, input.shares, input.shares, costPerShare,
      );
      const cashDelta = -cost;
      run(
        conn,
        `INSERT INTO cash_ledger (date, kind, amount, ref, note) VALUES (?, 'BUY', ?, ?, ?)`,
        input.date, cashDelta, `trade:${tradeId}`, `BUY ${input.shares} ${symbol} @ ${input.price}`,
      );
      return { tradeId, lotId, closures: [], cashDelta };
    }

    // SELL: consume open lots by the chosen method.
    const openLots = openLotsFor(conn, symbol, input.method ?? "FIFO", input.date);
    const totalOpen = openLots.reduce((s, l) => s + l.shares_remaining, 0);
    if (totalOpen + 1e-9 < input.shares) {
      throw new Error(`cannot sell ${input.shares} ${symbol}: only ${totalOpen} open`);
    }
    const proceedsPerShare = input.price - fees / input.shares;
    let toSell = input.shares;
    const closures: TradeResult["closures"] = [];

    for (const lot of openLots) {
      if (toSell <= 1e-9) break;
      const qty = Math.min(lot.shares_remaining, toSell);
      const costPerShare = lot.cost_per_share + lot.basis_adjustment / Math.max(lot.shares_opened, 1e-9);
      const realized = (proceedsPerShare - costPerShare) * qty;
      const holdingDays = daysBetween(lot.open_date, input.date);
      const term = termFor(holdingDays);
      run(
        conn,
        `INSERT INTO lot_closures
           (lot_id, close_trade_id, close_date, shares, proceeds_per_share, cost_per_share, realized_pnl, term, holding_days)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        lot.id, tradeId, input.date, qty, proceedsPerShare, costPerShare, realized, term, holdingDays,
      );
      run(conn, `UPDATE lots SET shares_remaining = shares_remaining - ? WHERE id = ?`, qty, lot.id);
      closures.push({ lotId: lot.id, shares: qty, realizedPnl: realized, term, holdingDays });
      toSell -= qty;
    }

    const cashDelta = input.shares * input.price - fees;
    run(
      conn,
      `INSERT INTO cash_ledger (date, kind, amount, ref, note) VALUES (?, 'SELL', ?, ?, ?)`,
      input.date, cashDelta, `trade:${tradeId}`, `SELL ${input.shares} ${symbol} @ ${input.price}`,
    );
    return { tradeId, closures, cashDelta };
  });
}

export function openLotsFor(conn: DatabaseSync, symbol: string, method: LotMethod, asOf?: string): Lot[] {
  const order =
    method === "HIFO" ? "cost_per_share DESC, open_date ASC"
    : method === "LIFO" ? "open_date DESC, id DESC"
    : "open_date ASC, id ASC";
  const dateClause = asOf ? "AND open_date <= ?" : "";
  const params: unknown[] = asOf ? [symbol.toUpperCase(), asOf] : [symbol.toUpperCase()];
  return all<Lot>(
    conn,
    `SELECT * FROM lots WHERE symbol = ? AND shares_remaining > 1e-9 ${dateClause} ORDER BY ${order}`,
    ...params,
  );
}

export function cashBalance(conn: DatabaseSync, asOf?: string): number {
  const row = asOf
    ? one<{ v: number | null }>(conn, `SELECT SUM(amount) AS v FROM cash_ledger WHERE date <= ?`, asOf)
    : one<{ v: number | null }>(conn, `SELECT SUM(amount) AS v FROM cash_ledger`);
  return row?.v ?? 0;
}

export function netContributions(conn: DatabaseSync, asOf?: string): number {
  const sql = `SELECT SUM(amount) AS v FROM cash_ledger WHERE kind IN ('DEPOSIT','WITHDRAW')${asOf ? " AND date <= ?" : ""}`;
  const row = asOf ? one<{ v: number | null }>(conn, sql, asOf) : one<{ v: number | null }>(conn, sql);
  return row?.v ?? 0;
}

export function deposit(conn: DatabaseSync, date: string, amount: number, note?: string): void {
  run(
    conn,
    `INSERT INTO cash_ledger (date, kind, amount, note) VALUES (?, ?, ?, ?)`,
    date, amount >= 0 ? "DEPOSIT" : "WITHDRAW", amount, note ?? null,
  );
}

/**
 * Shares still held on a given date, reconstructed from lots minus the closures that had
 * happened by then.
 *
 * This must never read lots.shares_remaining, which is a present-day figure: using it for a
 * historical date makes every past snapshot forget positions that have since been sold, which
 * silently corrupts the entire equity curve and every metric derived from it.
 */
export function heldAsOf(
  conn: DatabaseSync,
  asOf: string,
): Array<{ symbol: string; shares: number; basis: number }> {
  return all<{ symbol: string; shares: number; basis: number }>(
    conn,
    `SELECT l.symbol,
            SUM(l.shares_opened - COALESCE(c.closed, 0)) AS shares,
            SUM((l.shares_opened - COALESCE(c.closed, 0))
                * (l.cost_per_share + l.basis_adjustment / NULLIF(l.shares_opened, 0))) AS basis
     FROM lots l
     LEFT JOIN (
       SELECT lot_id, SUM(shares) AS closed FROM lot_closures WHERE close_date <= ? GROUP BY lot_id
     ) c ON c.lot_id = l.id
     WHERE l.open_date <= ?
     GROUP BY l.symbol
     HAVING shares > 1e-9
     ORDER BY l.symbol`,
    asOf, asOf,
  );
}

export function positions(conn: DatabaseSync, asOf?: string): Position[] {
  const date = asOf ?? new Date().toISOString().slice(0, 10);
  const rows = heldAsOf(conn, date);

  const enriched = rows.map((r): Position => {
    const price = priceAsOf(conn, r.symbol, date);
    const marketValue = price === null ? null : price * r.shares;
    return {
      symbol: r.symbol,
      shares: r.shares,
      costBasis: r.basis,
      avgCost: r.shares > 0 ? r.basis / r.shares : 0,
      lastPrice: price,
      marketValue,
      unrealizedPnl: marketValue === null ? null : marketValue - r.basis,
      unrealizedPct: marketValue === null || r.basis === 0 ? null : marketValue / r.basis - 1,
      weight: null,
    };
  });

  const total = enriched.reduce((s, p) => s + (p.marketValue ?? 0), 0) + cashBalance(conn, asOf);
  for (const p of enriched) {
    p.weight = total > 0 && p.marketValue !== null ? p.marketValue / total : null;
  }
  return enriched;
}

export function trades(conn: DatabaseSync, opts: { symbol?: string; limit?: number } = {}): Trade[] {
  const where = opts.symbol ? "WHERE symbol = ?" : "";
  const params: unknown[] = opts.symbol ? [opts.symbol.toUpperCase()] : [];
  const limit = opts.limit ? `LIMIT ${Math.floor(opts.limit)}` : "";
  return all<Trade>(conn, `SELECT * FROM trades ${where} ORDER BY date DESC, id DESC ${limit}`, ...params);
}
