// Loads .env into process.env as a side effect - must come before krakenConfig() reads it.
import { config } from "../core/config.ts";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { db, migrate } from "../core/db.ts";
import { makeClient } from "../core/llm/index.ts";
import { runCommittee } from "../core/committee/run.ts";
import { upsertBars } from "../core/market/index.ts";
import {
  addOrder, assetPairs, balance, candlesToBars, isConfigured, krakenConfig, ohlc, openOrders, queryOrders, roundPrice, tickers, toKraken, volumeForUsd,
  type PairInfo, type Ticker,
} from "../core/market/kraken.ts";
import { describe, scan, scanOne, type ScanInput } from "../core/crypto/scan.ts";
import { evaluateBuy, exposureUsd, killSwitchOn, loadRules, readState, writeState, applyBuy, applySell, type CryptoRules, type CryptoState } from "../core/crypto/guard.ts";
import { cryptoOperatorNotes } from "../core/crypto/committee.ts";
import { buildStatus, runCycle, writeStatus, type CycleEvent, type Exchange } from "../core/crypto/loop.ts";
import { ntfyConfig, sendAlert, type Alert } from "../core/check/notify.ts";
import { detectRepo, publishStatus, readToken } from "../core/check/publish.ts";
import { parseArgs, bool, num, str, heading, c, die, money } from "./args.ts";

/**
 * npm run kraken -- status                         keys, balance, rules, open positions, kill switch
 * npm run kraken -- scan [--top 20] [--pool 60]     the volatility scanner, nothing else
 * npm run kraken -- quote SOL BTC DOGE              live quotes
 * npm run kraken -- balance                         Kraken balances (read-only)
 * npm run kraken -- history SOL [--ingest]          daily candles, optionally into the prices table
 * npm run kraken -- committee SOL [--mock]          convene the crypto committee on one pair (no order)
 * npm run kraken -- order buy SOL 50 [--live]       a manual buy of $50, through the guard; validate-only unless --live
 * npm run kraken -- order sell SOL [--live]         sell the whole SOL position
 * npm run kraken -- run [--once] [--loop 3600]      the cycle: exits -> scan -> committee -> guarded entries
 *                     [--no-committee] [--mock] [--quiet] [--no-notify]
 * npm run kraken -- kill | resume                   the kill switch (blocks new buys; exits still run)
 * npm run kraken -- positions                       open positions and P&L at the last marks
 *
 * rules/crypto.json holds every cap. live=false there means: validate with Kraken, send nothing,
 * simulate fills into data/crypto-paper-state.json. Flip it to true - and only then - to trade.
 */

const args = parseArgs();
const cfg = krakenConfig();
const quiet = bool(args, "quiet");
const log = (s: string): void => { if (!quiet) console.log(s); };

function rules(): CryptoRules {
  try { return loadRules(config.cryptoRules); } catch (err) { return die((err as Error).message); }
}
const stateFile = (r: CryptoRules): string => (r.live ? config.cryptoState : config.cryptoState.replace(/state\.json$/, "paper-state.json"));

const live: Exchange = {
  pairs: () => assetPairs(cfg),
  tickers: async (alts) => tickers(alts, await cachedPairs(), cfg),
  ohlc: (alt, interval) => ohlc(alt, interval, undefined, cfg),
  addOrder: (req) => addOrder(req, cfg),
  queryOrders: (txids) => queryOrders(txids, cfg),
};
let pairCache: PairInfo[] | null = null;
async function cachedPairs(): Promise<PairInfo[]> { return (pairCache ??= await assetPairs(cfg)); }
async function pairFor(symbolArg: string): Promise<PairInfo> {
  const alt = toKraken(symbolArg);
  const p = (await cachedPairs()).find((x) => x.altname === alt || x.symbol === symbolArg.toUpperCase());
  if (!p) die(`no Kraken pair for ${symbolArg} (tried ${alt})`);
  return p;
}
async function tickFor(p: PairInfo): Promise<Ticker> {
  const t = (await tickers([p.altname], [p], cfg))[0];
  if (!t) die(`no ticker for ${p.altname}`);
  return t;
}

async function notify(a: Alert): Promise<void> {
  if (bool(args, "no-notify")) return;
  const n = ntfyConfig();
  if (!n.topic) return;
  try { await sendAlert(n, a); } catch (err) { log(c.yellow(`! phone alert failed: ${(err as Error).message}`)); }
}

const usd = (v: number): string => money(v);

// ---------------------------------------------------------------------------

async function status(): Promise<void> {
  const r = rules();
  heading("Altovix crypto sleeve");
  log(`Keys:          ${isConfigured(cfg) ? c.green("present") : c.red("missing")}  (KRAKEN_API_KEY / KRAKEN_API_SECRET in .env)`);
  log(`Mode:          ${r.live ? c.red("LIVE - orders are sent") : c.yellow("VALIDATE - nothing is sent")}  (rules/crypto.json: live)`);
  log(`Kill switch:   ${killSwitchOn(r) ? c.red("ON") : "off"}  (${r.killSwitchFile})`);
  log(`Caps:          sleeve ${usd(r.sleeveUsd)} · order ${usd(r.maxOrderUsd)} · position ${usd(r.maxPositionUsd)} · ${r.maxPositions} positions · day loss ${usd(r.maxDailyLossUsd)} · ${r.maxDailyBuys} buys/day · min conf ${r.minConfidence}`);
  log(`Exits:         stop ${(r.stopPct * 100).toFixed(0)}% · trail ${(r.trailPct * 100).toFixed(0)}% · take-profit +${(r.takeProfitPct * 100).toFixed(0)}% · max hold ${r.maxHoldDays}d`);
  const s = readState(stateFile(r));
  log(`State:         ${stateFile(r)} - ${s.positions.length} open, exposure ${usd(exposureUsd(s))}, ${s.trades.length} trades recorded${s.halted ? c.red(`, HALTED: ${s.halted.reason}`) : ""}`);
  if (s.lastCycleSummary) log(`Last cycle:    ${s.lastCycleSummary}`);
  if (isConfigured(cfg)) {
    try {
      const b = await balance(cfg);
      const line = Object.entries(b).map(([k, v]) => `${k} ${v < 1 ? v.toPrecision(4) : v.toFixed(4)}`).join(" · ") || "(empty)";
      log(`Kraken:        ${line}`);
      const open = await openOrders(cfg);
      if (open.length) log(`Open orders:   ${open.map((o) => `${o.txid} ${o.description}`).join(" | ")}`);
    } catch (err) { log(c.red(`Kraken:        ${(err as Error).message}`)); }
  }
  log(`LLM:           ${config.llmMode}${config.llmMode === "real" && !config.apiKey ? c.red(" (ANTHROPIC_API_KEY missing - committee runs will fail; use --mock to dry-run)") : ""}`);
}

async function scanCmd(): Promise<void> {
  const r = rules();
  const top = num(args, "top", 20) as number;
  const pool = num(args, "pool", 60) as number;
  const pairs = (await cachedPairs()).filter((p) => p.quote === r.quote && p.status === "online");
  const ticks = await tickers(undefined, pairs, cfg);
  const tickByAlt = new Map(ticks.map((t) => [t.altname, t] as const));
  const ranked = pairs.map((p) => ({ p, t: tickByAlt.get(p.altname) })).filter((x): x is { p: PairInfo; t: Ticker } => Boolean(x.t))
    .map((x) => ({ ...x, usd: x.t.volume24h * (x.t.vwap24h > 0 ? x.t.vwap24h : x.t.last) }))
    .filter((x) => x.usd >= r.minVolume24hUsd && !r.excludeAssets.includes(x.p.base))
    .sort((a, b) => b.usd - a.usd).slice(0, pool);
  log(c.dim(`${pairs.length} ${r.quote} pairs; ${ranked.length} above the $${(r.minVolume24hUsd / 1e6).toFixed(0)}M/24h floor; fetching daily candles...`));
  const inputs: ScanInput[] = [];
  for (const x of ranked) {
    try { inputs.push({ pair: x.p, ticker: x.t, candles: await ohlc(x.p.altname, 1440, undefined, cfg) }); }
    catch (err) { log(c.yellow(`! ${x.p.altname}: ${(err as Error).message}`)); }
  }
  const rows = scan(inputs, r);
  heading(`Scanner - top ${top} (score / setup / price / 1d / 7d / ATR / volume surge / 24h $)`);
  for (const row of rows.filter((x) => !x.excluded).slice(0, top)) {
    log(describe(row));
    if (row.reasons.length) log(c.dim(`           ${row.reasons.join("; ")}`));
  }
  const ex = rows.filter((x) => x.excluded);
  if (ex.length) log(c.dim(`\n${ex.length} excluded (${[...new Set(ex.map((x) => x.excluded))].slice(0, 5).join("; ")}...)`));
}

async function quote(): Promise<void> {
  const syms = args.positional.slice(1);
  if (!syms.length) die("usage: quote SOL BTC ...");
  for (const s of syms) {
    const p = await pairFor(s);
    const t = await tickFor(p);
    log(`${p.symbol.padEnd(10)} last ${t.last}  bid ${t.bid}  ask ${t.ask}  24h ${t.low24h}-${t.high24h}  vol24h ${usd(t.volume24h * t.vwap24h)}  min order ${p.orderMin} ${p.base} / ${usd(p.costMin)}`);
  }
}

async function balanceCmd(): Promise<void> {
  const b = await balance(cfg);
  heading("Kraken balances");
  for (const [k, v] of Object.entries(b)) log(`${k.padEnd(8)} ${v}`);
  if (!Object.keys(b).length) log("(empty)");
}

async function history(): Promise<void> {
  const s = args.positional[1];
  if (!s) die("usage: history SOL [--ingest]");
  const p = await pairFor(s);
  const candles = await ohlc(p.altname, 1440, undefined, cfg);
  const bars = candlesToBars(candles, true);
  log(`${p.symbol}: ${bars.length} completed daily bars, ${bars[0]?.date} -> ${bars.at(-1)?.date}, last close ${bars.at(-1)?.close}`);
  if (bool(args, "ingest")) {
    migrate();
    const n = upsertBars(db(), p.symbol, bars, "kraken");
    log(`ingested ${n} bars into prices as ${p.symbol}`);
  }
}

async function ingestFor(symbols: string[]): Promise<void> {
  for (const s of symbols) {
    const p = await pairFor(s);
    const candles = await ohlc(p.altname, 1440, undefined, cfg);
    upsertBars(db(), p.symbol, candlesToBars(candles, true), "kraken");
  }
}

async function committee(): Promise<void> {
  const s = args.positional[1];
  if (!s) die("usage: committee SOL [--mock]");
  const r = rules();
  migrate();
  const p = await pairFor(s);
  const t = await tickFor(p);
  const candles = await ohlc(p.altname, 1440, undefined, cfg);
  await ingestFor(["BTC-USD", "ETH-USD"].filter((b) => b !== p.symbol));
  upsertBars(db(), p.symbol, candlesToBars(candles, true), "kraken");
  const row = scanOne({ pair: p, ticker: t, candles }, r);
  log(c.dim(describe(row)));
  const llm = makeClient(bool(args, "mock") ? "mock" : config.llmMode);
  const res = await runCommittee(db(), p.symbol, {
    llm, mandate: "NEW_POSITION", assetClass: "CRYPTO", operatorNotes: cryptoOperatorNotes(row, r, readState(stateFile(r)), str(args, "notes")),
    onProgress: (pr) => { if (pr.phase === "done") log(`  ${pr.title.padEnd(16)} ${c.dim(`${pr.latencyMs}ms`)}`); if (pr.phase === "error") log(c.red(`  ${pr.title}: ${pr.error}`)); },
  });
  heading(`Run #${res.runId} - ${res.status}`);
  log(`${p.symbol}: ${res.action ?? "-"} size ${res.sizePct ?? "-"}% of sleeve, confidence ${res.confidence ?? "-"}  (${res.claimIds.length} claims recorded; npm run report -- --run ${res.runId})`);
  if (res.action === "BUY" && res.confidence !== null) {
    const v = evaluateBuy({ symbol: p.symbol, usd: ((res.sizePct ?? 0) / 100) * r.sleeveUsd, confidence: res.confidence, price: t.ask, volume24hUsd: row.volume24hUsd }, r, readState(stateFile(r)));
    log(v.ok ? c.green(`guard: would allow ${usd(v.usd)}${v.reasons.length ? ` (${v.reasons.join("; ")})` : ""}`) : c.yellow(`guard: would refuse - ${v.reasons.join("; ")}`));
  }
}

async function order(): Promise<void> {
  const [, side, s, amount] = args.positional;
  const r = rules();
  const wantLive = bool(args, "live");
  if (wantLive && !r.live) die("rules/crypto.json has live=false; set it to true before --live");
  const isLive = wantLive && r.live;
  const p = await pairFor(s ?? die("usage: order buy SOL 50 | order sell SOL"));
  const t = await tickFor(p);
  const file = stateFile({ ...r, live: isLive });
  let state = readState(file);
  if (side === "buy") {
    const want = Number(amount);
    if (!(want > 0)) die("usage: order buy SOL <usd>");
    const v = evaluateBuy({ symbol: p.symbol, usd: want, confidence: 1, price: t.ask, volume24hUsd: t.volume24h * t.vwap24h }, r, state);
    if (!v.ok) die(`guard refused: ${v.reasons.join("; ")}`);
    const price = roundPrice(t.ask * (1 + r.entrySlippagePct), p);
    const vol = volumeForUsd(v.usd, price, p);
    if (vol === null) die(`${usd(v.usd)} is under Kraken's minimum for ${p.altname} (${p.orderMin} ${p.base} / ${usd(p.costMin)})`);
    const res = await addOrder({ altname: p.altname, side: "buy", ordertype: "limit", volume: vol, price, timeinforce: "IOC", live: isLive }, cfg);
    log(`${isLive ? c.red("PLACED") : c.yellow("VALIDATED (not sent)")}: ${res.description}${res.txids.length ? ` txid ${res.txids.join(",")}` : ""}`);
    const fill = isLive ? (await queryOrders(res.txids, cfg))[0] : null;
    const rec = { at: new Date().toISOString(), symbol: p.symbol, side: "BUY" as const, volume: fill?.executed ?? vol, price: fill?.avgPrice ?? t.ask, usd: (fill?.executed ?? vol) * (fill?.avgPrice ?? t.ask), fee: fill?.fee ?? 0, reason: "manual buy", txids: res.txids, clientId: res.clientId, live: isLive };
    state = applyBuy(state, rec, r, p.altname, null, "manual");
    writeState(state, file);
    await notify({ title: `Altovix crypto: ${isLive ? "bought" : "validated"} ${p.symbol}`, message: `${rec.volume} ${p.symbol} @ ~$${rec.price} = ${usd(rec.usd)} (manual)`, priority: 3, tags: ["coin"] });
  } else if (side === "sell") {
    const pos = state.positions.find((x) => x.symbol === p.symbol);
    if (!pos) die(`no ${p.symbol} position in ${file}`);
    const res = await addOrder({ altname: p.altname, side: "sell", ordertype: "market", volume: pos.volume, live: isLive }, cfg);
    log(`${isLive ? c.red("PLACED") : c.yellow("VALIDATED (not sent)")}: ${res.description}${res.txids.length ? ` txid ${res.txids.join(",")}` : ""}`);
    const fill = isLive ? (await queryOrders(res.txids, cfg))[0] : null;
    const rec = { at: new Date().toISOString(), symbol: p.symbol, side: "SELL" as const, volume: fill?.executed ?? pos.volume, price: fill?.avgPrice ?? t.bid, usd: (fill?.executed ?? pos.volume) * (fill?.avgPrice ?? t.bid), fee: fill?.fee ?? 0, reason: "MANUAL", txids: res.txids, clientId: res.clientId, live: isLive };
    state = applySell(state, rec);
    writeState(state, file);
    await notify({ title: `Altovix crypto: ${isLive ? "sold" : "validated sell"} ${p.symbol}`, message: `${rec.volume} ${p.symbol} @ ~$${rec.price} = ${usd(rec.usd)} (manual)`, priority: 3, tags: ["coin"] });
  } else die("usage: order buy SOL 50 | order sell SOL");
}

async function positions(): Promise<void> {
  const r = rules();
  const s = readState(stateFile(r));
  heading(`Positions (${r.live ? "LIVE" : "paper / validate"} - ${stateFile(r)})`);
  if (!s.positions.length) { log("(none)"); return; }
  const pairs = await cachedPairs();
  const ticks = await tickers(s.positions.map((p) => p.altname), pairs, cfg);
  for (const p of s.positions) {
    const t = ticks.find((x) => x.altname === p.altname);
    const mark = t?.last ?? null;
    const pnl = mark === null ? null : (mark - p.avgCost) * p.volume;
    log(`${p.symbol.padEnd(10)} ${p.volume} @ ${p.avgCost.toPrecision(6)}  cost ${usd(p.costUsd)}  mark ${mark ?? "n/a"}  P&L ${pnl === null ? "n/a" : (pnl >= 0 ? c.green(usd(pnl)) : c.red(usd(pnl)))}  stop ${p.stop.toPrecision(5)}  trail ${(p.highWater * (1 - r.trailPct)).toPrecision(5)}  TP ${p.takeProfit.toPrecision(5)}  since ${p.openedAt.slice(0, 10)}`);
  }
}

function killSwitch(on: boolean): void {
  const r = rules();
  const path = resolve(process.cwd(), r.killSwitchFile);
  if (on) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${new Date().toISOString()} kill switch set by npm run kraken -- kill\n`); log(c.red(`kill switch ON: ${path}. New buys are blocked; protective exits still run. Remove with: npm run kraken -- resume`)); }
  else { if (existsSync(path)) unlinkSync(path); log(c.green("kill switch off")); }
}

async function runCmd(): Promise<void> {
  const r = rules();
  migrate();
  const file = stateFile(r);
  const llm = makeClient(bool(args, "mock") ? "mock" : config.llmMode);
  const loop = num(args, "loop");
  const once = bool(args, "once") || !loop;
  if (r.live && !isConfigured(cfg)) die("live=true but Kraken keys are missing");
  if (config.llmMode === "real" && !config.apiKey && !bool(args, "no-committee") && !bool(args, "mock")) die("ANTHROPIC_API_KEY is empty: the committee cannot run. Use --mock (dry run) or --no-committee (exits + scan only).");
  log(c.dim(`${r.live ? "LIVE" : "VALIDATE"} mode · state ${file} · ${once ? "one cycle" : `every ${loop}s until Ctrl+C`}${llm.mode === "mock" ? " · MOCK committee (random, excluded from scorecards)" : ""}`));

  for (;;) {
    const state = readState(file);
    const started = Date.now();
    let result;
    try {
      result = await runCycle({
        conn: db(), exchange: live, rules: r, state, llm, noCommittee: bool(args, "no-committee"),
        candlePool: num(args, "pool", 40), minScanScore: num(args, "min-score", 45), journalFile: "./data/crypto-journal.jsonl",
        onEvent: (e: CycleEvent) => log(`${e.kind === "ERROR" ? c.red(e.kind) : e.kind === "ENTRY" || e.kind === "EXIT" ? c.green(e.kind) : e.kind === "REFUSED" || e.kind === "HALT" ? c.yellow(e.kind) : c.dim(e.kind)} ${e.message}`),
      });
    } catch (err) {
      log(c.red(`cycle failed: ${(err as Error).message}`));
      await notify({ title: "Altovix crypto: cycle failed", message: (err as Error).message.slice(0, 300), priority: 4, tags: ["warning"] });
      if (once) process.exit(1);
      await new Promise((res) => setTimeout(res, (loop as number) * 1000));
      continue;
    }
    writeState(result.state, file);
    const status = buildStatus(result, r);
    writeStatus(status, config.cryptoStatus);
    // Same side branch the market check publishes to, one more file; the phone's Crypto tab reads it.
    const token = readToken(), repo = detectRepo();
    if (token && repo && !bool(args, "no-publish")) {
      try { await publishStatus({ ...repo, token, content: JSON.stringify(status), path: "crypto-status.json", apiBase: process.env["GITHUB_API_BASE"], message: `crypto: ${result.at.slice(0, 16)}Z` }); }
      catch (err) { log(c.yellow(`! phone app not updated: ${(err as Error).message}`)); }
    } else if (!token) log(c.dim("(phone app not updated - double-click altovix-publish-setup.cmd once)"));
    log(`${result.summary} ${c.dim(`(${((Date.now() - started) / 1000).toFixed(0)}s)`)}`);
    for (const e of result.events) {
      if (e.kind === "ENTRY" || e.kind === "EXIT") await notify({ title: `Altovix crypto: ${e.kind === "ENTRY" ? "bought" : "sold"} ${e.symbol}`, message: e.message, priority: 4, tags: ["coin"] });
      else if (e.kind === "HALT") await notify({ title: "Altovix crypto: HALTED", message: e.message, priority: 5, tags: ["rotating_light"] });
      else if (e.kind === "VALIDATED") await notify({ title: `Altovix crypto (validate): ${e.symbol}`, message: e.message, priority: 2, tags: ["coin"] });
    }
    if (once) break;
    await new Promise((res) => setTimeout(res, (loop as number) * 1000));
  }
}

const cmd = args.positional[0] ?? "status";
const commands: Record<string, () => Promise<void> | void> = {
  status, scan: scanCmd, quote, balance: balanceCmd, history, committee, order, positions, run: runCmd,
  kill: () => killSwitch(true), resume: () => killSwitch(false),
};
const fn = commands[cmd];
if (!fn) die(`unknown command "${cmd}". Commands: ${Object.keys(commands).join(", ")}`);
Promise.resolve(fn()).catch((err: Error) => die(err.message));
