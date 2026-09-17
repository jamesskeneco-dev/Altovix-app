import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  schwabConfig, authorizeUrl, extractCode, exchangeCode, refreshAccessToken, accessToken,
  readTokens, writeTokens, refreshExpiresAt, quotes, priceHistory, accounts, schwab,
  schwabSymbol, tradingDate, REFRESH_TOKEN_TTL_MS, SchwabApiError,
} from "../src/core/market/schwab.ts";
import { providerChain } from "../src/core/market/index.ts";

// ---------------------------------------------------------------------------
// A fake Schwab: records what it was asked, answers with realistic shapes.

interface Seen { method: string; path: string; auth: string | undefined; body: string }
const seen: Seen[] = [];
let tokenCounter = 0;
let rejectBearer: string | null = null;
let server: Server;
let dir: string;

const EQUITY_QUOTE = {
  SPY: {
    assetMainType: "EQUITY", symbol: "SPY",
    quote: { lastPrice: 651.23, closePrice: 648.1, netChange: 3.13, netPercentChange: 0.4829, bidPrice: 651.2, askPrice: 651.25, totalVolume: 41234567, tradeTime: 1788555600000, "52WeekHigh": 660, "52WeekLow": 480, openPrice: 649, highPrice: 652.4, lowPrice: 647.9 },
    fundamental: { peRatio: 27.4, eps: 23.77, divYield: 1.12, avg10DaysVolume: 52000000 },
    reference: { description: "SPDR S&P 500 ETF" },
  },
  $VIX: {
    assetMainType: "INDEX", symbol: "$VIX",
    quote: { lastPrice: 16.4, closePrice: 17.1, netChange: -0.7, netPercentChange: -4.09 },
    reference: { description: "CBOE Volatility Index" },
  },
  NOPE: { symbol: "NOPE", invalidSymbols: ["NOPE"] },
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "altovix-schwab-"));
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url ?? "/", "http://x");
    seen.push({ method: req.method ?? "", path: url.pathname + url.search, auth: req.headers.authorization, body });
    const json = (status: number, payload: unknown): void => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (url.pathname === "/v1/oauth/token") {
      const expectedBasic = `Basic ${Buffer.from("KEY123:SECRET456").toString("base64")}`;
      if (req.headers.authorization !== expectedBasic) return json(401, { error: "unauthorized_client" });
      const form = new URLSearchParams(body);
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        if (form.get("code") !== "C0.abc.def@") return json(400, { error: "invalid_grant", error_description: "bad code" });
        if (form.get("redirect_uri") !== "https://127.0.0.1:8182") return json(400, { error: "invalid_request", error_description: "redirect mismatch" });
      } else if (grant === "refresh_token") {
        if (form.get("refresh_token") !== "REFRESH-1") return json(400, { error: "invalid_grant", error_description: "unknown refresh token" });
      } else return json(400, { error: "unsupported_grant_type" });
      tokenCounter++;
      return json(200, {
        access_token: `ACCESS-${tokenCounter}`, refresh_token: "REFRESH-1", token_type: "Bearer",
        expires_in: 1800, scope: "api", id_token: "ID",
      });
    }

    const bearer = req.headers.authorization ?? "";
    if (!bearer.startsWith("Bearer ACCESS-") || bearer === `Bearer ${rejectBearer}`) return json(401, { errors: [{ title: "Unauthorized" }] });

    if (url.pathname === "/marketdata/v1/quotes") {
      const syms = (url.searchParams.get("symbols") ?? "").split(",");
      const out: Record<string, unknown> = {};
      for (const s of syms) out[s] = (EQUITY_QUOTE as Record<string, unknown>)[s] ?? { symbol: s, invalidSymbols: [s] };
      return json(200, out);
    }
    if (url.pathname === "/marketdata/v1/pricehistory") {
      // three candles: 2026-09-03, 09-04, 09-08 - Schwab stamps candles at midnight-ish ET (05:00Z)
      const day = 24 * 3600 * 1000;
      const t0 = Date.parse("2026-09-03T05:00:00Z");
      return json(200, {
        symbol: url.searchParams.get("symbol"), empty: false,
        candles: [
          { datetime: t0 + 5 * day, open: 170, high: 172, low: 168, close: 171.5, volume: 300000 },
          { datetime: t0, open: 165, high: 169, low: 164, close: 168.18, volume: 250000 },
          { datetime: t0 + 1 * day, open: 168, high: 171, low: 167, close: 170.0, volume: 280000 },
        ],
      });
    }
    if (url.pathname === "/trader/v1/accounts/accountNumbers") {
      return json(200, [{ accountNumber: "12345678", hashValue: "HASHXYZ" }]);
    }
    if (url.pathname === "/trader/v1/accounts") {
      return json(200, [{
        securitiesAccount: {
          accountNumber: "12345678", type: "MARGIN",
          currentBalances: { cashBalance: 7100.5, liquidationValue: 10050.25 },
          positions: [
            { instrument: { symbol: "DCO", assetType: "EQUITY" }, longQuantity: 0.8919, averagePrice: 168.18, marketValue: 152.95, currentDayProfitLoss: 2.95 },
            { instrument: { symbol: "SPY", assetType: "COLLECTIVE_INVESTMENT" }, longQuantity: 2, shortQuantity: 0, averagePrice: 600, marketValue: 1302.46, currentDayProfitLoss: -1.1 },
          ],
        },
      }]);
    }
    if (url.pathname === "/trader/v1/orders") return json(403, { errors: [{ title: "Forbidden" }] });
    json(404, { error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  process.env["SCHWAB_API_BASE"] = `http://127.0.0.1:${port}`;
  process.env["SCHWAB_APP_KEY"] = "KEY123";
  process.env["SCHWAB_APP_SECRET"] = "SECRET456";
  process.env["SCHWAB_CALLBACK_URL"] = "https://127.0.0.1:8182";
  process.env["SCHWAB_TOKEN_FILE"] = join(dir, "tokens.json");
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

test("authorize URL carries the key and the exact callback", () => {
  const u = new URL(authorizeUrl());
  assert.equal(u.pathname, "/v1/oauth/authorize");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("client_id"), "KEY123");
  assert.equal(u.searchParams.get("redirect_uri"), "https://127.0.0.1:8182");
});

test("extractCode accepts the pasted redirect URL, a bare code, and rejects junk", () => {
  assert.equal(extractCode("https://127.0.0.1:8182/?code=C0.abc.def%40&session=7f1a"), "C0.abc.def@");
  assert.equal(extractCode("  C0.abc.def%40 "), "C0.abc.def@");
  assert.equal(extractCode("C0.abc.def@"), "C0.abc.def@");
  assert.throws(() => extractCode("https://127.0.0.1:8182/"), /no \?code=/);
  assert.throws(() => extractCode("   "), /nothing pasted/);
});

test("symbol mapping: indices to $, dots to slashes", () => {
  assert.equal(schwabSymbol("^VIX"), "$VIX");
  assert.equal(schwabSymbol("^GSPC"), "$SPX");
  assert.equal(schwabSymbol("^XYZ"), "$XYZ");
  assert.equal(schwabSymbol("brk.b"), "BRK/B");
  assert.equal(schwabSymbol("spy"), "SPY");
});

test("tradingDate uses the New York calendar, not UTC", () => {
  // 2026-09-08 23:30 ET is 2026-09-09 03:30Z - the bar belongs to the 8th.
  assert.equal(tradingDate(Date.parse("2026-09-09T03:30:00Z")), "2026-09-08");
  assert.equal(tradingDate(Date.parse("2026-09-03T05:00:00Z")), "2026-09-03");
});

test("login: code exchange sends Basic auth + form body and caches tokens with a 7-day refresh clock", async () => {
  seen.length = 0;
  const before_ = Date.now();
  const t = await exchangeCode(extractCode("https://127.0.0.1:8182/?code=C0.abc.def%40&session=1"));
  const req = seen.find((s) => s.path === "/v1/oauth/token");
  assert.ok(req);
  assert.equal(req.method, "POST");
  assert.match(req.auth ?? "", /^Basic /);
  const form = new URLSearchParams(req.body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "C0.abc.def@");
  assert.equal(t.access_token, "ACCESS-1");
  assert.equal(t.refresh_token, "REFRESH-1");
  assert.ok(t.access_expires_at >= before_ + 1800 * 1000 - 50);
  assert.ok(refreshExpiresAt(t) >= before_ + REFRESH_TOKEN_TTL_MS - 50);
  const onDisk = JSON.parse(readFileSync(schwabConfig().tokenFile, "utf8")) as { access_token: string };
  assert.equal(onDisk.access_token, "ACCESS-1");
});

test("accessToken reuses a live token and refreshes an expiring one without touching the 7-day clock", async () => {
  assert.equal(await accessToken(), "ACCESS-1");
  const t = readTokens();
  assert.ok(t);
  const issued = t.refresh_issued_at;
  writeTokens({ ...t, access_expires_at: Date.now() + 10_000 }); // 10 s left -> must refresh
  seen.length = 0;
  const fresh = await accessToken();
  assert.equal(fresh, "ACCESS-2");
  const form = new URLSearchParams(seen[0]?.body ?? "");
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "REFRESH-1");
  assert.equal(readTokens()?.refresh_issued_at, issued, "refresh must not extend the 7-day life");
});

test("an expired refresh token asks for a fresh login instead of hammering the endpoint", async () => {
  const t = readTokens();
  assert.ok(t);
  writeTokens({ ...t, access_expires_at: 0, refresh_issued_at: Date.now() - REFRESH_TOKEN_TTL_MS - 1000 });
  await assert.rejects(accessToken(), /refresh token has expired/);
  writeTokens({ ...t, access_expires_at: Date.now() + 3_600_000 }); // restore
});

test("quotes: maps Schwab's shape, index tickers, and invalid symbols", async () => {
  const rows = await quotes(["SPY", "^VIX", "NOPE"]);
  assert.equal(rows.length, 3);
  const spy = rows[0];
  assert.ok(spy && !spy.invalid);
  assert.equal(spy.last, 651.23);
  assert.equal(spy.close, 648.1);
  assert.equal(spy.netPct, 0.4829);
  assert.equal(spy.bid, 651.2);
  assert.equal(spy.description, "SPDR S&P 500 ETF");
  assert.deepEqual([spy.open, spy.high, spy.low, spy.pe, spy.eps, spy.divYield, spy.avgVolume10d], [649, 652.4, 647.9, 27.4, 23.77, 1.12, 52000000]);
  const vix = rows[1];
  assert.ok(vix && !vix.invalid);
  assert.equal(vix.symbol, "^VIX");
  assert.equal(vix.last, 16.4);
  assert.equal(vix.bid, null);
  assert.deepEqual([vix.open, vix.pe, vix.divYield], [null, null, null], "no figure is null, never 0");
  assert.equal(rows[2]?.invalid, true);
  const req = seen.at(-1);
  assert.ok(req?.path.includes("symbols=SPY%2C%24VIX%2CNOPE"), req?.path);
  assert.ok(req?.path.includes("fundamental"), req?.path);
});

test("priceHistory: daily candles come back as sorted Bars with New York dates; from filters", async () => {
  const bars = await priceHistory("DCO");
  assert.deepEqual(bars.map((b) => b.date), ["2026-09-03", "2026-09-04", "2026-09-08"]);
  assert.equal(bars[0]?.close, 168.18);
  assert.equal(bars[2]?.volume, 300000);
  const req = seen.at(-1);
  assert.ok(req?.path.includes("frequencyType=daily"));
  assert.ok(req?.path.includes("startDate="));
  const later = await priceHistory("DCO", { from: "2026-09-04" });
  assert.deepEqual(later.map((b) => b.date), ["2026-09-04", "2026-09-08"]);
});

test("the schwab PriceProvider sits first in the chain and returns bars", async () => {
  assert.equal(providerChain("schwab")[0]?.name, "schwab");
  const bars = await schwab.fetchDaily("DCO", "2026-09-04");
  assert.equal(bars.length, 2);
  assert.equal(bars[1]?.date, "2026-09-08");
});

test("provider reports a clear error when not logged in", async () => {
  const saved = readFileSync(schwabConfig().tokenFile, "utf8");
  rmSync(schwabConfig().tokenFile);
  await assert.rejects(schwab.fetchDaily("DCO"), /not logged in/);
  writeFileSync(schwabConfig().tokenFile, saved);
});

test("accounts: read-only view, account number masked to last four", async () => {
  const list = await accounts();
  assert.equal(list.length, 1);
  const a = list[0];
  assert.ok(a);
  assert.equal(a.last4, "5678");
  assert.equal(a.hash, "HASHXYZ");
  assert.equal(a.type, "MARGIN");
  assert.equal(a.cash, 7100.5);
  assert.equal(a.positions.length, 2);
  assert.equal(a.positions[0]?.symbol, "DCO");
  assert.equal(a.positions[0]?.quantity, 0.8919);
  assert.equal(a.positions[1]?.marketValue, 1302.46);
  assert.ok(!JSON.stringify(a).includes("12345678"), "full account number must not leak");
});

test("a 401 on an API call triggers exactly one forced refresh, then surfaces the error", async () => {
  const t = readTokens();
  assert.ok(t);
  rejectBearer = t.access_token; // server rejects the current token
  seen.length = 0;
  const rows = await quotes(["SPY"]);
  assert.equal(rows[0]?.last, 651.23);
  const paths = seen.map((s) => s.path.split("?")[0]);
  assert.deepEqual(paths, ["/marketdata/v1/quotes", "/v1/oauth/token", "/marketdata/v1/quotes"]);
  rejectBearer = null;

  await assert.rejects(
    async () => { const { apiGet } = await import("../src/core/market/schwab.ts"); await apiGet("/trader/v1/orders"); },
    (err: unknown) => err instanceof SchwabApiError && err.status === 403,
  );
});
