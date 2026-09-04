import { S } from "../llm/schema.ts";
import type { AgentSpec, PriorOutputs } from "./types.ts";
import { HOUSE_RULES } from "./types.ts";
import { header, priorRunsBlock, priorBlock } from "./common.ts";

export interface JournalOut {
  headline: string;
  thesisOneLine: string;
  aiScore: number;
  riskScore: number;
  regimeAtEntry: string;
  exitRule: string;
  whatWouldMakeThisWrong: string;
  committeeTension: string;
  lessonFromPriorRuns: string;
  postMortemPrompt: string;
}

export const journalAgent: AgentSpec<JournalOut> = {
  name: "journal",
  title: "Trade Journal",
  purpose: "Writes the durable record, including what would prove it wrong.",
  toolName: "submit_journal_entry",
  toolDescription: "Submit the trade journal entry for this committee run.",
  temperature: 0.2,
  maxTokens: 1400,
  schema: S.obj({
    headline: S.str("One line summarising the run, readable a year later."),
    thesisOneLine: S.str("The thesis compressed to a single sentence."),
    aiScore: S.num("0-10 composite of how attractive the committee found this.", 0, 10),
    riskScore: S.num("0-10 where 10 is the riskiest.", 0, 10),
    regimeAtEntry: S.str("The regime call at the time, so it can be checked later."),
    exitRule: S.str("The exit rule as decided."),
    whatWouldMakeThisWrong: S.str("Written now, before the outcome is known."),
    committeeTension: S.str("Where the committee disagreed. 'none' only if it truly was unanimous."),
    lessonFromPriorRuns: S.str("What earlier runs on this name should teach us, or 'no prior runs'."),
    postMortemPrompt: S.str("The question to ask when reviewing this trade after the horizon closes."),
  }),
  system: `${HOUSE_RULES}

YOUR ROLE: Trade Journal Agent. You write the record that the Calibration Agent and a future
version of this portfolio's manager will read. Write for a reader who has forgotten
everything about today, including whether the trade worked.

The most valuable field is whatWouldMakeThisWrong, written now, while the outcome is unknown
and the reasoning is honest. Hindsight will rewrite it if you do not.

Do not editorialise the decision into sounding better than the committee actually made it.
If it was a close call over real objections, the record says so.`,
  buildUser(ctx, prior: PriorOutputs) {
    return [
      header(ctx),
      "",
      priorRunsBlock(ctx),
      "",
      "=== COMMITTEE REPORTS ===",
      priorBlock("REGIME", prior.regime),
      priorBlock("SECTOR", prior.sector),
      priorBlock("QUANT", prior.quant),
      priorBlock("RESEARCH", prior.research),
      priorBlock("RISK MANAGER", prior.risk),
      priorBlock("BEAR CASE", prior.bear),
      priorBlock("FINAL DECISION", prior.decision),
      "",
      `Write the journal entry for this ${ctx.symbol} run.`,
    ].join("\n");
  },
  claims() {
    return []; // the journal records, it does not forecast
  },
};
