// Loads .env into process.env as a side effect - must come before schwabConfig() reads it.
import "../core/config.ts";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import type { Bar } from "../core/types.ts";
import {
  schwabConfig, isConfigured, readTokens, refreshExpiresAt, quotes, priceHistory, tradingDate, type SchwabQuote,
} from "../core/market/schwab.ts";
import { parseAgentScores, parseRuleBook, runCheck, tickersFor, type AgentScores, type CheckResult, type RuleBook } from "../core/check/engine.ts";
import { ensureTopic, ntfyConfig, planAlerts, readState, sendAlert, summaryLine, writeState, type Alert } from "../core/check/notify.ts";
import { parseArgs, bool, str, heading, c, die } from "./args.ts";

/**
 * npm run check                      check every stop / buy trigger / watch rule now, alert the phone
 * npm run check -- --no-notify       look only, send nothing
 * npm run check -- --setup           one-time: phone alerts + the three daily scheduled runs
 * npm run check -- --test-alert      send a test notification
 * npm run check -- --remove-schedule stop the automatic runs
 * (or double-click altovix-check.cmd / altovix-setup.cmd)
 *
 * Rules live in rules/book.json. Every rule fires on a completed daily close; between runs nothing
 * is lost - each run re-reads the whole history, so a missed day is reported by the next run.
 */

const args = parseArgs();
const cfg = schwabConfig();
const RULES = process.env["ALTOVIX_RULES"] ?? "./rules/book.json";
const STATUS = process.env["ALTOVIX_STATUS_FILE"] ?? "./data/status.json";
const SCORES = process.env["ALTOVIX_SCORES"] ?? "./rules/scores.json";

/** The agents' scores are optional: no file (or a broken one) just means no score is shown. */
function loadAgents(): AgentScores | undefined {
  const path = resolve(process.cwd(), SCORES);
  if (!existsSync(path)) return undefined;
  try { return parseAgentScores(readFileSync(path, "utf8")); } catch (err) { if (!quiet) console.log(c.yellow(`! ${SCORES}: ${(err as Error).message}`)); return undefined; }
}
const quiet = bool(args, "quiet");

function nyClock(now = new Date()): { date: string; minutes: number; weekday: boolean } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23", weekday: "short", hour: "2-digit", minute: "2-digit",
  }).formatToParts(now);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: tradingDate(now.getTime()),
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
    weekday: !["Sat", "Sun"].includes(get("weekday")),
  };
}

function loadBook(): RuleBook {
  const path = resolve(process.cwd(), RULES);
  if (!existsSync(path)) die(`rules file not found: ${RULES}`);
  return parseRuleBook(readFileSync(path, "utf8"));
}

async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  }));
  return out;
}

async function notify(alerts: Alert[], send: boolean): Promise<string[]> {
  const problems: string[] = [];
  if (!send || !alerts.length) return problems;
  const n = ntfyConfig();
  if (!n.topic) return ["phone alerts are not set up yet - double-click altovix-setup.cmd"];
  for (const a of alerts) {
    try { await sendAlert(n, a); } catch (err) { problems.push((err as Error).message); }
  }
  return problems;
}

// ---------------------------------------------------------------------------

async function check(): Promise<void> {
  const send = !bool(args, "no-notify") && !bool(args, "dry-run");
  const persist = !bool(args, "dry-run");
  const book = loadBook();
  const state = readState();
  const clock = nyClock(process.env["ALTOVIX_NOW"] ? new Date(process.env["ALTOVIX_NOW"]) : new Date());
  const sessionComplete = clock.weekday && clock.minutes >= 16 * 60 + 5;

  // The login is the one thing that needs a person every week - say so on the phone, early.
  const tokens = isConfigured(cfg) ? readTokens(cfg) : null;
  const expires = tokens ? refreshExpiresAt(tokens) : 0;
  if (!tokens || Date.now() > expires) {
    const key = `LOGIN_EXPIRED:${clock.date}`;
    if (!(key in state.sent)) {
      const probs = await notify([{ title: "Altovix: Schwab login needed", message: "The market checks are BLIND until you sign in again: on the PC, Windows key + R, run schwab-login.cmd.", priority: 4, tags: ["key"] }], send);
      if (persist && !probs.length) { state.sent[key] = new Date().toISOString(); writeState(state); }
    }
    die("not logged in to Schwab (or the 7-day login expired) - run schwab-login.cmd, then check again.");
  }
  if (expires - Date.now() < 36 * 3_600_000) {
    const key = `LOGIN_SOON:${new Date(expires).toISOString().slice(0, 10)}`;
    if (!(key in state.sent)) {
      const when = new Date(expires).toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit" });
      const probs = await notify([{ title: "Altovix: Schwab login expires soon", message: `Your Schwab login runs out ${when}. On the PC: Windows key + R, run schwab-login.cmd. Takes a minute.`, priority: 3, tags: ["key"] }], send);
      if (persist && !probs.length) state.sent[key] = new Date().toISOString();
    }
  }

  const tickers = tickersFor(book);
  const from = new Date(`${book.cycle.start}T12:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 75); // room for the 21-session leg and 20-day averages
  const fromDate = from.toISOString().slice(0, 10);

  if (!quiet) process.stdout.write(c.dim(`Schwab: ${tickers.length} tickers... `));
  let qs: SchwabQuote[] = [];
  try { qs = await quotes(tickers, cfg); } catch (err) { if (!quiet) console.log(c.yellow(`quotes failed: ${(err as Error).message}`)); }
  const quoteOf = new Map(qs.map((q) => [q.symbol, q]));
  const errors: string[] = [];
  const barsList = await pool(tickers, 4, async (t) => {
    try { return await priceHistory(t, { from: fromDate }, cfg); } catch (err) { errors.push(`${t}: ${(err as Error).message}`); return [] as Bar[]; }
  });
  if (!quiet) console.log(c.dim("done."));

  const bars: Record<string, Bar[]> = {};
  const live: Record<string, number | null> = {};
  tickers.forEach((t, i) => {
    const list = [...(barsList[i] ?? [])];
    const q = quoteOf.get(t);
    const px = q ? q.regularLast ?? q.last : null;
    // Just after the bell the daily history may not have today's bar yet - the regular-session
    // last IS the close. Only when the quote actually traded today (not on a holiday).
    if (sessionComplete && q && px !== null && q.tradeTime && tradingDate(q.tradeTime) === clock.date && !list.some((b) => b.date === clock.date)) {
      list.push({ date: clock.date, open: null, high: null, low: null, close: px, volume: q.volume });
    }
    bars[t] = list;
    live[t] = sessionComplete ? null : px;
  });

  const result = runCheck({ book, agents: loadAgents(), bars, live, asOf: clock.date, sessionComplete });
  const plan = planAlerts(result, state);

  if (persist) {
    const path = resolve(process.cwd(), STATUS);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ generatedAt: new Date().toISOString(), rulesUpdated: book.updated ?? null, ...result }, null, 2) + "\n");
  }
  if (bool(args, "json")) { console.log(JSON.stringify(result, null, 2)); }
  else if (!quiet) print(result, book, plan.keys);

  const problems = await notify(plan.alerts, send);
  if (errors.length) problems.push(...errors.slice(0, 5));
  if (persist) {
    // Only mark alerts as sent when they were really delivered; otherwise the next run retries.
    if (send && !problems.some((p) => p.startsWith("ntfy") || p.startsWith("phone alerts"))) {
      for (const k of plan.keys) state.sent[k] = new Date().toISOString();
      for (const k of plan.withdrawn) delete state.sent[k];
      if (plan.summaryFor) state.lastSummary = plan.summaryFor;
    }
    state.lastRun = new Date().toISOString();
    writeState(state);
  }
  const stamp = new Date().toLocaleString("en-US");
  if (quiet) console.log(`${stamp}  ${result.asOf}${result.sessionComplete ? " close" : ""}  ${summaryLine(result)}  new events: ${plan.keys.length}${problems.length ? `  PROBLEMS: ${problems.join(" | ")}` : ""}`);
  else {
    if (plan.alerts.length && send && !problems.length) console.log(c.green(`\nSent ${plan.alerts.length} notification(s) to your phone.`));
    if (!plan.alerts.length) console.log(c.dim("\nNothing new to send to your phone."));
    for (const p of problems) console.log(c.yellow(`! ${p}`));
  }
}

function print(r: CheckResult, book: RuleBook, freshKeys: string[]): void {
  heading(`Altovix check  ${r.asOf}  ${r.sessionComplete ? "(after the close)" : "(market open or pre-open - closes through the last session)"}`);
  console.log(`${c.bold(`Opportunity ${r.opportunity}/100`)}  ${c.dim(r.opportunityWhy)}`);
  console.log(`${c.green(`${r.lights.green} green`)}  ${c.yellow(`${r.lights.yellow} yellow`)}  ${c.red(`${r.lights.red} red`)}   ${c.dim(summaryLine(r).split(". ").slice(2).join(". "))}`);

  const fresh = new Set(freshKeys);
  if (r.events.length) {
    console.log(`\n${c.bold("What fired")}  ${c.dim("(* = new since the last run)")}`);
    for (const e of r.events) {
      const colour = e.level === 1 ? c.red : e.level === 2 ? c.yellow : c.dim;
      console.log(`${fresh.has(e.key) ? "*" : " "} ${colour(e.title)}\n    ${e.text}`);
    }
  } else console.log(c.green("\nNothing fired."));

  console.log(`\n${c.dim("held      light   health   close      stop     cushion    P&L")}`);
  for (const p of r.positions) {
    const light = p.light === "GREEN" ? c.green("GREEN ") : p.light === "YELLOW" ? c.yellow("YELLOW") : c.red("RED   ");
    const f = (v: number | null, dp = 2): string => (v === null ? "n/a" : v.toFixed(dp));
    console.log(`${p.ticker.padEnd(9)} ${light}  ${String(p.health ?? "n/a").padStart(5)}   ${f(p.lastClose).padStart(8)}  ${f(p.stop).padStart(8)}  ${(p.cushionPct === null ? "n/a" : `${p.cushionPct >= 0 ? "+" : ""}${p.cushionPct.toFixed(1)}%`).padStart(8)}  ${(p.pnlPct === null ? "n/a" : `${p.pnlPct >= 0 ? "+" : ""}${p.pnlPct.toFixed(1)}%`).padStart(7)}${p.exit ? c.red(`  EXIT ${p.exit.date}`) : ""}`);
  }
  console.log(`\n${c.dim("watching  kind     state          close      level     away")}`);
  for (const t of r.triggers) {
    const f = (v: number | null): string => (v === null ? "n/a" : v.toFixed(2));
    const state = t.state === "FIRED" ? c.green(t.state.padEnd(13)) : t.state === "WAITING" ? t.state.padEnd(13) : c.dim(t.state.padEnd(13));
    console.log(`${t.ticker.padEnd(9)} ${t.kind.padEnd(7)}  ${state}  ${f(t.lastClose).padStart(8)}  ${f(t.level).padStart(8)}  ${(t.gapPct === null ? "" : `${t.gapPct.toFixed(1)}%`).padStart(7)}`);
  }
  const ctx = r.context.map((x) => `${x.ticker} ${x.close?.toFixed(2) ?? "n/a"}${x.dayPct === null ? "" : ` (${x.dayPct >= 0 ? "+" : ""}${x.dayPct.toFixed(2)}%)`}`).join("   ");
  console.log(`\n${c.dim(ctx)}`);
  if (r.missing.length) console.log(c.yellow(`No data for: ${r.missing.join(", ")}`));
  for (const n of book.standingNotes ?? []) console.log(c.dim(`- ${n}`));
  console.log(c.dim("\nRule checks on a paper book - decision support, not investment advice."));
}

// ---------------------------------------------------------------------------
// One-time setup: phone alerts + Windows scheduled runs

const RUNS = [
  { name: "Altovix check 1 - morning", et: 10 * 60 },        // 10:00 ET, 30 min after the open
  { name: "Altovix check 2 - midday", et: 13 * 60 },         // 1:00 pm ET
  { name: "Altovix check 3 - after the close", et: 16 * 60 + 15 }, // 4:15 pm ET - the one that fires rules
];

/** Minutes to add to a New York wall-clock time to get this PC's wall-clock time. */
function localOffsetFromNy(now = new Date()): number {
  const ny = nyClock(now).minutes;
  const local = now.getHours() * 60 + now.getMinutes();
  let d = local - ny;
  if (d > 720) d -= 1440;
  if (d < -720) d += 1440;
  return d;
}

const hhmm = (m: number): string => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, "0")}:${String((((m % 1440) + 1440) % 1440) % 60).padStart(2, "0")}`;

function run(cmd: string, a: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((res) => execFile(cmd, a, { windowsHide: true }, (err, so, se) => res({ ok: !err, out: `${so}${se}`.trim() })));
}

async function installSchedule(): Promise<void> {
  if (process.platform !== "win32") { console.log(c.yellow("Scheduled runs are set up with Windows Task Scheduler - skipped on this system.")); return; }
  const launcher = resolve(process.cwd(), "altovix-check.cmd");
  if (!existsSync(launcher)) die(`altovix-check.cmd not found in ${process.cwd()}`);
  const off = localOffsetFromNy();
  for (const r of RUNS) {
    const at = hhmm(r.et + off);
    const res = await run("schtasks", ["/Create", "/F", "/TN", `Altovix\\${r.name}`, "/SC", "WEEKLY", "/D", "MON,TUE,WED,THU,FRI", "/ST", at,
      "/TR", `cmd /c start "Altovix check" /min "${launcher}" scheduled`]);
    console.log(res.ok ? `${c.green("scheduled")}  ${r.name}  - weekdays at ${at} (your PC's time)` : c.red(`could not schedule "${r.name}": ${res.out}`));
  }
  console.log(c.dim("The PC must be on and you signed in to Windows at those times. A missed run loses nothing - the next one catches up."));
}

async function removeSchedule(): Promise<void> {
  for (const r of RUNS) {
    const res = await run("schtasks", ["/Delete", "/F", "/TN", `Altovix\\${r.name}`]);
    console.log(res.ok ? `removed  ${r.name}` : c.dim(`not found  ${r.name}`));
  }
}

async function setup(): Promise<void> {
  const n = ntfyConfig();
  const { topic, created } = ensureTopic(n);
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    heading("Altovix setup - step 1 of 2: alerts on your phone");
    console.log("On your iPhone, open the ntfy app (green speech-bubble icon):");
    console.log("  1. Tap the + button.");
    console.log(`  2. In "Topic name" type exactly:\n\n        ${c.bold(c.cyan(topic))}\n`);
    console.log('  3. Leave "Use another server" OFF. Tap Subscribe.');
    console.log("  4. If the phone asks to allow notifications, tap Allow.\n");
    console.log(c.dim(created ? "(That name was just made up for you. It works like a password - do not post it anywhere.)" : "(Same name as before.)"));
    for (;;) {
      await rl.question(c.bold("\nWhen you have tapped Subscribe, press Enter here and a test alert will be sent... "));
      try {
        await sendAlert(n, { title: "Altovix test alert", message: "If you can read this on your phone, alerts work.", priority: 4, tags: ["white_check_mark"] });
        console.log(c.green("Test alert sent."));
      } catch (err) {
        console.log(c.red(`Could not send: ${(err as Error).message}`));
      }
      const a = (await rl.question("Did it arrive on your phone? Type y and Enter (or n to try again): ")).trim().toLowerCase();
      if (a.startsWith("y")) break;
      console.log(c.yellow("Check the topic name in the ntfy app matches exactly (all lower case, with the dashes), then try again."));
    }
    heading("Step 2 of 2: run the check automatically");
    await installSchedule();
    console.log(`\n${c.green(c.bold("Setup finished."))} Running the first check now...\n`);
  } finally {
    rl.close();
  }
  await check();
}

try {
  if (bool(args, "setup")) await setup();
  else if (bool(args, "install-schedule")) await installSchedule();
  else if (bool(args, "remove-schedule")) await removeSchedule();
  else if (bool(args, "test-alert")) {
    await sendAlert(ntfyConfig(), { title: "Altovix test alert", message: str(args, "message") ?? "If you can read this on your phone, alerts work.", priority: 4, tags: ["white_check_mark"] });
    console.log(c.green("Test alert sent."));
  } else await check();
} catch (err) {
  die((err as Error).message);
}
