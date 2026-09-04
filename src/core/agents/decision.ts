import { S } from "../llm/schema.ts";
import type { AgentSpec, PriorOutputs } from "./types.ts";
import { HOUSE_RULES } from "./types.ts";
import { header, candidateBlock, portfolioBlock, priorBlock } from "./common.ts";

export interface DecisionOut {
  action: "BUY" | "HOLD" | "AVOID" | "TRIM" | "SELL";
  sizePct: number;
  confidence: number;
  horizonDays: number;
  rationale: string;
  decisiveFactor: string;
  disagreementResolved: string;
  overruled: string;
  exitRule: string;
  reviewInDays: number;
  wouldSpyBeBetter: boolean;
}

/** A HOLD is scored inside a band; everything else is a directional relative call. */
export const HOLD_BAND = 0.02;

export const decisionAgent: AgentSpec<DecisionOut> = {
  name: "decision",
  title: "Final Decision",
  purpose: "Synthesises the committee into one action and owns the disagreement it resolved.",
  toolName: "submit_decision",
  toolDescription: "Submit the committee's final decision.",
  temperature: 0.1,
  maxTokens: 1800,
  schema: S.obj({
    action: S.enum("The committee's action.", ["BUY", "HOLD", "AVOID", "TRIM", "SELL"]),
    sizePct: S.num("Position size as a percent of portfolio value. 0 for AVOID or a full SELL.", 0, 25),
    confidence: S.confidence(),
    horizonDays: S.int("Trading days over which this decision should be judged.", 21, 252),
    rationale: S.str("Why this action. Three to five sentences.", 100),
    decisiveFactor: S.str("The single input that decided it. If you cannot name one, the case is weak - say that."),
    disagreementResolved: S.str("Where the committee disagreed and how you resolved it. 'unanimous' only if it truly was."),
    overruled: S.str("Which agent you overrode and why, or 'none'."),
    exitRule: S.str("The condition that closes this position, checkable without judgement."),
    reviewInDays: S.int("Trading days until this should be re-run.", 5, 126),
    wouldSpyBeBetter: S.bool("Honestly: would simply buying SPY have been the better use of this capital."),
  }),
  system: `${HOUSE_RULES}

YOUR ROLE: Final Decision Agent. You synthesise; you do not re-analyse. Every member has
reported and you must produce one action.

How to weigh them:
- The Risk Manager's DECLINE_ON_RISK is a veto on size, not on the idea. You may not size
  above their maxSizePct. If you disagree with the veto, record that in 'overruled' and
  accept the smaller size anyway.
- A strong Bear Case with high probabilities and a specific mechanism should reduce size or
  flip the action, not be noted and ignored. If you are proceeding despite it, say exactly
  which part of it you think is wrong.
- The Regime read sets the base rate for everything. Acting long into a confident RISK_OFF
  read requires a stock-specific reason, and you must state it.
- Doing nothing is a real answer. AVOID and HOLD are not failures, and a committee that
  produces BUY every time it meets has learned nothing.
- Answer wouldSpyBeBetter honestly. It is recorded and compared against what happens.

Your decision is scored on whether it beat simply holding SPY over your stated horizon.`,
  buildUser(ctx, prior: PriorOutputs) {
    return [
      header(ctx),
      "",
      candidateBlock(ctx),
      "",
      portfolioBlock(ctx),
      "",
      "=== COMMITTEE REPORTS ===",
      priorBlock("REGIME", prior.regime),
      priorBlock("SECTOR", prior.sector),
      priorBlock("QUANT", prior.quant),
      priorBlock("RESEARCH", prior.research),
      priorBlock("RISK MANAGER", prior.risk),
      priorBlock("BEAR CASE", prior.bear),
      "",
      `Decide on ${ctx.symbol}. Mandate: ${ctx.mandate}.`,
    ].join("\n");
  },
  claims(out, ctx) {
    const expectsOutperformance = out.action === "BUY" || out.action === "HOLD";
    return [
      {
        agent: "decision", claimKind: "DECISION_VALUE", subject: ctx.symbol,
        statement:
          out.action === "HOLD"
            ? `HOLD ${ctx.symbol}: it does not lag SPY by more than ${HOLD_BAND * 100}% over ${out.horizonDays} trading days.`
            : `${out.action} ${ctx.symbol}: it ${expectsOutperformance ? "beats" : "lags"} SPY over ${out.horizonDays} trading days.`,
        direction: expectsOutperformance ? "OUTPERFORM" : "UNDERPERFORM",
        threshold: out.action === "HOLD" ? HOLD_BAND : 0,
        confidence: out.confidence, horizonDays: out.horizonDays, resolver: "MECHANICAL",
      },
    ];
  },
};
