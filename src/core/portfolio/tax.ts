import type { DatabaseSync } from "node:sqlite";
import type { Term } from "../types.ts";
import { all, run, tx } from "../db.ts";
import { priceAsOf } from "../market/index.ts";
import { addDays, daysBetween, termFor } from "./lots.ts";

export const WASH_WINDOW_DAYS = 30;

interface ClosureRow {
  id: number; lot_id: number; close_date: string; shares: number;
  realized_pnl: number; term: Term; symbol: string;
}
interface LotRow {
  id: number; symbol: string; open_date: string; shares_opened: number;
  shares_remaining: number; cost_per_share: number; basis_adjustment: number;
}

/**
 * Recompute wash-sale flags from scratch for a symbol (or the whole book).
 *
 * Rule modelled: a loss is disallowed to the extent that substantially identical
 * shares were acquired within 30 days before or after the sale. The disallowed
 * amount is added to the basis of the replacement shares.
 *
 * Scope, stated plainly: same-ticker, same-account matching only. It does not
 * model substantially-identical-but-different-ticker positions, options, or
 * purchases in an IRA or a spouse's account. Those remain a human check.
 */
export function flagWashSales(conn: DatabaseSync, symbol?: string): { flagged: number; disallowed: number } {
  const symClause = symbol ? "WHERE l.symbol = ?" : "";
  const params: unknown[] = symbol ? [symbol.toUpperCase()] : [];

  return tx(conn, () => {
    // 1. reset
    run(conn,
      `UPDATE lot_closures SET wash_sale = 0, disallowed_loss = 0
       WHERE lot_id IN (SELECT id FROM lots ${symbol ? "WHERE symbol = ?" : ""})`,
      ...params);
    run(conn, `UPDATE lots SET basis_adjustment = 0 ${symbol ? "WHERE symbol = ?" : ""}`, ...params);

    const closures = all<ClosureRow>(
      conn,
      `SELECT c.id, c.lot_id, c.close_date, c.shares, c.realized_pnl, c.term, l.symbol
       FROM lot_closures c JOIN lots l ON l.id = c.lot_id
       ${symClause}
       ORDER BY c.close_date ASC, c.id ASC`,
      ...params,
    );
    const lots = all<LotRow>(
      conn,
      `SELECT id, symbol, open_date, shares_opened, shares_remaining, cost_per_share, basis_adjustment
       FROM lots ${symbol ? "WHERE symbol = ?" : ""} ORDER BY open_date ASC, id ASC`,
      ...params,
    );

    // Shares disposed of on or before a given sale cannot serve as replacement for it -
    // a position you fully exited is not a position you maintained.
    const closuresByLot = all<{ lot_id: number; close_date: string; shares: number }>(
      conn,
      `SELECT c.lot_id, c.close_date, c.shares FROM lot_closures c
       JOIN lots l ON l.id = c.lot_id ${symClause}`,
      ...params,
    );
    const sharesClosedBy = (lotId: number, onOrBefore: string): number => {
      let n = 0;
      for (const c of closuresByLot) {
        if (c.lot_id === lotId && c.close_date <= onOrBefore) n += c.shares;
      }
      return n;
    };

    // Replacement shares are consumable: one purchase cannot absorb two different losses.
    const consumed = new Map<number, number>();
    let flagged = 0;
    let disallowedTotal = 0;

    for (const c of closures) {
      if (c.realized_pnl >= 0) continue;
      const lo = addDays(c.close_date, -WASH_WINDOW_DAYS);
      const hi = addDays(c.close_date, WASH_WINDOW_DAYS);
      const candidates = lots.filter(
        (l) => l.symbol === c.symbol && l.id !== c.lot_id && l.open_date >= lo && l.open_date <= hi,
      );

      let remainingLossShares = c.shares;
      let disallowedForClosure = 0;
      for (const cand of candidates) {
        if (remainingLossShares <= 1e-9) break;
        const used = consumed.get(cand.id) ?? 0;
        const stillHeldAfterSale = cand.shares_opened - sharesClosedBy(cand.id, c.close_date);
        const availableShares = stillHeldAfterSale - used;
        if (availableShares <= 1e-9) continue;
        const matched = Math.min(availableShares, remainingLossShares);
        const portion = matched / c.shares;
        const amount = Math.abs(c.realized_pnl) * portion;
        run(conn, `UPDATE lots SET basis_adjustment = basis_adjustment + ? WHERE id = ?`, amount, cand.id);
        consumed.set(cand.id, used + matched);
        remainingLossShares -= matched;
        disallowedForClosure += amount;
      }

      if (disallowedForClosure > 1e-9) {
        run(conn, `UPDATE lot_closures SET wash_sale = 1, disallowed_loss = ? WHERE id = ?`,
            disallowedForClosure, c.id);
        flagged++;
        disallowedTotal += disallowedForClosure;
      }
    }
    return { flagged, disallowed: disallowedTotal };
  });
}

export interface HarvestCandidate {
  lotId: number;
  symbol: string;
  openDate: string;
  shares: number;
  costPerShare: number;
  price: number;
  unrealizedPnl: number;
  unrealizedPct: number;
  holdingDays: number;
  term: Term;
  daysToLongTerm: number | null;
  washRisk: boolean;
  washReason: string | null;
  estTaxBenefit: number;
}

export interface TaxRates {
  shortTerm: number;   // marginal ordinary rate, e.g. 0.32
  longTerm: number;    // e.g. 0.15
}

export const DEFAULT_RATES: TaxRates = { shortTerm: 0.32, longTerm: 0.15 };

/**
 * Lots sitting at a loss that are worth considering for harvesting.
 * A candidate is only actionable if buying back would not trip the wash rule,
 * so recent purchases are surfaced as an explicit blocker rather than a footnote.
 */
export function harvestCandidates(
  conn: DatabaseSync,
  asOf: string,
  opts: { minLossPct?: number; minLossAmount?: number; rates?: TaxRates } = {},
): HarvestCandidate[] {
  const minLossPct = opts.minLossPct ?? 0.05;
  const minLossAmount = opts.minLossAmount ?? 100;
  const rates = opts.rates ?? DEFAULT_RATES;

  // shares_remaining is a present-day number; reconstruct what was actually open on asOf.
  const lots = all<LotRow>(
    conn,
    `SELECT l.id, l.symbol, l.open_date, l.shares_opened,
            (l.shares_opened - COALESCE(c.closed, 0)) AS shares_remaining,
            l.cost_per_share, l.basis_adjustment
     FROM lots l
     LEFT JOIN (
       SELECT lot_id, SUM(shares) AS closed FROM lot_closures WHERE close_date <= ? GROUP BY lot_id
     ) c ON c.lot_id = l.id
     WHERE l.open_date <= ? AND (l.shares_opened - COALESCE(c.closed, 0)) > 1e-9
     ORDER BY l.symbol, l.open_date`,
    asOf, asOf,
  );

  const out: HarvestCandidate[] = [];
  for (const l of lots) {
    const price = priceAsOf(conn, l.symbol, asOf);
    if (price === null) continue;
    const adjPerShare = l.cost_per_share + l.basis_adjustment / Math.max(l.shares_opened, 1e-9);
    const pnl = (price - adjPerShare) * l.shares_remaining;
    if (pnl >= 0) continue;
    const pct = adjPerShare === 0 ? 0 : price / adjPerShare - 1;
    if (Math.abs(pct) < minLossPct && Math.abs(pnl) < minLossAmount) continue;

    const holdingDays = daysBetween(l.open_date, asOf);
    const term = termFor(holdingDays);
    const recentBuys = all<{ n: number }>(
      conn,
      `SELECT COUNT(*) AS n FROM lots
       WHERE symbol = ? AND id != ? AND open_date >= ? AND open_date <= ?`,
      l.symbol, l.id, addDays(asOf, -WASH_WINDOW_DAYS), asOf,
    )[0]?.n ?? 0;

    out.push({
      lotId: l.id,
      symbol: l.symbol,
      openDate: l.open_date,
      shares: l.shares_remaining,
      costPerShare: adjPerShare,
      price,
      unrealizedPnl: pnl,
      unrealizedPct: pct,
      holdingDays,
      term,
      daysToLongTerm: term === "SHORT" ? Math.max(0, 366 - holdingDays) : null,
      washRisk: recentBuys > 0,
      washReason: recentBuys > 0
        ? `${recentBuys} purchase(s) of ${l.symbol} in the last ${WASH_WINDOW_DAYS} days`
        : null,
      estTaxBenefit: Math.abs(pnl) * (term === "SHORT" ? rates.shortTerm : rates.longTerm),
    });
  }
  return out.sort((a, b) => b.estTaxBenefit - a.estTaxBenefit);
}

export interface RealizedSummary {
  shortTermGain: number;
  longTermGain: number;
  disallowed: number;
  estTaxOwed: number;
}

export function realizedSummary(
  conn: DatabaseSync,
  year: number,
  rates: TaxRates = DEFAULT_RATES,
): RealizedSummary {
  const rows = all<{ term: Term; pnl: number; disallowed: number }>(
    conn,
    `SELECT term, SUM(realized_pnl) AS pnl, SUM(disallowed_loss) AS disallowed
     FROM lot_closures WHERE close_date >= ? AND close_date <= ? GROUP BY term`,
    `${year}-01-01`, `${year}-12-31`,
  );
  let shortTermGain = 0, longTermGain = 0, disallowed = 0;
  for (const r of rows) {
    // A disallowed loss is added back: it is not deductible this year.
    const recognised = r.pnl + (r.disallowed ?? 0);
    if (r.term === "SHORT") shortTermGain += recognised;
    else longTermGain += recognised;
    disallowed += r.disallowed ?? 0;
  }
  const estTaxOwed =
    Math.max(0, shortTermGain) * rates.shortTerm + Math.max(0, longTermGain) * rates.longTerm;
  return { shortTermGain, longTermGain, disallowed, estTaxOwed };
}
