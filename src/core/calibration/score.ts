import type { DatabaseSync } from "node:sqlite";
import type { AgentName } from "../types.ts";
import { all, run } from "../db.ts";
import type { ClaimKind, ClaimRow } from "./claims.ts";

export interface Bucket {
  lo: number;
  hi: number;
  n: number;
  avgConfidence: number;
  observedRate: number;
  gap: number;    // avgConfidence - observedRate; positive means overconfident
}

export interface KindScore {
  kind: ClaimKind;
  n: number;
  hitRate: number;
  brier: number;
}

export interface AgentScore {
  agent: AgentName;
  nClaims: number;
  nCorrect: number;
  hitRate: number;
  avgConfidence: number;
  overconfidence: number;
  brier: number;
  /** 1 - BS/BS_ref against the agent's own base rate. >0 means the confidence carries information. */
  brierSkill: number;
  /** Same, against a fixed 50/50 forecaster - the "is this better than a coin" test. */
  brierSkillVsCoin: number;
  buckets: Bucket[];
  byKind: KindScore[];
  verdict: string;
}

export function brierScore(pairs: Array<{ confidence: number; outcome: number }>): number {
  if (!pairs.length) return 0;
  let acc = 0;
  for (const p of pairs) acc += (p.confidence - p.outcome) ** 2;
  return acc / pairs.length;
}

export function buildBuckets(pairs: Array<{ confidence: number; outcome: number }>, width = 0.1): Bucket[] {
  const buckets: Bucket[] = [];
  for (let lo = 0; lo < 1 - 1e-9; lo += width) {
    const hi = Math.min(1, lo + width);
    const inBucket = pairs.filter((p) =>
      hi >= 1 ? p.confidence >= lo && p.confidence <= 1 : p.confidence >= lo && p.confidence < hi);
    if (!inBucket.length) continue;
    const avgConfidence = inBucket.reduce((s, p) => s + p.confidence, 0) / inBucket.length;
    const observedRate = inBucket.reduce((s, p) => s + p.outcome, 0) / inBucket.length;
    buckets.push({
      lo: round3(lo), hi: round3(hi), n: inBucket.length,
      avgConfidence: round3(avgConfidence), observedRate: round3(observedRate),
      gap: round3(avgConfidence - observedRate),
    });
  }
  return buckets;
}

export function scoreClaims(agent: AgentName, claims: ClaimRow[]): AgentScore {
  const resolved = claims.filter((c) => c.status === "RESOLVED" && c.outcome !== null);
  const pairs = resolved.map((c) => ({ confidence: c.confidence, outcome: c.outcome as number }));
  const n = pairs.length;

  if (!n) {
    return {
      agent, nClaims: 0, nCorrect: 0, hitRate: 0, avgConfidence: 0, overconfidence: 0,
      brier: 0, brierSkill: 0, brierSkillVsCoin: 0, buckets: [], byKind: [],
      verdict: "No resolved claims yet.",
    };
  }

  const nCorrect = pairs.reduce((s, p) => s + p.outcome, 0);
  const hitRate = nCorrect / n;
  const avgConfidence = pairs.reduce((s, p) => s + p.confidence, 0) / n;
  const bs = brierScore(pairs);

  // Reference 1: a forecaster who always predicts this agent's own base rate.
  const bsBase = brierScore(pairs.map((p) => ({ confidence: hitRate, outcome: p.outcome })));
  // Reference 2: a forecaster who always says 0.5.
  const bsCoin = brierScore(pairs.map((p) => ({ confidence: 0.5, outcome: p.outcome })));

  const byKindMap = new Map<ClaimKind, Array<{ confidence: number; outcome: number }>>();
  for (const c of resolved) {
    const list = byKindMap.get(c.claim_kind) ?? [];
    list.push({ confidence: c.confidence, outcome: c.outcome as number });
    byKindMap.set(c.claim_kind, list);
  }

  const score: AgentScore = {
    agent,
    nClaims: n,
    nCorrect,
    hitRate: round3(hitRate),
    avgConfidence: round3(avgConfidence),
    overconfidence: round3(avgConfidence - hitRate),
    brier: round4(bs),
    brierSkill: bsBase > 1e-12 ? round3(1 - bs / bsBase) : 0,
    brierSkillVsCoin: bsCoin > 1e-12 ? round3(1 - bs / bsCoin) : 0,
    buckets: buildBuckets(pairs),
    byKind: [...byKindMap.entries()].map(([kind, ps]) => ({
      kind, n: ps.length,
      hitRate: round3(ps.reduce((s, p) => s + p.outcome, 0) / ps.length),
      brier: round4(brierScore(ps)),
    })).sort((a, b) => b.n - a.n),
    verdict: "",
  };
  score.verdict = verdictFor(score);
  return score;
}

/** Plain-English reading of the numbers, with an explicit small-sample warning. */
export function verdictFor(s: AgentScore): string {
  const parts: string[] = [];
  if (s.nClaims < 20) parts.push(`Only ${s.nClaims} resolved claims - treat everything below as provisional.`);
  parts.push(`Right ${(s.hitRate * 100).toFixed(0)}% of the time while claiming ${(s.avgConfidence * 100).toFixed(0)}% confidence.`);
  if (Math.abs(s.overconfidence) < 0.05) parts.push("Confidence is well calibrated.");
  else if (s.overconfidence > 0) parts.push(`Overconfident by ${(s.overconfidence * 100).toFixed(0)} points.`);
  else parts.push(`Underconfident by ${(-s.overconfidence * 100).toFixed(0)} points - it is right more often than it claims.`);
  if (s.brierSkill > 0.05) parts.push("Its confidence carries real information: high-confidence calls land more often than low-confidence ones.");
  else if (s.brierSkill < -0.05) parts.push("Its confidence is anti-informative: you would do better ignoring it and using its base rate.");
  else parts.push("Its confidence adds little beyond its base rate.");
  return parts.join(" ");
}

/**
 * Scores resolved claims. Claims made by an offline mock run are excluded unless
 * explicitly asked for: they are kept in the database (nothing is ever deleted) but
 * they are not evidence about anything, so they must never enter a scorecard by default.
 */
export function scoreAll(
  conn: DatabaseSync,
  opts: { from?: string; to?: string; includeMock?: boolean } = {},
): AgentScore[] {
  const clauses = ["c.status = 'RESOLVED'"];
  const params: unknown[] = [];
  if (!opts.includeMock) clauses.push("r.llm_mode = 'real'");
  if (opts.from) { clauses.push("c.made_on >= ?"); params.push(opts.from); }
  if (opts.to) { clauses.push("c.made_on <= ?"); params.push(opts.to); }
  const rows = all<ClaimRow>(
    conn,
    `SELECT c.* FROM agent_claims c
     JOIN committee_runs r ON r.id = c.run_id
     WHERE ${clauses.join(" AND ")} ORDER BY c.agent, c.made_on`,
    ...params,
  );
  const byAgent = new Map<AgentName, ClaimRow[]>();
  for (const r of rows) {
    const list = byAgent.get(r.agent) ?? [];
    list.push(r);
    byAgent.set(r.agent, list);
  }
  return [...byAgent.entries()]
    .map(([agent, claims]) => scoreClaims(agent, claims))
    .sort((a, b) => b.nClaims - a.nClaims);
}

export function saveReview(
  conn: DatabaseSync,
  scores: AgentScore[],
  window: { from: string; to: string },
): void {
  for (const s of scores) {
    run(
      conn,
      `INSERT INTO calibration_reviews
         (ran_at, window_start, window_end, agent, n_claims, n_correct, hit_rate,
          brier, brier_skill, avg_confidence, overconfidence, buckets_json, notes)
       VALUES (datetime('now'),?,?,?,?,?,?,?,?,?,?,?,?)`,
      window.from, window.to, s.agent, s.nClaims, s.nCorrect, s.hitRate,
      s.brier, s.brierSkill, s.avgConfidence, s.overconfidence,
      JSON.stringify({ buckets: s.buckets, byKind: s.byKind }), s.verdict,
    );
  }
}

const round3 = (n: number): number => Number(n.toFixed(3));
const round4 = (n: number): number => Number(n.toFixed(4));
