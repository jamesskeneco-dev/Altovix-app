import { db, migrate } from "../core/db.ts";
import { takeSnapshot, rebuildSnapshots } from "../core/portfolio/snapshot.ts";
import { latestDate } from "../core/market/index.ts";
import { parseArgs, str, bool, today, heading, money, pct, c } from "./args.ts";

const args = parseArgs();
const conn = db();
migrate(conn);

if (bool(args, "rebuild")) {
  const n = rebuildSnapshots(conn, str(args, "from"));
  console.log(`rebuilt ${n} snapshots.`);
  process.exit(0);
}

const date = str(args, "date", latestDate(conn) ?? today()) as string;
const s = takeSnapshot(conn, date);
heading(`Snapshot ${s.date}`);
console.log(`  total     ${money(s.total_value)}`);
console.log(`  positions ${money(s.positions_value)}`);
console.log(`  cash      ${money(s.cash)}`);
console.log(`  net paid in ${money(s.net_contributions)}`);
console.log(`  TWR index ${s.twr_index.toFixed(2)} ${c.dim("(100 = inception)")}  ${pct(s.twr_index / 100 - 1)}`);
