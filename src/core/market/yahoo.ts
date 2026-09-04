import type { Bar } from "../types.ts";
import { type PriceProvider, ProviderError } from "./types.ts";

interface YahooChart {
  chart?: {
    error?: { description?: string } | null;
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: (number | null)[]; high?: (number | null)[];
          low?: (number | null)[]; close?: (number | null)[];
          volume?: (number | null)[];
        }>;
        adjclose?: Array<{ adjclose?: (number | null)[] }>;
      };
    }>;
  };
}

/** Yahoo chart JSON. Free, no key, unofficial - kept as a fallback provider. */
export const yahoo: PriceProvider = {
  name: "yahoo",
  async fetchDaily(symbol: string, from?: string): Promise<Bar[]> {
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?range=10y&interval=1d&events=div%2Csplit`;
    let payload: YahooChart;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 altovix/0.1" } });
      if (!res.ok) throw new ProviderError("yahoo", symbol, `HTTP ${res.status}`);
      payload = (await res.json()) as YahooChart;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError("yahoo", symbol, (err as Error).message);
    }
    const desc = payload.chart?.error?.description;
    if (desc) throw new ProviderError("yahoo", symbol, desc);
    const result = payload.chart?.result?.[0];
    const ts = result?.timestamp;
    const quote = result?.indicators?.quote?.[0];
    const adj = result?.indicators?.adjclose?.[0]?.adjclose;
    if (!ts || !quote) throw new ProviderError("yahoo", symbol, "no rows returned");

    const bars: Bar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const close = adj?.[i] ?? quote.close?.[i] ?? null;
      if (close === null || close === undefined) continue;
      const date = new Date((ts[i] as number) * 1000).toISOString().slice(0, 10);
      if (from && date < from) continue;
      bars.push({
        date,
        open: quote.open?.[i] ?? null,
        high: quote.high?.[i] ?? null,
        low: quote.low?.[i] ?? null,
        close,
        volume: quote.volume?.[i] ?? null,
      });
    }
    if (!bars.length) throw new ProviderError("yahoo", symbol, "no usable rows");
    return bars;
  },
};
