import { db, migrate, run } from "../core/db.ts";
import { config } from "../core/config.ts";
import { deposit } from "../core/portfolio/lots.ts";
import { parseArgs, num, str, today, heading, money, c } from "./args.ts";

const args = parseArgs();
const conn = db();
migrate(conn);
heading("Altovix - initialise");
console.log(`database: ${config.dbPath}`);

const universe = [
  ...config.benchmarks.map((s) => [s, 1] as const),
  ...config.sectorEtfs.map((s) => [s, 1] as const),
  ...config.macroTickers.map((s) => [s, 1] as const),
];
for (const [symbol, isBench] of universe) {
  run(conn, `INSERT OR IGNORE INTO symbols (symbol, is_benchmark) VALUES (?, ?)`, symbol, isBench);
}
const extra = args.positional.map((s) => s.toUpperCase());
for (const symbol of extra) run(conn, `INSERT OR IGNORE INTO symbols (symbol) VALUES (?)`, symbol);

console.log(`tracked symbols: ${universe.length + extra.length}`);

const fund = num(args, "fund");
if (fund !== undefined) {
  deposit(conn, str(args, "date", today()) as string, fund, "initial funding");
  console.log(`funded with ${money(fund)}`);
}

console.log(`
${c.bold("next:")}
  npm run ingest                 # pull daily prices for everything tracked
  npm run trade -- BUY NVDA 10 118.50
  npm run committee -- NVDA
  npm run calibrate
`);
