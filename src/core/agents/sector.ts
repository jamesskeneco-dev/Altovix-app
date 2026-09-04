import { S } from "../llm/schema.ts";
import type { AgentSpec, PriorOutputs } from "./types.ts";
import { HOUSE_RULES } from "./types.ts";
import { header, sectorBlock, candidateBlock, priorBlock } from "./common.ts";
import type { ClaimDraft } from "../calibration/claims.ts";

export interface SectorOut {
  leaders: Array<{ etf: string; why: string; confidence: number }>;
  laggards: Array<{ etf: string; why: string; confidence: number }>;
  candidateSector: string;
  candidateSectorStance: "TAILWIND" | "NEUTRAL" | "HEADWIND";
  stanceConfidence: number;
  horizonDays: number;
  rotationNarrative: string;
  contradictsRegime: boolean;
  contradictionNote: string;
}

export const sectorAgent: AgentSpec<SectorOut> = {
  name: "sector",
  title: "Sector Rotation",
  purpose: "Ranks sector leadership against SPY and places the candidate inside it.",
  toolName: "submit_sector_read",
  toolDescription: "Submit the sector rotation assessment.",
  temperature: 0.2,
  maxTokens: 1600,
  schema: S.obj({
    leaders: S.arr("Sector ETFs you expect to beat SPY over the horizon.", S.obj({
      etf: S.str("Ticker from the table, e.g. XLK."),
      why: S.str("The reading that supports it."),
      confidence: S.confidence(),
    }), 1, 4),
    laggards: S.arr("Sector ETFs you expect to lag SPY over the horizon.", S.obj({
      etf: S.str("Ticker from the table."),
      why: S.str("The reading that supports it."),
      confidence: S.confidence(),
    }), 1, 4),
    candidateSector: S.str("Which sector ETF best represents the candidate. Use UNKNOWN if you were not told and cannot tell."),
    candidateSectorStance: S.enum("Whether the candidate's sector is a tailwind or headwind.", ["TAILWIND", "NEUTRAL", "HEADWIND"]),
    stanceConfidence: S.confidence(),
    horizonDays: S.int("Trading days these relative calls are meant to hold for.", 10, 63),
    rotationNarrative: S.str("What the rotation pattern says about what the market is pricing."),
    contradictsRegime: S.bool("True if sector leadership disagrees with the regime call you were handed."),
    contradictionNote: S.str("If it contradicts, say how. If not, write 'none'."),
  }),
  system: `${HOUSE_RULES}

YOUR ROLE: Sector Rotation Agent. You run after the Regime Agent and you are allowed -
encouraged - to contradict it, because leadership often turns before the index does.

Read rs21 and rs63 (excess return over SPY) together with the moving-average columns.
Defensives leading (XLP, XLU, XLV) while cyclicals lag is a risk-off tell even in a rising
tape. Broad participation across XLK, XLY and XLI is the opposite. A sector that is strong
on rs63 but negative on rs21 is decelerating - say so rather than calling it a leader.

Only name a sector as leader or laggard if you would stand behind it as a 21-day relative
bet. Every one you name is recorded and scored against SPY.`,
  buildUser(ctx, prior: PriorOutputs) {
    return [
      header(ctx),
      "",
      sectorBlock(ctx),
      "",
      candidateBlock(ctx),
      "",
      priorBlock("REGIME AGENT OUTPUT", prior.regime),
      "",
      `Rank leadership and place ${ctx.symbol} inside it.`,
    ].join("\n");
  },
  claims(out) {
    const drafts: ClaimDraft[] = [];
    for (const l of out.leaders) {
      drafts.push({
        agent: "sector", claimKind: "SECTOR_RELATIVE", subject: l.etf,
        statement: `${l.etf} outperforms SPY over ${out.horizonDays} trading days.`,
        direction: "OUTPERFORM", confidence: l.confidence,
        horizonDays: out.horizonDays, resolver: "MECHANICAL",
      });
    }
    for (const l of out.laggards) {
      drafts.push({
        agent: "sector", claimKind: "SECTOR_RELATIVE", subject: l.etf,
        statement: `${l.etf} underperforms SPY over ${out.horizonDays} trading days.`,
        direction: "UNDERPERFORM", confidence: l.confidence,
        horizonDays: out.horizonDays, resolver: "MECHANICAL",
      });
    }
    return drafts;
  },
};
