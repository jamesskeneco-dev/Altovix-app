export type Side = "BUY" | "SELL";
export type Term = "SHORT" | "LONG";
export type Mandate = "NEW_POSITION" | "REVIEW" | "EXIT";
export type Action = "BUY" | "HOLD" | "AVOID" | "TRIM" | "SELL";
export type RunStatus = "RUNNING" | "COMPLETE" | "FAILED";
export type Resolver = "MECHANICAL" | "JUDGMENT";
export type ClaimStatus = "OPEN" | "RESOLVED" | "VOID";

export const AGENTS = [
  "regime",
  "sector",
  "quant",
  "research",
  "risk",
  "bear",
  "decision",
  "journal",
] as const;
export type AgentName = (typeof AGENTS)[number] | "calibration";

export interface Bar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
}

export interface Trade {
  id: number;
  date: string;
  symbol: string;
  side: Side;
  shares: number;
  price: number;
  fees: number;
  thesis: string | null;
  exit_rule: string | null;
  committee_run_id: number | null;
}

export interface Lot {
  id: number;
  symbol: string;
  open_trade_id: number;
  open_date: string;
  shares_opened: number;
  shares_remaining: number;
  cost_per_share: number;
  basis_adjustment: number;
}

export interface Position {
  symbol: string;
  shares: number;
  costBasis: number;
  avgCost: number;
  lastPrice: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  unrealizedPct: number | null;
  weight: number | null;
}
