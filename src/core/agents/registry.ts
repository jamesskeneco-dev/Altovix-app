import type { AgentName } from "../types.ts";
import type { AgentSpec } from "./types.ts";
import { regimeAgent } from "./regime.ts";
import { sectorAgent } from "./sector.ts";
import { quantAgent } from "./quant.ts";
import { researchAgent } from "./research.ts";
import { riskAgent } from "./risk.ts";
import { bearAgent } from "./bear.ts";
import { decisionAgent } from "./decision.ts";
import { journalAgent } from "./journal.ts";

/** The chain, in order. Each agent sees every prior agent's output. */
export const CHAIN: AgentSpec<never>[] = [
  regimeAgent, sectorAgent, quantAgent, researchAgent,
  riskAgent, bearAgent, decisionAgent, journalAgent,
] as unknown as AgentSpec<never>[];

export const BY_NAME: Partial<Record<AgentName, AgentSpec<never>>> = Object.fromEntries(
  CHAIN.map((a) => [a.name, a]),
) as Partial<Record<AgentName, AgentSpec<never>>>;

/**
 * Per-role model overrides. The bear case and research benefit from the stronger
 * model; the mechanical roles do not. Leave a role out to use ALTOVIX_MODEL.
 */
export const MODEL_OVERRIDES: Partial<Record<AgentName, string>> = {};

export { regimeAgent, sectorAgent, quantAgent, researchAgent, riskAgent, bearAgent, decisionAgent, journalAgent };
