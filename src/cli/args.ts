export interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv = process.argv.slice(2)): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) { flags[a.slice(2)] = next; i++; }
        else flags[a.slice(2)] = true;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

export const str = (a: Args, key: string, fallback?: string): string | undefined => {
  const v = a.flags[key];
  return typeof v === "string" ? v : fallback;
};
export const num = (a: Args, key: string, fallback?: number): number | undefined => {
  const v = a.flags[key];
  return typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : fallback;
};
export const bool = (a: Args, key: string): boolean => a.flags[key] === true || a.flags[key] === "true";

export const today = (): string => new Date().toISOString().slice(0, 10);

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", magenta: "\x1b[35m",
};
const enabled = process.stdout.isTTY && !process.env["NO_COLOR"];
const wrap = (code: string) => (s: string): string => (enabled ? `${code}${s}${C.reset}` : s);

export const c = {
  dim: wrap(C.dim), bold: wrap(C.bold), green: wrap(C.green), red: wrap(C.red),
  yellow: wrap(C.yellow), cyan: wrap(C.cyan), magenta: wrap(C.magenta),
};

export function pct(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  const s = `${(v * 100).toFixed(dp)}%`;
  return v > 0 ? c.green(`+${s}`) : v < 0 ? c.red(s) : s;
}

/** Unsigned percentage, for magnitudes where a +/- sign would be meaningless (vol, win rate). */
export function mag(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  return `${(v * 100).toFixed(dp)}%`;
}

export function money(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function heading(s: string): void {
  console.log(`\n${c.bold(c.cyan(s))}\n${c.dim("-".repeat(s.length))}`);
}

export function die(msg: string): never {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}
