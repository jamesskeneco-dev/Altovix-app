import type { Bar } from "../types.ts";
import { type PriceProvider, ProviderError, parseNum } from "./types.ts";

/**
 * Stooq daily CSV. Free, no key, end-of-day only.
 * Endpoint: https://stooq.com/q/d/l/?s=<symbol>&i=d
 */
export const stooq: PriceProvider = {
  name: "stooq",
  async fetchDaily(symbol: string, from?: string): Promise<Bar[]> {
    const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol(symbol))}&i=d`;
    let text: string;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "altovix/0.1" } });
      if (!res.ok) throw new ProviderError("stooq", symbol, `HTTP ${res.status}`);
      text = await res.text();
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError("stooq", symbol, (err as Error).message);
    }
    const lines = text.trim().split("\n");
    const header = lines[0]?.toLowerCase() ?? "";
    if (!header.startsWith("date")) {
      throw new ProviderError("stooq", symbol, `unexpected payload: ${text.slice(0, 120)}`);
    }
    const bars: Bar[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = (lines[i] as string).split(",");
      const date = cols[0]?.trim();
      const close = parseNum(cols[4]);
      if (!date || close === null) continue;
      if (from && date < from) continue;
      bars.push({
        date,
        open: parseNum(cols[1]),
        high: parseNum(cols[2]),
        low: parseNum(cols[3]),
        close,
        volume: parseNum(cols[5]),
      });
    }
    if (!bars.length) throw new ProviderError("stooq", symbol, "no rows returned");
    return bars;
  },
};

/** SPY -> spy.us ; ^VIX -> ^vix ; BRK.B -> brk-b.us */
export function stooqSymbol(symbol: string): string {
  const s = symbol.trim().toLowerCase();
  if (s.startsWith("^")) return s;
  if (s.includes(".") && !s.endsWith(".us")) return `${s.replace(/\./g, "-")}.us`;
  return s.endsWith(".us") ? s : `${s}.us`;
}
