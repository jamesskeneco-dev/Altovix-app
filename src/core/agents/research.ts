import { S } from "../llm/schema.ts";
import type { AgentSpec, PriorOutputs } from "./types.ts";
import { HOUSE_RULES } from "./types.ts";
import { header, candidateBlock, portfolioBlock, priorRunsBlock, priorBlock } from "./common.ts";

export interface ResearchOut {
  thesis: string;
  whyNow: string;
  catalyst: string;
  catalystWindowDays: number;
  keyRisks: string[];
  exitTrigger: string;
  vsSpyArgument: string;
  beatsSpy: boolean;
  horizonDays: number;
  thesisConfidence: number;
  disconfirmingEvidence: string;
  knowledgeLimits: string;
}

export const researchAgent: AgentSpec<ResearchOut> = {
  name: "research",
  title: "Research",
  purpose: "Writes the falsifiable thesis: why this, why now, what would kill it.",
  toolName: "submit_research_thesis",
  toolDescription: "Submit the investment thesis for the candidate.",
  temperature: 0.35,
  maxTokens: 2200,
  schema: S.obj({
    thesis: S.str("Three to six sentences. The actual argument for owning or avoiding this.", 120),
    whyNow: S.str("Why this is a decision for today rather than any other day."),
    catalyst: S.str("The specific thing that would cause repricing. 'Sentiment improves' is not a catalyst."),
    catalystWindowDays: S.int("Trading days within which the catalyst should show up.", 5, 252),
    keyRisks: S.arr("The risks that matter, most severe first.", S.str("A specific risk."), 2, 6),
    exitTrigger: S.str("The precise condition on which you would exit. Must be checkable from price or a dated event."),
    vsSpyArgument: S.str("Why hold this instead of simply owning SPY. This is the bar that matters."),
    beatsSpy: S.bool("Do you expect it to beat SPY over your horizon."),
    horizonDays: S.int("Trading days over which the thesis should show up in price.", 21, 252),
    thesisConfidence: S.confidence(),
    disconfirmingEvidence: S.str("What observation would tell you the thesis is wrong, stated before the fact."),
    knowledgeLimits: S.str("What you do not know here: no news, no filings, no earnings data were provided. Be explicit."),
  }),
  system: `${HOUSE_RULES}

YOUR ROLE: Research Agent. You write the thesis. Two hard constraints:

FIRST, you have been given price and volume data only. No filings, no earnings, no guidance,
no news. You may use general knowledge of what a company does, but you must not invent
specific figures, dates, product launches, analyst views or headlines. If the thesis needs a
fact you were not given, name it in knowledgeLimits and lower your confidence. A thesis built
on invented specifics is worse than no thesis, and it will be scored as wrong.

SECOND, the benchmark is SPY, not zero. "This will go up" is not a thesis, because SPY
usually goes up too. The question is always: why this instead of the index. If you cannot
answer that, say so plainly and set beatsSpy to false.

Write the exit trigger before the position exists, while you are still honest. It must be
checkable without judgement later.`,
  buildUser(ctx, prior: PriorOutputs) {
    return [
      header(ctx),
      "",
      candidateBlock(ctx),
      "",
      portfolioBlock(ctx),
      "",
      priorRunsBlock(ctx),
      "",
      priorBlock("REGIME AGENT OUTPUT", prior.regime),
      priorBlock("SECTOR AGENT OUTPUT", prior.sector),
      priorBlock("QUANT AGENT OUTPUT", prior.quant),
      "",
      `Write the thesis for ${ctx.symbol} under a ${ctx.mandate} mandate.`,
    ].join("\n");
  },
  claims(out, ctx) {
    return [
      {
        agent: "research", claimKind: "THESIS_PLAYS_OUT", subject: ctx.symbol,
        statement: `Thesis: ${out.thesis.slice(0, 400)} | Catalyst: ${out.catalyst}`,
        direction: "TRUE", confidence: out.thesisConfidence,
        horizonDays: out.horizonDays, resolver: "JUDGMENT",
      },
      {
        agent: "research", claimKind: "RELATIVE_TO_BENCH", subject: ctx.symbol,
        statement: `${ctx.symbol} ${out.beatsSpy ? "outperforms" : "underperforms"} SPY over ${out.horizonDays} trading days on the research thesis.`,
        direction: out.beatsSpy ? "OUTPERFORM" : "UNDERPERFORM",
        confidence: out.thesisConfidence, horizonDays: out.horizonDays, resolver: "MECHANICAL",
      },
    ];
  },
};
