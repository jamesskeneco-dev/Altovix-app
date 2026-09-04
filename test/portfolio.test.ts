import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { memoryDb, all, one } from "../src/core/db.ts";
import {
  recordTrade, positions, cashBalance, deposit, openLotsFor, termFor, daysBetween, addDays,
} from "../src/core/portfolio/lots.ts";
import { flagWashSales, harvestCandidates, realizedSummary } from "../src/core/portfolio/tax.ts";

const near = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b}`);

function price(conn: DatabaseSync, symbol: string, date: string, close: number) {
  conn.prepare(`INSERT OR REPLACE INTO prices (symbol,date,close,source) VALUES (?,?,?,'test')`)
    .run(symbol, date, close);
}

test("date helpers", () => {
  assert.equal(addDays("2026-01-31", 1), "2026-02-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(daysBetween("2026-01-01", "2026-01-31"), 30);
  assert.equal(termFor(365), "SHORT");
  assert.equal(termFor(366), "LONG");
});

test("buy creates a lot with fees folded into basis and debits cash", () => {
  const db = memoryDb();
  deposit(db, "2026-01-01", 10_000, "initial funding");
  const r = recordTrade(db, { date: "2026-01-02", symbol: "nvda", side: "BUY", shares: 10, price: 100, fees: 5 });
  const lot = one<{ cost_per_share: number; shares_remaining: number; symbol: string }>(
    db, `SELECT * FROM lots WHERE id = ?`, r.lotId);
  near(lot!.cost_per_share, 100.5);
  assert.equal(lot!.symbol, "NVDA");
  near(cashBalance(db), 10_000 - 1005);
});

test("sell closes lots FIFO with correct realized P&L and term", () => {
  const db = memoryDb();
  deposit(db, "2026-01-01", 50_000);
  recordTrade(db, { date: "2026-01-02", symbol: "AAPL", side: "BUY", shares: 10, price: 100, fees: 5 });
  recordTrade(db, { date: "2026-06-02", symbol: "AAPL", side: "BUY", shares: 10, price: 150 });
  const sell = recordTrade(db, { date: "2026-07-02", symbol: "AAPL", side: "SELL", shares: 15, price: 200, fees: 15 });

  assert.equal(sell.closures.length, 2);
  // proceeds/share = 200 - 15/15 = 199
  near(sell.closures[0]!.realizedPnl, (199 - 100.5) * 10);
  near(sell.closures[1]!.realizedPnl, (199 - 150) * 5);
  assert.equal(sell.closures[0]!.term, "SHORT");
  near(cashBalance(db), 50_000 - 1005 - 1500 + (15 * 200 - 15));

  const remaining = openLotsFor(db, "AAPL", "FIFO");
  assert.equal(remaining.length, 1);
  near(remaining[0]!.shares_remaining, 5);
});

test("HIFO consumes the most expensive lot first", () => {
  const db = memoryDb();
  deposit(db, "2026-01-01", 50_000);
  recordTrade(db, { date: "2026-01-02", symbol: "MSFT", side: "BUY", shares: 10, price: 100 });
  recordTrade(db, { date: "2026-02-02", symbol: "MSFT", side: "BUY", shares: 10, price: 300 });
  const sell = recordTrade(db, { date: "2026-03-02", symbol: "MSFT", side: "SELL", shares: 10, price: 200, method: "HIFO" });
  near(sell.closures[0]!.realizedPnl, (200 - 300) * 10); // took the loss lot
  const left = openLotsFor(db, "MSFT", "FIFO");
  near(left[0]!.cost_per_share, 100);
});

test("long-term term flag after more than a year", () => {
  const db = memoryDb();
  deposit(db, "2025-01-01", 50_000);
  recordTrade(db, { date: "2025-01-02", symbol: "GOOG", side: "BUY", shares: 5, price: 100 });
  const sell = recordTrade(db, { date: "2026-01-05", symbol: "GOOG", side: "SELL", shares: 5, price: 150 });
  assert.equal(sell.closures[0]!.term, "LONG");
  assert.equal(sell.closures[0]!.holdingDays, 368);
});

test("selling more than is held is rejected", () => {
  const db = memoryDb();
  deposit(db, "2026-01-01", 10_000);
  recordTrade(db, { date: "2026-01-02", symbol: "TSLA", side: "BUY", shares: 2, price: 100 });
  assert.throws(
    () => recordTrade(db, { date: "2026-01-03", symbol: "TSLA", side: "SELL", shares: 5, price: 110 }),
    /only 2 open/,
  );
});

test("wash sale disallows the loss and moves it into the replacement basis", () => {
  const db = memoryDb();
  deposit(db, "2026-01-01", 50_000);
  recordTrade(db, { date: "2026-01-05", symbol: "AMD", side: "BUY", shares: 10, price: 100 });
  recordTrade(db, { date: "2026-02-05", symbol: "AMD", side: "SELL", shares: 10, price: 90 });   // -100 loss
  recordTrade(db, { date: "2026-02-14", symbol: "AMD", side: "BUY", shares: 10, price: 92 });    // 9 days later

  const res = flagWashSales(db, "AMD");
  assert.equal(res.flagged, 1);
  near(res.disallowed, 100);

  const closure = one<{ wash_sale: number; disallowed_loss: number }>(
    db, `SELECT wash_sale, disallowed_loss FROM lot_closures LIMIT 1`);
  assert.equal(closure!.wash_sale, 1);
  near(closure!.disallowed_loss, 100);

  const replacement = one<{ basis_adjustment: number }>(
    db, `SELECT basis_adjustment FROM lots WHERE open_date = '2026-02-14'`);
  near(replacement!.basis_adjustment, 100);
});

test("a repurchase outside the 30-day window is not a wash sale", () => {
  const db = memoryDb();
  deposit(db, "2026-01-01", 50_000);
  recordTrade(db, { date: "2026-01-05", symbol: "INTC", side: "BUY", shares: 10, price: 100 });
  recordTrade(db, { date: "2026-02-05", symbol: "INTC", side: "SELL", shares: 10, price: 90 });
  recordTrade(db, { date: "2026-03-20", symbol: "INTC", side: "BUY", shares: 10, price: 92 }); // 43 days later
  const res = flagWashSales(db, "INTC");
  assert.equal(res.flagged, 0);
});

test("one replacement purchase cannot absorb two separate losses", () => {
  const db = memoryDb();
  deposit(db, "2026-01-01", 100_000);
  recordTrade(db, { date: "2026-01-05", symbol: "NIO", side: "BUY", shares: 10, price: 100 });
  recordTrade(db, { date: "2026-01-06", symbol: "NIO", side: "BUY", shares: 10, price: 100 });
  recordTrade(db, { date: "2026-02-05", symbol: "NIO", side: "SELL", shares: 20, price: 90 });
  recordTrade(db, { date: "2026-02-10", symbol: "NIO", side: "BUY", shares: 10, price: 88 });
  const res = flagWashSales(db, "NIO");
  // 20 shares sold at a loss, only 10 replacement shares -> half the loss disallowed
  const totalLoss = 200;
  near(res.disallowed, totalLoss / 2, 1e-6);
});

test("harvest scanner ranks losses and flags wash risk", () => {
  const db = memoryDb();
  deposit(db, "2026-01-01", 100_000);
  recordTrade(db, { date: "2026-01-05", symbol: "PLTR", side: "BUY", shares: 100, price: 50 });
  recordTrade(db, { date: "2026-01-05", symbol: "SNOW", side: "BUY", shares: 10, price: 200 });
  recordTrade(db, { date: "2026-06-01", symbol: "PLTR", side: "BUY", shares: 10, price: 40 }); // recent buy
  price(db, "PLTR", "2026-06-15", 40);
  price(db, "SNOW", "2026-06-15", 150);

  const cands = harvestCandidates(db, "2026-06-15");
  const pltr = cands.find((c) => c.symbol === "PLTR" && c.openDate === "2026-01-05");
  const snow = cands.find((c) => c.symbol === "SNOW");
  assert.ok(pltr && snow);
  near(pltr!.unrealizedPnl, (40 - 50) * 100);
  assert.equal(pltr!.washRisk, true);
  assert.equal(snow!.washRisk, false);
  assert.equal(snow!.term, "SHORT");
  near(snow!.estTaxBenefit, 500 * 0.32);
  // ranked by tax benefit
  assert.equal(cands[0]!.symbol, "PLTR");
});

test("realized summary adds disallowed losses back", () => {
  const db = memoryDb();
  deposit(db, "2026-01-01", 50_000);
  recordTrade(db, { date: "2026-01-05", symbol: "AMD", side: "BUY", shares: 10, price: 100 });
  recordTrade(db, { date: "2026-02-05", symbol: "AMD", side: "SELL", shares: 10, price: 90 });
  recordTrade(db, { date: "2026-02-14", symbol: "AMD", side: "BUY", shares: 10, price: 92 });
  flagWashSales(db, "AMD");
  const s = realizedSummary(db, 2026);
  near(s.shortTermGain, 0);   // -100 loss + 100 disallowed
  near(s.disallowed, 100);
  near(s.estTaxOwed, 0);
});

test("positions aggregate lots, price them and weight them against total equity", () => {
  const db = memoryDb();
  deposit(db, "2026-01-01", 10_000);
  recordTrade(db, { date: "2026-01-02", symbol: "SPY", side: "BUY", shares: 10, price: 500 });
  price(db, "SPY", "2026-01-03", 550);
  const p = positions(db, "2026-01-03");
  assert.equal(p.length, 1);
  near(p[0]!.marketValue!, 5500);
  near(p[0]!.unrealizedPnl!, 500);
  near(p[0]!.unrealizedPct!, 0.1);
  // total equity = 5500 positions + 5000 cash
  near(p[0]!.weight!, 5500 / 10_500);
});

test("a buy that would overdraw cash is refused unless margin is explicit", () => {
  const db = memoryDb();
  deposit(db, "2026-01-01", 1_000);
  assert.throws(
    () => recordTrade(db, { date: "2026-01-02", symbol: "SPY", side: "BUY", shares: 10, price: 500 }),
    /insufficient cash/,
  );
  near(cashBalance(db), 1_000);
  recordTrade(db, { date: "2026-01-02", symbol: "SPY", side: "BUY", shares: 10, price: 500, allowMargin: true });
  near(cashBalance(db), -4_000);
});

test("fees count against available cash", () => {
  const db = memoryDb();
  deposit(db, "2026-01-01", 1_000);
  assert.throws(
    () => recordTrade(db, { date: "2026-01-02", symbol: "SPY", side: "BUY", shares: 2, price: 500, fees: 1 }),
    /insufficient cash/,
  );
  recordTrade(db, { date: "2026-01-02", symbol: "SPY", side: "BUY", shares: 2, price: 499, fees: 1 });
  near(cashBalance(db), 1);
});

test("historical positions are reconstructed as of the date, not from today's balances", () => {
  const db = memoryDb();
  deposit(db, "2026-01-01", 50_000);
  recordTrade(db, { date: "2026-01-05", symbol: "AMD", side: "BUY", shares: 100, price: 100 });
  price(db, "AMD", "2026-01-10", 110);
  price(db, "AMD", "2026-02-10", 120);

  // Before the sale, the position exists.
  assert.equal(positions(db, "2026-01-10").length, 1);
  near(positions(db, "2026-01-10")[0]!.shares, 100);

  recordTrade(db, { date: "2026-02-01", symbol: "AMD", side: "SELL", shares: 100, price: 120 });

  // After the sale it is gone from today - but it must still be there on 10 Jan.
  assert.equal(positions(db, "2026-02-10").length, 0);
  assert.equal(positions(db, "2026-01-10").length, 1, "a past snapshot must not forget a since-sold position");
  near(positions(db, "2026-01-10")[0]!.marketValue!, 11_000);
});

test("total portfolio value stays continuous across a sale", () => {
  const db = memoryDb();
  deposit(db, "2026-01-01", 50_000);
  recordTrade(db, { date: "2026-01-05", symbol: "AMD", side: "BUY", shares: 100, price: 100 });
  for (const d of ["2026-01-05", "2026-01-30", "2026-02-02"]) price(db, "AMD", d, 100);
  recordTrade(db, { date: "2026-02-02", symbol: "AMD", side: "SELL", shares: 100, price: 100 });

  const value = (d: string) =>
    positions(db, d).reduce((s, p) => s + (p.marketValue ?? 0), 0) + cashBalance(db, d);
  near(value("2026-01-30"), 50_000);
  near(value("2026-02-02"), 50_000, 1e-6);
});

test("partial sales leave the right share count on both sides of the date", () => {
  const db = memoryDb();
  deposit(db, "2026-01-01", 50_000);
  recordTrade(db, { date: "2026-01-05", symbol: "SPY", side: "BUY", shares: 60, price: 100 });
  recordTrade(db, { date: "2026-03-05", symbol: "SPY", side: "SELL", shares: 25, price: 120 });
  price(db, "SPY", "2026-01-06", 100);
  price(db, "SPY", "2026-04-06", 120);
  near(positions(db, "2026-01-06")[0]!.shares, 60);
  near(positions(db, "2026-04-06")[0]!.shares, 35);
});
