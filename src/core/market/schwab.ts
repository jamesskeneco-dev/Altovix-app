import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { Bar } from "../types.ts";
import { type PriceProvider, ProviderError } from "./types.ts";

/**
 * Charles Schwab Trader API - OAuth client, market data, read-only account access.
 *
 * Zero dependencies, like the rest of the repo. Credentials come from the environment
 * (loaded from .env by src/core/config.ts) and never from source:
 *
 *   SCHWAB_APP_KEY        App Key (Client ID) from developer.schwab.com
 *   SCHWAB_APP_SECRET     App Secret (Client Secret)
 *   SCHWAB_CALLBACK_URL   must match the app exactly - default https://127.0.0.1:8182
 *   SCHWAB_TOKEN_FILE     where tokens are cached - default ./data/schwab-tokens.json
 *   SCHWAB_API_BASE       override for tests only
 *
 * Token lifetimes (Schwab): access token 30 minutes, refresh token 7 days. The refresh
 * token is NOT extended by refreshing - after seven days `npm run schwab -- login` again.
 *
 * Deliberately absent: anything that places, replaces or cancels an order.
 */

export interface SchwabConfig {
  appKey: string;
  appSecret: string;
  callbackUrl: string;
  tokenFile: string;
  apiBase: string;
}

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  token_type: string;
  scope?: string;
  id_token?: string;
  /** epoch ms when access_token stops working */
  access_expires_at: number;
  /** epoch ms when the refresh token was issued at login (7-day life) */
  refresh_issued_at: number;
}

export const ACCESS_TOKEN_TTL_MS = 30 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function schwabConfig(): SchwabConfig {
  return {
    appKey: process.env["SCHWAB_APP_KEY"] ?? "",
    appSecret: process.env["SCHWAB_APP_SECRET"] ?? "",
    callbackUrl: process.env["SCHWAB_CALLBACK_URL"] ?? "https://127.0.0.1:8182",
    tokenFile: process.env["SCHWAB_TOKEN_FILE"] ?? "./data/schwab-tokens.json",
    apiBase: process.env["SCHWAB_API_BASE"] ?? "https://api.schwabapi.com",
  };
}

export function isConfigured(cfg: SchwabConfig = schwabConfig()): boolean {
  return Boolean(cfg.appKey && cfg.appSecret);
}

// ---------------------------------------------------------------------------
// Token storage

export function readTokens(cfg: SchwabConfig = schwabConfig()): TokenSet | null {
  const path = resolve(process.cwd(), cfg.tokenFile);
  if (!existsSync(path)) return null;
  try {
    const t = JSON.parse(readFileSync(path, "utf8")) as Partial<TokenSet>;
    if (!t.access_token || !t.refresh_token) return null;
    return {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      token_type: t.token_type ?? "Bearer",
      scope: t.scope,
      id_token: t.id_token,
      access_expires_at: Number(t.access_expires_at ?? 0),
      refresh_issued_at: Number(t.refresh_issued_at ?? 0),
    };
  } catch {
    return null;
  }
}

export function writeTokens(tokens: TokenSet, cfg: SchwabConfig = schwabConfig()): string {
  const path = resolve(process.cwd(), cfg.tokenFile);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(tokens, null, 2) + "\n", { mode: 0o600 });
  return path;
}

export function refreshExpiresAt(t: TokenSet): number {
  return t.refresh_issued_at + REFRESH_TOKEN_TTL_MS;
}

// ---------------------------------------------------------------------------
// OAuth

export function authorizeUrl(cfg: SchwabConfig = schwabConfig()): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: cfg.appKey,
    redirect_uri: cfg.callbackUrl,
  });
  return `${cfg.apiBase}/v1/oauth/authorize?${q.toString()}`;
}

/**
 * Accepts the full redirect URL the browser landed on (https://127.0.0.1:8182/?code=...&session=...)
 * or a bare authorization code. URL parsing decodes the trailing %40 -> '@' for us.
 */
export function extractCode(pasted: string): string {
  const s = pasted.trim();
  if (!s) throw new Error("nothing pasted");
  if (/^https?:\/\//i.test(s)) {
    const code = new URL(s).searchParams.get("code");
    if (!code) throw new Error("that URL has no ?code= in it - paste the address you were redirected to after approving");
    return code;
  }
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: URLSearchParams, cfg: SchwabConfig): Promise<RawTokenResponse> {
  const basic = Buffer.from(`${cfg.appKey}:${cfg.appSecret}`, "utf8").toString("base64");
  const res = await fetch(`${cfg.apiBase}/v1/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  const text = await res.text();
  let json: RawTokenResponse = {};
  try { json = JSON.parse(text) as RawTokenResponse; } catch { /* non-JSON error body */ }
  if (!res.ok || !json.access_token) {
    const why = json.error_description ?? json.error ?? (text.trim() ? text.slice(0, 200) : "empty response");
    throw new Error(`Schwab token endpoint: HTTP ${res.status} - ${why}`);
  }
  return json;
}

export async function exchangeCode(code: string, cfg: SchwabConfig = schwabConfig()): Promise<TokenSet> {
  if (!isConfigured(cfg)) throw new Error("SCHWAB_APP_KEY / SCHWAB_APP_SECRET are not set in .env");
  const now = Date.now();
  const raw = await tokenRequest(
    new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: cfg.callbackUrl }),
    cfg,
  );
  const tokens: TokenSet = {
    access_token: raw.access_token as string,
    refresh_token: raw.refresh_token ?? "",
    token_type: raw.token_type ?? "Bearer",
    scope: raw.scope,
    id_token: raw.id_token,
    access_expires_at: now + (raw.expires_in ? raw.expires_in * 1000 : ACCESS_TOKEN_TTL_MS),
    refresh_issued_at: now,
  };
  if (!tokens.refresh_token) throw new Error("Schwab returned no refresh token");
  writeTokens(tokens, cfg);
  return tokens;
}

export async function refreshAccessToken(cfg: SchwabConfig = schwabConfig()): Promise<TokenSet> {
  const current = readTokens(cfg);
  if (!current) throw new Error("not logged in - run `npm run schwab -- login`");
  if (Date.now() > refreshExpiresAt(current)) {
    throw new Error("Schwab refresh token has expired (7-day limit) - run `npm run schwab -- login` again");
  }
  const now = Date.now();
  const raw = await tokenRequest(
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refresh_token }),
    cfg,
  );
  const rotated = Boolean(raw.refresh_token) && raw.refresh_token !== current.refresh_token;
  const tokens: TokenSet = {
    ...current,
    access_token: raw.access_token as string,
    refresh_token: raw.refresh_token ?? current.refresh_token,
    token_type: raw.token_type ?? current.token_type,
    scope: raw.scope ?? current.scope,
    id_token: raw.id_token ?? current.id_token,
    access_expires_at: now + (raw.expires_in ? raw.expires_in * 1000 : ACCESS_TOKEN_TTL_MS),
    // Schwab does not extend the 7-day life on refresh; only trust a genuinely new token.
    refresh_issued_at: rotated ? now : current.refresh_issued_at,
  };
  writeTokens(tokens, cfg);
  return tokens;
}

/** A usable access token, refreshing when fewer than 60 seconds remain. */
export async function accessToken(cfg: SchwabConfig = schwabConfig()): Promise<string> {
  if (!isConfigured(cfg)) throw new Error("SCHWAB_APP_KEY / SCHWAB_APP_SECRET are not set in .env");
  const t = readTokens(cfg);
  if (!t) throw new Error("not logged in - run `npm run schwab -- login`");
  if (Date.now() < t.access_expires_at - 60_000) return t.access_token;
  return (await refreshAccessToken(cfg)).access_token;
}

// ---------------------------------------------------------------------------
// HTTP

export class SchwabApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, path: string, body: string) {
    super(`Schwab ${path}: HTTP ${status}${body ? ` - ${body.slice(0, 200)}` : ""}`);
    this.name = "SchwabApiError";
    this.status = status;
    this.body = body;
  }
}

export async function apiGet<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  cfg: SchwabConfig = schwabConfig(),
): Promise<T> {
  const url = new URL(`${cfg.apiBase}${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  const token = await accessToken(cfg);
  let res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (res.status === 401) {
    // Token may have been revoked or clock skewed - one forced refresh, then give up.
    const fresh = await refreshAccessToken(cfg);
    res = await fetch(url, { headers: { Authorization: `Bearer ${fresh.access_token}`, Accept: "application/json" } });
  }
  const text = await res.text();
  if (!res.ok) throw new SchwabApiError(res.status, path, text);
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// Symbols and dates

/** Altovix uses Yahoo-style index tickers (^VIX). Schwab wants $VIX, $SPX, $COMPX, $DJI. */
export function schwabSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  const map: Record<string, string> = { "^VIX": "$VIX", "^GSPC": "$SPX", "^IXIC": "$COMPX", "^DJI": "$DJI", "^RUT": "$RUT" };
  if (map[s]) return map[s] as string;
  if (s.startsWith("^")) return `$${s.slice(1)}`;
  return s.replace(/\./g, "/"); // BRK.B -> BRK/B
}

const nyDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});

/** Epoch ms -> YYYY-MM-DD in New York, the trading calendar's timezone. */
export function tradingDate(ms: number): string {
  return nyDate.format(new Date(ms));
}

// ---------------------------------------------------------------------------
// Market data

export interface SchwabQuote {
  symbol: string;
  assetType: string | null;
  last: number | null;
  /** Last REGULAR-session trade (no pre/post-market). What a "daily close" rule should read after 4pm ET. */
  regularLast: number | null;
  close: number | null;
  netChange: number | null;
  netPct: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  tradeTime: number | null;
  high52: number | null;
  low52: number | null;
  /** Today's regular-session open / high / low (null before the first trade). */
  open: number | null;
  high: number | null;
  low: number | null;
  /** From the "fundamental" block; null for ETFs, indexes and anything Schwab has no figure for. */
  pe: number | null;
  eps: number | null;
  divYield: number | null;
  avgVolume10d: number | null;
  description: string | null;
  invalid: boolean;
}

interface RawQuoteEntry {
  symbol?: string;
  assetMainType?: string;
  invalidSymbols?: string[];
  quote?: Record<string, number | string | undefined>;
  regular?: Record<string, number | string | undefined>;
  fundamental?: Record<string, number | string | undefined>;
  reference?: { description?: string };
}

const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Schwab sends 0 for "no figure" (no trade yet today, no earnings, no dividend) - that is not a number to show. */
const positive = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

export async function quotes(symbols: string[], cfg: SchwabConfig = schwabConfig()): Promise<SchwabQuote[]> {
  if (!symbols.length) return [];
  const wanted = symbols.map((s) => s.toUpperCase());
  const raw = await apiGet<Record<string, RawQuoteEntry>>(
    "/marketdata/v1/quotes",
    { symbols: wanted.map(schwabSymbol).join(","), fields: "quote,reference,regular,fundamental", indicative: false },
    cfg,
  );
  const out: SchwabQuote[] = [];
  for (const sym of wanted) {
    const key = schwabSymbol(sym);
    const e = raw[key] ?? raw[sym];
    if (!e || e.invalidSymbols?.length) {
      out.push({ symbol: sym, assetType: null, last: null, regularLast: null, close: null, netChange: null, netPct: null, bid: null, ask: null, volume: null, tradeTime: null, high52: null, low52: null, open: null, high: null, low: null, pe: null, eps: null, divYield: null, avgVolume10d: null, description: null, invalid: true });
      continue;
    }
    const q = e.quote ?? {};
    out.push({
      symbol: sym,
      assetType: e.assetMainType ?? null,
      last: numOrNull(q["lastPrice"]) ?? numOrNull(e.regular?.["regularMarketLastPrice"]),
      regularLast: numOrNull(e.regular?.["regularMarketLastPrice"]),
      close: numOrNull(q["closePrice"]),
      netChange: numOrNull(q["netChange"]),
      netPct: numOrNull(q["netPercentChange"]),
      bid: numOrNull(q["bidPrice"]),
      ask: numOrNull(q["askPrice"]),
      volume: numOrNull(q["totalVolume"]),
      tradeTime: numOrNull(q["tradeTime"]) ?? numOrNull(q["quoteTime"]),
      high52: numOrNull(q["52WeekHigh"]),
      low52: numOrNull(q["52WeekLow"]),
      open: positive(q["openPrice"]),
      high: positive(q["highPrice"]),
      low: positive(q["lowPrice"]),
      pe: positive(e.fundamental?.["peRatio"]),
      eps: numOrNull(e.fundamental?.["eps"]),
      divYield: positive(e.fundamental?.["divYield"]),
      avgVolume10d: positive(e.fundamental?.["avg10DaysVolume"]),
      description: e.reference?.description ?? null,
      invalid: false,
    });
  }
  return out;
}

interface RawCandle { datetime?: number; open?: number; high?: number; low?: number; close?: number; volume?: number }
interface RawHistory { symbol?: string; empty?: boolean; candles?: RawCandle[]; previousClose?: number }

/** Daily bars, oldest first. `from` is YYYY-MM-DD; default ten years. */
export async function priceHistory(
  symbol: string,
  opts: { from?: string; to?: string } = {},
  cfg: SchwabConfig = schwabConfig(),
): Promise<Bar[]> {
  const start = opts.from ? Date.parse(`${opts.from}T00:00:00-05:00`) : Date.now() - 10 * 365.25 * 24 * 3600 * 1000;
  const end = opts.to ? Date.parse(`${opts.to}T23:59:59-05:00`) : Date.now();
  const raw = await apiGet<RawHistory>(
    "/marketdata/v1/pricehistory",
    {
      symbol: schwabSymbol(symbol),
      periodType: "year",
      frequencyType: "daily",
      frequency: 1,
      startDate: Math.floor(start),
      endDate: Math.floor(end),
      needExtendedHoursData: false,
      needPreviousClose: false,
    },
    cfg,
  );
  const bars: Bar[] = [];
  for (const c of raw.candles ?? []) {
    if (typeof c.datetime !== "number" || typeof c.close !== "number") continue;
    const date = tradingDate(c.datetime);
    if (opts.from && date < opts.from) continue;
    bars.push({
      date,
      open: numOrNull(c.open),
      high: numOrNull(c.high),
      low: numOrNull(c.low),
      close: c.close,
      volume: numOrNull(c.volume),
    });
  }
  bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return bars;
}

/** PriceProvider adapter so `npm run ingest -- --provider schwab` and the fallback chain work. */
export const schwab: PriceProvider = {
  name: "schwab",
  async fetchDaily(symbol: string, from?: string): Promise<Bar[]> {
    const cfg = schwabConfig();
    if (!isConfigured(cfg)) throw new ProviderError("schwab", symbol, "SCHWAB_APP_KEY not set");
    if (!readTokens(cfg)) throw new ProviderError("schwab", symbol, "not logged in (npm run schwab -- login)");
    let bars: Bar[];
    try {
      bars = await priceHistory(symbol, { from }, cfg);
    } catch (err) {
      throw new ProviderError("schwab", symbol, (err as Error).message);
    }
    if (!bars.length) throw new ProviderError("schwab", symbol, "no candles returned");
    return bars;
  },
};

// ---------------------------------------------------------------------------
// Accounts - read only

export interface SchwabPosition {
  symbol: string;
  assetType: string | null;
  quantity: number;
  averagePrice: number | null;
  marketValue: number | null;
  dayPnl: number | null;
}

export interface SchwabAccount {
  /** encrypted account id Schwab uses in URLs */
  hash: string;
  /** last four digits of the account number - never the whole thing */
  last4: string;
  type: string | null;
  cash: number | null;
  liquidationValue: number | null;
  positions: SchwabPosition[];
}

interface RawAccountNumber { accountNumber?: string; hashValue?: string }
interface RawPosition {
  instrument?: { symbol?: string; assetType?: string };
  longQuantity?: number; shortQuantity?: number; averagePrice?: number;
  marketValue?: number; currentDayProfitLoss?: number;
}
interface RawAccount {
  securitiesAccount?: {
    accountNumber?: string; type?: string; positions?: RawPosition[];
    currentBalances?: { cashBalance?: number; liquidationValue?: number; cashAvailableForTrading?: number };
  };
}

export async function accounts(cfg: SchwabConfig = schwabConfig()): Promise<SchwabAccount[]> {
  const numbers = await apiGet<RawAccountNumber[]>("/trader/v1/accounts/accountNumbers", {}, cfg);
  const detail = await apiGet<RawAccount[]>("/trader/v1/accounts", { fields: "positions" }, cfg);
  const hashFor = new Map<string, string>(numbers.map((n): [string, string] => [n.accountNumber ?? "", n.hashValue ?? ""]));
  return detail.map((a) => {
    const s = a.securitiesAccount ?? {};
    const num = s.accountNumber ?? "";
    return {
      hash: hashFor.get(num) ?? "",
      last4: num.slice(-4),
      type: s.type ?? null,
      cash: numOrNull(s.currentBalances?.cashBalance) ?? numOrNull(s.currentBalances?.cashAvailableForTrading),
      liquidationValue: numOrNull(s.currentBalances?.liquidationValue),
      positions: (s.positions ?? []).map((p) => ({
        symbol: p.instrument?.symbol ?? "?",
        assetType: p.instrument?.assetType ?? null,
        quantity: (p.longQuantity ?? 0) - (p.shortQuantity ?? 0),
        averagePrice: numOrNull(p.averagePrice),
        marketValue: numOrNull(p.marketValue),
        dayPnl: numOrNull(p.currentDayProfitLoss),
      })),
    };
  });
}
