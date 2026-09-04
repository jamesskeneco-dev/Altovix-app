import { db, migrate } from "../core/db.ts";
import { config } from "../core/config.ts";
import { makeClient } from "../core/llm/index.ts";
import { runCommittee } from "../core/committee/run.ts";
import { claimsForRun } from "../core/calibration/claims.ts";
import type { Mandate } from "../core/types.ts";
import { parseArgs, str, bool, heading, pct, die, c } from "./args.ts";

const args = parseArgs();
const symbol = args.positional[0];
if (!symbol) {
  die(`usage: npm run committee -- NVDA [--as-of 2026-09-02] [--mandate REVIEW] [--mock]`);
}

const conn = db();
migrate(conn);

const llm = makeClient(bool(args, "mock") ? "mock" : config.llmMode);
heading(`Altovix committee - ${symbol.toUpperCase()}`);
console.log(c.dim(`model: ${llm.mode === "mock" ? "MOCK (offline dry run, not a real assessment)" : config.model}`));

const result = await runCommittee(conn, symbol, {
  asOf: str(args, "as-of"),
  mandate: str(args, "mandate") as Mandate | undefined,
  llm,
  onProgress: (p) => {
    if (p.phase === "start") process.stdout.write(`  ${String(p.index + 1).padStart(2)}/${p.total} ${p.title.padEnd(16)} `);
    if (p.phase === "done") console.log(c.green(`ok`) + c.dim(` ${p.latencyMs}ms`));
    if (p.phase === "error") console.log(c.red(`failed: ${p.error}`));
  },
});

if (result.status === "FAILED") {
  console.log(c.red(`\nrun #${result.runId} failed: ${result.error}`));
  console.log(c.dim(`the partial transcript is still saved - inspect it with: npm run report -- --run ${result.runId}`));
  process.exit(1);
}

const decision = result.outputs.decision as Record<string, unknown> | undefined;
const bear = result.outputs.bear as Record<string, unknown> | undefined;
const risk = result.outputs.risk as Record<string, unknown> | undefined;

heading(`Decision`);
console.log(`  action        ${c.bold(String(decision?.["action"]))}`);
console.log(`  size          ${decision?.["sizePct"]}% of portfolio`);
console.log(`  confidence    ${pct(Number(decision?.["confidence"]), 0)}`);
console.log(`  horizon       ${decision?.["horizonDays"]} trading days`);
console.log(`  exit rule     ${decision?.["exitRule"]}`);
console.log(`  decisive      ${decision?.["decisiveFactor"]}`);
console.log(`  disagreement  ${decision?.["disagreementResolved"]}`);
console.log(`  overruled     ${decision?.["overruled"]}`);
console.log(`  SPY better?   ${decision?.["wouldSpyBeBetter"] ? c.yellow("yes - by its own admission") : "no"}`);

if (risk) console.log(`\n  risk verdict  ${risk["verdict"]} (max ${risk["maxSizePct"]}%)`);
if (bear) console.log(`  bear case     ${String(bear["strongestBearCase"]).slice(0, 160)}`);

const claims = claimsForRun(conn, result.runId);
heading(`Claims recorded for scoring (${claims.length})`);
for (const cl of claims) {
  console.log(`  ${c.dim(`#${cl.id}`)} ${cl.agent.padEnd(9)} ${String(cl.confidence).padEnd(5)} ${String(cl.horizon_days).padStart(3)}d  due ${cl.resolve_after}  ${cl.statement.slice(0, 90)}`);
}
if (!claims.length && llm.mode === "mock") {
  console.log(c.dim("  (none - mock runs are excluded from calibration by design)"));
}

console.log(`\nrun #${result.runId}  ${result.elapsedMs}ms  ${result.inputTokens} in / ${result.outputTokens} out tokens`);
console.log(c.dim(`full transcript: npm run report -- --run ${result.runId}`));
