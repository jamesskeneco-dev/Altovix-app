import type { CommitteeContext } from "../committee/context.ts";
import { table } from "../committee/context.ts";

export const MACRO_COLUMNS = ["symbol", "price", "ret5d", "ret21d", "ret63d", "ret252d", "pctVs50", "pctVs200", "rsi14", "vol20", "volRatio", "drawdownFromHigh"];
export const SECTOR_COLUMNS = ["symbol", "ret21d", "ret63d", "rs21", "rs63", "pctVs50", "pctVs200", "rsi14"];

export function header(ctx: CommitteeContext): string {
  return [
    `As-of trading date: ${ctx.asOfDate}`,
    `Candidate: ${ctx.symbol}`,
    `Mandate: ${ctx.mandate}`,
    ctx.dataGaps.length ? `DATA GAPS (treat as unknown, do not fill in): ${ctx.dataGaps.join("; ")}` : "Data gaps: none",
    ...(ctx.operatorNotes
      ? ["", "OPERATOR-SUPPLIED CONTEXT (dated facts from published sources; use them, cite them, do not extend them)", ctx.operatorNotes]
      : []),
  ].join("\n");
}

export function macroBlock(ctx: CommitteeContext): string {
  return `MACRO / BREADTH TABLE (returns are fractions, e.g. 0.0312 = +3.12%)\n${table(ctx.macro, MACRO_COLUMNS)}`;
}

export function sectorBlock(ctx: CommitteeContext): string {
  return `SECTOR ETFs vs SPY (rs21/rs63 = excess return over SPY on that window)\n${table(ctx.sectors, SECTOR_COLUMNS)}`;
}

export function candidateBlock(ctx: CommitteeContext): string {
  const c = ctx.candidate;
  const rel = ctx.candidateVs
    .map((r) => `  vs ${r.vsSymbol}: rs21=${fmt(r.rs21)} rs63=${fmt(r.rs63)} rs252=${fmt(r.rs252)} beta63=${fmt(r.beta63)} corr63=${fmt(r.correlation63)}`)
    .join("\n");
  return [
    `CANDIDATE ${c.symbol} (${c.bars} daily bars available, last bar ${c.asOf})`,
    `  price=${fmt(c.price)} ret5d=${fmt(c.ret5d)} ret21d=${fmt(c.ret21d)} ret63d=${fmt(c.ret63d)} ret252d=${fmt(c.ret252d)}`,
    `  sma50=${fmt(c.sma50)} sma200=${fmt(c.sma200)} pctVs50=${fmt(c.pctVs50)} pctVs200=${fmt(c.pctVs200)} goldenCross=${c.goldenCross}`,
    `  rsi14=${fmt(c.rsi14)} vol20=${fmt(c.vol20)} vol60=${fmt(c.vol60)} volRatio=${fmt(c.volRatio)}`,
    `  drawdownFromHigh=${fmt(c.drawdownFromHigh)} maxDrawdown252=${fmt(c.maxDrawdown252)} pctOf52wRange=${fmt(c.pctOf52wRange)}`,
    `  trend63=${fmt(c.trend63)} volumeSurge=${fmt(c.volumeSurge)}`,
    `RELATIVE STRENGTH`,
    rel || "  (no benchmark overlap)",
  ].join("\n");
}

export function portfolioBlock(ctx: CommitteeContext): string {
  const p = ctx.portfolio;
  const lines = [
    `PORTFOLIO`,
    `  totalValue=${money(p.totalValue)} cash=${money(p.cash)} cashPct=${fmt(p.cashPct)} positions=${p.positionCount} largestWeight=${fmt(p.largestWeight)}`,
    `  holdings: ${p.top.length ? p.top.map((t) => `${t.symbol} ${fmt(t.weight)} (${fmt(t.unrealizedPct)})`).join(", ") : "(none)"}`,
    p.existing
      ? `  EXISTING POSITION in ${ctx.symbol}: ${p.existing.shares} sh @ avg ${money(p.existing.avgCost)}, unrealised ${fmt(p.existing.unrealizedPct)}, weight ${fmt(p.existing.weight)}`
      : `  No existing position in ${ctx.symbol}.`,
  ];
  if (p.correlationWithCandidate.length) {
    lines.push(`  63d return correlation of ${ctx.symbol} with holdings: ${p.correlationWithCandidate.map((c) => `${c.symbol}=${fmt(c.corr)}`).join(", ")}`);
  }
  return lines.join("\n");
}

export function priorRunsBlock(ctx: CommitteeContext): string {
  if (!ctx.priorRuns.length) return `PRIOR COMMITTEE RUNS ON ${ctx.symbol}: none.`;
  return [
    `PRIOR COMMITTEE RUNS ON ${ctx.symbol} (most recent first)`,
    ...ctx.priorRuns.map((r) => `  ${r.as_of_date}: ${r.final_action} (confidence ${fmt(r.final_confidence)})`),
  ].join("\n");
}

export function priorBlock(label: string, value: unknown): string {
  if (value === undefined || value === null) return `${label}: (did not run)`;
  return `${label}:\n${JSON.stringify(value, null, 2)}`;
}

export function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  return Math.abs(v) < 1 ? v.toFixed(4) : v.toFixed(2);
}

export function money(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** Map a stated regime onto the direction it implies for SPY, so it can be scored. */
export function regimeDirection(regime: string): "UP" | "DOWN" | "FLAT" {
  if (regime === "RISK_ON") return "UP";
  if (regime === "RISK_OFF") return "DOWN";
  return "FLAT";
}
