import { db, migrate } from "../core/db.ts";
import { config } from "../core/config.ts";
import { makeClient } from "../core/llm/index.ts";
import { runCalibration } from "../core/calibration/index.ts";
import { parseArgs, str, bool, today, heading, pct, c } from "./args.ts";

const args = parseArgs();
const conn = db();
migrate(conn);

const mechanicalOnly = bool(args, "mechanical-only");
heading(`Altovix calibration - as of ${str(args, "as-of", today())}`);

const report = await runCalibration(conn, {
  asOf: str(args, "as-of", today()),
  from: str(args, "from"),
  mechanicalOnly,
  includeMock: bool(args, "include-mock"),
  llm: mechanicalOnly ? undefined : makeClient(bool(args, "mock") ? "mock" : config.llmMode),
  onProgress: (m) => console.log(c.dim(`  ${m}`)),
});

heading("Resolution");
console.log(`  mechanical: ${report.mechanical.resolved} resolved (${report.mechanical.correct} correct), ${report.mechanical.notReady} not yet due, ${report.mechanical.voided} void`);
console.log(`  judgment:   ${report.judgment.resolved} resolved, ${report.judgment.undetermined} undetermined, ${report.judgment.notReady} not yet due, ${report.judgment.failed} failed`);

heading("Agent scorecard");
if (!report.scores.length) {
  console.log(c.dim("  no resolved claims yet"));
} else {
  console.log(`  ${"agent".padEnd(10)} ${"n".padStart(4)} ${"hit".padStart(7)} ${"conf".padStart(7)} ${"over".padStart(7)} ${"brier".padStart(7)} ${"skill".padStart(7)}`);
  for (const s of report.scores) {
    console.log(
      `  ${s.agent.padEnd(10)} ${String(s.nClaims).padStart(4)} ` +
      `${(s.hitRate * 100).toFixed(0).padStart(6)}% ${(s.avgConfidence * 100).toFixed(0).padStart(6)}% ` +
      `${(s.overconfidence >= 0 ? "+" : "") + (s.overconfidence * 100).toFixed(0) + "%"}`.padStart(8) +
      ` ${s.brier.toFixed(3).padStart(7)} ${s.brierSkill.toFixed(2).padStart(7)}`,
    );
  }
  for (const s of report.scores) {
    console.log(`\n  ${c.bold(s.agent)}: ${s.verdict}`);
    if (s.buckets.length > 1) {
      console.log(c.dim(`    reliability: ${s.buckets.map((b) => `${(b.avgConfidence * 100).toFixed(0)}%->${(b.observedRate * 100).toFixed(0)}% (n=${b.n})`).join("  ")}`));
    }
  }
}

heading("Headline");
console.log(`  ${report.headline}`);
