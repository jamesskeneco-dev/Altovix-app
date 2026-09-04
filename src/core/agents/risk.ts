import { S } from "../llm/schema.ts";
import type { AgentSpec, PriorOutputs } from "./types.ts";
import { HOUSE_RULES } from "./types.ts";
import { header, candidateBlock, portfolioBlock, priorBlock } from "./common.ts";

export interface RiskOut {
  verdict: "PROCEED" | "PROCEED_SMALLER" | "DECLINE_ON_RISK";
  recommendedSizePct: number;
  maxSizePct: number;
  stopType: "PCT" | "ATR_MULTIPLE" | "LEVEL";
  stopValue: number;
  expectedMaxDrawdownPct: number;
  drawdownConfidence: number;
  horizonDays: number;
  concentrationConcerns: string;
  correlationConcerns: string;
  cashAfterPct: number;
  sizingRationale: string;
  vetoReason: string;
}

export const riskAgent: AgentSpec<RiskOut> = {
  name: "risk",
  title: "Risk Manager",
  purpose: "Sizes the position, sets the stop, and holds veto power on portfolio grounds.",
  toolName: "submit_risk_assessment",
  toolDescription: "Submit position sizing and risk limits.",
  temperature: 0.15,
  maxTokens: 1800,
  schema: S.obj({
    verdict: S.enum("Your gate on this trade.", ["PROCEED", "PROCEED_SMALLER", "DECLINE_ON_RISK"]),
    recommendedSizePct: S.num("Recommended position size as a percent of total portfolio value, 0-25.", 0, 25),
    maxSizePct: S.num("Hard ceiling for this name as a percent of the portfolio, 0-25.", 0, 25),
    stopType: S.enum("How the stop is defined.", ["PCT", "ATR_MULTIPLE", "LEVEL"]),
    stopValue: S.num("The stop value: a fraction for PCT (0.08 = 8%), a multiple for ATR, a price for LEVEL.", 0),
    expectedMaxDrawdownPct: S.num("Worst peak-to-trough you expect in this name over the horizon, as a negative fraction, e.g. -0.15.", -0.9, 0),
    drawdownConfidence: S.confidence("Probability the drawdown stays shallower than that number."),
    horizonDays: S.int("Trading days the sizing and drawdown estimate apply to.", 21, 126),
    concentrationConcerns: S.str("Concentration effects of adding this. 'none' if genuinely none."),
    correlationConcerns: S.str("What the correlation table means for diversification. 'none' if genuinely none."),
    cashAfterPct: S.num("Cash as a fraction of the portfolio after the recommended trade.", 0, 1),
    sizingRationale: S.str("Why this size and not double or half it."),
    vetoReason: S.str("If declining, the reason. Otherwise 'n/a'."),
  }),
  system: `${HOUSE_RULES}

YOUR ROLE: Risk Manager. You are the only member who can stop a trade on portfolio grounds
alone, and you should be willing to use it. The Research and Quant agents are paid to find
reasons to act; you are not.

Sizing principles for a small personal book:
- Size from volatility, not conviction. A name with vol20 of 0.60 gets a fraction of the
  weight of one at 0.20 for the same dollar risk. Conviction belongs in whether you act,
  not in how big you go.
- Correlation above roughly 0.7 with something already held means this is not a new
  position, it is more of the existing one. Size it as an add-on and say so.
- A single name above ~15% of the book, or the top two above ~35%, is concentration that
  needs an explicit argument, not a shrug.
- Cash is a position. Dropping below ~10% cash removes the ability to act on anything better.
- The stop must be wide enough that ordinary noise does not hit it. Compare it to vol20:
  a stop tighter than roughly one 20-day standard deviation of daily moves will be hit by
  noise alone and is not a stop, it is a donation.

Your expectedMaxDrawdownPct is recorded and scored against what actually happens. State the
number you believe, not the comfortable one.`,
  buildUser(ctx, prior: PriorOutputs) {
    return [
      header(ctx),
      "",
      candidateBlock(ctx),
      "",
      portfolioBlock(ctx),
      "",
      priorBlock("REGIME AGENT OUTPUT", prior.regime),
      priorBlock("SECTOR AGENT OUTPUT", prior.sector),
      priorBlock("QUANT AGENT OUTPUT", prior.quant),
      priorBlock("RESEARCH AGENT OUTPUT", prior.research),
      "",
      `Size ${ctx.symbol}, set the stop, and state whether risk permits the trade at all.`,
    ].join("\n");
  },
  claims(out, ctx) {
    return [
      {
        agent: "risk", claimKind: "DRAWDOWN_LIMIT", subject: ctx.symbol,
        statement: `${ctx.symbol} max drawdown stays shallower than ${out.expectedMaxDrawdownPct} over ${out.horizonDays} trading days.`,
        direction: "TRUE", threshold: out.expectedMaxDrawdownPct,
        confidence: out.drawdownConfidence, horizonDays: out.horizonDays, resolver: "MECHANICAL",
      },
    ];
  },
};
