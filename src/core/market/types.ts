import type { Bar } from "../types.ts";

export interface PriceProvider {
  readonly name: string;
  /** Daily bars, oldest first, inclusive of `from` when available. */
  fetchDaily(symbol: string, from?: string): Promise<Bar[]>;
}

export class ProviderError extends Error {
  readonly provider: string;
  readonly symbol: string;
  constructor(provider: string, symbol: string, message: string) {
    super(`[${provider}] ${symbol}: ${message}`);
    this.name = "ProviderError";
    this.provider = provider;
    this.symbol = symbol;
  }
}

export function parseNum(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const t = raw.trim();
  if (!t || t === "N/A" || t === "null" || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
