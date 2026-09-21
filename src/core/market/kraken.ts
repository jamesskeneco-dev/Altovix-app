import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Bar } from "../types.ts";
import { type PriceProvider, ProviderError } from "./types.ts";

/**
 * Kraken Spot REST client - market data, balances and orders. Zero dependencies.
 *
 * Credentials come from the environment (loaded from .env by src/core/config.ts):
 *
 *   KRAKEN_API_KEY      API key from kraken.com -> Settings -> API. Give it ONLY
 *   KRAKEN_API_SECRET   "Query Funds", "Query Open/Closed Orders & Trades" and
 *                       "Create & Modify Orders". Never "Withdraw Funds".
 *   KRAKEN_API_BASE     override for tests only (default https://api.kraken.com)
 *
 * Every order goes through `addOrder`, which sends `validate: true` unless the caller
 * passes `live: true`. A validated order is checked by Kraken (pair, size, price, funds)
 * and NOT placed. That is the default on purpose - see src/core/crypto/guard.ts for the
 * rules that decide when an order may go live.
 *
 * Symbols: Altovix uses `SOL-USD`, `BTC-USD`. Kraken calls BTC "XBT" and DOGE "XDG" and
 * addresses pairs by altname (`SOLUSD`, `XBTUSD`). `toKraken` / `fromKraken` translate.
 */

export interface KrakenConfig {
  apiKey: string;
  apiSecret: string;
  apiBase: string;
}

export function krakenConfig(env: Record<string, string | undefined> = process.env): KrakenConfig {
  return {
    apiKey: env["KRAKEN_API_KEY"] ?? "",
    apiSecret: env["KRAKEN_API_SECRET"] ?? "",
    apiBase: (env["KRAKEN_API_BASE"] ?? "https://api.kraken.com").replace(/\/+$/, ""),
  };
}

export function isConfigured(cfg: KrakenConfig = krakenConfig()): boolean {
  return Boolean(cfg.apiKey && cfg.apiSecret);
}

// ---------------------------------------------------------------------------
// Symbols

const TO_KRAKEN: Record<string, string> = { BTC: "XBT", DOGE: "XDG" };
const FROM_KRAKEN: Record<string, string> = { XBT: "BTC", XDG: "DOGE", XXBT: "BTC", XETH: "ETH", XXRP: "XRP", XLTC: "LTC", XXLM: "XLM", XXMR: "XMR", XZEC: "ZEC", XETC: "ETC", XXDG: "DOGE", ZUSD: "USD", ZEUR: "EUR", ZGBP: "GBP", ZCAD: "CAD", ZJPY: "JPY" };

/** Altovix symbol (`SOL-USD`) -> Kraken pair altname (`SOLUSD`). Plain `SOL` means `SOL-USD`. */
export function toKraken(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  const [base, quote = "USD"] = s.includes("-") ? s.split("-") : s.includes("/") ? s.split("/") : [s];
  const b = TO_KRAKEN[base as string] ?? base;
  const q = TO_KRAKEN[quote as string] ?? quote;
  return `${b}${q}`;
}

/** Kraken asset code (`XXBT`, `XBT`, `ZUSD`) -> plain code (`BTC`, `USD`). */
export function fromKrakenAsset(code: string): string {
  const c = code.toUpperCase().replace(/\.(F|B|T|S|M|HOLD)$/, "");
  return FROM_KRAKEN[c] ?? c;
}

/** Kraken wsname (`SOL/USD`, `XBT/USD`) -> Altovix symbol (`SOL-USD`, `BTC-USD`). */
export function fromKrakenPair(wsname: string): string {
  const [b = "", q = ""] = wsname.toUpperCase().split("/");
  return `${fromKrakenAsset(b)}-${fromKrakenAsset(q)}`;
}

export function isCryptoSymbol(symbol: string): boolean {
  return /^[A-Z0-9]{2,10}-(USD|USDT|USDC|EUR|BTC|ETH)$/.test(symbol.trim().toUpperCase());
}

// ---------------------------------------------------------------------------
// Signing

/**
 * API-Sign = base64( HMAC-SHA512( path + SHA256(nonce + postdata), base64decode(secret) ) ).
 * Matches Kraken's published test vector (see test/kraken.test.ts).
 */
export function sign(path: string, nonce: string, postdata: string, secret: string): string {
  const inner = createHash("sha256").update(nonce + postdata).digest();
  return createHmac("sha512", Buffer.from(secret, "base64"))
    .update(Buffer.concat([Buffer.from(path, "utf8"), inner]))
    .digest("base64");
}

/** Nonces must only ever increase, even across two calls inside one millisecond. */
let lastNonce = 0;
export function nextNonce(now = Date.now()): string {
  const n = Math.max(now * 1000, lastNonce + 1);
  lastNonce = n;
  return String(n);
}

// ---------------------------------------------------------------------------
// HTTP

export class KrakenApiError extends Error {
  readonly errors: string[];
  readonly status: number;
  constructor(path: string, status: number, errors: string[]) {
    super(`Kraken ${path}: ${errors.length ? errors.join("; ") : `HTTP ${status}`}`);
    this.name = "KrakenApiError";
    this.errors = errors;
    this.status = status;
  }
  /** Rate limit and temporary lockouts read differently from a rejected order. */
  get retryable(): boolean {
    return this.errors.some((e) => /Rate limit|Too many|Unavailable|Busy|EService/i.test(e)) || this.status >= 500;
  }
  get insufficientFunds(): boolean {
    return this.errors.some((e) => /Insufficient funds/i.test(e));
  }
}

interface Envelope<T> { error?: string[]; result?: T }

export type Params = Record<string, string | number | boolean | undefined>;

function encode(params: Params): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  return q.toString();
}

async function parse<T>(path: string, res: Response): Promise<T> {
  const text = await res.text();
  let json: Envelope<T> = {};
  try { json = JSON.parse(text) as Envelope<T>; } catch { /* non-JSON body: HTML from a proxy, say */ }
  if (json.error?.length) throw new KrakenApiError(path, res.status, json.error);
  if (!res.ok) throw new KrakenApiError(path, res.status, [text.trim().slice(0, 200)]);
  if (json.result === undefined) throw new KrakenApiError(path, res.status, ["empty result"]);
  return json.result;
}

/** Kraken's public rate limit is roughly one call a second sustained; a burst gets "EAPI:Rate limit exceeded". */
export const PUBLIC_PACING_MS = 350;
let lastPublicCall = 0;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One retry after a pause when Kraken says it is rate-limited or busy; anything else surfaces at once. */
export async function withRetry<T>(fn: () => Promise<T>, pauseMs = 5000): Promise<T> {
  try { return await fn(); } catch (err) {
    if (err instanceof KrakenApiError && err.retryable) { await wait(pauseMs); return fn(); }
    throw err;
  }
}

export async function publicGet<T>(method: string, params: Params = {}, cfg: KrakenConfig = krakenConfig()): Promise<T> {
  const path = `/0/public/${method}`;
  const qs = encode(params);
  return withRetry(async () => {
    const gap = PUBLIC_PACING_MS - (Date.now() - lastPublicCall);
    if (gap > 0) await wait(gap);
    lastPublicCall = Date.now();
    const res = await fetch(`${cfg.apiBase}${path}${qs ? `?${qs}` : ""}`, { headers: { Accept: "application/json", "User-Agent": "altovix/1.0" } });
    return parse<T>(path, res);
  });
}

export async function privatePost<T>(method: string, params: Params = {}, cfg: KrakenConfig = krakenConfig()): Promise<T> {
  if (!isConfigured(cfg)) throw new Error("KRAKEN_API_KEY / KRAKEN_API_SECRET are not set in .env");
  const path = `/0/private/${method}`;
  const nonce = nextNonce();
  const body = encode({ nonce, ...params });
  const res = await fetch(`${cfg.apiBase}${path}`, {
    method: "POST",
    headers: {
      "API-Key": cfg.apiKey,
      "API-Sign": sign(path, nonce, body, cfg.apiSecret),
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      Accept: "application/json",
      "User-Agent": "altovix/1.0",
    },
    body,
  });
  return parse<T>(path, res);
}

// ---------------------------------------------------------------------------
// Public market data

export interface PairInfo {
  /** Kraken's internal pair id, the key AssetPairs and Ticker responses use (XXBTZUSD, SOLUSD). */
  id: string;
  /** Altovix symbol, e.g. SOL-USD */
  symbol: string;
  /** Kraken altname used in requests, e.g. SOLUSD */
  altname: string;
  wsname: string;
  base: string;
  quote: string;
  status: string;
  /** Minimum order size in base units. */
  orderMin: number;
  /** Minimum order value in quote units (USD). */
  costMin: number;
  lotDecimals: number;
  pairDecimals: number;
  tickSize: number | null;
}

interface RawPair {
  altname?: string; wsname?: string; base?: string; quote?: string; status?: string;
  ordermin?: string; costmin?: string; lot_decimals?: number; pair_decimals?: number; tick_size?: string;
}

export function parsePairs(raw: Record<string, RawPair>): PairInfo[] {
  const out: PairInfo[] = [];
  for (const [id, p] of Object.entries(raw)) {
    if (!p.altname || !p.wsname) continue;
    out.push({
      id,
      symbol: fromKrakenPair(p.wsname),
      altname: p.altname,
      wsname: p.wsname,
      base: fromKrakenAsset(p.base ?? p.wsname.split("/")[0] ?? ""),
      quote: fromKrakenAsset(p.quote ?? p.wsname.split("/")[1] ?? ""),
      status: p.status ?? "unknown",
      orderMin: Number(p.ordermin ?? 0) || 0,
      costMin: Number(p.costmin ?? 0) || 0,
      lotDecimals: p.lot_decimals ?? 8,
      pairDecimals: p.pair_decimals ?? 2,
      tickSize: p.tick_size !== undefined ? Number(p.tick_size) : null,
    });
  }
  return out;
}

export async function assetPairs(cfg?: KrakenConfig): Promise<PairInfo[]> {
  return parsePairs(await publicGet<Record<string, RawPair>>("AssetPairs", {}, cfg));
}

export interface Ticker {
  altname: string;
  last: number;
  bid: number;
  ask: number;
  /** Base-asset volume over the trailing 24 hours. */
  volume24h: number;
  vwap24h: number;
  high24h: number;
  low24h: number;
  /** Today's UTC open. */
  open: number;
  trades24h: number;
}

interface RawTicker { a?: string[]; b?: string[]; c?: string[]; v?: string[]; p?: string[]; t?: number[]; l?: string[]; h?: string[]; o?: string }

const n = (v: string | number | undefined): number => (v === undefined ? NaN : Number(v));

export function parseTickers(raw: Record<string, RawTicker>, altnameOf: (key: string) => string = (k) => k): Ticker[] {
  const out: Ticker[] = [];
  for (const [key, t] of Object.entries(raw)) {
    const last = n(t.c?.[0]);
    if (!Number.isFinite(last)) continue;
    out.push({
      altname: altnameOf(key),
      last,
      bid: n(t.b?.[0]),
      ask: n(t.a?.[0]),
      volume24h: n(t.v?.[1]),
      vwap24h: n(t.p?.[1]),
      high24h: n(t.h?.[1]),
      low24h: n(t.l?.[1]),
      open: n(t.o),
      trades24h: n(t.t?.[1]),
    });
  }
  return out;
}

/**
 * Tickers for the given altnames (or every pair when omitted). Kraken keys the result by
 * internal pair id (XXBTZUSD), so the caller maps ids back to altnames via `pairs`.
 */
export async function tickers(altnames: string[] | undefined, pairs: PairInfo[], cfg?: KrakenConfig): Promise<Ticker[]> {
  const raw = await publicGet<Record<string, RawTicker>>("Ticker", altnames?.length ? { pair: altnames.join(",") } : {}, cfg);
  // Response keys are the internal ids AssetPairs used (XXBTZUSD) - or altnames when queried by altname.
  const byId = new Map(pairs.map((p) => [p.id, p.altname] as const));
  const byAlt = new Set(pairs.map((p) => p.altname));
  return parseTickers(raw, (key) => {
    const viaId = byId.get(key);
    if (viaId) return viaId;
    if (byAlt.has(key)) return key;
    // Unknown key: strip the X/Z asset prefixes as a last resort (XXBTZUSD -> XBTUSD).
    const stripped = key.replace(/^X(?=[A-Z]{3}Z)/, "").replace(/Z(?=USD$|EUR$|GBP$|CAD$|JPY$)/, "");
    return byAlt.has(stripped) ? stripped : key;
  });
}

export type Interval = 1 | 5 | 15 | 30 | 60 | 240 | 1440 | 10080 | 21600;

export interface Candle { time: number; open: number; high: number; low: number; close: number; vwap: number; volume: number; count: number }

export function parseOhlc(raw: Record<string, unknown>): Candle[] {
  for (const [k, v] of Object.entries(raw)) {
    if (k === "last" || !Array.isArray(v)) continue;
    return (v as Array<Array<string | number>>).map((r) => ({
      time: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]),
      close: Number(r[4]), vwap: Number(r[5]), volume: Number(r[6]), count: Number(r[7]),
    })).filter((c) => Number.isFinite(c.close));
  }
  return [];
}

/** Up to 720 candles ending now. Kraken ignores `since` older than that window. */
export async function ohlc(altname: string, interval: Interval = 1440, since?: number, cfg?: KrakenConfig): Promise<Candle[]> {
  return parseOhlc(await publicGet<Record<string, unknown>>("OHLC", { pair: altname, interval, since }, cfg));
}

export const utcDate = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

/** Daily candles -> Altovix bars. The last candle is today's, still forming, unless `completeOnly`. */
export function candlesToBars(candles: Candle[], completeOnly = false): Bar[] {
  const rows = completeOnly ? candles.slice(0, -1) : candles;
  return rows.map((c) => ({ date: utcDate(c.time), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
}

/** PriceProvider for `npm run ingest -- SOL-USD`: daily bars, UTC days, complete candles only. */
export const kraken: PriceProvider = {
  name: "kraken",
  async fetchDaily(symbol: string, from?: string): Promise<Bar[]> {
    const sym = symbol.toUpperCase();
    if (!isCryptoSymbol(sym)) throw new ProviderError("kraken", sym, "not a crypto pair (use SOL-USD, BTC-USD)");
    let candles: Candle[];
    try { candles = await ohlc(toKraken(sym), 1440); } catch (err) { throw new ProviderError("kraken", sym, (err as Error).message); }
    if (!candles.length) throw new ProviderError("kraken", sym, "no candles returned");
    const bars = candlesToBars(candles, true);
    return from ? bars.filter((b) => b.date >= from) : bars;
  },
};

// ---------------------------------------------------------------------------
// Private: balances and orders

export interface Balances { [asset: string]: number }

export async function balance(cfg?: KrakenConfig): Promise<Balances> {
  const raw = await privatePost<Record<string, string>>("Balance", {}, cfg);
  const out: Balances = {};
  for (const [k, v] of Object.entries(raw)) {
    const asset = fromKrakenAsset(k);
    const amt = Number(v);
    if (Number.isFinite(amt) && amt !== 0) out[asset] = (out[asset] ?? 0) + amt;
  }
  return out;
}

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop-loss" | "take-profit" | "stop-loss-limit" | "trailing-stop";

export interface OrderRequest {
  altname: string;
  side: OrderSide;
  ordertype: OrderType;
  /** Base-asset quantity, already rounded to the pair's lot decimals. */
  volume: number;
  /** Limit price, or trigger price for stop/take-profit orders. */
  price?: number;
  /** Secondary price (limit) for stop-loss-limit; trailing offset like "+5%" is passed in `price` for trailing-stop. */
  price2?: number;
  timeinforce?: "GTC" | "IOC" | "FOK";
  /** Post-only limit orders never take liquidity (maker fee). */
  postOnly?: boolean;
  /** Attached close order (Kraken places it when this order fills). */
  close?: { ordertype: "stop-loss" | "take-profit" | "stop-loss-limit"; price: number; price2?: number };
  /** Client order id, up to 18 chars. Generated when omitted. */
  clientId?: string;
  /** Reject the order server-side if not processed within this many seconds (2-60). */
  deadlineSeconds?: number;
  /** ONLY when true is the order actually placed. Default: validate and return. */
  live?: boolean;
}

export interface OrderResult {
  validated: boolean;
  placed: boolean;
  description: string;
  closeDescription: string | null;
  txids: string[];
  clientId: string;
}

export function orderParams(o: OrderRequest): Params {
  const clientId = o.clientId ?? randomUUID().replace(/-/g, "").slice(0, 18);
  const p: Params = {
    pair: o.altname,
    type: o.side,
    ordertype: o.ordertype,
    volume: String(o.volume),
    cl_ord_id: clientId,
  };
  if (o.price !== undefined) p["price"] = String(o.price);
  if (o.price2 !== undefined) p["price2"] = String(o.price2);
  if (o.timeinforce) p["timeinforce"] = o.timeinforce;
  if (o.postOnly) p["oflags"] = "post";
  if (o.close) {
    p["close[ordertype]"] = o.close.ordertype;
    p["close[price]"] = String(o.close.price);
    if (o.close.price2 !== undefined) p["close[price2]"] = String(o.close.price2);
  }
  if (o.deadlineSeconds) p["deadline"] = new Date(Date.now() + Math.min(60, Math.max(2, o.deadlineSeconds)) * 1000).toISOString();
  if (!o.live) p["validate"] = true;
  return p;
}

interface RawAddOrder { descr?: { order?: string; close?: string }; txid?: string[] }

/**
 * Validate (default) or place an order. Validation asks Kraken to check the order
 * without executing it - the same pair/size/price/funds checks a live order gets.
 */
export async function addOrder(o: OrderRequest, cfg?: KrakenConfig): Promise<OrderResult> {
  const params = orderParams(o);
  const raw = await privatePost<RawAddOrder>("AddOrder", params, cfg);
  return {
    validated: true,
    placed: Boolean(o.live),
    description: raw.descr?.order ?? "",
    closeDescription: raw.descr?.close ?? null,
    txids: raw.txid ?? [],
    clientId: String(params["cl_ord_id"]),
  };
}

export async function cancelOrder(txid: string, cfg?: KrakenConfig): Promise<number> {
  const raw = await privatePost<{ count?: number }>("CancelOrder", { txid }, cfg);
  return raw.count ?? 0;
}

export interface OpenOrder { txid: string; altname: string; side: OrderSide; ordertype: string; volume: number; executed: number; price: number | null; status: string; description: string; openedAt: number; clientId: string | null }

interface RawOrder { status?: string; opentm?: number; closetm?: number; vol?: string; vol_exec?: string; cost?: string; fee?: string; price?: string; cl_ord_id?: string; descr?: { pair?: string; type?: string; ordertype?: string; price?: string; order?: string } }

function parseOrders(raw: Record<string, RawOrder>): OpenOrder[] {
  return Object.entries(raw).map(([txid, o]) => ({
    txid,
    altname: o.descr?.pair ?? "",
    side: (o.descr?.type ?? "buy") as OrderSide,
    ordertype: o.descr?.ordertype ?? "",
    volume: Number(o.vol ?? 0),
    executed: Number(o.vol_exec ?? 0),
    price: o.descr?.price ? Number(o.descr.price) : null,
    status: o.status ?? "",
    description: o.descr?.order ?? "",
    openedAt: Number(o.opentm ?? 0),
    clientId: o.cl_ord_id ?? null,
  }));
}

export async function openOrders(cfg?: KrakenConfig): Promise<OpenOrder[]> {
  const raw = await privatePost<{ open?: Record<string, RawOrder> }>("OpenOrders", {}, cfg);
  return parseOrders(raw.open ?? {});
}

export interface ClosedOrder extends OpenOrder { closedAt: number; cost: number; fee: number; avgPrice: number | null }

export async function queryOrders(txids: string[], cfg?: KrakenConfig): Promise<ClosedOrder[]> {
  if (!txids.length) return [];
  const raw = await privatePost<Record<string, RawOrder>>("QueryOrders", { txid: txids.join(","), trades: true }, cfg);
  return Object.entries(raw).map(([txid, o]) => {
    const base = parseOrders({ [txid]: o })[0] as OpenOrder;
    const executed = Number(o.vol_exec ?? 0);
    const cost = Number(o.cost ?? 0);
    return { ...base, closedAt: Number(o.closetm ?? 0), cost, fee: Number(o.fee ?? 0), avgPrice: executed > 0 ? cost / executed : (o.price ? Number(o.price) : null) };
  });
}

export interface Fill { tradeId: string; txid: string; altname: string; side: OrderSide; price: number; volume: number; cost: number; fee: number; time: number }

export async function tradesHistory(sinceUnix?: number, cfg?: KrakenConfig): Promise<Fill[]> {
  const raw = await privatePost<{ trades?: Record<string, { ordertxid?: string; pair?: string; type?: string; price?: string; vol?: string; cost?: string; fee?: string; time?: number }> }>("TradesHistory", { start: sinceUnix }, cfg);
  return Object.entries(raw.trades ?? {}).map(([id, t]) => ({
    tradeId: id, txid: t.ordertxid ?? "", altname: t.pair ?? "", side: (t.type ?? "buy") as OrderSide,
    price: Number(t.price ?? 0), volume: Number(t.vol ?? 0), cost: Number(t.cost ?? 0), fee: Number(t.fee ?? 0), time: Number(t.time ?? 0),
  })).sort((a, b) => a.time - b.time);
}

// ---------------------------------------------------------------------------
// Rounding helpers (Kraken rejects volumes/prices with too many decimals)

export function roundDown(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.floor(value * f + 1e-9) / f;
}

export function roundPrice(value: number, pair: PairInfo): number {
  if (pair.tickSize && pair.tickSize > 0) return Math.round(value / pair.tickSize) * pair.tickSize;
  return Number(value.toFixed(pair.pairDecimals));
}

/** Base volume for a USD amount at a price, rounded to the pair's lot size; null if under Kraken's minimums. */
export function volumeForUsd(usd: number, price: number, pair: PairInfo): number | null {
  if (!(usd > 0) || !(price > 0)) return null;
  const vol = roundDown(usd / price, pair.lotDecimals);
  if (vol < pair.orderMin) return null;
  if (pair.costMin > 0 && vol * price < pair.costMin) return null;
  return vol;
}
