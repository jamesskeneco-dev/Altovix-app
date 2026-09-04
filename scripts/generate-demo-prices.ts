/**
 * Generates SYNTHETIC price CSVs so the terminal can be exercised end to end with no
 * network access and no data vendor.
 *
 * These are random walks. They are not market data, they do not correspond to any real
 * security, and nothing produced from them means anything about the real world. Every
 * file is written with a SYNTHETIC banner and the demo database is a separate file from
 * the real one so the two can never be confused.
 *
 *   node --experimental-strip-types scripts/generate-demo-prices.ts [--days 500] [--out data/demo-prices]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../src/core/config.ts";
import { parseArgs, num, str } from "../src/cli/args.ts";

const args = parseArgs();
const days = num(args, "days", 520) as number;
const outDir = resolve(process.cwd(), str(args, "out", "data/demo-prices") as string);
mkdirSync(outDir, { recursive: true });

// Deterministic generator so the demo book is reproducible run to run.
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}
const seedOf = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
};

function tradingDays(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out.reverse();
}

const dates = tradingDays(days);
const universe = [...new Set([...config.benchmarks, ...config.sectorEtfs, ...config.macroTickers, "NVDA", "AAPL", "MSFT", "AMD", "COST"])];

// One shared market factor, so correlations between names are realistic rather than zero.
const marketRng = rng(20260903);
const marketShock: number[] = [];
for (let i = 0; i < dates.length; i++) {
  const u = Math.max(1e-9, marketRng());
  const v = marketRng();
  marketShock.push(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
}

for (const symbol of universe) {
  const r = rng(seedOf(symbol));
  const isVix = symbol.startsWith("^");
  const beta = isVix ? -3.5 : 0.6 + r() * 1.1;
  const idioVol = isVix ? 0.05 : 0.006 + r() * 0.016;
  const drift = isVix ? 0 : (r() - 0.42) * 0.0012;
  let price = isVix ? 16 : 40 + r() * 260;

  const rows: string[] = ["Date,Open,High,Low,Close,Volume"];
  for (let i = 0; i < dates.length; i++) {
    const u = Math.max(1e-9, r());
    const v = r();
    const idio = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * idioVol;
    const ret = drift + beta * (marketShock[i] as number) * 0.007 + idio;
    price = Math.max(1, price * (1 + ret));
    const high = price * (1 + Math.abs(idio) * 0.6);
    const low = price * (1 - Math.abs(idio) * 0.6);
    const open = low + (high - low) * r();
    rows.push([
      dates[i], open.toFixed(2), high.toFixed(2), low.toFixed(2), price.toFixed(2),
      Math.round(500_000 + r() * 40_000_000),
    ].join(","));
  }
  writeFileSync(resolve(outDir, `${symbol.toUpperCase()}.csv`), `${rows.join("\n")}\n`);
}

console.log(`wrote ${universe.length} SYNTHETIC price files (${dates.length} bars each) to ${outDir}`);
console.log(`these are random walks - not market data, and not usable for any real decision.`);
