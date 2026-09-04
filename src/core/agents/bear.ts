import { S } from "../llm/schema.ts";
import type { AgentSpec, PriorOutputs } from "./types.ts";
import { HOUSE_RULES } from "./types.ts";
import { header, candidateBlock, priorBlock } from "./common.ts";
import type { ClaimDraft } from "../calibration/claims.ts";

export interface BearOut {
  strongestBearCase: string;
  specificRisks: Array<{
    risk: string;
    mechanism: string;
    probability: number;
    horizonDays: number;
    observableSignal: string;
  }>;
  whatTheBullsAreMissing: string;
  priceImpactIfRight: number;
  fallsOutright: boolean;
  conviction: number;
  horizonDays: number;
  strongestCounterToMyself: string;
}

export const bearAgent: AgentSpec<BearOut> = {
  name: "bear",
  title: "Bear Case",
  purpose: "Argues against the trade in specific, observable terms - and gets scored on it.",
  toolName: "submit_bear_case",
  toolDescription: "Submit the case against the trade.",
  temperature: 0.55,
  maxTokens: 2000,
  schema: S.obj({
    strongestBearCase: S.str("The single most damaging honest argument against this trade.", 100),
    specificRisks: S.arr("Named risks, each one falsifiable.", S.obj({
      risk: S.str("What goes wrong, in one line."),
      mechanism: S.str("How it actually transmits into the share price."),
      probability: S.confidence("Probability this occurs within its horizon."),
      horizonDays: S.int("Trading days within which it would show up.", 5, 252),
      observableSignal: S.str("What would be visible in price or data if this is starting to happen."),
    }), 2, 5),
    whatTheBullsAreMissing: S.str("The blind spot in the thesis you were handed, quoted specifically."),
    priceImpactIfRight: S.num("Peak-to-trough impact if your case plays out, as a negative fraction, e.g. -0.25.", -0.95, 0),
    fallsOutright: S.bool("Do you expect the price to be lower than today at the end of your horizon."),
    conviction: S.confidence("How strongly you hold the bear case overall."),
    horizonDays: S.int("Trading days for your overall call.", 10, 126),
    strongestCounterToMyself: S.str("The best argument against your own bear case. You must supply one."),
  }),
  system: `${HOUSE_RULES}

YOUR ROLE: Bear Case Agent. You argue against the trade. You are not a contrarian for its own
sake and you are not permitted to be vague - vagueness is how a bear case avoids ever being
wrong, and here every risk you name is recorded with its probability and scored against what
actually happened.

Requirements:
- Attack the specific thesis you were handed, quoting the part you think is weakest. Do not
  write a generic list of market risks that would apply to any stock.
- Every risk needs a transmission mechanism. "Competition" is not a risk. "Margin compression
  as competitors price below them, showing up first as decelerating revenue growth" is.
- Give real probabilities. If you mark five risks at 0.8 each you are claiming near-certain
  catastrophe, and the scoring will treat you accordingly.
- Do not invent news, filings or events. Attack from structure, price behaviour, valuation
  logic and the gaps in the thesis.
- You must supply the strongest counter to your own case. An advocate who cannot state the
  other side is not being useful.

A bear case that is right about direction for the wrong reason still scores as right on
price, and wrong on mechanism. Both are tracked.`,
  buildUser(ctx, prior: PriorOutputs) {
    return [
      header(ctx),
      "",
      candidateBlock(ctx),
      "",
      priorBlock("REGIME AGENT OUTPUT", prior.regime),
      priorBlock("SECTOR AGENT OUTPUT", prior.sector),
      priorBlock("QUANT AGENT OUTPUT", prior.quant),
      priorBlock("RESEARCH AGENT OUTPUT (this is the thesis to attack)", prior.research),
      priorBlock("RISK MANAGER OUTPUT", prior.risk),
      "",
      `Make the case against ${ctx.symbol}.`,
    ].join("\n");
  },
  claims(out, ctx) {
    const drafts: ClaimDraft[] = [
      {
        agent: "bear", claimKind: "PRICE_DIRECTION", subject: ctx.symbol,
        statement: `Bear case: ${ctx.symbol} is ${out.fallsOutright ? "lower" : "not lower"} in ${out.horizonDays} trading days.`,
        direction: out.fallsOutright ? "DOWN" : "UP", threshold: 0.0,
        confidence: out.conviction, horizonDays: out.horizonDays, resolver: "MECHANICAL",
      },
    ];
    for (const r of out.specificRisks) {
      drafts.push({
        agent: "bear", claimKind: "BEAR_RISK_MATERIALIZES", subject: ctx.symbol,
        statement: `${r.risk} | mechanism: ${r.mechanism} | visible as: ${r.observableSignal}`,
        direction: "TRUE", confidence: r.probability,
        horizonDays: r.horizonDays, resolver: "JUDGMENT",
      });
    }
    return drafts;
  },
};
