import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { memoryDb, run, all } from "../src/core/db.ts";
import { saveClaims, openClaimsDue, type ClaimRow } from "../src/core/calibration/claims.ts";
import { forwardWindow, resolveMechanical, resolveDue, NOT_READY, evidenceFor } from "../src/core/calibration/resolve.ts";
import { brierScore, buildBuckets, scoreClaims, scoreAll } from "../src/core/calibration/score.ts";

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b}`);

/** Weekday-only series starting at `start`, price[i] produced by fn(i). */
function seed(db: DatabaseSync, symbol: string, start: string, n: number, fn: (i: number) => number) {
  const d = new Date(`${start}T00:00:00Z`);
  let written = 0;
  while (written < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      db.prepare(`INSERT OR REPLACE INTO prices (symbol,date,close,source) VALUES (?,?,?,'test')`)
        .run(symbol, d.toISOString().slice(0, 10), fn(written));
      written++;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

function newRun(db: DatabaseSync, symbol: string, asOf: string): number {
  const r = run(db,
    `INSERT INTO committee_runs (started_at, as_of_date, symbol, mandate, status, llm_mode, context_json, context_hash)
     VALUES (datetime('now'), ?, ?, 'NEW_POSITION', 'COMPLETE', 'real', '{}', 'x')`,
    asOf, symbol);
  return r.lastInsertRowid;
}

function claimOf(db: DatabaseSync, id: number): ClaimRow {
  return all<ClaimRow>(db, `SELECT * FROM agent_claims WHERE id = ?`, id)[0] as ClaimRow;
}

test("forward window waits for enough bars instead of resolving early", () => {
  const db = memoryDb();
  seed(db, "SPY", "2026-01-05", 10, (i) => 100 + i);
  assert.equal(forwardWindow(db, "SPY", "2026-01-05", 5)?.bars, 5);
  assert.equal(forwardWindow(db, "SPY", "2026-01-05", 30), null);
  assert.equal(forwardWindow(db, "NOPE", "2026-01-05", 5), null);
});

test("forward window measures return, drawdown and the exact date range", () => {
  const db = memoryDb();
  // 100, 110, 120, 90, 130 ... then flat
  const path = [100, 110, 120, 90, 130, 130];
  seed(db, "ACME", "2026-01-05", 6, (i) => path[i] as number);
  const w = forwardWindow(db, "ACME", "2026-01-05", 4);
  assert.ok(w);
  near(w!.ret, 0.3);
  near(w!.maxDrawdown, -0.25);
  assert.equal(w!.startDate, "2026-01-05");
  assert.equal(w!.bars, 4);
});

test("regime direction resolves against SPY's realised move", () => {
  const db = memoryDb();
  seed(db, "SPY", "2026-01-05", 30, (i) => 100 * (1 + 0.004 * i));  // steadily up
  const runId = newRun(db, "SPY", "2026-01-05");
  const [upId, downId, flatId] = saveClaims(db, runId, "2026-01-05", [
    { agent: "regime", claimKind: "REGIME_DIRECTION", subject: "SPY", statement: "up", direction: "UP", confidence: 0.7, horizonDays: 21, resolver: "MECHANICAL" },
    { agent: "regime", claimKind: "REGIME_DIRECTION", subject: "SPY", statement: "down", direction: "DOWN", confidence: 0.7, horizonDays: 21, resolver: "MECHANICAL" },
    { agent: "regime", claimKind: "REGIME_DIRECTION", subject: "SPY", statement: "flat", direction: "FLAT", threshold: 0.03, confidence: 0.5, horizonDays: 21, resolver: "MECHANICAL" },
  ]);
  assert.equal((resolveMechanical(db, claimOf(db, upId as number)) as { outcome: number }).outcome, 1);
  assert.equal((resolveMechanical(db, claimOf(db, downId as number)) as { outcome: number }).outcome, 0);
  // +8.4% over 21 bars is well outside a 3% band
  assert.equal((resolveMechanical(db, claimOf(db, flatId as number)) as { outcome: number }).outcome, 0);
});

test("relative claims are scored as excess return over SPY, not raw direction", () => {
  const db = memoryDb();
  seed(db, "SPY", "2026-01-05", 30, (i) => 100 * (1 + 0.005 * i));   // +10% over 20 bars
  seed(db, "LAGGARD", "2026-01-05", 30, (i) => 50 * (1 + 0.002 * i)); // +4%: up, but behind
  const runId = newRun(db, "LAGGARD", "2026-01-05");
  const [outId, underId] = saveClaims(db, runId, "2026-01-05", [
    { agent: "quant", claimKind: "RELATIVE_TO_BENCH", subject: "LAGGARD", statement: "beats", direction: "OUTPERFORM", confidence: 0.6, horizonDays: 20, resolver: "MECHANICAL" },
    { agent: "research", claimKind: "RELATIVE_TO_BENCH", subject: "LAGGARD", statement: "lags", direction: "UNDERPERFORM", confidence: 0.6, horizonDays: 20, resolver: "MECHANICAL" },
  ]);
  // rose in absolute terms, so a naive direction check would pass it - it must fail
  assert.equal((resolveMechanical(db, claimOf(db, outId as number)) as { outcome: number }).outcome, 0);
  assert.equal((resolveMechanical(db, claimOf(db, underId as number)) as { outcome: number }).outcome, 1);
});

test("drawdown limit holds when the realised drawdown is shallower", () => {
  const db = memoryDb();
  const path = [100, 95, 92, 97, 101, 99, 100, 103];
  seed(db, "SPY", "2026-01-05", 8, () => 100);
  seed(db, "RISKY", "2026-01-05", 8, (i) => path[i] as number);
  const runId = newRun(db, "RISKY", "2026-01-05");
  const [ok, breached] = saveClaims(db, runId, "2026-01-05", [
    { agent: "risk", claimKind: "DRAWDOWN_LIMIT", subject: "RISKY", statement: "shallower than -15%", direction: "TRUE", threshold: -0.15, confidence: 0.8, horizonDays: 7, resolver: "MECHANICAL" },
    { agent: "risk", claimKind: "DRAWDOWN_LIMIT", subject: "RISKY", statement: "shallower than -3%", direction: "TRUE", threshold: -0.03, confidence: 0.8, horizonDays: 7, resolver: "MECHANICAL" },
  ]);
  assert.equal((resolveMechanical(db, claimOf(db, ok as number)) as { outcome: number }).outcome, 1);   // -8% > -15%
  assert.equal((resolveMechanical(db, claimOf(db, breached as number)) as { outcome: number }).outcome, 0); // -8% < -3%
});

test("a HOLD decision is graded inside its tolerance band", () => {
  const db = memoryDb();
  seed(db, "SPY", "2026-01-05", 30, (i) => 100 * (1 + 0.005 * i));
  seed(db, "STEADY", "2026-01-05", 30, (i) => 100 * (1 + 0.0045 * i)); // lags by ~1% over 20 bars
  const runId = newRun(db, "STEADY", "2026-01-05");
  const [hold, buy] = saveClaims(db, runId, "2026-01-05", [
    { agent: "decision", claimKind: "DECISION_VALUE", subject: "STEADY", statement: "hold", direction: "OUTPERFORM", threshold: 0.02, confidence: 0.6, horizonDays: 20, resolver: "MECHANICAL" },
    { agent: "decision", claimKind: "DECISION_VALUE", subject: "STEADY", statement: "buy", direction: "OUTPERFORM", threshold: 0, confidence: 0.6, horizonDays: 20, resolver: "MECHANICAL" },
  ]);
  assert.equal((resolveMechanical(db, claimOf(db, hold as number)) as { outcome: number }).outcome, 1); // inside the band
  assert.equal((resolveMechanical(db, claimOf(db, buy as number)) as { outcome: number }).outcome, 0);  // strict outperformance failed
});

test("resolveDue only touches claims whose horizon has actually closed", () => {
  const db = memoryDb();
  seed(db, "SPY", "2026-01-05", 12, (i) => 100 + i);
  const runId = newRun(db, "SPY", "2026-01-05");
  saveClaims(db, runId, "2026-01-05", [
    { agent: "regime", claimKind: "REGIME_DIRECTION", subject: "SPY", statement: "short", direction: "UP", confidence: 0.7, horizonDays: 5, resolver: "MECHANICAL" },
    { agent: "regime", claimKind: "REGIME_DIRECTION", subject: "SPY", statement: "long", direction: "UP", confidence: 0.7, horizonDays: 60, resolver: "MECHANICAL" },
  ]);
  const s = resolveDue(db, "2026-02-01");
  assert.equal(s.resolved, 1);
  assert.equal(s.correct, 1);
  assert.equal(openClaimsDue(db, "2026-06-01", "MECHANICAL").length, 1); // the 60-day one is still open
});

test("judgment claims are left for the calibration agent, with an evidence packet", () => {
  const db = memoryDb();
  seed(db, "SPY", "2026-01-05", 30, () => 100);
  seed(db, "THESIS", "2026-01-05", 30, (i) => 100 + i);
  const runId = newRun(db, "THESIS", "2026-01-05");
  const [id] = saveClaims(db, runId, "2026-01-05", [
    { agent: "research", claimKind: "THESIS_PLAYS_OUT", subject: "THESIS", statement: "it works", direction: "TRUE", confidence: 0.65, horizonDays: 20, resolver: "JUDGMENT" },
  ]);
  const s = resolveDue(db, "2026-03-01");
  assert.equal(s.resolved, 0);
  assert.equal(s.pendingJudgment, 1);
  const ev = evidenceFor(db, claimOf(db, id as number));
  assert.ok(ev);
  assert.equal(ev!["bars"], 20);
  near(ev!["excessVsBenchmark"] as number, 0.2, 1e-3);
  assert.ok(Array.isArray(ev!["pathSample"]));
});

test("brier score is the mean squared error of the probability", () => {
  near(brierScore([{ confidence: 0.8, outcome: 1 }, { confidence: 0.6, outcome: 0 }]), 0.2);
  near(brierScore([{ confidence: 1, outcome: 1 }]), 0);
  near(brierScore([{ confidence: 0, outcome: 1 }]), 1);
  near(brierScore([]), 0);
});

test("buckets group by stated confidence and expose the calibration gap", () => {
  const b = buildBuckets([
    { confidence: 0.92, outcome: 1 }, { confidence: 0.95, outcome: 0 },
    { confidence: 0.55, outcome: 1 },
  ]);
  assert.equal(b.length, 2);
  const high = b.find((x) => x.lo > 0.85)!;
  assert.equal(high.n, 2);
  near(high.observedRate, 0.5);
  assert.ok(high.gap > 0.4); // claimed ~93%, delivered 50%
});

test("an informative forecaster scores positive Brier skill, an anti-informative one negative", () => {
  const mk = (pairs: Array<[number, number]>): ClaimRow[] =>
    pairs.map(([c, o], i) => ({
      id: i, run_id: 1, agent: "quant", claim_kind: "PRICE_DIRECTION", subject: "X",
      statement: "s", direction: "UP", threshold: null, confidence: c, made_on: "2026-01-01",
      horizon_days: 21, resolve_after: "2026-02-01", resolver: "MECHANICAL",
      status: "RESOLVED", outcome: o, resolved_at: "2026-02-01", resolution_note: null, resolution_data: null,
    })) as ClaimRow[];

  const good = scoreClaims("quant", mk([[0.9, 1], [0.9, 1], [0.1, 0], [0.1, 0]]));
  near(good.brier, 0.01);
  near(good.brierSkill, 0.96, 1e-3);
  assert.ok(good.brierSkillVsCoin > 0.9);
  assert.equal(good.hitRate, 0.5);

  const bad = scoreClaims("quant", mk([[0.9, 0], [0.9, 0], [0.1, 1], [0.1, 1]]));
  near(bad.brier, 0.81);
  assert.ok(bad.brierSkill < -2);
  assert.ok(bad.verdict.includes("anti-informative"));
});

test("overconfidence is measured as stated confidence minus realised hit rate", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    id: i, run_id: 1, agent: "bear", claim_kind: "PRICE_DIRECTION", subject: "X",
    statement: "s", direction: "DOWN", threshold: null, confidence: 0.9, made_on: "2026-01-01",
    horizon_days: 21, resolve_after: "2026-02-01", resolver: "MECHANICAL",
    status: "RESOLVED", outcome: i < 4 ? 1 : 0, resolved_at: "2026-02-01",
    resolution_note: null, resolution_data: null,
  })) as ClaimRow[];
  const s = scoreClaims("bear", rows);
  near(s.hitRate, 0.4);
  near(s.avgConfidence, 0.9);
  near(s.overconfidence, 0.5);
  assert.ok(s.verdict.includes("Overconfident by 50 points"));
  assert.ok(s.verdict.includes("provisional"));
});

test("scoreAll groups by agent and ignores unresolved claims", () => {
  const db = memoryDb();
  seed(db, "SPY", "2026-01-05", 40, (i) => 100 + i);
  seed(db, "ABC", "2026-01-05", 40, (i) => 100 + 2 * i);
  const runId = newRun(db, "ABC", "2026-01-05");
  saveClaims(db, runId, "2026-01-05", [
    { agent: "quant", claimKind: "RELATIVE_TO_BENCH", subject: "ABC", statement: "beats", direction: "OUTPERFORM", confidence: 0.8, horizonDays: 10, resolver: "MECHANICAL" },
    { agent: "regime", claimKind: "REGIME_DIRECTION", subject: "SPY", statement: "up", direction: "UP", confidence: 0.7, horizonDays: 10, resolver: "MECHANICAL" },
    { agent: "research", claimKind: "THESIS_PLAYS_OUT", subject: "ABC", statement: "works", direction: "TRUE", confidence: 0.6, horizonDays: 10, resolver: "JUDGMENT" },
  ]);
  resolveDue(db, "2026-03-01");
  const scores = scoreAll(db);
  assert.equal(scores.length, 2); // the judgment claim stays unresolved
  assert.ok(scores.every((s) => s.nClaims === 1 && s.hitRate === 1));
});

test("identical market-wide claims from same-day runs are recorded once", () => {
  const db = memoryDb();
  seed(db, "SPY", "2026-01-05", 5, () => 100);
  const a = newRun(db, "NVDA", "2026-01-05");
  const b = newRun(db, "MSFT", "2026-01-05");
  const draft = { agent: "regime" as const, claimKind: "REGIME_DIRECTION" as const, subject: "SPY", statement: "up",
    direction: "UP" as const, threshold: 0.03, confidence: 0.6, horizonDays: 21, resolver: "MECHANICAL" as const };
  assert.equal(saveClaims(db, a, "2026-01-05", [draft]).length, 1);
  assert.equal(saveClaims(db, b, "2026-01-05", [draft]).length, 0, "the second run's copy is a duplicate");
  // A different horizon, direction, or day is a different forecast.
  assert.equal(saveClaims(db, b, "2026-01-05", [{ ...draft, horizonDays: 42 }]).length, 1);
  assert.equal(saveClaims(db, b, "2026-01-05", [{ ...draft, direction: "DOWN" }]).length, 1);
  assert.equal(saveClaims(db, b, "2026-01-06", [draft]).length, 1);
  assert.equal(all<{ n: number }>(db, `SELECT COUNT(*) AS n FROM agent_claims`)[0]!.n, 4);
});
