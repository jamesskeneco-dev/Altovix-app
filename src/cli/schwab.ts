// Loads .env into process.env as a side effect - must come before schwabConfig() reads it.
import "../core/config.ts";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  schwabConfig, isConfigured, authorizeUrl, extractCode, exchangeCode, refreshAccessToken,
  readTokens, refreshExpiresAt, quotes, priceHistory, accounts, SchwabApiError,
} from "../core/market/schwab.ts";
import { systemClipboardReader, watchClipboard } from "../core/market/clipboard.ts";
import { findBrowser, openLoginBrowser, type LoginBrowser } from "../core/market/browser-login.ts";
import { parseArgs, str, num, bool, heading, c, money, die } from "./args.ts";

/**
 * npm run schwab -- login [--manual]      sign in; tokens cached in data/schwab-tokens.json. Opens its own
 *                                         browser window and reads the redirect itself (hands-free);
 *                                         --manual uses your normal browser + copy/paste instead.
 *                                         Or double-click schwab-login.cmd in the repo folder.
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
    // Windows: cmd treats a bare '&' as a command separator, which cut the authorize URL off at
    // "?response_type=code" (Schwab then answered invalid_client). Pass the whole command line
    // verbatim with the URL in quotes so cmd hands it to the browser intact.
    const p = process.platform === "win32"
      ? spawn("cmd", ["/c", `start "" "${url}"`], { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true })
      : process.platform === "darwin"
        ? spawn("open", [url], { detached: true, stdio: "ignore" })
        : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    p.on("error", () => { /* fall through to the printed URL */ });
    p.unref();
  } catch { /* printed URL is the fallback */ }
}

/** How many rejected/expired codes `login` tolerates before giving up. */
const MAX_LOGIN_ATTEMPTS = 6;

type LoginSource = "browser" | "clipboard" | "pasted";

/**
 * Three ways in, all live at once, first one wins:
 *   browser   - login opens its own Edge/Chrome window and reads the redirect from the tab URL
 *               (hands-free; see core/market/browser-login.ts). Skipped with --manual.
 *   clipboard - the redirected address is copied in any browser (Ctrl+C).
 *   pasted    - the address is pasted into this window and Enter pressed.
 */
async function login(): Promise<void> {
  requireKeys();
  const url = authorizeUrl(cfg);
  const manual = bool(args, "manual") || process.env["SCHWAB_LOGIN"] === "manual";

  const inbox: Array<{ source: LoginSource; text: string }> = [];
  let wake: (() => void) | null = null;
  const poke = (): void => { if (wake) { const w = wake; wake = null; w(); } };
  const push = (source: LoginSource, text: string): void => { inbox.push({ source, text }); poke(); };

  // 1. Hands-free window.
  let browser: LoginBrowser | null = null;
  let browserNote: string | null = null;
  const browserPath = manual ? null : findBrowser();
  if (browserPath) {
    try {
      browser = await openLoginBrowser({
        url, callbackUrl: cfg.callbackUrl, browserPath,
        extraArgs: (process.env["SCHWAB_BROWSER_ARGS"] ?? "").split(" ").filter(Boolean),
      });
    } catch (err) {
      browserNote = (err as Error).message;
    }
  }

  // 2. Clipboard. Whatever is on it right now (usually an expired address) is ignored.
  const read = systemClipboardReader();
  const watch = read ? watchClipboard({ callbackUrl: cfg.callbackUrl, read }) : null;

  heading("Schwab sign-in");
  if (browser) {
    console.log(`A ${c.bold("separate browser window")} has just opened on the Schwab login page.`);
    console.log(c.dim("(It is a clean window kept only for this sign-in, so saved passwords are not filled in -"));
    console.log(c.dim(" type your Schwab Login ID and password.)\n"));
    console.log("1. Log in, tick the account(s) to link, click Continue and accept the consent screens.");
    console.log(`2. ${c.green(c.bold("That is all."))} This window reads the result by itself and closes the browser window.`);
    console.log(c.dim("   Nothing to copy, nothing to paste. If you see \"can't reach this page\" for a moment, that is normal.\n"));
  } else {
    if (browserNote) console.log(c.yellow(`(Could not open a sign-in window: ${browserNote} - using your normal browser.)\n`));
    printManualSteps(url, Boolean(watch));
    openBrowser(url);
  }

  if (browser) {
    const b = browser;
    void (async () => {
      for (;;) {
        const e = await b.next();
        if (e.kind === "callback") { push("browser", e.url); continue; }
        // Window closed before a code arrived: fall back to the normal browser.
        if (browser === b) {
          browser = null;
          console.log(c.yellow(`\n\n${e.reason} - opening the page in your normal browser instead.\n`));
          printManualSteps(url, Boolean(watch));
          openBrowser(url);
          process.stdout.write(c.bold("Waiting... "));
        }
        return;
      }
    })();
  }
  if (watch) void (async () => { for (;;) push("clipboard", await watch.next()); })();
  const rl = createInterface({ input: stdin, output: stdout });
  let closed = false;
  rl.on("line", (line) => { if (line.trim()) push("pasted", line); });
  rl.on("close", () => { closed = true; poke(); });

  const tried = new Set<string>();
  try {
    for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
      process.stdout.write(c.bold(browser ? "Waiting for you to finish signing in... " : "Waiting for the address... "));
      let item: { source: LoginSource; text: string } | undefined;
      let code = "";
      for (;;) {
        while (!inbox.length && !closed) await new Promise<void>((r) => { wake = r; });
        item = inbox.shift();
        if (!item) die("\nInput closed before an address arrived - run login again.");
        try { code = extractCode(item.text); } catch (err) {
          console.log(c.red(`\nThat was not the address: ${(err as Error).message}`));
          continue;
        }
        // The same address often arrives twice (copied, then pasted). A code works once.
        if (tried.has(code)) continue;
        tried.add(code);
        break;
      }
      console.log(c.green(item.source === "browser" ? "signed in - got the code." : item.source === "clipboard" ? "got it from the clipboard." : "got it."));

      process.stdout.write("Exchanging the code for tokens... ");
      try {
        const t = await exchangeCode(code, cfg);
        console.log(c.green("done.\n"));
        console.log(c.green(c.bold("LOGGED IN.")));
        console.log(`Tokens saved to ${c.dim(cfg.tokenFile)} (git-ignored).`);
        console.log(`Access token good until ${fmtDate(t.access_expires_at)} ET (auto-refreshes).`);
        console.log(`Refresh token good until ${c.bold(fmtDate(refreshExpiresAt(t)))} ET - after that, run login again.`);
        process.stdout.write("Live check: ");
        try {
          const [q] = await quotes(["SPY"], cfg);
          console.log(q && q.last !== null ? c.green(`ok - SPY ${q.last.toFixed(2)}`) : c.yellow("connected, but no SPY quote returned"));
        } catch (err) {
          console.log(c.yellow(`signed in, but the quote check failed: ${(err as Error).message}`));
        }
        console.log(`\nNext:  ${c.cyan("npm run schwab -- quote SPY")}   ${c.cyan("npm run schwab -- accounts")}`);
        return;
      } catch (err) {
        const msg = (err as Error).message;
        console.log(c.red("failed."));
        if (/HTTP 401/.test(msg)) {
          die(`${msg}\nSchwab rejected the app key/secret. Check lines 1-2 of .env against the developer portal `
            + "(if you regenerated the secret, .env needs the NEW one), then run login again.");
        }
        console.log(c.yellow(msg));
        if (attempt === MAX_LOGIN_ATTEMPTS) break;
        console.log(c.yellow("That code was too old (they last ~30 seconds) or was not accepted. No harm done."));
        console.log("Opening the Schwab page again - just sign in once more.\n");
        if (!(browser && await browser.open(url))) openBrowser(url);
      }
    }
    die("Too many failed attempts. Send Claude a screenshot of this window.");
  } finally {
    watch?.stop();
    rl.close();
    const b = browser;
    browser = null;
    if (b) await b.close();
  }
}

function printManualSteps(url: string, clipboard: boolean): void {
  console.log("1. A Schwab login page is opening in your browser. If it does not, open this address yourself:\n");
  console.log(`   ${c.cyan(url)}\n`);
  console.log("2. Log in, tick the account(s) to link, and click through the consent screens.");
  console.log(`3. You will land on a page that says it ${c.bold("can't reach / cannot connect")} to 127.0.0.1.`);
  console.log(`   ${c.green("That page means it WORKED.")} Nothing is listening there; the address bar holds the login code.`);
  if (clipboard) {
    console.log(`4. On that page: click the address bar and press ${c.bold("Ctrl+C")} (copy) ${c.bold("straight away")}.`);
    console.log("   This window is watching the clipboard and carries on by itself - no pasting needed.");
    console.log(c.dim("   (Pasting the address here and pressing Enter still works too.)"));
  } else {
    console.log("4. Copy the FULL address from the address bar, paste it here and press Enter.");
  }
  console.log(c.yellow("   The code lasts about 30 seconds - copy it as soon as the page appears.\n"));
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
