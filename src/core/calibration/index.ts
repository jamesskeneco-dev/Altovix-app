import type { DatabaseSync } from "node:sqlite";
import { config } from "../config.ts";
import { makeClient, type LlmClient } from "../llm/index.ts";
import {
  CALIBRATION_SYSTEM, buildCalibrationPrompt, calibrationSchema, type CalibrationVerdict,
} from "../agents/calibration.ts";
import { openClaimsDue, settleClaim } from "./claims.ts";
import { evidenceFor, resolveDue, type ResolveSummary } from "./resolve.ts";
import { scoreAll, saveReview, type AgentScore } from "./score.ts";

export * from "./claims.ts";
export * from "./resolve.ts";
export * from "./score.ts";

export interface CalibrationReport {
  asOf: string;
  mechanical: ResolveSummary;
  judgment: { attempted: number; resolved: number; undetermined: number; notReady: number; failed: number };
  scores: AgentScore[];
  headline: string;
}

export interface CalibrationOptions {
  asOf?: string;
  llm?: LlmClient;
  /** Skip the model-graded claims (free, and enough for a quick check). */
  mechanicalOnly?: boolean;
  /** Include offline mock runs in the scorecard. Demo use only - never for a real record. */
  includeMock?: boolean;
  from?: string;
  onProgress?: (msg: string) => void;
}

/**
 * The evaluation pass. Mechanical claims resolve against stored prices with no model
 * involved; only genuinely judgemental claims cost a model call. Scores are then
 * recomputed across every resolved claim and written to calibration_reviews.
 */
export async function runCalibration(
  conn: DatabaseSync,
  opts: CalibrationOptions = {},
): Promise<CalibrationReport> {
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const mechanical = resolveDue(conn, asOf);
  opts.onProgress?.(`mechanical: ${mechanical.resolved} resolved, ${mechanical.correct} correct, ${mechanical.notReady} not yet due`);

  const judgment = { attempted: 0, resolved: 0, undetermined: 0, notReady: 0, failed: 0 };

  if (!opts.mechanicalOnly) {
    const llm = opts.llm ?? makeClient();
    for (const claim of openClaimsDue(conn, asOf, "JUDGMENT")) {
      const evidence = evidenceFor(conn, claim);
      if (!evidence) { judgment.notReady++; continue; }
      judgment.attempted++;
      try {
        const res = await llm.complete({
          system: CALIBRATION_SYSTEM,
          user: buildCalibrationPrompt(claim, evidence),
          schema: calibrationSchema,
          toolName: "submit_calibration_verdict",
          toolDescription: "Grade whether the claim held up.",
          temperature: 0.1,
          maxTokens: 1200,
        });
        const verdict = res.json as CalibrationVerdict;
        const outcome = verdict.held === "TRUE" ? 1 : verdict.held === "FALSE" ? 0 : null;
        settleClaim(
          conn, claim.id, outcome,
          `${verdict.whatActuallyHappened} | ${verdict.reasoning}`,
          { ...evidence, verdict },
        );
        if (outcome === null) judgment.undetermined++;
        else judgment.resolved++;
        opts.onProgress?.(`judgment claim #${claim.id} (${claim.agent}): ${verdict.held}`);
      } catch (err) {
        judgment.failed++;
        opts.onProgress?.(`judgment claim #${claim.id} failed: ${(err as Error).message}`);
      }
    }
  }

  const scores = scoreAll(conn, { from: opts.from, includeMock: opts.includeMock });
  if (scores.length) saveReview(conn, scores, { from: opts.from ?? "inception", to: asOf });

  return { asOf, mechanical, judgment, scores, headline: headlineFor(scores) };
}

function headlineFor(scores: AgentScore[]): string {
  if (!scores.length) return "No resolved claims yet - calibration begins once the first horizons close.";
  const total = scores.reduce((s, a) => s + a.nClaims, 0);
  const best = [...scores].sort((a, b) => b.brierSkill - a.brierSkill)[0] as AgentScore;
  const worst = [...scores].sort((a, b) => b.overconfidence - a.overconfidence)[0] as AgentScore;
  const parts = [`${total} claims resolved across ${scores.length} agents.`];
  parts.push(`Best-calibrated: ${best.agent} (Brier skill ${best.brierSkill}).`);
  if (worst.overconfidence > 0.05) {
    parts.push(`Most overconfident: ${worst.agent}, by ${(worst.overconfidence * 100).toFixed(0)} points.`);
  }
  if (total < 30) parts.push("Sample is still small; do not over-read it.");
  return parts.join(" ");
}

export const CALIBRATION_MODEL = config.model;
