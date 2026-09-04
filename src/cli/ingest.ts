import { db, migrate } from "../core/db.ts";
import { config } from "../core/config.ts";
import { ingestSymbol, trackedSymbols } from "../core/market/index.ts";
import { parseArgs, str, heading, c } from "./args.ts";

const args = parseArgs();
const conn = db();
migrate(conn);

const symbols = args.positional.length
  ? args.positional.map((s) => s.toUpperCase())
  : trackedSymbols(conn);

if (!symbols.length) {
  console.log("nothing tracked yet - run `npm run init` first, or pass symbols explicitly.");
  process.exit(0);
}

heading(`Ingesting ${symbols.length} symbols via ${str(args, "provider", config.marketProvider)}`);
let ok = 0;
const failures: string[] = [];

for (const symbol of symbols) {
  const res = await ingestSymbol(conn, symbol, { from: str(args, "from"), provider: str(args, "provider") });
  if (res.error) {
    failures.push(`${symbol}: ${res.error}`);
    console.log(`${c.red("x")} ${symbol.padEnd(6)} ${c.dim(res.error.slice(0, 110))}`);
  } else {
    ok++;
    console.log(`${c.green("ok")} ${symbol.padEnd(6)} ${String(res.rows).padStart(5)} bars  ${res.firstDate} -> ${res.lastDate}  ${c.dim(`via ${res.provider}`)}`);
  }
}

console.log(`\n${ok}/${symbols.length} succeeded.`);
if (failures.length) {
  console.log(c.yellow(`\n${failures.length} failed. If every provider is blocked on this network, export CSVs and use:`));
  console.log(c.dim(`  ALTOVIX_MARKET_PROVIDER=csv  (one file per symbol in ${config.csvDir}, columns Date,Close)`));
}
