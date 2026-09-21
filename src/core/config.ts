import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/** Minimal .env loader - keeps the repo dependency-free. */
function loadDotEnv(file = ".env"): void {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return;
  // Windows Notepad may write a UTF-8 byte-order mark; strip it or the first key is unreadable.
  const text = readFileSync(path, "utf8").replace(/^﻿/, "");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const env = (key: string, fallback: string): string => process.env[key] ?? fallback;

export const config = {
  dbPath: env("ALTOVIX_DB", "./altovix.db"),
  llmMode: env("ALTOVIX_LLM", "mock") as "real" | "mock",
  apiKey: process.env["ANTHROPIC_API_KEY"] ?? "",
  model: env("ALTOVIX_MODEL", "claude-sonnet-4-6"),
  marketProvider: env("ALTOVIX_MARKET_PROVIDER", "stooq") as "schwab" | "stooq" | "yahoo" | "csv" | "kraken",
  csvDir: env("ALTOVIX_CSV_DIR", "./data/prices"),
  benchmarks: env("ALTOVIX_BENCHMARKS", "SPY,QQQ")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  /** Sector ETFs the Sector Rotation agent reads. */
  sectorEtfs: [
    "XLK", "XLF", "XLV", "XLY", "XLP",
    "XLE", "XLI", "XLB", "XLU", "XLRE", "XLC",
  ],
  /** Macro context tickers. Free daily sources cover these as ETFs/indices. */
  macroTickers: ["SPY", "QQQ", "IWM", "TLT", "HYG", "LQD", "UUP", "USO", "GLD", "^VIX"],
  /** Crypto committee runs measure the candidate against these instead of SPY/QQQ. */
  cryptoBenchmarks: env("ALTOVIX_CRYPTO_BENCHMARKS", "BTC-USD,ETH-USD")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  /** Where the crypto sleeve's rules and state live. */
  cryptoRules: env("ALTOVIX_CRYPTO_RULES", "./rules/crypto.json"),
  cryptoState: env("ALTOVIX_CRYPTO_STATE", "./data/crypto-state.json"),
  cryptoStatus: env("ALTOVIX_CRYPTO_STATUS", "./data/crypto-status.json"),
} as const;

export type Config = typeof config;
