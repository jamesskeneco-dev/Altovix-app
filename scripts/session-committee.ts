/**
 * Stage runner for a committee session where the model answers are supplied by hand
 * (or by any process that can read a prompt file and write a JSON answer file).
 *
 *   --stage <agent> --symbols A,B,C    write each symbol's prompt for that agent, using
 *                                      the answers already on disk for earlier agents
 *   --commit --symbols A,B,C           replay the saved answers through runCommittee so the
 *                                      run is persisted, schema-validated and claims recorded
 *
 * Answers live in data/session/<SYMBOL>/<agent>.json. Operator notes in data/session/notes/
 * (market.md applies to all symbols; <SYMBOL>.md is appended for that symbol).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { db, migrate } from "../src/core/db.ts";
import { CHAIN } from "../src/core/agents/registry.ts";
import type { AgentSpec, PriorOutputs } from "../src/core/agents/types.ts";
import { buildContext } from "../src/core/committee/context.ts";
import { runCommittee } from "../src/core/committee/run.ts";
import { validate, type LlmClient, type LlmRequest } from "../src/core/llm/index.ts";
import type { AgentName } from "../src/core/types.ts";
import { parseArgs, str, bool } from "../src/cli/args.ts";

const args = parseArgs();
const root = resolve(process.cwd(), "data/session");
const symbols = (str(args, "symbols", "") as string).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const model = str(args, "model", "claude (interactive session)") as string;
const conn = db();
migrate(conn);

const notesFor = (symbol: string): string => {
  const parts: string[] = [];
  for (const f of ["notes/market.md", `notes/${symbol}.md`]) {
    const p = resolve(root, f);
    if (existsSync(p)) parts.push(readFileSync(p, "utf8").trim());
  }
  return parts.join("\n\n");
};
const answerPath = (symbol: string, agent: string) => resolve(root, symbol, `${agent}.json`);
const readAnswer = (symbol: string, agent: string): unknown | undefined => {
  const p = answerPath(symbol, agent);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
};

if (str(args, "stage")) {
  const agentName = str(args, "stage") as AgentName;
  const agent = CHAIN.find((a) => a.name === agentName) as AgentSpec<never> | undefined;
  if (!agent) throw new Error(`unknown agent ${agentName}`);
  for (const symbol of symbols) {
    const ctx = buildContext(conn, symbol, { operatorNotes: notesFor(symbol) });
    const prior: PriorOutputs = {};
    for (const a of CHAIN) {
      if (a.name === agentName) break;
      const ans = readAnswer(symbol, a.name);
      if (ans !== undefined) prior[a.name] = ans;
    }
    const prompt = agent.buildUser(ctx, prior);
    mkdirSync(resolve(root, symbol), { recursive: true });
    writeFileSync(resolve(root, symbol, `${agentName}.prompt.txt`), prompt);
    console.log(`\n${"=".repeat(100)}\n### ${symbol} :: ${agent.title}\n${"=".repeat(100)}\n${prompt}`);
  }
  // Print the schema once so the answer shape is unambiguous.
  console.log(`\n${"=".repeat(100)}\n### SCHEMA for ${agent.name}\n${JSON.stringify(agent.schema, null, 1)}`);
}

if (bool(args, "validate")) {
  let bad = 0;
  for (const symbol of symbols) {
    for (const a of CHAIN) {
      const ans = readAnswer(symbol, a.name);
      if (ans === undefined) continue;
      const errs = validate(ans, a.schema);
      if (errs.length) { bad++; console.log(`${symbol}/${a.name}: ${errs.join("; ")}`); }
    }
  }
  console.log(bad ? `${bad} invalid answer file(s)` : "all answer files valid");
}

if (bool(args, "commit")) {
  for (const symbol of symbols) {
    const started = Date.now();
    /** Replays saved answers in chain order. Fails loudly if one is missing or invalid. */
    const replay: LlmClient = {
      mode: "real",
      async complete(req: LlmRequest) {
        const agent = CHAIN.find((a) => a.toolName === req.toolName);
        if (!agent) throw new Error(`no agent for tool ${req.toolName}`);
        const ans = readAnswer(symbol, agent.name);
        if (ans === undefined) throw new Error(`missing answer file ${answerPath(symbol, agent.name)}`);
        const errs = validate(ans, req.schema);
        if (errs.length) throw new Error(`answer failed schema: ${errs.join("; ")}`);
        return {
          json: ans, raw: JSON.stringify(ans), model,
          inputTokens: Math.ceil((req.system.length + req.user.length) / 4),
          outputTokens: Math.ceil(JSON.stringify(ans).length / 4),
          latencyMs: Date.now() - started, attempts: 1,
        };
      },
    };
    const res = await runCommittee(conn, symbol, { llm: replay, operatorNotes: notesFor(symbol) });
    console.log(`${symbol}: run #${res.runId} ${res.status} ${res.action ?? ""} conf=${res.confidence ?? ""} size=${res.sizePct ?? ""}% claims=${res.claimIds.length}${res.error ? " ERROR " + res.error : ""}`);
  }
}
