import { db, migrate } from "../core/db.ts";
import { recordTrade, deposit, positions, cashBalance, type LotMethod } from "../core/portfolio/lots.ts";
import { flagWashSales } from "../core/portfolio/tax.ts";
import { takeSnapshot } from "../core/portfolio/snapshot.ts";
import { parseArgs, str, num, bool, today, heading, money, pct, die, c } from "./args.ts";

const args = parseArgs();
const conn = db();
migrate(conn);

const [verb, ...rest] = args.positional;
const action = (verb ?? "").toUpperCase();

if (action === "DEPOSIT" || action === "WITHDRAW") {
  const amount = Number(rest[0]);
  if (!Number.isFinite(amount)) die(`usage: npm run trade -- DEPOSIT 10000 [--date 2026-09-03]`);
  deposit(conn, str(args, "date", today()) as string, action === "DEPOSIT" ? amount : -amount);
  console.log(`${action.toLowerCase()} ${money(Math.abs(amount))} - cash now ${money(cashBalance(conn))}`);
  process.exit(0);
}

if (action !== "BUY" && action !== "SELL") {
  die(`usage:
  npm run trade -- BUY  NVDA 10 118.50 [--fees 1] [--date 2026-09-03] [--thesis "..."] [--exit "..."] [--run 12]
  npm run trade -- SELL NVDA 10 131.20 [--method HIFO]
  npm run trade -- DEPOSIT 10000`);
}

const [symbol, sharesRaw, priceRaw] = rest;
const shares = Number(sharesRaw);
const price = Number(priceRaw);
if (!symbol || !Number.isFinite(shares) || !Number.isFinite(price)) {
  die("need SYMBOL SHARES PRICE, e.g. BUY NVDA 10 118.50");
}

const date = str(args, "date", today()) as string;
const result = recordTrade(conn, {
  date, symbol, side: action, shares, price,
  fees: num(args, "fees", 0),
  thesis: str(args, "thesis") ?? null,
  exitRule: str(args, "exit") ?? null,
  committeeRunId: num(args, "run") ?? null,
  method: (str(args, "method", "FIFO") as LotMethod),
  allowMargin: bool(args, "allow-margin"),
});

heading(`${action} ${shares} ${symbol.toUpperCase()} @ ${money(price)} on ${date}`);
console.log(`trade #${result.tradeId}   cash ${result.cashDelta >= 0 ? "+" : ""}${money(result.cashDelta)}`);

if (result.closures.length) {
  console.log(`\nclosed lots:`);
  for (const cl of result.closures) {
    console.log(`  lot #${cl.lotId}  ${cl.shares} sh  ${cl.term.padEnd(5)}  held ${cl.holdingDays}d  realised ${money(cl.realizedPnl)}`);
  }
  const wash = flagWashSales(conn, symbol);
  if (wash.flagged) {
    console.log(c.yellow(`\nwash sale: ${wash.flagged} closure(s), ${money(wash.disallowed)} of loss disallowed and moved into replacement basis.`));
  }
}

takeSnapshot(conn, date);

console.log(`\nposition summary:`);
for (const p of positions(conn, date)) {
  console.log(`  ${p.symbol.padEnd(6)} ${String(p.shares).padStart(8)} sh  avg ${money(p.avgCost).padStart(12)}  mv ${money(p.marketValue).padStart(12)}  ${pct(p.unrealizedPct)}`);
}
console.log(`  ${"CASH".padEnd(6)} ${money(cashBalance(conn, date)).padStart(26)}`);
