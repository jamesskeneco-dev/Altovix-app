import type { DatabaseSync } from "node:sqlite";
import type { AgentName, ClaimStatus, Resolver } from "../types.ts";
import { all, run } from "../db.ts";
import { addDays } from "../portfolio/lots.ts";

export const CLAIM_KINDS = [
  "REGIME_DIRECTION",        // the stated regime implies a direction for SPY
  "SECTOR_RELATIVE",         // a sector ETF beats or lags SPY
  "PRICE_DIRECTION",         // a symbol rises or falls outright
  "RELATIVE_TO_BENCH",       // a symbol beats or lags SPY
  "DRAWDOWN_LIMIT",          // a symbol's drawdown stays shallower than a threshold
  "VOL_BAND",                // realised vol stays under a threshold
  "THESIS_PLAYS_OUT",        // the research thesis and catalyst hold up
  "BEAR_RISK_MATERIALIZES",  // the specific risk named by the bear case happens
  "DECISION_VALUE",          // the committee's action beat doing nothing
] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export type Direction =
  | "UP" | "DOWN" | "FLAT"
  | "OUTPERFORM" | "UNDERPERFORM"
  | "TRUE" | "FALSE";

export interface ClaimDraft {
  agent: AgentName;
  claimKind: ClaimKind;
  subject: string;
  statement: string;
  direction: Direction | null;
  threshold?: number | null;
  confidence: number;
  horizonDays: number;
  resolver: Resolver;
}

export interface ClaimRow {
  id: number;
  run_id: number;
  agent: AgentName;
  claim_kind: ClaimKind;
  subject: string;
  statement: string;
  direction: Direction | null;
  threshold: number | null;
  confidence: number;
  made_on: string;
  horizon_days: number;
  resolve_after: string;
  resolver: Resolver;
  status: ClaimStatus;
  outcome: number | null;
  resolved_at: string | null;
  resolution_note: string | null;
  resolution_data: string | null;
}

/**
 * Persist a run's claims. Market-wide claims (a regime call, a sector ranking) are made
 * afresh by every run on the same day, so without deduplication a ten-ticker session would
 * record the same forecast ten times and inflate that agent's sample size tenfold. A claim
 * is the same forecast if agent, kind, subject, direction, threshold, horizon and date all
 * match; the first run to make it owns it and later duplicates are skipped.
 */
export function saveClaims(
  conn: DatabaseSync,
  runId: number,
  madeOn: string,
  drafts: ClaimDraft[],
): number[] {
  const ids: number[] = [];
  for (const d of drafts) {
    const horizon = Math.max(1, Math.round(d.horizonDays));
    const confidence = Math.min(1, Math.max(0, d.confidence));
    const dup = conn.prepare(
      `SELECT id FROM agent_claims
       WHERE agent = ? AND claim_kind = ? AND subject = ? AND made_on = ? AND horizon_days = ?
         AND COALESCE(direction, '') = COALESCE(?, '') AND COALESCE(threshold, -999999) = COALESCE(?, -999999)
       LIMIT 1`,
    ).get(d.agent, d.claimKind, d.subject.toUpperCase(), madeOn, horizon, d.direction ?? null, d.threshold ?? null) as { id: number } | undefined;
    if (dup) continue;
    const { lastInsertRowid } = run(
      conn,
      `INSERT INTO agent_claims
        (run_id, agent, claim_kind, subject, statement, direction, threshold,
         confidence, made_on, horizon_days, resolve_after, resolver, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'OPEN')`,
      runId, d.agent, d.claimKind, d.subject.toUpperCase(), d.statement,
      d.direction ?? null, d.threshold ?? null, confidence, madeOn, horizon,
      // calendar days is the right unit for a deadline a human can check
      addDays(madeOn, Math.round(horizon * (7 / 5)) + 1),
      d.resolver,
    );
    ids.push(lastInsertRowid);
  }
  return ids;
}

export function openClaimsDue(conn: DatabaseSync, asOf: string, resolver?: Resolver): ClaimRow[] {
  const extra = resolver ? "AND resolver = ?" : "";
  const params: unknown[] = resolver ? [asOf, resolver] : [asOf];
  return all<ClaimRow>(
    conn,
    `SELECT * FROM agent_claims
     WHERE status = 'OPEN' AND resolve_after <= ? ${extra}
     ORDER BY resolve_after ASC, id ASC`,
    ...params,
  );
}

export function claimsForRun(conn: DatabaseSync, runId: number): ClaimRow[] {
  return all<ClaimRow>(conn, `SELECT * FROM agent_claims WHERE run_id = ? ORDER BY id`, runId);
}

export function settleClaim(
  conn: DatabaseSync,
  claimId: number,
  outcome: 0 | 1 | null,
  note: string,
  data: unknown,
): void {
  run(
    conn,
    `UPDATE agent_claims
     SET status = ?, outcome = ?, resolved_at = date('now'), resolution_note = ?, resolution_data = ?
     WHERE id = ?`,
    outcome === null ? "VOID" : "RESOLVED",
    outcome,
    note,
    JSON.stringify(data ?? null),
    claimId,
  );
}
