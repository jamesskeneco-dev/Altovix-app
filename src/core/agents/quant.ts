import { S } from "../llm/schema.ts";
import type { AgentSpec, PriorOutputs } from "./types.ts";
import { HOUSE_RULES } from "./types.ts";
import { header, candidateBlock, priorBlock } from "./common.ts";

export interface QuantOut {
  trend: "STRONG_UP" | "UP" | "SIDEWAYS" | "DOWN" | "STRONG_DOWN";
  momentumScore: number;
  setupQuality: number;
  stretch: "OVERBOUGHT" | "NEUTRAL" | "OVERSOLD";
  volatilityRead: string;
  relativeStrengthRead: string;
  directionalCall: "UP" | "DOWN" | "FLAT";
  beatsBenchmark: boolean;
  horizonDays: number;
  confidence: number;
  signalConflicts: string;
  caveats: string;
}

export const quantAgent: AgentSpec<QuantOut> = {
  name: "quant",
  title: "Quant Signal",
  purpose: "Interprets the computed technical picture and commits to a directional call.",
  toolName: "submit_quant_read",
  toolDescription: "Submit the quantitative signal assessment.",
  temperature: 0.15,
  maxTokens: 1600,
  schema: S.obj({
    trend: S.enum("Primary trend from price versus its moving averages and trend63.", ["STRONG_UP", "UP", "SIDEWAYS", "DOWN", "STRONG_DOWN"]),
    momentumScore: S.num("-3 (worst) to +3 (best), your synthesis of the return columns.", -3, 3),
    setupQuality: S.num("0-10. How clean is this entry technically, ignoring whether you like the company.", 0, 10),
    stretch: S.enum("Whether price is extended.", ["OVERBOUGHT", "NEUTRAL", "OVERSOLD"]),
    volatilityRead: S.str("What vol20, vol60 and volRatio say about the risk of the entry."),
    relativeStrengthRead: S.str("What rs21/rs63/rs252 say versus the benchmarks."),
    directionalCall: S.enum("Where you expect the price to go over the horizon.", ["UP", "DOWN", "FLAT"]),
    beatsBenchmark: S.bool("True if you expect it to beat SPY over the horizon, regardless of direction."),
    horizonDays: S.int("Trading days for the call.", 5, 63),
    confidence: S.confidence(),
    signalConflicts: S.str("Name the signals that disagree with each other here. If none, say 'none'."),
    caveats: S.str("What the data cannot tell you, including any gaps you were warned about."),
  }),
  system: `${HOUSE_RULES}

YOUR ROLE: Quant Signal Agent. Every number you need has already been computed. Your job is
interpretation, not calculation, and not narrative about the company.

Guidance that reflects how these signals actually behave:
- Trend and momentum persist on 3-12 month windows and mean-revert on 1-5 day windows.
  Do not read a one-week move as a trend change.
- RSI is a stretch gauge, not a signal on its own. RSI above 70 in a strong uptrend is
  usually continuation; RSI above 70 in a sideways range is usually exhaustion.
- volRatio above roughly 1.3 means volatility is expanding, which widens any stop and
  argues for smaller size regardless of how good the setup looks.
- A stock making new highs on rs21 but with volumeSurge below 1 is a thinner move than it
  appears. Say so.
- If pctOf52wRange is very low and trend63 is negative, you are looking at a falling knife,
  not a discount. Name it.

Distinguish two separate calls: direction (does it go up) and relative (does it beat SPY).
They are scored separately and they often differ.`,
  buildUser(ctx, prior: PriorOutputs) {
    return [
      header(ctx),
      "",
      candidateBlock(ctx),
      "",
      priorBlock("REGIME AGENT OUTPUT", prior.regime),
      "",
      priorBlock("SECTOR AGENT OUTPUT", prior.sector),
      "",
      `Give the technical read on ${ctx.symbol} and commit to both a directional and a relative call.`,
    ].join("\n");
  },
  claims(out, ctx) {
    return [
      {
        agent: "quant", claimKind: "PRICE_DIRECTION", subject: ctx.symbol,
        statement: `${ctx.symbol} moves ${out.directionalCall} over ${out.horizonDays} trading days.`,
        direction: out.directionalCall, threshold: 0.02,
        confidence: out.confidence, horizonDays: out.horizonDays, resolver: "MECHANICAL",
      },
      {
        agent: "quant", claimKind: "RELATIVE_TO_BENCH", subject: ctx.symbol,
        statement: `${ctx.symbol} ${out.beatsBenchmark ? "outperforms" : "underperforms"} SPY over ${out.horizonDays} trading days.`,
        direction: out.beatsBenchmark ? "OUTPERFORM" : "UNDERPERFORM",
        confidence: out.confidence, horizonDays: out.horizonDays, resolver: "MECHANICAL",
      },
    ];
  },
};
