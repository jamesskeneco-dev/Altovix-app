/**
 * Builds a SYNTHETIC demo book on top of the synthetic price files, so every part of the
 * terminal has something to show: multiple lots, a long-term holding, a realised loss
 * followed by a repurchase inside 30 days (which must trip the wash-sale flag), and an
 * open loss for the harvesting scanner.
 *
 * Nothing here is a real trade. Run against the demo database only.
 */
import { db, migrate } from "../src/core/db.ts";
import { config } from "../src/core/config.ts";
import { recordTrade } from "../src/core/portfolio/lots.ts";
import { flagWashSales } from "../src/core/portfolio/tax.ts";
import { rebuildSnapshots } from "../src/core/portfolio/snapshot.ts";
import { priceAsOf } from "../src/core/market/index.ts";

if (!config.dbPath.includes("demo")) {
  console.error(`refusing to seed a demo book into ${config.dbPath} - point ALTOVIX_DB at a demo file.`);
  process.exit(1);
}

const conn = db();
migrate(conn);

const plan: Array<[string, string, "BUY" | "SELL", number]> = [
  ["2025-01-03", "NVDA", "BUY", 40],
  ["2025-02-14", "AAPL", "BUY", 35],
  ["2025-03-10", "MSFT", "BUY", 20],
  ["2025-05-19", "AMD", "BUY", 60],
  ["2025-08-06", "COST", "BUY", 12],
  ["2026-01-15", "AMD", "SELL", 60],   // realise whatever the walk produced
  ["2026-01-28", "AMD", "BUY", 55],    // 13 days later - wash sale if the sale was a loss
  ["2026-04-02", "NVDA", "SELL", 15],  // partial trim, long-term by then
  ["2026-06-11", "MSFT", "BUY", 10],
];

for (const [date, symbol, side, shares] of plan) {
  const price = priceAsOf(conn, symbol, date);
  if (price === null) { console.log(`skip ${symbol} ${date}: no price`); continue; }
  try {
    const r = recordTrade(conn, {
      date, symbol, side, shares, price, fees: 0.65,
      thesis: side === "BUY" ? `[demo] synthetic entry for ${symbol}` : null,
      exitRule: side === "BUY" ? "[demo] exit on close below the 200-day average" : null,
    });
    const realised = r.closures.reduce((s, c) => s + c.realizedPnl, 0);
    console.log(`${date} ${side.padEnd(4)} ${String(shares).padStart(3)} ${symbol.padEnd(5)} @ ${price.toFixed(2)}` +
      (r.closures.length ? `  realised ${realised.toFixed(2)}` : ""));
  } catch (err) {
    console.log(`skip ${symbol} ${date}: ${(err as Error).message}`);
  }
}

const wash = flagWashSales(conn);
console.log(`wash-sale pass: ${wash.flagged} closure(s) flagged, ${wash.disallowed.toFixed(2)} disallowed`);
console.log(`rebuilt ${rebuildSnapshots(conn)} daily snapshots`);
