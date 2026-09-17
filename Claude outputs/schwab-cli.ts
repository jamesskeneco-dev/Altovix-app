import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  schwabConfig, isConfigured, authorizeUrl, extractCode, exchangeCode, refreshAccessToken,
  readTokens, refreshExpiresAt, quotes, priceHistory, accounts, SchwabApiError,
} from "../core/market/schwab.ts";
import { parseArgs, str, num, bool, heading, c, money, die } from "./args.ts";

/**
 * npm run schwab -- login                 sign in once; tokens cached in data/schwab-tokens.json
 * npm run schwab -- status                keys present? logged in? how long until re-login?
 * npm run schwab -- quote SPY QQQ ^VIX    live quotes
 * npm run schwab -- history DCO [--from 2026-01-01] [--last 10] [--ingest]
 * npm run schwab -- accounts              read-only: balances and positions (account numbers masked)
 * npm run schwab -- refresh               force a new access token (normally automatic)
 */

const args = parseArgs();
const cmd = (args.positional[0] ?? "status").toLowerCase();
const rest = args.positional.slice(1);
const cfg = schwabConfig();

const fmtDate = (ms: number): string => new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
const fmtNum = (v: number | null, dp = 2): string => (v === null ? "n/a" : v.toFixed(dp));
const hoursLeft = (ms: number): string => {
  const h = (ms - Date.now()) / 3_600_000;
  if (h <= 0) return c.red("expired");
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} days`;
};

function requireKeys(): void {
  if (!isConfigured(cfg)) {
    die("SCHWAB_APP_KEY and SCHWAB_APP_SECRET are not set. Put them in .env (see .env.example) - never in the repo.");
  }
}

function openBrowser(url: string): void {
  try {
    const p = process.platform === "win32"
      ? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true })
      : process.platform === "darwin"
        ? spawn("open", [url], { detached: true, stdio: "ignore" })
        : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    p.on("error", () => { /* fall through to the printed URL */ });
    p.unref();
  } catch { /* printed URL is the fallback */ }
}

async function login(): Promise<void> {
  requireKeys();
  const url = authorizeUrl(cfg);
  heading("Schwab sign-in");
  console.log("1. A Schwab login page is opening in your browser. If it does not, open this address yourself:\n");
  console.log(`   ${c.cyan(url)}\n`);
  console.log("2. Log in, tick the account(s) to link, and click through the consent screens.");
  console.log(`3. You will land on ${c.bold(cfg.callbackUrl)} and the browser will say it ${c.bold("cannot connect")}.`);
  console.log("   That is expected - nothing is listening there. Copy the FULL address from the address bar.\n");
  openBrowser(url);
  const rl = createInterface({ input: stdin, output: stdout });
  let pasted = "";
  try {
    pasted = await rl.question(c.bold("4. Paste that address here and press Enter: "));
  } finally {
    rl.close();
  }
  let code: string;
  try { code = extractCode(pasted); } catch (err) { die((err as Error).message); }
  process.stdout.write("\nExchanging the code for tokens... ");
  const t = await exchangeCode(code, cfg);
  console.log(c.green("done."));
  console.log(`Tokens saved to ${c.dim(cfg.tokenFile)} (git-ignored).`);
  console.log(`Access token good until ${fmtDate(t.access_expires_at)} ET (auto-refreshes).`);
  console.log(`Refresh token good until ${c.bold(fmtDate(refreshExpiresAt(t)))} ET - after that, run login again.`);
  console.log(`\nTry it:  ${c.cyan("npm run schwab -- quote SPY")}`);
}

async function status(): Promise<void> {
  heading("Schwab status");
  console.log(`Keys in .env      ${isConfigured(cfg) ? c.green("yes") : c.red("missing")}  ${c.dim(isConfigured(cfg) ? `(app key ...${cfg.appKey.slice(-4)})` : "SCHWAB_APP_KEY / SCHWAB_APP_SECRET")}`);
  console.log(`Callback URL      ${cfg.callbackUrl}`);
  const t = readTokens(cfg);
  if (!t) {
    console.log(`Logged in         ${c.red("no")}  ${c.dim("run: npm run schwab -- login")}`);
    return;
  }
  console.log(`Logged in         ${c.green("yes")}  ${c.dim(cfg.tokenFile)}`);
  console.log(`Access token      ${hoursLeft(t.access_expires_at)} left ${c.dim("(refreshes automatically)")}`);
  const rl = refreshExpiresAt(t);
  const left = hoursLeft(rl);
  console.log(`Refresh token     ${left} left  ${c.dim(`until ${fmtDate(rl)} ET`)}`);
  if (rl - Date.now() < 24 * 3_600_000) console.log(c.yellow("  Re-login soon: npm run schwab -- login"));
  if (!isConfigured(cfg)) return;
  process.stdout.write("Live check        ");
  try {
    const [q] = await quotes(["SPY"], cfg);
    console.log(q && q.last !== null ? c.green(`ok - SPY ${q.last.toFixed(2)}`) : c.yellow("connected, but no SPY quote returned"));
  } catch (err) {
    console.log(c.red((err as Error).message));
  }
}

async function quote(symbols: string[]): Promise<void> {
  requireKeys();
  if (!symbols.length) die("usage: npm run schwab -- quote SPY QQQ ^VIX");
  const rows = await quotes(symbols, cfg);
  heading(`Schwab quotes  ${c.dim(new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" }) + " ET")}`);
  console.log(c.dim("symbol   last       chg       chg%     close      bid/ask              volume     as of"));
  for (const q of rows) {
    if (q.invalid) { console.log(`${q.symbol.padEnd(8)} ${c.red("invalid symbol")}`); continue; }
    const chg = q.netChange === null ? "n/a" : (q.netChange >= 0 ? c.green(`+${q.netChange.toFixed(2)}`) : c.red(q.netChange.toFixed(2)));
    const pct = q.netPct === null ? "n/a" : (q.netPct >= 0 ? c.green(`+${q.netPct.toFixed(2)}%`) : c.red(`${q.netPct.toFixed(2)}%`));
    const ba = q.bid !== null && q.ask !== null ? `${q.bid.toFixed(2)}/${q.ask.toFixed(2)}` : "n/a";
    const asOf = q.tradeTime ? new Date(q.tradeTime).toLocaleTimeString("en-US", { timeZone: "America/New_York" }) : "n/a";
    console.log(
      `${q.symbol.padEnd(8)} ${fmtNum(q.last).padStart(9)}  ${chg.padStart(9)} ${pct.padStart(9)}  ${fmtNum(q.close).padStart(9)}  ${ba.padEnd(20)} ${(q.volume === null ? "n/a" : q.volume.toLocaleString("en-US")).padStart(11)}  ${asOf}`,
    );
  }
}

async function history(symbols: string[]): Promise<void> {
  requireKeys();
  if (!symbols.length) die("usage: npm run schwab -- history DCO [--from 2026-01-01] [--last 10] [--ingest]");
  const from = str(args, "from");
  const last = num(args, "last", 10) as number;
  const ingest = bool(args, "ingest");
  // The database (node:sqlite) is only loaded when bars are actually being written.
  const store = ingest ? await (async () => {
    const [{ db, migrate }, { upsertBars }] = await Promise.all([import("../core/db.ts"), import("../core/market/index.ts")]);
    const conn = db();
    migrate(conn);
    return { conn, upsertBars };
  })() : null;
  for (const symbol of symbols) {
    const sym = symbol.toUpperCase();
    const bars = await priceHistory(sym, { from }, cfg);
    heading(`${sym}  ${bars.length} daily bars${bars.length ? `  ${bars[0]?.date} -> ${bars[bars.length - 1]?.date}` : ""}`);
    for (const b of bars.slice(-last)) {
      console.log(`${b.date}  o ${fmtNum(b.open).padStart(9)}  h ${fmtNum(b.high).padStart(9)}  l ${fmtNum(b.low).padStart(9)}  c ${c.bold(b.close.toFixed(2).padStart(9))}  v ${(b.volume ?? 0).toLocaleString("en-US").padStart(12)}`);
    }
    if (store && bars.length) {
      const n = store.upsertBars(store.conn, sym, bars, "schwab");
      console.log(c.green(`ingested ${n} bars into ${c.dim("prices")} for ${sym}`));
    }
  }
}

async function showAccounts(): Promise<void> {
  requireKeys();
  const list = await accounts(cfg);
  if (!list.length) { console.log("No accounts were linked when you signed in. Run login again and tick an account."); return; }
  for (const a of list) {
    heading(`Account ****${a.last4}  ${c.dim(a.type ?? "")}`);
    console.log(`Cash               ${money(a.cash)}`);
    console.log(`Liquidation value  ${money(a.liquidationValue)}`);
    if (!a.positions.length) { console.log(c.dim("no positions")); continue; }
    console.log(`\n${c.dim("symbol    qty        avg cost    mkt value     day P&L")}`);
    for (const p of [...a.positions].sort((x, y) => (y.marketValue ?? 0) - (x.marketValue ?? 0))) {
      const pnl = p.dayPnl === null ? "n/a" : (p.dayPnl >= 0 ? c.green(`+${p.dayPnl.toFixed(2)}`) : c.red(p.dayPnl.toFixed(2)));
      console.log(`${p.symbol.padEnd(9)} ${p.quantity.toFixed(4).padStart(10)}  ${fmtNum(p.averagePrice).padStart(10)}  ${money(p.marketValue).padStart(12)}  ${pnl.padStart(10)}`);
    }
  }
  console.log(c.dim("\nRead-only. Nothing in this repo can place, replace or cancel an order."));
}

try {
  switch (cmd) {
    case "login": await login(); break;
    case "status": await status(); break;
    case "quote": case "quotes": await quote(rest); break;
    case "history": await history(rest); break;
    case "accounts": case "account": await showAccounts(); break;
    case "refresh": {
      requireKeys();
      const t = await refreshAccessToken(cfg);
      console.log(`${c.green("refreshed")} - access token good until ${fmtDate(t.access_expires_at)} ET`);
      break;
    }
    default:
      die(`unknown command "${cmd}". Try: login | status | quote SPY | history DCO | accounts | refresh`);
  }
} catch (err) {
  if (err instanceof SchwabApiError && err.status === 401) {
    die(`${err.message}\nYour Schwab session is no longer valid - run: npm run schwab -- login`);
  }
  die((err as Error).message);
}
