import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Bar } from "../types.ts";
import { type PriceProvider, ProviderError, parseNum } from "./types.ts";
import { config } from "../config.ts";

/**
 * Offline provider: one CSV per symbol in ALTOVIX_CSV_DIR, e.g. data/prices/SPY.csv
 * Header must contain Date and Close (case-insensitive). Open/High/Low/Volume optional.
 * This is the escape hatch when a network provider is blocked or a broker export is all you have.
 */
export const csvProvider: PriceProvider = {
  name: "csv",
  async fetchDaily(symbol: string, from?: string): Promise<Bar[]> {
    const path = resolve(process.cwd(), config.csvDir, `${symbol.toUpperCase()}.csv`);
    if (!existsSync(path)) throw new ProviderError("csv", symbol, `missing file ${path}`);
    return parseCsv(readFileSync(path, "utf8"), symbol, from);
  },
};

export function parseCsv(text: string, symbol: string, from?: string): Bar[] {
  const lines = text.trim().split(/\r?\n/);
  const header = (lines[0] ?? "").split(",").map((h) => h.trim().toLowerCase());
  const col = (...names: string[]): number => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i !== -1) return i;
    }
    return -1;
  };
  const iDate = col("date", "timestamp");
  const iClose = col("adj close", "adjclose", "close", "close/last");
  if (iDate === -1 || iClose === -1) {
    throw new ProviderError("csv", symbol, "header needs Date and Close columns");
  }
  const iOpen = col("open"), iHigh = col("high"), iLow = col("low"), iVol = col("volume");
  const clean = (v: string | undefined): string | undefined => v?.trim().replace(/^\$/, "");

  const bars: Bar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = (lines[i] as string).split(",");
    const rawDate = clean(cols[iDate]);
    if (!rawDate) continue;
    const date = normaliseDate(rawDate);
    const close = parseNum(clean(cols[iClose]));
    if (!date || close === null) continue;
    if (from && date < from) continue;
    bars.push({
      date,
      open: iOpen === -1 ? null : parseNum(clean(cols[iOpen])),
      high: iHigh === -1 ? null : parseNum(clean(cols[iHigh])),
      low: iLow === -1 ? null : parseNum(clean(cols[iLow])),
      close,
      volume: iVol === -1 ? null : parseNum(clean(cols[iVol])),
    });
  }
  bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!bars.length) throw new ProviderError("csv", symbol, "no usable rows");
  return bars;
}

/** Accepts yyyy-mm-dd, mm/dd/yyyy and yyyy/mm/dd. */
export function normaliseDate(raw: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const slash = raw.match(/^(\d{1,4})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    const [, a, b, c] = slash;
    if ((a as string).length === 4) {
      return `${a}-${(b as string).padStart(2, "0")}-${(c as string).padStart(2, "0")}`;
    }
    return `${c}-${(a as string).padStart(2, "0")}-${(b as string).padStart(2, "0")}`;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
