import type { AgentName } from "../types.ts";
import type { ScanRow } from "./scan.ts";
import type { CryptoRules, CryptoState } from "./guard.ts";

/**
 * What changes when the committee sits on a crypto pair. The eight roles, schemas and
 * claims are unchanged - the same calibration record scores them - but each role gets a
 * crypto brief appended to its system prompt (versioned here, persisted with every run).
 *
 * CRYPTO_BRIEF_VERSION bumps whenever any text below changes, so a scorecard can be
 * split by brief version.
 */
export const CRYPTO_BRIEF_VERSION = 1;

const COMMON = `
CRYPTO BRIEF v${CRYPTO_BRIEF_VERSION}. The candidate is a spot crypto pair on Kraken, bought with real
money from a small sleeve. What is different from an equity, and how you must treat it:
- It trades 24/7. "Daily bars" are UTC days, seven a week. horizonDays is in bars = calendar days.
- There are no earnings, filings, guidance or analysts. Token fundamentals (supply unlocks,
  emissions, exchange listings, protocol revenue) are NOT in your inputs unless the operator
  notes carry them. Do not invent them. Name the gap and lower confidence.
- The scoring benchmark is still SPY. That is deliberate: the honest question for real money
  is whether it would have done better in the index. BTC and ETH appear as the "sector".
- The macro table (SPY, QQQ, IWM, TLT, HYG, UUP, USO, GLD, ^VIX) is the equity tape. Crypto
  has traded as high-beta risk: dollar up + credit widening + VIX rising is a crypto headwind
  even when the coin's own chart looks fine.
- Volatility is 3-10x an equity. A 12% move is a normal day in a small cap coin; do not read
  it as news. Realised vol (vol20) is annualised - 1.0 means 100%.
- The names this sleeve looks at are chosen by a volatility scanner for being volatile and
  liquid, not for being good. Most such names round-trip. Your job is to say which ones
  will not, and to say AVOID readily.`.trim();

const BY_ROLE: Partial<Record<AgentName, string>> = {
  regime: `${COMMON}

FOR THE REGIME ROLE: read the equity tape as usual and add one line on crypto beta: is BTC
above or below its 50- and 200-day (the sector table), and is it leading or lagging SPY on
rs21. RISK_OFF for equities is RISK_OFF for crypto with more force. Your regime claim is still
scored on SPY.`,

  sector: `${COMMON}

FOR THE SECTOR ROLE: the "sector" is BTC and ETH. Rank them versus SPY as leaders or laggards
(those are your scored claims), then place the candidate: a small coin outperforming while
BTC lags is either early leadership or a pump - say which the volume and range data support.
An empty leaders list is a valid answer when both majors lag.`,

  quant: `${COMMON}

FOR THE QUANT ROLE: the useful reads are volumeSurge, volRatio (vol expanding), pctOf52wRange,
drawdownFromHigh and rsi14. A breakout on volume from a base is the setup the sleeve wants;
an RSI over 85 with a +25% day is the one it must not chase. The stop the sleeve will actually
use is a fixed fraction under cost (see the operator notes); say plainly whether one day of
ordinary noise (vol20 / sqrt(365)) would hit it.`,

  research: `${COMMON}

FOR THE RESEARCH ROLE: with no filings, your thesis can only be about price structure, the
crypto-beta backdrop and whatever the operator notes carry. That is a thin thesis and your
confidence must say so (cap it at 0.6 unless the notes carry dated, specific catalysts).
"It could 10x" is not a thesis. What specific, checkable thing happens over the horizon?`,

  risk: `${COMMON}

FOR THE RISK ROLE: sizes are USD out of a small sleeve whose caps are in the operator notes.
maxSizePct is a percent of that sleeve. The sleeve's own stop and trail are mechanical and
fixed; if you think the fixed stop is too tight for this coin's vol20, say DECLINE_ON_RISK -
a stop inside one day's noise is a donation. Round-trip fees are roughly 0.5-1%; a trade
whose edge is under 3% is a fee donation too. Correlation to the other holdings will be high
(everything trades with BTC) - treat the sleeve as one position for drawdown purposes.`,

  bear: `${COMMON}

FOR THE BEAR ROLE: the base rate for a small coin that just doubled is that it gives most of
it back. Mechanisms to weigh: the volume that made the move was exchange-only and can
vanish; unlocks and emissions you cannot see; a thin book that gaps through the stop; the
move being BTC beta and BTC turning. Put a probability on "gives back half the move inside
the horizon".`,

  decision: `${COMMON}

FOR THE DECISION ROLE: sizePct is a percent of the crypto SLEEVE, not the whole Book, and the
guard will cut it to the caps regardless. The exit is mechanical (stop, trail, take-profit,
max hold - in the operator notes); your exitRule should restate it in price terms or tighten
it, never loosen it. BUY only with confidence at or above the sleeve's minimum; otherwise
AVOID and say what would change your mind. A committee that buys every volatile coin the
scanner shows it will be calibrated out of existence within a month.`,

  journal: `${COMMON}

FOR THE JOURNAL ROLE: record the setup type the scanner assigned and the mechanical exit,
so the post-mortem can ask whether the setup or the exit was what failed.`,
};

export function cryptoAddendum(agent: AgentName): string {
  return BY_ROLE[agent] ?? COMMON;
}

/**
 * The operator notes handed to a crypto run: the scanner's read, the sleeve's caps and
 * state, and the mechanical exits - dated facts the agents may use but not extend.
 */
export function cryptoOperatorNotes(row: ScanRow, rules: CryptoRules, state: CryptoState, extra?: string | null): string {
  const pct = (v: number | null): string => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
  const lines = [
    `SCANNER READ for ${row.symbol} (Kraken spot, ${new Date().toISOString().slice(0, 16)}Z):`,
    `  last $${row.price}; 24h volume $${Math.round(row.volume24hUsd).toLocaleString("en-US")}; setup ${row.setup}; score ${row.score}/100`,
    `  ret1d ${pct(row.ret1d)}, ret7d ${pct(row.ret7d)}, ret30d ${pct(row.ret30d)}; ATR14 ${pct(row.atrPct14)} of price/day, ATR expansion x${(row.atrExpansion ?? 0).toFixed(2)}`,
    `  volume x${(row.volumeSurge ?? 0).toFixed(2)} vs 20d avg; vs 20d high ${pct(row.vsHigh20)}; 30d range position ${pct(row.rangePos30)}; drawdown from 90d high ${pct(row.drawdown90)}; RSI14 ${(row.rsi14 ?? 0).toFixed(0)}`,
    `  reasons: ${row.reasons.join("; ") || "none"}`,
    "",
    `SLEEVE (real money, hard caps enforced in code - the committee cannot exceed them):`,
    `  sleeve $${rules.sleeveUsd}; max order $${rules.maxOrderUsd}; max per position $${rules.maxPositionUsd}; max positions ${rules.maxPositions}; open now ${state.positions.length} (${state.positions.map((p) => p.symbol).join(", ") || "none"})`,
    `  minimum decision confidence to trade ${rules.minConfidence}; daily loss halt $${rules.maxDailyLossUsd}; live trading ${rules.live ? "ON" : "OFF (validate only)"}`,
    `  MECHANICAL EXITS: stop ${pct(rules.stopPct)} under cost; trailing stop ${pct(rules.trailPct)} under the high-water mark; take-profit +${pct(rules.takeProfitPct)}; max hold ${rules.maxHoldDays} days. Kraken fees roughly 0.25-0.40% per side at low volume.`,
  ];
  if (extra?.trim()) lines.push("", extra.trim());
  return lines.join("\n");
}
