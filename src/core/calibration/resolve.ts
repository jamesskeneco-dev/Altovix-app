import type { DatabaseSync } from "node:sqlite";
import { all } from "../db.ts";
import { drawdown, realizedVol, simpleReturns } from "../indicators/index.ts";
import { type ClaimRow, openClaimsDue, settleClaim } from "./claims.ts";

export const BENCH = "SPY";

export interface ForwardWindow {
  symbol: string;
  startDate: string;
  endDate: string;
  startClose: number;
  endClose: number;
  bars: number;
  ret: number;
  maxDrawdown: number;
  realizedVol: number | null;
}

/**
 * The `horizon` trading bars that follow `madeOn`. Returns null when the market
 * has not yet produced enough bars, which is the signal to leave a claim open
 * rather than resolve it early on partial data.
 */
export function forwardWindow(
  conn: DatabaseSync,
  symbol: string,
  madeOn: string,
  horizonDays: number,
): ForwardWindow | null {
  const startRow = all<{ date: string; close: number }>(
    conn,
    `SELECT date, close FROM prices WHERE symbol = ? AND date <= ? ORDER BY date DESC LIMIT 1`,
    symbol.toUpperCase(), madeOn,
  )[0];
  if (!startRow) return null;

  const fwd = all<{ date: string; close: number }>(
    conn,
    `SELECT date, close FROM prices WHERE symbol = ? AND date > ? ORDER BY date ASC LIMIT ?`,
    symbol.toUpperCase(), startRow.date, horizonDays,
  );
  if (fwd.length < horizonDays) return null;

  const closes = [startRow.close, ...fwd.map((r) => r.close)];
  const endRow = fwd[fwd.length - 1] as { date: string; close: number };
  return {
    symbol: symbol.toUpperCase(),
    startDate: startRow.date,
    endDate: endRow.date,
    startClose: startRow.close,
    endClose: endRow.close,
    bars: fwd.length,
    ret: startRow.close === 0 ? 0 : endRow.close / startRow.close - 1,
    maxDrawdown: drawdown(closes).maxDrawdown,
    realizedVol: realizedVol(closes, Math.min(20, Math.max(2, closes.length - 1))),
  };
}

export interface Resolution {
  outcome: 0 | 1 | null;   // null = void
  note: string;
  data: Record<string, unknown>;
}

export const NOT_READY = Symbol("not-ready");

/**
 * Mechanical resolution. No model is involved and no judgement is exercised:
 * a claim either happened or it did not, measured against stored prices.
 */
export function resolveMechanical(conn: DatabaseSync, claim: ClaimRow): Resolution | typeof NOT_READY {
  const subject = claim.subject.toUpperCase();
  const win = forwardWindow(conn, subject, claim.made_on, claim.horizon_days);
  if (!win) return NOT_READY;

  const benchWin = subject === BENCH ? win : forwardWindow(conn, BENCH, claim.made_on, claim.horizon_days);
  const excess = benchWin ? win.ret - benchWin.ret : null;
  const base = {
    window: `${win.startDate} -> ${win.endDate} (${win.bars} bars)`,
    subjectReturn: round4(win.ret),
    benchReturn: benchWin ? round4(benchWin.ret) : null,
    excessReturn: excess === null ? null : round4(excess),
    maxDrawdown: round4(win.maxDrawdown),
    realizedVol: win.realizedVol === null ? null : round4(win.realizedVol),
  };

  switch (claim.claim_kind) {
    case "REGIME_DIRECTION": {
      const band = claim.threshold ?? 0.03;
      const hit =
        claim.direction === "UP" ? win.ret > 0
        : claim.direction === "DOWN" ? win.ret < 0
        : Math.abs(win.ret) <= band;
      return {
        outcome: hit ? 1 : 0,
        note: `SPY returned ${pctStr(win.ret)} over ${win.bars} bars; claim was ${claim.direction}${claim.direction === "FLAT" ? ` within +/-${pctStr(band)}` : ""}.`,
        data: base,
      };
    }
    case "VOL_BAND": {
      if (win.realizedVol === null) return { outcome: null, note: "insufficient bars to measure realised vol", data: base };
      const ceiling = claim.threshold ?? 0.2;
      const hit = win.realizedVol < ceiling;
      return {
        outcome: hit ? 1 : 0,
        note: `Realised vol ${pctStr(win.realizedVol)} vs ceiling ${pctStr(ceiling)}.`,
        data: base,
      };
    }
    case "SECTOR_RELATIVE":
    case "RELATIVE_TO_BENCH": {
      if (excess === null) return { outcome: null, note: "benchmark data unavailable", data: base };
      const hit = claim.direction === "OUTPERFORM" ? excess > 0 : excess < 0;
      return {
        outcome: hit ? 1 : 0,
        note: `${subject} ${excess >= 0 ? "beat" : "lagged"} ${BENCH} by ${pctStr(Math.abs(excess))}; claim was ${claim.direction}.`,
        data: base,
      };
    }
    case "PRICE_DIRECTION": {
      const band = claim.threshold ?? 0.02;
      const hit =
        claim.direction === "UP" ? win.ret > 0
        : claim.direction === "DOWN" ? win.ret < 0
        : Math.abs(win.ret) <= band;
      return {
        outcome: hit ? 1 : 0,
        note: `${subject} returned ${pctStr(win.ret)}; claim was ${claim.direction}.`,
        data: base,
      };
    }
    case "DRAWDOWN_LIMIT": {
      const limit = claim.threshold ?? -0.2;
      const hit = win.maxDrawdown > limit; // both negative: shallower is greater
      return {
        outcome: hit ? 1 : 0,
        note: `Worst drawdown ${pctStr(win.maxDrawdown)} vs stated limit ${pctStr(limit)}: ${hit ? "held" : "breached"}.`,
        data: base,
      };
    }
    case "DECISION_VALUE": {
      if (excess === null) return { outcome: null, note: "benchmark data unavailable", data: base };
      const tolerance = claim.threshold ?? 0;
      const hit = claim.direction === "OUTPERFORM" ? excess > -tolerance : excess < 0;
      return {
        outcome: hit ? 1 : 0,
        note:
          `Action implied ${claim.direction}; ${subject} vs ${BENCH} was ${pctStr(excess)}` +
          (tolerance > 0 ? ` against a tolerance band of ${pctStr(tolerance)}.` : "."),
        data: base,
      };
    }
    default:
      return { outcome: null, note: `no mechanical resolver for ${claim.claim_kind}`, data: base };
  }
}

export interface ResolveSummary {
  checked: number;
  resolved: number;
  correct: number;
  voided: number;
  notReady: number;
  pendingJudgment: number;
}

/** Run every mechanical claim that has come due. Cheap, deterministic, no model calls. */
export function resolveDue(conn: DatabaseSync, asOf: string): ResolveSummary {
  const due = openClaimsDue(conn, asOf, "MECHANICAL");
  const summary: ResolveSummary = { checked: due.length, resolved: 0, correct: 0, voided: 0, notReady: 0, pendingJudgment: 0 };

  for (const claim of due) {
    const res = resolveMechanical(conn, claim);
    if (res === NOT_READY) { summary.notReady++; continue; }
    settleClaim(conn, claim.id, res.outcome, res.note, res.data);
    if (res.outcome === null) summary.voided++;
    else {
      summary.resolved++;
      if (res.outcome === 1) summary.correct++;
    }
  }
  summary.pendingJudgment = openClaimsDue(conn, asOf, "JUDGMENT").length;
  return summary;
}

/** Evidence packet handed to the Calibration Agent for a judgment claim. */
export function evidenceFor(conn: DatabaseSync, claim: ClaimRow): Record<string, unknown> | null {
  const win = forwardWindow(conn, claim.subject, claim.made_on, claim.horizon_days);
  if (!win) return null;
  const bench = forwardWindow(conn, BENCH, claim.made_on, claim.horizon_days);
  const path = all<{ date: string; close: number }>(
    conn,
    `SELECT date, close FROM prices WHERE symbol = ? AND date >= ? AND date <= ? ORDER BY date`,
    claim.subject.toUpperCase(), win.startDate, win.endDate,
  );
  const rets = simpleReturns(path.map((p) => p.close));
  return {
    window: `${win.startDate} -> ${win.endDate}`,
    bars: win.bars,
    startClose: win.startClose,
    endClose: win.endClose,
    totalReturn: round4(win.ret),
    benchmarkReturn: bench ? round4(bench.ret) : null,
    excessVsBenchmark: bench ? round4(win.ret - bench.ret) : null,
    maxDrawdown: round4(win.maxDrawdown),
    realizedVol: win.realizedVol === null ? null : round4(win.realizedVol),
    worstDay: rets.length ? round4(Math.min(...rets)) : null,
    bestDay: rets.length ? round4(Math.max(...rets)) : null,
    // A coarse path so the agent can see shape, not just endpoints.
    pathSample: samplePath(path, 12),
  };
}

function samplePath(path: Array<{ date: string; close: number }>, points: number): Array<{ date: string; close: number }> {
  if (path.length <= points) return path;
  const step = (path.length - 1) / (points - 1);
  return Array.from({ length: points }, (_, i) => path[Math.round(i * step)] as { date: string; close: number });
}

const round4 = (n: number): number => Number(n.toFixed(4));
const pctStr = (n: number): string => `${(n * 100).toFixed(2)}%`;
