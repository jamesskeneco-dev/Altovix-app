import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { memoryDb, all } from "../src/core/db.ts";
import { config } from "../src/core/config.ts";
import { mockClient } from "../src/core/llm/mock.ts";
import type { LlmClient, LlmRequest } from "../src/core/llm/types.ts";
import {
  sign, nextNonce, toKraken, fromKrakenPair, fromKrakenAsset, isCryptoSymbol, parsePairs, parseTickers, parseOhlc, candlesToBars,
  orderParams, volumeForUsd, roundPrice, KrakenApiError, type Candle, type PairInfo, type Ticker, type OrderRequest, type OrderResult, type ClosedOrder,
} from "../src/core/market/kraken.ts";
import { scanOne, scan, atr } from "../src/core/crypto/scan.ts";
import {
  parseRules, evaluateBuy, exitCheck, applyBuy, applySell, markHighWater, dayPnl, EMPTY_STATE, type CryptoRules, type CryptoState,
} from "../src/core/crypto/guard.ts";
import { cryptoAddendum, cryptoOperatorNotes, CRYPTO_BRIEF_VERSION } from "../src/core/crypto/committee.ts";
import { runCycle, buildStatus, type Exchange } from "../src/core/crypto/loop.ts";
import { runCommittee, runTranscript } from "../src/core/committee/run.ts";
import { buildContext } from "../src/core/committee/context.ts";
import { forwardWindow, windowTo, benchmarkWindow } from "../src/core/calibration/resolve.ts";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Kraken client: pure parts

test("API-Sign matches Kraken's published test vector", () => {
  const secret = "kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==";
  const post = "nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25";
  assert.equal(sign("/0/private/AddOrder", "1616492376594", post, secret), "4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==");
});

test("nonces only ever increase, even inside one millisecond", () => {
  const a = nextNonce(1000);
  const b = nextNonce(1000);
  const c = nextNonce(999);
  assert.ok(BigInt(b) > BigInt(a));
  assert.ok(BigInt(c) > BigInt(b));
});

test("symbol translation both ways, including Kraken's X/Z prefixes and yield suffixes", () => {
  assert.equal(toKraken("BTC-USD"), "XBTUSD");
  assert.equal(toKraken("sol"), "SOLUSD");
  assert.equal(toKraken("DOGE/USD"), "XDGUSD");
  assert.equal(fromKrakenPair("XBT/USD"), "BTC-USD");
  assert.equal(fromKrakenPair("SOL/USD"), "SOL-USD");
  assert.equal(fromKrakenAsset("XXBT"), "BTC");
  assert.equal(fromKrakenAsset("ZUSD"), "USD");
  assert.equal(fromKrakenAsset("SOL.F"), "SOL");
  assert.ok(isCryptoSymbol("SOL-USD"));
  assert.ok(!isCryptoSymbol("NVDA"));
  assert.ok(!isCryptoSymbol("BRK.B"));
});

test("AssetPairs, Ticker and OHLC payloads parse into typed rows", () => {
  const pairs = parsePairs({
    XXBTZUSD: { altname: "XBTUSD", wsname: "XBT/USD", base: "XXBT", quote: "ZUSD", status: "online", ordermin: "0.00005", costmin: "0.5", lot_decimals: 8, pair_decimals: 1, tick_size: "0.1" },
    SOLUSD: { altname: "SOLUSD", wsname: "SOL/USD", base: "SOL", quote: "ZUSD", status: "online", ordermin: "0.02", costmin: "0.5", lot_decimals: 8, pair_decimals: 2, tick_size: "0.01" },
  });
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs.map((p) => p.symbol), ["BTC-USD", "SOL-USD"]);
  assert.equal(pairs[0]?.base, "BTC");
  assert.equal(pairs[0]?.id, "XXBTZUSD");
  assert.equal(pairs[0]?.orderMin, 0.00005);

  const ticks = parseTickers({ SOLUSD: { a: ["150.10", "1", "1.000"], b: ["150.00", "2", "2.000"], c: ["150.05", "0.5"], v: ["1000", "24000"], p: ["149", "148.5"], t: [100, 2400], l: ["140", "138"], h: ["155", "156"], o: "145" } });
  assert.equal(ticks[0]?.last, 150.05);
  assert.equal(ticks[0]?.volume24h, 24000);
  assert.equal(ticks[0]?.vwap24h, 148.5);
  assert.equal(ticks[0]?.high24h, 156);

  const candles = parseOhlc({ SOLUSD: [[1758326400, "150", "160", "140", "155", "150", "1234.5", 99], [1758412800, "155", "158", "150", "152", "154", "800", 50]], last: 1758412800 });
  assert.equal(candles.length, 2);
  assert.equal(candles[0]?.close, 155);
  const bars = candlesToBars(candles, true);
  assert.equal(bars.length, 1, "the forming candle is dropped");
  assert.equal(bars[0]?.date, "2025-09-20");
});

test("order params: validate is on unless live, close orders and IOC encode correctly", () => {
  const base: OrderRequest = { altname: "SOLUSD", side: "buy", ordertype: "limit", volume: 0.5, price: 150.25, timeinforce: "IOC", clientId: "abc" };
  const p = orderParams(base);
  assert.equal(p["validate"], true);
  assert.equal(p["pair"], "SOLUSD");
  assert.equal(p["volume"], "0.5");
  assert.equal(p["price"], "150.25");
  assert.equal(p["timeinforce"], "IOC");
  assert.equal(p["cl_ord_id"], "abc");
  const liveP = orderParams({ ...base, live: true, close: { ordertype: "stop-loss", price: 130 } });
  assert.equal(liveP["validate"], undefined);
  assert.equal(liveP["close[ordertype]"], "stop-loss");
  assert.equal(liveP["close[price]"], "130");
  assert.ok(/^[0-9a-f]{18}$/.test(String(orderParams({ ...base, clientId: undefined })["cl_ord_id"])), "generated client id fits Kraken's 18 chars");
});

test("volume for a USD amount respects lot decimals and Kraken minimums", () => {
  const pair: PairInfo = { id: "SOLUSD", symbol: "SOL-USD", altname: "SOLUSD", wsname: "SOL/USD", base: "SOL", quote: "USD", status: "online", orderMin: 0.02, costMin: 0.5, lotDecimals: 8, pairDecimals: 2, tickSize: 0.01 };
  assert.equal(volumeForUsd(50, 150, pair), 0.33333333);
  assert.equal(volumeForUsd(1, 150, pair), null, "under ordermin");
  assert.equal(volumeForUsd(0, 150, pair), null);
  assert.equal(roundPrice(150.256, pair), 150.26);
});

test("KrakenApiError classifies rate limits and insufficient funds", () => {
  assert.ok(new KrakenApiError("/x", 200, ["EAPI:Rate limit exceeded"]).retryable);
  assert.ok(new KrakenApiError("/x", 200, ["EOrder:Insufficient funds"]).insufficientFunds);
  assert.ok(!new KrakenApiError("/x", 200, ["EOrder:Insufficient funds"]).retryable);
});

// ---------------------------------------------------------------------------
// Scanner

function candlesFor(closes: number[], vol = 100_000, start = 1_750_000_000): Candle[] {
  return closes.map((c, i) => ({ time: start + i * 86400, open: c * 0.99, high: c * 1.03, low: c * 0.97, close: c, vwap: c, volume: vol, count: 10 }));
}
const pair = (base: string, quote = "USD", status = "online"): PairInfo => ({ id: `${base}${quote}`, symbol: `${base}-${quote}`, altname: `${base}${quote}`, wsname: `${base}/${quote}`, base, quote, status, orderMin: 0.01, costMin: 0.5, lotDecimals: 8, pairDecimals: 4, tickSize: null });
const tick = (last: number, volume24h: number, extra: Partial<Ticker> = {}): Ticker => ({ altname: "", last, bid: last * 0.999, ask: last * 1.001, volume24h, vwap24h: last, high24h: last * 1.05, low24h: last * 0.95, open: last, trades24h: 1000, ...extra });
const scanRules = { quote: "USD", excludeAssets: ["USDT", "USDC"], blocklist: ["SCAM"], minVolume24hUsd: 1_000_000, minPriceUsd: 0.0005 };

test("ATR is the average true range including gaps", () => {
  const c = candlesFor([100, 100, 100, 100, 100]);
  // Each bar: high 103, low 97 -> range 6; prev close 100 -> TR 6.
  assert.equal(atr(c, 4), 6);
  assert.equal(atr(c, 10), null);
});

test("a breakout on volume from a base outscores a flat coin, and exclusions are explained", () => {
  const flat = Array.from({ length: 60 }, () => 10);
  const flatRow = scanOne({ pair: pair("AAA"), ticker: tick(10, 100_000), candles: candlesFor(flat) }, scanRules);
  assert.equal(flatRow.excluded, null);
  // Same base, then a surge: last five days climb 10 -> 14 on 4x volume, and today's ticker is above the 20d high.
  const surge = [...flat.slice(0, 55), 10.5, 11.2, 12, 13, 14];
  const surgeRow = scanOne({ pair: pair("BBB"), ticker: tick(14.5, 400_000), candles: candlesFor(surge).map((c, i) => (i >= 55 ? { ...c, volume: 400_000 } : c)) }, scanRules);
  assert.equal(surgeRow.excluded, null);
  assert.ok(surgeRow.score > flatRow.score + 20, `surge ${surgeRow.score} vs flat ${flatRow.score}`);
  assert.equal(surgeRow.setup, "BREAKOUT");
  assert.ok(surgeRow.reasons.some((r) => r.includes("fresh breakout")));
  assert.ok((surgeRow.vsHigh20 ?? 0) > 0);

  assert.equal(scanOne({ pair: pair("USDT"), ticker: tick(1, 50_000_000), candles: candlesFor(flat) }, scanRules).excluded, "excluded asset");
  assert.equal(scanOne({ pair: pair("SCAM"), ticker: tick(1, 50_000_000), candles: candlesFor(flat) }, scanRules).excluded, "blocklist");
  assert.equal(scanOne({ pair: pair("AAA", "EUR"), ticker: tick(1, 50_000_000), candles: candlesFor(flat) }, scanRules).excluded, "quote EUR");
  assert.equal(scanOne({ pair: pair("ETH3L"), ticker: tick(1, 50_000_000), candles: candlesFor(flat) }, scanRules).excluded, "leveraged token");
  assert.match(scanOne({ pair: pair("TINY"), ticker: tick(1, 10), candles: candlesFor(flat) }, scanRules).excluded ?? "", /under floor/);
  assert.match(scanOne({ pair: pair("NEW"), ticker: tick(1, 5_000_000), candles: candlesFor(flat.slice(0, 10)) }, scanRules).excluded ?? "", /daily bars/);
});

test("a coin that already went vertical is penalised, not chased", () => {
  const base = Array.from({ length: 60 }, () => 1);
  const vertical = base.map((v, i) => (i >= 50 ? v * (1 + (i - 49) * 0.3) : v)); // +30%/day for ten days
  const row = scanOne({ pair: pair("MOON"), ticker: tick((vertical.at(-1) as number) * 1.4, 2_000_000), candles: candlesFor(vertical, 1_000_000).map((c, i) => (i >= 50 ? { ...c, volume: 8_000_000 } : c)) }, scanRules);
  assert.ok(row.reasons.some((r) => /parabolic|chasing|\+80%/.test(r)), row.reasons.join("; "));
  assert.ok(row.score < 60, `score ${row.score} should be capped by the penalties`);
});

test("scan sorts scored rows first, by score then liquidity", () => {
  const flat = Array.from({ length: 60 }, () => 10);
  const rows = scan([
    { pair: pair("USDT"), ticker: tick(1, 50_000_000), candles: candlesFor(flat) },
    { pair: pair("AAA"), ticker: tick(10, 200_000), candles: candlesFor(flat, 200_000) },
    { pair: pair("BBB"), ticker: tick(10, 900_000), candles: candlesFor(flat, 900_000) },
  ], scanRules);
  assert.equal(rows.at(-1)?.symbol, "USDT-USD");
  assert.equal(rows[0]?.symbol, "BBB-USD", "same score -> more liquid first");
});

// ---------------------------------------------------------------------------
// Guard

const RULES_JSON = readFileSync(new URL("../rules/crypto.json", import.meta.url), "utf8");
const R: CryptoRules = parseRules(RULES_JSON);
const buy = (over: Partial<Parameters<typeof evaluateBuy>[0]> = {}) => ({ symbol: "SOL-USD", usd: 80, confidence: 0.7, price: 150, volume24hUsd: 50_000_000, ...over });
const NOW = new Date("2026-09-21T15:00:00Z");
const opts = { now: NOW, killSwitch: false };

test("rules/crypto.json parses, ships with live=false, and rejects nonsense", () => {
  assert.equal(R.live, false, "the shipped rules must not trade");
  assert.ok(R.maxOrderUsd <= R.sleeveUsd);
  assert.throws(() => parseRules(JSON.stringify({ ...R, maxOrderUsd: 10_000 })), /maxOrderUsd/);
  assert.throws(() => parseRules(JSON.stringify({ ...R, minConfidence: 0.2 })), /minConfidence/);
  assert.throws(() => parseRules(JSON.stringify({ ...R, stopPct: 12 })), /fractions/);
  assert.throws(() => parseRules(JSON.stringify({ ...R, live: "yes" })), /live/);
});

test("guard: a clean buy passes; every cap refuses or cuts, with a reason", () => {
  const s: CryptoState = structuredClone(EMPTY_STATE);
  assert.deepEqual(evaluateBuy(buy(), R, s, opts), { ok: true, reasons: [], usd: 80 });

  assert.match(evaluateBuy(buy(), R, s, { ...opts, killSwitch: true }).reasons.join(), /kill switch/);
  assert.match(evaluateBuy(buy({ confidence: 0.5 }), R, s, opts).reasons.join(), /minConfidence/);
  assert.match(evaluateBuy(buy({ volume24hUsd: 1000 }), R, s, opts).reasons.join(), /24h volume/);
  assert.match(evaluateBuy(buy({ symbol: "USDT-USD" }), R, s, opts).reasons.join(), /excluded asset/);
  assert.match(evaluateBuy(buy(), { ...R, blocklist: ["SOL"] }, s, opts).reasons.join(), /blocklist/);
  assert.match(evaluateBuy(buy(), { ...R, watchOnly: ["SOL-USD"] }, s, opts).reasons.join(), /watch-only/);

  const cut = evaluateBuy(buy({ usd: 500 }), R, s, opts);
  assert.equal(cut.ok, true);
  assert.equal(cut.usd, R.maxOrderUsd);
  assert.match(cut.reasons.join(), /maxOrderUsd/);

  const halted = { ...s, halted: { at: NOW.toISOString(), reason: "test" } };
  assert.match(evaluateBuy(buy(), R, halted, opts).reasons.join(), /halted/);

  const busy = { ...s, days: { "2026-09-21": { buys: R.maxDailyBuys, sells: 0, realized: 0, fees: 0 } } };
  assert.match(evaluateBuy(buy(), R, busy, opts).reasons.join(), /maxDailyBuys/);

  const bleeding = { ...s, days: { "2026-09-21": { buys: 0, sells: 2, realized: -R.maxDailyLossUsd, fees: 0 } } };
  assert.match(evaluateBuy(buy(), R, bleeding, opts).reasons.join(), /maxDailyLossUsd/);

  const cooling = { ...s, lastTradeAt: { "SOL-USD": new Date(NOW.getTime() - 3_600_000).toISOString() } };
  assert.match(evaluateBuy(buy(), R, cooling, opts).reasons.join(), /cooldown/);
  const cooled = { ...s, lastTradeAt: { "SOL-USD": new Date(NOW.getTime() - (R.cooldownHours + 1) * 3_600_000).toISOString() } };
  assert.equal(evaluateBuy(buy(), R, cooled, opts).ok, true);
});

test("guard: position count, per-position and sleeve caps are enforced on the running total", () => {
  let s: CryptoState = structuredClone(EMPTY_STATE);
  const rec = (symbol: string, usd: number, at = NOW.toISOString()) => ({ at, symbol, side: "BUY" as const, volume: usd / 10, price: 10, usd, fee: 0, reason: "t", txids: [], clientId: "c", live: false });
  const R10 = { ...R, maxDailyBuys: 10 };
  for (const sym of ["A-USD", "B-USD", "C-USD", "D-USD"]) s = applyBuy(s, rec(sym, 90), R10, sym.replace("-", ""), null, "t");
  assert.equal(s.positions.length, 4);
  assert.match(evaluateBuy(buy({ symbol: "E-USD" }), R10, s, opts).reasons.join(), /maxPositions/);
  // Adding to an existing one is allowed but capped by maxPositionUsd and by what is left in the sleeve ($400 - $360).
  const add = evaluateBuy(buy({ symbol: "A-USD" }), { ...R10, cooldownHours: 0 }, s, opts);
  assert.equal(add.ok, true);
  assert.equal(add.usd, R.maxPositionUsd - 90 < R.sleeveUsd - 360 ? R.maxPositionUsd - 90 : R.sleeveUsd - 360);
  assert.ok(add.reasons.length >= 1);
  // Fill the sleeve entirely and the next one has no room.
  s = applyBuy(s, rec("A-USD", 40), R10, "AUSD", null, "t");
  assert.match(evaluateBuy(buy({ symbol: "B-USD" }), { ...R10, cooldownHours: 0 }, s, opts).reasons.join(), /no room/);
});

test("exits: stop, trailing stop off the high-water mark, take-profit, max hold", () => {
  const pos = { symbol: "SOL-USD", altname: "SOLUSD", volume: 1, avgCost: 100, costUsd: 100, openedAt: "2026-09-01T00:00:00Z", highWater: 100, stop: 88, takeProfit: 140, committeeRunId: null, entryTxids: [], entryClientId: "c", thesis: "t" };
  assert.equal(exitCheck(pos, 95, R, NOW)?.reason, undefined);
  assert.equal(exitCheck(pos, 88, R, NOW)?.reason, "STOP");
  assert.equal(exitCheck(pos, 140, R, NOW)?.reason, "TAKE_PROFIT");
  // Ran to 130 then fell 15%: the trail (110.5) is above the stop and is what fires.
  const ran = markHighWater({ ...structuredClone(EMPTY_STATE), positions: [pos] }, { "SOL-USD": 130 }).positions[0]!;
  assert.equal(ran.highWater, 130);
  const trail = exitCheck(ran, 110, R, NOW);
  assert.equal(trail?.reason, "TRAIL");
  assert.ok(Math.abs((trail?.level ?? 0) - 110.5) < 1e-9);
  assert.equal(exitCheck(ran, 112, R, NOW), null, "above the trail, below take-profit: hold");
  // High-water never ratchets down.
  assert.equal(markHighWater({ ...structuredClone(EMPTY_STATE), positions: [ran] }, { "SOL-USD": 90 }).positions[0]?.highWater, 130);
  assert.equal(exitCheck(pos, 95, R, new Date("2026-10-01T00:00:00Z"))?.reason, "MAX_HOLD");
});

test("buys and sells update positions, day figures and realised P&L; day P&L includes unrealised", () => {
  let s: CryptoState = structuredClone(EMPTY_STATE);
  s = applyBuy(s, { at: "2026-09-21T10:00:00Z", symbol: "SOL-USD", side: "BUY", volume: 0.5, price: 150, usd: 75, fee: 0.3, reason: "t", txids: ["T1"], clientId: "c1", live: true }, R, "SOLUSD", 7, "thesis");
  const p = s.positions[0]!;
  assert.equal(p.volume, 0.5);
  assert.ok(Math.abs(p.costUsd - 75.3) < 1e-9);
  assert.ok(Math.abs(p.avgCost - 150.6) < 1e-9);
  assert.ok(Math.abs(p.stop - 150.6 * (1 - R.stopPct)) < 1e-9);
  assert.equal(p.committeeRunId, 7);
  assert.equal(s.days["2026-09-21"]?.buys, 1);
  assert.equal(dayPnl(s, "2026-09-21", { "SOL-USD": 160 }).unrealized.toFixed(2), ((160 - 150.6) * 0.5).toFixed(2));

  s = applySell(s, { at: "2026-09-21T18:00:00Z", symbol: "SOL-USD", side: "SELL", volume: 0.5, price: 170, usd: 85, fee: 0.34, reason: "TAKE_PROFIT", txids: ["T2"], clientId: "c2", live: true });
  assert.equal(s.positions.length, 0);
  assert.ok(Math.abs((s.days["2026-09-21"]?.realized ?? 0) - (85 - 0.34 - 75.3)) < 1e-9);
  assert.equal(s.trades.length, 2);
  assert.ok(Math.abs((s.trades[1]?.realized ?? 0) - (85 - 0.34 - 75.3)) < 1e-9);
});

// ---------------------------------------------------------------------------
// Committee on a crypto pair

function seedDaily(db: DatabaseSync, symbol: string, n: number, base: number, drift: number, weekdaysOnly: boolean) {
  const d = new Date("2025-06-02T00:00:00Z");
  let i = 0;
  while (i < n) {
    const dow = d.getUTCDay();
    if (!weekdaysOnly || (dow !== 0 && dow !== 6)) {
      const wiggle = 1 + 0.01 * Math.sin(i / 7);
      db.prepare(`INSERT OR REPLACE INTO prices (symbol,date,open,high,low,close,volume,source) VALUES (?,?,?,?,?,?,?,'test')`)
        .run(symbol, d.toISOString().slice(0, 10), base, base * 1.02, base * 0.98, base * (1 + drift * i) * wiggle, 1_000_000 + i * 1000);
      i++;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
}
function seedCryptoUniverse(db: DatabaseSync) {
  for (const s of [...config.benchmarks, ...config.macroTickers]) seedDaily(db, s, 300, 100, 0.001, true);
  seedDaily(db, "BTC-USD", 420, 60_000, 0.001, false);
  seedDaily(db, "ETH-USD", 420, 3_000, 0.0008, false);
  seedDaily(db, "SOL-USD", 420, 100, 0.003, false);
}
function recordingClient(sink: LlmRequest[]): LlmClient {
  const inner = mockClient();
  return { mode: "real", complete: (r) => { sink.push(r); return inner.complete(r); } };
}

test("a crypto run is classed CRYPTO, measured against BTC/ETH, and every role gets the crypto brief", async () => {
  const db = memoryDb();
  seedCryptoUniverse(db);
  const ctx = buildContext(db, "SOL-USD");
  assert.equal(ctx.assetClass, "CRYPTO");
  assert.deepEqual(ctx.benchmarks, ["BTC-USD", "ETH-USD"]);
  assert.deepEqual(ctx.candidateVs.map((r) => r.vsSymbol), ["BTC-USD", "ETH-USD"]);
  assert.deepEqual(ctx.sectors.map((s) => s.symbol), ["BTC-USD", "ETH-USD"], "the sector table is the majors");
  assert.equal(buildContext(db, "SPY").assetClass, "EQUITY");

  const sink: LlmRequest[] = [];
  const res = await runCommittee(db, "SOL-USD", { llm: recordingClient(sink), operatorNotes: "SCANNER READ: test" });
  assert.equal(res.status, "COMPLETE");
  assert.equal(sink.length, 8);
  for (const r of sink) {
    assert.ok(r.system.includes(`CRYPTO BRIEF v${CRYPTO_BRIEF_VERSION}`), "system prompt carries the brief");
    assert.ok(r.user.includes("CRYPTO spot pair"), "user prompt flags the asset class");
    assert.ok(r.user.includes("SCANNER READ"), "operator notes are in the prompt");
  }
  assert.ok(sink[1]?.user.includes("CRYPTO MAJORS vs SPY"), "sector agent sees the majors table");
  assert.ok(sink[4]?.system.includes("DECLINE_ON_RISK"), "risk brief is role-specific");
  // What was persisted is the prompt as sent.
  const transcript = runTranscript(db, res.runId);
  assert.ok(transcript.every((t) => t.system_prompt.includes("CRYPTO BRIEF")));
  assert.ok(res.claimIds.length > 0, "claims recorded like any run");
  assert.equal(cryptoAddendum("journal").includes("FOR THE JOURNAL ROLE"), true);
});

test("claim resolution compares a 7-day-a-week subject with SPY over the same calendar span", () => {
  const db = memoryDb();
  seedCryptoUniverse(db);
  const win = forwardWindow(db, "SOL-USD", "2025-09-01", 21);
  assert.ok(win);
  const barFor = forwardWindow(db, "SPY", "2025-09-01", 21)!;
  const cal = windowTo(db, "SPY", "2025-09-01", win!.endDate)!;
  assert.ok(cal.endDate <= win!.endDate);
  assert.ok(cal.bars < barFor.bars, `calendar-matched SPY window (${cal.bars} bars) is shorter than 21 SPY bars`);
  assert.equal(benchmarkWindow(db, "SOL-USD", win!, "2025-09-01", 21)?.endDate, cal.endDate);
  assert.equal(benchmarkWindow(db, "NVDA", win!, "2025-09-01", 21)?.bars, 21, "equities keep the bar-for-bar window");
});

// ---------------------------------------------------------------------------
// The cycle, end to end against a fake exchange

class FakeExchange implements Exchange {
  orders: OrderRequest[] = [];
  fills: Record<string, Partial<ClosedOrder>> = {};
  pairList: PairInfo[];
  ticks: Ticker[];
  candles: Record<string, Candle[]>;
  constructor(pairList: PairInfo[], ticks: Ticker[], candles: Record<string, Candle[]>) { this.pairList = pairList; this.ticks = ticks; this.candles = candles; }
  async pairs() { return this.pairList; }
  async tickers() { return this.ticks; }
  async ohlc(alt: string) { const c = this.candles[alt]; if (!c) throw new Error(`no candles for ${alt}`); return c; }
  async addOrder(req: OrderRequest): Promise<OrderResult> {
    this.orders.push(req);
    const id = `TX${this.orders.length}`;
    return { validated: true, placed: Boolean(req.live), description: `${req.side} ${req.volume} ${req.altname} @ ${req.ordertype}`, closeDescription: null, txids: req.live ? [id] : [], clientId: req.clientId ?? "cid" };
  }
  async queryOrders(txids: string[]): Promise<ClosedOrder[]> {
    return txids.map((txid) => {
      const req = this.orders[Number(txid.slice(2)) - 1]!;
      const t = this.ticks.find((x) => x.altname === req.altname)!;
      const px = req.side === "buy" ? t.ask : t.bid;
      return { txid, altname: req.altname, side: req.side, ordertype: req.ordertype, volume: req.volume, executed: req.volume, price: req.price ?? null, status: "closed", description: "", openedAt: 0, clientId: null, closedAt: 1, cost: req.volume * px, fee: req.volume * px * 0.004, avgPrice: px, ...this.fills[txid] };
    });
  }
}

function fakeMarket() {
  const flat = Array.from({ length: 80 }, () => 10);
  const surge = [...flat.slice(0, 75), 10.5, 11.2, 12, 13, 14];
  const pairs = [pair("BTC"), pair("ETH"), pair("SOL"), pair("AAA"), pair("USDT")];
  const ticks: Ticker[] = [
    { ...tick(60_000, 500), altname: "BTCUSD" }, { ...tick(3_000, 5_000), altname: "ETHUSD" },
    { ...tick(14.5, 400_000), altname: "SOLUSD" }, { ...tick(10, 150_000), altname: "AAAUSD" }, { ...tick(1, 90_000_000), altname: "USDTUSD" },
  ];
  const candles = {
    BTCUSD: candlesFor(Array.from({ length: 80 }, (_, i) => 55_000 + i * 60), 500),
    ETHUSD: candlesFor(Array.from({ length: 80 }, (_, i) => 2_800 + i * 2), 5000),
    SOLUSD: candlesFor(surge).map((c, i) => (i >= 75 ? { ...c, volume: 400_000 } : c)),
    AAAUSD: candlesFor(flat, 150_000),
    USDTUSD: candlesFor(Array.from({ length: 80 }, () => 1), 1e8),
  };
  return { pairs, ticks, candles };
}

/** A decision agent that always says BUY at the given confidence, everything else from the mock. */
function buyingClient(confidence: number, sizePct = 20): LlmClient {
  const inner = mockClient();
  return {
    mode: "real",
    async complete(r) {
      const res = await inner.complete(r);
      if (r.toolName === "submit_decision") {
        const j = res.json as Record<string, unknown>;
        return { ...res, json: { ...j, action: "BUY", confidence, sizePct, rationale: "test buy rationale that is long enough to satisfy the schema minimum length for the field." } };
      }
      return res;
    },
  };
}

test("cycle in VALIDATE mode: the scanner finds the surge, the committee buys, the guard sizes it, nothing is sent", async () => {
  const db = memoryDb();
  seedCryptoUniverse(db);
  const m = fakeMarket();
  const ex = new FakeExchange(m.pairs, m.ticks, m.candles);
  const rules = { ...R, live: false, minVolume24hUsd: 1_000_000 };
  const r = await runCycle({ conn: db, exchange: ex, rules, state: structuredClone(EMPTY_STATE), llm: buyingClient(0.7, 30), now: NOW, minScanScore: 30 });
  assert.equal(r.live, false);
  assert.ok(r.candidates[0]?.symbol === "SOL-USD", `top candidate ${r.candidates[0]?.symbol}`);
  assert.equal(r.committeeRuns.length, 1, "only the surge scored high enough");
  assert.equal(r.committeeRuns[0]?.symbol, "SOL-USD");
  assert.equal(ex.orders.length, 1);
  assert.equal(ex.orders[0]?.live, false, "validate only");
  assert.equal(ex.orders[0]?.timeinforce, "IOC");
  assert.ok((ex.orders[0]?.price ?? 0) > 14.5 && (ex.orders[0]?.price ?? 0) < 14.6, "limit sits just above the ask");
  const ev = r.events.find((e) => e.kind === "VALIDATED");
  assert.ok(ev, r.events.map((e) => e.message).join("\n"));
  assert.equal(r.state.positions.length, 1, "paper fill recorded in the validate state");
  assert.ok(r.state.positions[0]!.costUsd <= rules.maxOrderUsd + 1e-6, `sized under the order cap: ${r.state.positions[0]!.costUsd}`);
  assert.ok(ev!.message.includes("would buy"));
  assert.ok(all(db, `SELECT * FROM prices WHERE symbol = 'SOL-USD' AND source = 'kraken'`).length > 0, "candles ingested for the committee");
  const status = buildStatus(r, rules);
  assert.equal(status.mode, "VALIDATE");
  assert.equal(status.positions.length, 1);
  assert.ok(status.positions[0]!.trail < status.positions[0]!.avgCost);
});

test("cycle: low confidence is refused by the guard and no order is created at all", async () => {
  const db = memoryDb();
  seedCryptoUniverse(db);
  const m = fakeMarket();
  const ex = new FakeExchange(m.pairs, m.ticks, m.candles);
  const r = await runCycle({ conn: db, exchange: ex, rules: { ...R, minVolume24hUsd: 1_000_000 }, state: structuredClone(EMPTY_STATE), llm: buyingClient(0.5), now: NOW, minScanScore: 30 });
  assert.equal(r.committeeRuns.length, 1);
  assert.equal(ex.orders.length, 0);
  assert.ok(r.events.some((e) => e.kind === "REFUSED" && /minConfidence/.test(e.message)));
});

test("cycle in LIVE mode: fills come from the exchange, fees are booked, alerts-worthy events are emitted", async () => {
  const db = memoryDb();
  seedCryptoUniverse(db);
  const m = fakeMarket();
  const ex = new FakeExchange(m.pairs, m.ticks, m.candles);
  const rules = { ...R, live: true, minVolume24hUsd: 1_000_000 };
  const r = await runCycle({ conn: db, exchange: ex, rules, state: structuredClone(EMPTY_STATE), llm: buyingClient(0.8, 25), now: NOW, minScanScore: 30, sleep: async () => {} });
  assert.equal(ex.orders[0]?.live, true);
  const entry = r.events.find((e) => e.kind === "ENTRY");
  assert.ok(entry);
  const p = r.state.positions[0]!;
  assert.deepEqual(p.entryTxids, ["TX1"]);
  assert.ok(p.avgCost > 14.5, "average cost carries the fee");
  assert.equal(r.state.trades[0]?.live, true);
  assert.ok((r.state.trades[0]?.fee ?? 0) > 0);
});

test("cycle: a stop hit sells at market even with the kill switch on, and a losing day halts new buys", async () => {
  const db = memoryDb();
  seedCryptoUniverse(db);
  const m = fakeMarket();
  const ex = new FakeExchange(m.pairs, m.ticks, m.candles);
  const rules = { ...R, live: true, minVolume24hUsd: 1_000_000, maxDailyLossUsd: 5, killSwitchFile: join(mkdtempSync(join(tmpdir(), "altovix-")), "KILL") };
  writeFileSync(rules.killSwitchFile, "on");
  let state: CryptoState = structuredClone(EMPTY_STATE);
  // Holding AAA from $20; the tape now says $10 - far through the 12% stop.
  state = applyBuy(state, { at: "2026-09-20T10:00:00Z", symbol: "AAA-USD", side: "BUY", volume: 5, price: 20, usd: 100, fee: 0.4, reason: "t", txids: ["OLD"], clientId: "c", live: true }, rules, "AAAUSD", null, "t");
  const r = await runCycle({ conn: db, exchange: ex, rules, state, llm: buyingClient(0.9, 25), now: NOW, minScanScore: 30, sleep: async () => {} });
  const exit = r.events.find((e) => e.kind === "EXIT");
  assert.ok(exit, r.events.map((e) => e.message).join("\n"));
  assert.match(exit!.message, /STOP AAA-USD/);
  assert.equal(ex.orders[0]?.side, "sell");
  assert.equal(ex.orders[0]?.ordertype, "market");
  assert.equal(r.state.positions.length, 0);
  assert.ok(r.dayPnl.realized < -40, `realised ${r.dayPnl.realized}`);
  assert.ok(r.events.some((e) => e.kind === "HALT"), "the loss halts the sleeve");
  assert.ok(r.state.halted);
  assert.equal(r.committeeRuns.length, 0, "no committee while killed/halted");
  assert.equal(ex.orders.length, 1, "no buys");
  rmSync(rules.killSwitchFile, { force: true });
  assert.ok(!existsSync(rules.killSwitchFile));
});

test("operator notes for a crypto run carry the scanner read and the sleeve's caps", () => {
  const flat = Array.from({ length: 60 }, () => 10);
  const row = scanOne({ pair: pair("SOL"), ticker: tick(10, 5_000_000), candles: candlesFor(flat) }, scanRules);
  const notes = cryptoOperatorNotes(row, R, structuredClone(EMPTY_STATE));
  assert.ok(notes.includes("SCANNER READ for SOL-USD"));
  assert.ok(notes.includes(`max order $${R.maxOrderUsd}`));
  assert.ok(notes.includes("live trading OFF"));
  assert.ok(notes.includes("MECHANICAL EXITS"));
});
