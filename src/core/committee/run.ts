import type { DatabaseSync } from "node:sqlite";
import type { AgentName, Mandate } from "../types.ts";
import { config } from "../config.ts";
import { all, one, run as exec } from "../db.ts";
import { makeClient, type LlmClient } from "../llm/index.ts";
import { CHAIN, MODEL_OVERRIDES } from "../agents/registry.ts";
import type { AgentSpec, PriorOutputs } from "../agents/types.ts";
import type { DecisionOut } from "../agents/decision.ts";
import type { JournalOut } from "../agents/journal.ts";
import { saveClaims, type ClaimDraft } from "../calibration/claims.ts";
import { buildContext, hashContext, type CommitteeContext } from "./context.ts";

export interface RunProgress {
  agent: AgentName;
  title: string;
  index: number;
  total: number;
  phase: "start" | "done" | "error";
  latencyMs?: number;
  error?: string;
  output?: unknown;
}

export interface RunOptions {
  asOf?: string;
  mandate?: Mandate;
  llm?: LlmClient;
  onProgress?: (p: RunProgress) => void;
  /** Run only these agents. The chain order is preserved. */
  only?: AgentName[];
  operatorNotes?: string | null;
}

export interface CommitteeRunResult {
  runId: number;
  status: "COMPLETE" | "FAILED";
  context: CommitteeContext;
  outputs: PriorOutputs;
  claimIds: number[];
  action: string | null;
  confidence: number | null;
  sizePct: number | null;
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
  error: string | null;
}

export async function runCommittee(
  conn: DatabaseSync,
  symbol: string,
  opts: RunOptions = {},
): Promise<CommitteeRunResult> {
  const llm = opts.llm ?? makeClient();
  const ctx = buildContext(conn, symbol, { asOf: opts.asOf, mandate: opts.mandate, operatorNotes: opts.operatorNotes });
  const started = Date.now();

  const { lastInsertRowid: runId } = exec(
    conn,
    `INSERT INTO committee_runs
       (started_at, as_of_date, symbol, mandate, status, llm_mode, context_json, context_hash)
     VALUES (datetime('now'), ?, ?, ?, 'RUNNING', ?, ?, ?)`,
    ctx.asOfDate, ctx.symbol, ctx.mandate, llm.mode, JSON.stringify(ctx), hashContext(ctx),
  );

  const chain = opts.only
    ? CHAIN.filter((a) => (opts.only as AgentName[]).includes(a.name))
    : CHAIN;

  const outputs: PriorOutputs = {};
  const drafts: ClaimDraft[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let failure: string | null = null;

  for (let i = 0; i < chain.length; i++) {
    const agent = chain[i] as AgentSpec<never>;
    opts.onProgress?.({ agent: agent.name, title: agent.title, index: i, total: chain.length, phase: "start" });

    const system = agent.system;
    const user = agent.buildUser(ctx, outputs);
    const model = MODEL_OVERRIDES[agent.name] ?? config.model;

    try {
      const res = await llm.complete({
        system, user, schema: agent.schema,
        toolName: agent.toolName, toolDescription: agent.toolDescription,
        model, temperature: agent.temperature, maxTokens: agent.maxTokens,
      });
      exec(
        conn,
        `INSERT INTO agent_outputs
           (run_id, seq, agent, model, system_prompt, user_prompt, raw_response, output_json,
            input_tokens, output_tokens, latency_ms, attempts)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        runId, i, agent.name, res.model, system, user, res.raw, JSON.stringify(res.json),
        res.inputTokens, res.outputTokens, res.latencyMs, res.attempts,
      );
      outputs[agent.name] = res.json;
      inputTokens += res.inputTokens;
      outputTokens += res.outputTokens;
      drafts.push(...agent.claims(res.json as never, ctx));
      opts.onProgress?.({ agent: agent.name, title: agent.title, index: i, total: chain.length, phase: "done", latencyMs: res.latencyMs, output: res.json });
    } catch (err) {
      const message = (err as Error).message;
      exec(
        conn,
        `INSERT INTO agent_outputs (run_id, seq, agent, model, system_prompt, user_prompt, error)
         VALUES (?,?,?,?,?,?,?)`,
        runId, i, agent.name, model, system, user, message,
      );
      failure = `${agent.name}: ${message}`;
      opts.onProgress?.({ agent: agent.name, title: agent.title, index: i, total: chain.length, phase: "error", error: message });
      break;
    }
  }

  // Claims are always recorded - deleting evidence is exactly what this system exists not to do.
  // Mock runs are excluded at scoring time instead, via committee_runs.llm_mode.
  const claimIds = failure ? [] : saveClaims(conn, runId, ctx.asOfDate, drafts);

  const decision = outputs.decision as DecisionOut | undefined;
  const elapsed = Date.now() - started;

  exec(
    conn,
    `UPDATE committee_runs
     SET finished_at = datetime('now'), status = ?, final_action = ?, final_confidence = ?,
         final_size_pct = ?, elapsed_ms = ?, input_tokens = ?, output_tokens = ?, error = ?
     WHERE id = ?`,
    failure ? "FAILED" : "COMPLETE",
    decision?.action ?? null, decision?.confidence ?? null, decision?.sizePct ?? null,
    elapsed, inputTokens, outputTokens, failure, runId,
  );

  const journal = outputs.journal as JournalOut | undefined;
  if (journal && !failure) {
    exec(
      conn,
      `INSERT INTO research_notes (symbol, date, title, body, committee_run_id) VALUES (?,?,?,?,?)`,
      ctx.symbol, ctx.asOfDate, journal.headline,
      [
        `Thesis: ${journal.thesisOneLine}`,
        `AI score ${journal.aiScore}/10 | Risk score ${journal.riskScore}/10`,
        `Regime at entry: ${journal.regimeAtEntry}`,
        `Exit rule: ${journal.exitRule}`,
        `What would make this wrong: ${journal.whatWouldMakeThisWrong}`,
        `Committee tension: ${journal.committeeTension}`,
        `Post-mortem prompt: ${journal.postMortemPrompt}`,
      ].join("\n\n"),
      runId,
    );
  }

  return {
    runId,
    status: failure ? "FAILED" : "COMPLETE",
    context: ctx,
    outputs,
    claimIds,
    action: decision?.action ?? null,
    confidence: decision?.confidence ?? null,
    sizePct: decision?.sizePct ?? null,
    elapsedMs: elapsed,
    inputTokens,
    outputTokens,
    error: failure,
  };
}

export interface RunRow {
  id: number; started_at: string; as_of_date: string; symbol: string; mandate: Mandate;
  status: string; llm_mode: string; final_action: string | null; final_confidence: number | null;
  final_size_pct: number | null; elapsed_ms: number | null; input_tokens: number; output_tokens: number;
  error: string | null;
}

export function listRuns(conn: DatabaseSync, limit = 50): RunRow[] {
  return all<RunRow>(
    conn,
    `SELECT id, started_at, as_of_date, symbol, mandate, status, llm_mode, final_action,
            final_confidence, final_size_pct, elapsed_ms, input_tokens, output_tokens, error
     FROM committee_runs ORDER BY id DESC LIMIT ?`,
    limit,
  );
}

export interface AgentOutputRow {
  id: number; seq: number; agent: AgentName; model: string;
  system_prompt: string; user_prompt: string; raw_response: string | null;
  output_json: string | null; input_tokens: number; output_tokens: number;
  latency_ms: number; attempts: number; error: string | null;
}

export function runTranscript(conn: DatabaseSync, runId: number): AgentOutputRow[] {
  return all<AgentOutputRow>(conn, `SELECT * FROM agent_outputs WHERE run_id = ? ORDER BY seq`, runId);
}

export function getRun(conn: DatabaseSync, runId: number): RunRow | undefined {
  return one<RunRow>(conn, `SELECT * FROM committee_runs WHERE id = ?`, runId);
}
