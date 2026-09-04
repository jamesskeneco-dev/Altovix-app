import type { AgentName } from "../types.ts";
import type { JsonSchema } from "../llm/schema.ts";
import type { ClaimDraft } from "../calibration/claims.ts";
import type { CommitteeContext } from "../committee/context.ts";

/** Outputs of the agents that have already run, keyed by agent name. */
export type PriorOutputs = Partial<Record<AgentName, unknown>>;

export interface AgentSpec<TOut = unknown> {
  name: AgentName;
  title: string;
  /** One line for the UI and the methodology writeup. */
  purpose: string;
  toolName: string;
  toolDescription: string;
  schema: JsonSchema;
  system: string;
  /** Temperature is per-role: the bear case runs hotter, the decision colder. */
  temperature: number;
  maxTokens: number;
  buildUser(ctx: CommitteeContext, prior: PriorOutputs): string;
  /** Falsifiable statements this output commits to, for later scoring. */
  claims(out: TOut, ctx: CommitteeContext): ClaimDraft[];
}

export const HOUSE_RULES = `
You are one member of the Altovix investment committee. Rules that bind every member:

1. You are given pre-computed numbers. Never recompute, estimate, or invent a figure.
   If a number you need is absent, say so and lower your confidence rather than guessing.
2. Confidence is a probability, not enthusiasm. 0.5 means a coin flip. Every confidence
   you state is recorded and scored against what actually happened, so systematic
   overconfidence will show up in your calibration record and count against you.
3. Be specific enough to be wrong. "Tech may face headwinds" is unscoreable and worthless.
   "XLK underperforms SPY over the next 21 trading days" is a real claim. Prefer the latter.
4. You see only your own slice plus the output of members before you. Do not pretend to
   knowledge you were not given, and do not invent news, earnings dates, or headlines.
5. Disagreeing with an earlier member is expected and useful. Say so explicitly when you do.
`.trim();
