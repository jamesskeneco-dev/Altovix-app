import { db, migrate, all } from "../core/db.ts";
import { config } from "../core/config.ts";
import { positions, cashBalance, trades } from "../core/portfolio/lots.ts";
import { harvestCandidates, realizedSummary } from "../core/portfolio/tax.ts";
import { performance, benchmarkComparison, tradeStats } from "../core/portfolio/metrics.ts";
import { latestDate } from "../core/market/index.ts";
import { listRuns, runTranscript, getRun } from "../core/committee/run.ts";
import { claimsForRun } from "../core/calibration/claims.ts";
import { scoreAll } from "../core/calibration/score.ts";
import { parseArgs, num, str, today, heading, money, pct, mag, c, die } from "./args.ts";

const args = parseArgs();
const conn = db();
migrate(conn);
const asOf = str(args, "as-of", latestDate(conn) ?? today()) as string;

const runId = num(args, "run");
if (runId !== undefined) {
  const run = getRun(conn, runId);
  if (!run) die(`no committee run #${runId}`);
  heading(`Committee run #${runId} - ${run.symbol} (${run.mandate}) as of ${run.as_of_date}`);
  console.log(`  status ${run.status}   mode ${run.llm_mode}   ${run.elapsed_ms}ms   ${run.input_tokens}/${run.output_tokens} tokens`);
  if (run.error) console.log(c.red(`  error: ${run.error}`));

  for (const step of runTranscript(conn, runId)) {
    heading(`${step.seq + 1}. ${step.agent}`);
    if (step.error) { console.log(c.red(`  failed: ${step.error}`)); continue; }
    console.log(JSON.stringify(JSON.parse(step.output_json ?? "null"), null, 2).split("\n").map((l) => `  ${l}`).join("\n"));
    if (args.flags["prompts"]) {
      heading(`   prompt sent to ${step.agent}`);
      console.log(c.dim(step.user_prompt.split("\n").map((l) => `    ${l}`).join("\n")));
    }
  }

  const claims = claimsForRun(conn, runId);
  heading(`Claims (${claims.length})`);
  for (const cl of claims) {
    const mark = cl.status === "RESOLVED" ? (cl.outcome === 1 ? c.green("HIT ") : c.red("MISS")) : c.dim("open");
    console.log(`  ${mark} ${cl.agent.padEnd(9)} conf ${cl.confidence.toFixed(2)}  ${cl.statement.slice(0, 100)}`);
    if (cl.resolution_note) console.log(c.dim(`         ${cl.resolution_note.slice(0, 160)}`));
  }
  process.exit(0);
}

heading(`Altovix Terminal - ${asOf}`);

const held = positions(conn, asOf);
const cash = cashBalance(conn, asOf);
const total = held.reduce((s, p) => s + (p.marketValue ?? 0), 0) + cash;
console.log(`  total value ${c.bold(money(total))}   cash ${money(cash)} (${((cash / (total || 1)) * 100).toFixed(1)}%)   positions ${held.length}`);

if (held.length) {
  heading("Positions");
  console.log(`  ${"sym".padEnd(7)}${"shares".padStart(10)}${"avg".padStart(12)}${"last".padStart(12)}${"value".padStart(14)}${"unreal".padStart(11)}${"wt".padStart(8)}`);
  for (const p of held) {
    console.log(
      `  ${p.symbol.padEnd(7)}${String(p.shares).padStart(10)}${money(p.avgCost).padStart(12)}` +
      `${money(p.lastPrice).padStart(12)}${money(p.marketValue).padStart(14)}` +
      `${mag(p.unrealizedPct).padStart(11)}${((p.weight ?? 0) * 100).toFixed(1).padStart(7)}%`,
    );
  }
}

const perf = performance(conn);
if (perf.totalReturn !== null) {
  heading("Performance (time-weighted, deposits neutralised)");
  console.log(`  window      ${perf.from} -> ${perf.to} (${perf.days} snapshots)`);
  console.log(`  total       ${pct(perf.totalReturn)}      annualised ${pct(perf.annualizedReturn)}`);
  console.log(`  volatility  ${mag(perf.volatility)}      sharpe ${perf.sharpe?.toFixed(2) ?? "n/a"}   sortino ${perf.sortino?.toFixed(2) ?? "n/a"}`);
  console.log(`  max DD      ${pct(perf.maxDrawdown)}      current DD ${pct(perf.currentDrawdown)}`);
  console.log(`  best day    ${pct(perf.bestDay)}      worst day ${pct(perf.worstDay)}`);

  heading(`Versus benchmarks`);
  for (const b of benchmarkComparison(conn)) {
    console.log(
      `  ${b.symbol.padEnd(5)} return ${pct(b.totalReturn).padEnd(20)} excess ${pct(b.excessReturn).padEnd(20)}` +
      ` beta ${b.beta?.toFixed(2) ?? "n/a"}  corr ${b.correlation?.toFixed(2) ?? "n/a"}  IR ${b.informationRatio?.toFixed(2) ?? "n/a"}`,
    );
  }
}

const ts = tradeStats(conn);
if (ts.closedTrades) {
  heading("Closed lots");
  console.log(`  ${ts.closedTrades} closed   win rate ${mag(ts.winRate, 0)}   avg win ${money(ts.avgWin)}   avg loss ${money(ts.avgLoss)}`);
  console.log(`  profit factor ${ts.profitFactor?.toFixed(2) ?? "n/a"}   expectancy ${money(ts.expectancy)}   realised ${money(ts.realizedPnl)}`);
}

const harvest = harvestCandidates(conn, asOf);
if (harvest.length) {
  heading("Tax-loss harvesting candidates");
  for (const h of harvest.slice(0, 8)) {
    const flag = h.washRisk ? c.yellow(" WASH RISK") : "";
    console.log(`  lot #${String(h.lotId).padEnd(4)} ${h.symbol.padEnd(6)} ${h.shares} sh  ${pct(h.unrealizedPct)}  loss ${money(h.unrealizedPnl)}  ${h.term}  benefit ~${money(h.estTaxBenefit)}${flag}`);
    if (h.washReason) console.log(c.dim(`        ${h.washReason}`));
    if (h.daysToLongTerm !== null && h.daysToLongTerm < 60) console.log(c.dim(`        ${h.daysToLongTerm} days to long-term treatment`));
  }
  const rs = realizedSummary(conn, Number(asOf.slice(0, 4)));
  console.log(`\n  ${asOf.slice(0, 4)} realised: short ${money(rs.shortTermGain)}  long ${money(rs.longTermGain)}  disallowed ${money(rs.disallowed)}  est. tax ${money(rs.estTaxOwed)}`);
}

const runs = listRuns(conn, 8);
if (runs.length) {
  heading("Recent committee runs");
  for (const r of runs) {
    const tag = r.llm_mode === "mock" ? c.dim(" [mock]") : "";
    console.log(`  #${String(r.id).padEnd(4)} ${r.as_of_date} ${r.symbol.padEnd(6)} ${(r.final_action ?? r.status).padEnd(6)} conf ${r.final_confidence?.toFixed(2) ?? "-"}  size ${r.final_size_pct ?? "-"}%${tag}`);
  }
}

const scores = scoreAll(conn);
if (scores.length) {
  heading("Calibration");
  for (const s of scores) {
    console.log(`  ${s.agent.padEnd(10)} n=${String(s.nClaims).padStart(3)}  hit ${(s.hitRate * 100).toFixed(0)}%  stated ${(s.avgConfidence * 100).toFixed(0)}%  brier ${s.brier.toFixed(3)}  skill ${s.brierSkill.toFixed(2)}`);
  }
}

const recent = trades(conn, { limit: 6 });
if (recent.length) {
  heading("Recent trades");
  for (const t of recent) {
    console.log(`  ${t.date} ${t.side.padEnd(4)} ${String(t.shares).padStart(8)} ${t.symbol.padEnd(6)} @ ${money(t.price)}${t.committee_run_id ? c.dim(`  (run #${t.committee_run_id})`) : ""}`);
  }
}
console.log(`\n${c.dim(`benchmarks: ${config.benchmarks.join(", ")}   db: ${config.dbPath}`)}`);
