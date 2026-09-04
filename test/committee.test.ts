import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { memoryDb, all, one } from "../src/core/db.ts";
import { config } from "../src/core/config.ts";
import { mockClient } from "../src/core/llm/mock.ts";
import { validate } from "../src/core/llm/schema.ts";
import type { LlmClient, LlmRequest } from "../src/core/llm/types.ts";
import { CHAIN, BY_NAME } from "../src/core/agents/registry.ts";
import { runCommittee, runTranscript } from "../src/core/committee/run.ts";
import { buildContext } from "../src/core/committee/context.ts";
import { deposit, recordTrade } from "../src/core/portfolio/lots.ts";
import { resolveDue } from "../src/core/calibration/resolve.ts";
import { scoreAll } from "../src/core/calibration/score.ts";
import type { AgentName } from "../src/core/types.ts";

function seed(db: DatabaseSync, symbol: string, n = 300, base = 100, drift = 0.001) {
  const d = new Date("2025-06-02T00:00:00Z");
  let i = 0;
  while (i < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const wiggle = 1 + 0.01 * Math.sin(i / 7);
      db.prepare(`INSERT OR REPLACE INTO prices (symbol,date,close,volume,source) VALUES (?,?,?,?,'test')`)
        .run(symbol, d.toISOString().slice(0, 10), base * (1 + drift * i) * wiggle, 1_000_000 + i * 1000);
      i++;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

function seedUniverse(db: DatabaseSync) {
  for (const s of [...config.benchmarks, ...config.sectorEtfs, ...config.macroTickers]) seed(db, s);
  seed(db, "NVDA", 300, 90, 0.002);
}

/** The mock model, but presenting as a real one so claim persistence is exercised. */
function realLikeClient(): LlmClient {
  const inner = mockClient();
  return { mode: "real", complete: (r) => inner.complete(r) };
}

function recordingClient(sink: LlmRequest[]): LlmClient {
  const inner = mockClient();
  return { mode: "real", complete: (r) => { sink.push(r); return inner.complete(r); } };
}

test("the full chain runs, in order, and writes every call to the audit trail", async () => {
  const db = memoryDb();
  seedUniverse(db);
  deposit(db, "2025-06-02", 25_000);

  const res = await runCommittee(db, "NVDA", { llm: realLikeClient() });
  assert.equal(res.status, "COMPLETE");
  assert.equal(res.error, null);

  const transcript = runTranscript(db, res.runId);
  assert.equal(transcript.length, CHAIN.length);
  assert.deepEqual(transcript.map((t) => t.agent), CHAIN.map((a) => a.name));
  assert.ok(transcript.every((t) => t.system_prompt.length > 200 && t.user_prompt.length > 100));
  assert.ok(transcript.every((t) => t.error === null && t.output_json !== null));

  const run = one<{ status: string; final_action: string; context_hash: string }>(
    db, `SELECT status, final_action, context_hash FROM committee_runs WHERE id = ?`, res.runId);
  assert.equal(run!.status, "COMPLETE");
  assert.ok(["BUY", "HOLD", "AVOID", "TRIM", "SELL"].includes(run!.final_action));
  assert.equal(run!.context_hash.length, 16);
});

test("every stored agent output validates against that agent's own schema", async () => {
  const db = memoryDb();
  seedUniverse(db);
  const res = await runCommittee(db, "NVDA", { llm: realLikeClient() });
  for (const step of runTranscript(db, res.runId)) {
    const spec = BY_NAME[step.agent as AgentName];
    assert.ok(spec, `no spec for ${step.agent}`);
    const errors = validate(JSON.parse(step.output_json as string), spec!.schema);
    assert.deepEqual(errors, [], `${step.agent}: ${errors.join("; ")}`);
  }
});

test("each agent is shown the outputs of the agents before it", async () => {
  const db = memoryDb();
  seedUniverse(db);
  const seen: LlmRequest[] = [];
  await runCommittee(db, "NVDA", { llm: recordingClient(seen) });

  const promptFor = (name: string) => seen[CHAIN.findIndex((a) => a.name === name)]?.user ?? "";
  assert.ok(promptFor("regime").includes("MACRO / BREADTH TABLE"));
  assert.ok(!promptFor("regime").includes("REGIME AGENT OUTPUT"));
  assert.ok(promptFor("sector").includes("REGIME AGENT OUTPUT"));
  assert.ok(promptFor("quant").includes("SECTOR AGENT OUTPUT"));
  assert.ok(promptFor("research").includes("QUANT AGENT OUTPUT"));
  assert.ok(promptFor("bear").includes("this is the thesis to attack"));
  const decisionPrompt = promptFor("decision");
  for (const label of ["REGIME", "SECTOR", "QUANT", "RESEARCH", "RISK MANAGER", "BEAR CASE"]) {
    assert.ok(decisionPrompt.includes(label), `decision prompt missing ${label}`);
  }
  assert.ok(seen.every((r) => r.user.includes("NVDA")));
});

test("claims are persisted for every run, but mock runs never enter a scorecard", async () => {
  const db = memoryDb();
  seedUniverse(db);

  // Date the runs back so their horizons actually close inside the seeded price history.
  const asOf = all<{ date: string }>(
    db, `SELECT date FROM prices WHERE symbol='NVDA' ORDER BY date LIMIT 1 OFFSET 120`)[0]!.date;

  const real = await runCommittee(db, "NVDA", { llm: realLikeClient(), asOf });
  assert.ok(real.claimIds.length >= 6, `expected several claims, got ${real.claimIds.length}`);
  const claims = all<{ agent: string; resolver: string; confidence: number; resolve_after: string }>(
    db, `SELECT agent, resolver, confidence, resolve_after FROM agent_claims WHERE run_id = ?`, real.runId);
  assert.ok(claims.some((c) => c.agent === "decision"));
  assert.ok(claims.some((c) => c.resolver === "MECHANICAL"));
  assert.ok(claims.some((c) => c.resolver === "JUDGMENT"));
  assert.ok(claims.every((c) => c.confidence >= 0 && c.confidence <= 1));
  assert.ok(claims.every((c) => c.resolve_after > "2025-06-02"));

  // A mock run still records everything - evidence is never deleted - but it is not evidence
  // about the world, so it must be invisible to scoring unless explicitly requested.
  // One bar later, so its forecasts are distinct from the real run's rather than deduplicated.
  const asOfNext = all<{ date: string }>(
    db, `SELECT date FROM prices WHERE symbol='NVDA' AND date > ? ORDER BY date LIMIT 1`, asOf)[0]!.date;
  const mock = await runCommittee(db, "NVDA", { llm: mockClient(), asOf: asOfNext });
  assert.ok(mock.claimIds.length > 0, "mock claims are still written to the audit trail");

  resolveDue(db, "2030-01-01");
  const realOnly = scoreAll(db).reduce((n, s) => n + s.nClaims, 0);
  const withMock = scoreAll(db, { includeMock: true }).reduce((n, s) => n + s.nClaims, 0);
  assert.ok(realOnly > 0, "the real run must be scored");
  assert.ok(withMock > realOnly, "mock claims are excluded from the default scorecard");
});

test("a database containing only mock runs produces an empty scorecard", async () => {
  const db = memoryDb();
  seedUniverse(db);
  const asOf = all<{ date: string }>(
    db, `SELECT date FROM prices WHERE symbol='NVDA' ORDER BY date LIMIT 1 OFFSET 120`)[0]!.date;

  const res = await runCommittee(db, "NVDA", { llm: mockClient(), asOf });
  assert.ok(res.claimIds.length > 0);
  resolveDue(db, "2030-01-01");

  assert.equal(scoreAll(db).length, 0, "an offline dry run must never look like a track record");
  assert.ok(scoreAll(db, { includeMock: true }).length > 0, "but the evidence is still there when asked for");
});

test("a mid-chain failure marks the run FAILED but keeps the partial transcript", async () => {
  const db = memoryDb();
  seedUniverse(db);
  const inner = mockClient();
  let calls = 0;
  const flaky: LlmClient = {
    mode: "real",
    complete: async (r) => {
      calls++;
      if (calls === 3) throw new Error("simulated upstream 529");
      return inner.complete(r);
    },
  };

  const res = await runCommittee(db, "NVDA", { llm: flaky });
  assert.equal(res.status, "FAILED");
  assert.match(res.error as string, /quant: simulated upstream 529/);

  const transcript = runTranscript(db, res.runId);
  assert.equal(transcript.length, 3);
  assert.equal(transcript[2]!.error, "simulated upstream 529");
  assert.ok(transcript[2]!.user_prompt.length > 100, "the failing prompt is still recorded");
  assert.equal(res.claimIds.length, 0);
});

test("the journal entry is written into research notes", async () => {
  const db = memoryDb();
  seedUniverse(db);
  const res = await runCommittee(db, "NVDA", { llm: realLikeClient() });
  const note = one<{ symbol: string; body: string; committee_run_id: number }>(
    db, `SELECT * FROM research_notes WHERE committee_run_id = ?`, res.runId);
  assert.ok(note);
  assert.equal(note!.symbol, "NVDA");
  assert.match(note!.body, /What would make this wrong/);
});

test("context reflects the live book and flags missing data instead of inventing it", async () => {
  const db = memoryDb();
  seedUniverse(db);
  deposit(db, "2025-06-02", 50_000);
  recordTrade(db, { date: "2025-06-03", symbol: "NVDA", side: "BUY", shares: 100, price: 90 });

  const ctx = buildContext(db, "NVDA");
  assert.equal(ctx.mandate, "REVIEW", "an existing holding should default to REVIEW");
  assert.ok(ctx.portfolio.existing);
  assert.equal(ctx.portfolio.existing!.shares, 100);
  assert.ok(ctx.portfolio.totalValue > 50_000);
  assert.equal(ctx.dataGaps.length, 0);

  const missing = buildContext(db, "ZZZZ");
  assert.equal(missing.mandate, "NEW_POSITION");
  assert.ok(missing.dataGaps.some((g) => g.includes("no price history for ZZZZ")));
  assert.equal(missing.candidate.price, null);
});
