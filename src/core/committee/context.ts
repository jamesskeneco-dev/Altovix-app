import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Mandate, Position } from "../types.ts";
import { config } from "../config.ts";
import { all } from "../db.ts";
import { latestDate, loadSeries } from "../market/index.ts";
import { symbolFeatures, relativeFeatures, round, type SymbolFeatures, type RelativeFeatures } from "../indicators/features.ts";
import { positions, cashBalance } from "../portfolio/lots.ts";
import { simpleReturns, correlation } from "../indicators/index.ts";

export interface SectorRow extends SymbolFeatures {
  rs21: number | null;
  rs63: number | null;
}

export interface PortfolioContext {
  totalValue: number;
  cash: number;
  cashPct: number;
  positionCount: number;
  largestWeight: number | null;
  top: Array<{ symbol: string; weight: number | null; unrealizedPct: number | null }>;
  existing: { shares: number; avgCost: number; unrealizedPct: number | null; weight: number | null } | null;
  correlationWithCandidate: Array<{ symbol: string; corr: number | null }>;
}

export interface PriorRunSummary {
  id: number;
  as_of_date: string;
  final_action: string | null;
  final_confidence: number | null;
}

export interface CommitteeContext {
  asOfDate: string;
  symbol: string;
  mandate: Mandate;
  candidate: SymbolFeatures;
  candidateVs: RelativeFeatures[];
  macro: SymbolFeatures[];
  sectors: SectorRow[];
  portfolio: PortfolioContext;
  priorRuns: PriorRunSummary[];
  dataGaps: string[];
  /** Free-text context supplied by the operator: macro readings, dated events, anything not in the price tables. */
  operatorNotes: string | null;
}

export function buildContext(
  conn: DatabaseSync,
  symbol: string,
  opts: { asOf?: string; mandate?: Mandate; operatorNotes?: string | null } = {},
): CommitteeContext {
  const sym = symbol.toUpperCase();
  const asOf = opts.asOf ?? latestDate(conn) ?? new Date().toISOString().slice(0, 10);
  const dataGaps: string[] = [];

  const candidate = round(symbolFeatures(conn, sym, asOf));
  if (candidate.bars === 0) dataGaps.push(`no price history for ${sym}`);
  else if (candidate.bars < 252) dataGaps.push(`${sym} has only ${candidate.bars} bars; 1-year stats unavailable`);

  const candidateVs = config.benchmarks.map((b) => round(relativeFeatures(conn, sym, b, asOf) as unknown as Record<string, unknown>) as unknown as RelativeFeatures);

  const macro: SymbolFeatures[] = [];
  for (const t of config.macroTickers) {
    const f = round(symbolFeatures(conn, t, asOf));
    if (f.bars === 0) { dataGaps.push(`macro ticker ${t} missing`); continue; }
    macro.push(f);
  }

  const sectors: SectorRow[] = [];
  for (const t of config.sectorEtfs) {
    const f = symbolFeatures(conn, t, asOf);
    if (f.bars === 0) { dataGaps.push(`sector ETF ${t} missing`); continue; }
    const rel = relativeFeatures(conn, t, "SPY", asOf);
    sectors.push({ ...round(f), rs21: rel.rs21, rs63: rel.rs63 });
  }

  const held = positions(conn, asOf);
  const cash = cashBalance(conn, asOf);
  const totalValue = held.reduce((s, p) => s + (p.marketValue ?? 0), 0) + cash;
  const existing = held.find((p) => p.symbol === sym) ?? null;

  const portfolio: PortfolioContext = {
    totalValue,
    cash,
    cashPct: totalValue > 0 ? cash / totalValue : 1,
    positionCount: held.length,
    largestWeight: held.reduce<number | null>((m, p) => (p.weight ?? 0) > (m ?? 0) ? p.weight : m, null),
    top: [...held]
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
      .slice(0, 8)
      .map((p) => ({ symbol: p.symbol, weight: p.weight, unrealizedPct: p.unrealizedPct })),
    existing: existing
      ? { shares: existing.shares, avgCost: existing.avgCost, unrealizedPct: existing.unrealizedPct, weight: existing.weight }
      : null,
    correlationWithCandidate: held
      .filter((p) => p.symbol !== sym)
      .map((p: Position) => ({ symbol: p.symbol, corr: pairCorrelation(conn, sym, p.symbol, asOf) })),
  };

  const priorRuns = all<PriorRunSummary>(
    conn,
    `SELECT id, as_of_date, final_action, final_confidence FROM committee_runs
     WHERE symbol = ? AND status = 'COMPLETE' AND as_of_date < ?
     ORDER BY as_of_date DESC LIMIT 5`,
    sym, asOf,
  );

  const mandate: Mandate = opts.mandate ?? (existing ? "REVIEW" : "NEW_POSITION");
  return {
    asOfDate: asOf, symbol: sym, mandate, candidate, candidateVs, macro, sectors, portfolio, priorRuns, dataGaps,
    operatorNotes: opts.operatorNotes?.trim() ? opts.operatorNotes.trim() : null,
  };
}

function pairCorrelation(conn: DatabaseSync, a: string, b: string, asOf: string): number | null {
  const sa = loadSeries(conn, a, { to: asOf });
  const sb = loadSeries(conn, b, { to: asOf });
  const map = new Map(sb.map((x) => [x.date, x.close] as const));
  const xa: number[] = [];
  const xb: number[] = [];
  for (const bar of sa) {
    const other = map.get(bar.date);
    if (other !== undefined) { xa.push(bar.close); xb.push(other); }
  }
  const c = correlation(simpleReturns(xa.slice(-64)), simpleReturns(xb.slice(-64)));
  return c === null ? null : Number(c.toFixed(3));
}

export function hashContext(ctx: CommitteeContext): string {
  return createHash("sha256").update(JSON.stringify(ctx)).digest("hex").slice(0, 16);
}

/** Compact table rendering - agents read these far more reliably than raw JSON blobs. */
export function table(rows: Array<Record<string, unknown>>, columns: string[]): string {
  if (!rows.length) return "(none)";
  const fmt = (v: unknown): string => {
    if (v === null || v === undefined) return "-";
    if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 1 ? 4 : 2);
    if (typeof v === "boolean") return v ? "yes" : "no";
    return String(v);
  };
  const widths = columns.map((c) =>
    Math.max(c.length, ...rows.map((r) => fmt(r[c]).length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i] as number)).join("  ").trimEnd();
  return [line(columns), line(widths.map((w) => "-".repeat(w))), ...rows.map((r) => line(columns.map((c) => fmt(r[c]))))].join("\n");
}
