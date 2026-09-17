import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { CheckEvent, CheckResult } from "./engine.ts";

/**
 * Phone alerts through ntfy (https://ntfy.sh): one HTTPS POST from this PC, a push notification
 * on the phone. No account. The TOPIC NAME IS THE PASSWORD - anyone who knows it can read the
 * alerts - so it is generated here, kept in data/ (git-ignored; this repo is public) and never
 * printed anywhere but this PC's own console.
 */

export interface NtfyConfig { server: string; topic: string | null; topicFile: string; appUrl: string }

export function ntfyConfig(env: Record<string, string | undefined> = process.env): NtfyConfig {
  const topicFile = env["NTFY_TOPIC_FILE"] ?? "./data/ntfy-topic.txt";
  let topic = env["NTFY_TOPIC"]?.trim() || null;
  const path = resolve(process.cwd(), topicFile);
  if (!topic && existsSync(path)) topic = readFileSync(path, "utf8").trim() || null;
  return {
    server: (env["NTFY_SERVER"] ?? "https://ntfy.sh").replace(/\/+$/, ""),
    topic, topicFile,
    appUrl: env["ALTOVIX_APP_URL"] ?? "https://jamesskeneco-dev.github.io/Altovix-app/",
  };
}

const WORDS = [
  "maple", "otter", "river", "cedar", "falcon", "harbor", "granite", "meadow", "copper", "willow", "summit", "prairie",
  "lantern", "orchard", "canyon", "heron", "juniper", "pebble", "thicket", "anchor", "bramble", "cobalt", "drift", "ember",
  "fjord", "glacier", "hollow", "island", "jasper", "kestrel", "lagoon", "marble", "nectar", "onyx", "pine", "quartz",
  "raven", "sable", "timber", "umber", "valley", "walnut", "yarrow", "zephyr", "birch", "clover", "dune", "elm",
];

/** Easy to type on a phone, hard to guess: altovix-<word>-<word>-<word>-<4 digits> (~1e9 combinations). */
export function generateTopic(): string {
  const w = (): string => WORDS[randomInt(WORDS.length)] as string;
  return `altovix-${w()}-${w()}-${w()}-${String(randomInt(10_000)).padStart(4, "0")}`;
}

export function ensureTopic(cfg: NtfyConfig): { topic: string; created: boolean } {
  if (cfg.topic) return { topic: cfg.topic, created: false };
  const topic = generateTopic();
  const path = resolve(process.cwd(), cfg.topicFile);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${topic}\n`);
  cfg.topic = topic;
  return { topic, created: true };
}

export interface Alert {
  title: string;
  message: string;
  /** ntfy priority: 5 urgent, 4 high, 3 default, 2 low. */
  priority: 2 | 3 | 4 | 5;
  tags?: string[];
}

export async function sendAlert(cfg: NtfyConfig, a: Alert): Promise<void> {
  if (!cfg.topic) throw new Error("phone alerts are not set up - run: npm run check -- --setup-alerts");
  // JSON publishing (POST to the server root) keeps titles and bodies UTF-8 safe.
  const res = await fetch(`${cfg.server}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic: cfg.topic, title: a.title, message: a.message, priority: a.priority, tags: a.tags ?? [],
      click: cfg.appUrl, actions: [{ action: "view", label: "Open Altovix", url: cfg.appUrl }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ntfy: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// What was already sent (data/check-state.json)

export interface CheckState {
  sent: Record<string, string>;
  lastSummary: string | null;
  lastRun: string | null;
  /** Bumped when the daily card changes shape, so the new card is sent once even if today's went out already. */
  cardVersion?: number;
}

const CARD_VERSION = 2;

export function readState(file = process.env["ALTOVIX_CHECK_STATE"] ?? "./data/check-state.json"): CheckState {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return { sent: {}, lastSummary: null, lastRun: null };
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as Partial<CheckState>;
    return { sent: s.sent ?? {}, lastSummary: s.cardVersion === CARD_VERSION ? s.lastSummary ?? null : null, lastRun: s.lastRun ?? null, cardVersion: CARD_VERSION };
  } catch {
    return { sent: {}, lastSummary: null, lastRun: null };
  }
}

export function writeState(state: CheckState, file = process.env["ALTOVIX_CHECK_STATE"] ?? "./data/check-state.json"): void {
  const path = resolve(process.cwd(), file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...state, cardVersion: CARD_VERSION }, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Turning a check into alerts

/** ntfy turns these tag names into the emoji in front of the title. */
const TAG: Record<CheckEvent["kind"], string> = {
  STOP_HIT: "red_circle", EXIT_LEG: "red_circle", TRIGGER: "green_circle", REOPEN: "eyes",
  NEAR_STOP: "warning", HEADS_UP: "hourglass_flowing_sand", FILE_CLOSED: "file_folder", TRIGGER_VOID: "no_entry_sign",
  TRIGGER_REVIEW: "memo", CALENDAR: "spiral_calendar",
};

const signed = (v: number, dp = 2): string => `${v >= 0 ? "+" : "\u2212"}${Math.abs(v).toFixed(dp)}%`;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** 2026-09-17 -> "Thu Sep 17". */
export function longDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** One line for logs and the console. */
export function summaryLine(r: CheckResult): string {
  const b = r.book;
  const perf = b.sinceStartPct === null ? "" : ` Book ${signed(b.sinceStartPct)}${b.spySinceStartPct === null ? "" : ` vs SPY ${signed(b.spySinceStartPct)}`}.`;
  return `Opportunity ${r.opportunity}/100. ${r.lights.green} green, ${r.lights.yellow} yellow, ${r.lights.red} red.${perf}`;
}

const titleOf = (e: CheckEvent): string => e.phone?.title ?? e.title;
const bodyOf = (e: CheckEvent): string => (e.phone ? e.phone.lines.join("\n") : e.text);
/** Several events in one notification: a bold-ish heading line per event, its lines underneath. */
const bundle = (list: CheckEvent[]): string => list.map((e) => `${titleOf(e)}\n${bodyOf(e)}`).join("\n\n");

/** The daily card: the numbers a glance should give you, in the order you would ask for them. */
export function summaryAlert(r: CheckResult, signalsToday: CheckEvent[]): Alert {
  const open = r.positions.filter((p) => !p.exit && p.pnlPct !== null).sort((a, b) => (b.pnlPct as number) - (a.pnlPct as number));
  const best = open[0];
  const worst = open.at(-1);
  const next = r.triggers
    .filter((t) => (t.state === "WAITING" || t.state === "NOT_LIVE_YET") && t.kind !== "REOPEN" && t.level !== null && t.lastClose !== null)
    .sort((a, b) => b.proximity - a.proximity)[0];
  const lines = [
    `\ud83d\udfe2 ${r.lights.green}   \ud83d\udfe1 ${r.lights.yellow}   \ud83d\udd34 ${r.lights.red}`,
    r.book.sinceStartPct === null ? "" : `Book ${signed(r.book.sinceStartPct)}${r.book.spySinceStartPct === null ? "" : `  \u00b7  S&P ${signed(r.book.spySinceStartPct)}`}`,
    best && worst && best !== worst ? `Best ${best.ticker} ${signed(best.pnlPct as number, 1)}  \u00b7  Worst ${worst.ticker} ${signed(worst.pnlPct as number, 1)}` : "",
    next ? `Next buy: ${next.ticker} ${(next.lastClose as number).toFixed(2)} \u2192 ${(next.level as number).toFixed(2)} (${(next.gapPct ?? 0).toFixed(1)}% away)` : "No buy trigger is in range.",
    signalsToday.length ? `Today: ${signalsToday.map((e) => titleOf(e).replace(/ \u00b7 .*/, "")).join(", ")}` : "No trade signal today.",
  ].filter(Boolean);
  return { title: `Altovix \u00b7 Opportunity ${r.opportunity} \u00b7 ${longDay(r.asOf)}`, message: lines.join("\n"), priority: 2, tags: ["bar_chart"] };
}

/**
 * New events only. One notification per actionable event; when a run turns up many at once
 * (the first run, or the first after days off) they are bundled so the phone buzzes once.
 */
export function planAlerts(r: CheckResult, state: CheckState): { alerts: Alert[]; keys: string[]; summaryFor: string | null; withdrawn: string[] } {
  const fresh = r.events.filter((e) => !(e.key in state.sent));
  // A trade alert that was sent but no longer comes out of the rules (the rules or the data were
  // corrected) must be taken back explicitly - silence would leave a wrong BUY/SELL on the phone.
  // A SELL for a lot that has since been moved to `closed` is not withdrawn: it happened.
  const current = new Set(r.events.map((e) => e.key));
  const closed = new Set(r.closed.map((l) => l.ticker));
  const withdrawn = Object.keys(state.sent).filter((k) => {
    if (current.has(k) || !/^(TRIGGER|REOPEN|STOP_HIT|EXIT_LEG):/.test(k)) return false;
    return !(/^(STOP_HIT|EXIT_LEG):/.test(k) && closed.has(k.split(":")[1] ?? ""));
  });
  const act = fresh.filter((e) => e.level === 1);
  const watch = fresh.filter((e) => e.level === 2);
  const info = fresh.filter((e) => e.level === 3);
  const alerts: Alert[] = [];

  if (withdrawn.length) {
    const tickerOf = new Map(r.triggers.map((t) => [t.id, t.ticker]));
    const lines = withdrawn.map((k) => {
      const [kind, id, date] = k.split(":") as [string, string, string];
      const what = kind === "TRIGGER" ? "BUY" : kind === "REOPEN" ? "Back on the list:" : "SELL";
      return `\u2022 ${what} ${tickerOf.get(id) ?? id}${date ? ` (${longDay(date).slice(4)})` : ""}`;
    });
    alerts.push({
      title: `Correction \u00b7 ignore ${withdrawn.length} earlier alert${withdrawn.length === 1 ? "" : "s"}`,
      message: `These were sent earlier and do NOT apply:\n${lines.join("\n")}\nEverything else you were sent stands.`,
      priority: 4, tags: ["leftwards_arrow_with_hook"],
    });
  }

  if (act.length > 3) {
    alerts.push({ title: `${act.length} trade signals \u00b7 catch-up`, message: bundle(act), priority: 4, tags: ["rotating_light"] });
  } else {
    for (const e of act) alerts.push({ title: titleOf(e), message: bodyOf(e), priority: 4, tags: [TAG[e.kind]] });
  }
  if (watch.length > 2) {
    alerts.push({ title: `${watch.length} things to watch`, message: bundle(watch), priority: 3, tags: ["eyes"] });
  } else {
    for (const e of watch) alerts.push({ title: titleOf(e), message: bodyOf(e), priority: 3, tags: [TAG[e.kind]] });
  }
  if (info.length) {
    const only = info.length === 1 ? info[0] : undefined;
    alerts.push(only
      ? { title: only.kind === "CALENDAR" ? `Today \u00b7 ${longDay(only.date)}` : titleOf(only), message: bodyOf(only), priority: 2, tags: [TAG[only.kind]] }
      : { title: "Altovix notes", message: bundle(info), priority: 2, tags: ["memo"] });
  }

  // One summary card per completed session.
  let summaryFor: string | null = null;
  if (r.sessionComplete && r.lastCloseDate && r.lastCloseDate === r.asOf && state.lastSummary !== r.asOf) {
    summaryFor = r.asOf;
    alerts.push(summaryAlert(r, r.events.filter((e) => e.level === 1 && e.date === r.asOf)));
  }
  return { alerts, keys: fresh.map((e) => e.key), summaryFor, withdrawn };
}
