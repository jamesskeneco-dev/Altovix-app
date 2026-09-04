import { S } from "../llm/schema.ts";
import { HOUSE_RULES } from "./types.ts";
import type { JsonSchema } from "../llm/schema.ts";
import type { ClaimRow } from "../calibration/claims.ts";

export interface CalibrationVerdict {
  held: "TRUE" | "FALSE" | "UNDETERMINED";
  whatActuallyHappened: string;
  reasoning: string;
  rightForTheRightReason: boolean;
  severity: number;
}

export const calibrationSchema: JsonSchema = S.obj({
  held: S.enum(
    "Did the claim hold up? UNDETERMINED only when the evidence genuinely cannot settle it - not when the answer is merely uncomfortable.",
    ["TRUE", "FALSE", "UNDETERMINED"],
  ),
  whatActuallyHappened: S.str("Describe the outcome from the evidence, quoting the numbers."),
  reasoning: S.str("Why that outcome does or does not satisfy what was claimed."),
  rightForTheRightReason: S.str as unknown as JsonSchema,
  severity: S.num("If the claim failed, how badly, 0 (trivial) to 1 (completely wrong). Use 0 if it held.", 0, 1),
});
// rightForTheRightReason must be a boolean; assigned explicitly to keep the helper types honest.
(calibrationSchema.properties as Record<string, JsonSchema>)["rightForTheRightReason"] =
  S.bool("True if the mechanism the agent described is what actually drove the outcome, not just the direction being lucky.");

export const CALIBRATION_SYSTEM = `${HOUSE_RULES}

YOUR ROLE: Calibration Agent. You grade claims other agents made in the past, after the fact,
using only the evidence supplied. You are the reason this system can claim to be evaluated
rather than merely elaborate, so grade honestly and without mercy.

Rules:
- Grade the claim that was actually made, not a more reasonable version of it. If an agent
  said a specific risk would materialise and something else went wrong instead, the claim is
  FALSE even if the direction was right.
- Separate outcome from reasoning. A bear case that called a decline for a reason that never
  happened is right on direction and wrong on mechanism: mark held=TRUE only if the claim as
  stated occurred, and set rightForTheRightReason=false.
- UNDETERMINED is for genuine ambiguity - the evidence provided cannot settle it - and not
  for avoiding a hard call. Overusing it makes the whole calibration record worthless.
- You have price evidence only. If the claim asserted something the price path cannot
  confirm or deny, that is UNDETERMINED, and say which evidence would have settled it.
- You are grading a past self of the same system. There is no credit for charity here.`;

export function buildCalibrationPrompt(claim: ClaimRow, evidence: Record<string, unknown>): string {
  return [
    `CLAIM UNDER REVIEW`,
    `  Made by: ${claim.agent} agent`,
    `  Made on: ${claim.made_on} (horizon ${claim.horizon_days} trading days)`,
    `  Stated confidence: ${claim.confidence}`,
    `  Subject: ${claim.subject}`,
    `  Claim kind: ${claim.claim_kind}`,
    `  Statement: ${claim.statement}`,
    "",
    `EVIDENCE (price and volatility over exactly that horizon)`,
    JSON.stringify(evidence, null, 2),
    "",
    `Grade it.`,
  ].join("\n");
}
