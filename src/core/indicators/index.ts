/**
 * Pure, dependency-free technical/statistical primitives.
 *
 * Design rule for the whole project: the LLM never computes a number.
 * Everything quantitative is calculated here, unit-tested, and handed to the
 * agents as facts. Agents interpret; they do not do arithmetic.
 */

export const TRADING_DAYS = 252;

export function last<T>(xs: readonly T[]): T | undefined {
  return xs.length ? xs[xs.length - 1] : undefined;
}

export function sma(values: readonly number[], n: number): number | null {
  if (n <= 0 || values.length < n) return null;
  let sum = 0;
  for (let i = values.length - n; i < values.length; i++) sum += values[i] as number;
  return sum / n;
}

/** Standard EMA seeded with the SMA of the first n values. */
export function ema(values: readonly number[], n: number): number | null {
  if (n <= 0 || values.length < n) return null;
  const k = 2 / (n + 1);
  let acc = 0;
  for (let i = 0; i < n; i++) acc += values[i] as number;
  acc /= n;
  for (let i = n; i < values.length; i++) acc = (values[i] as number) * k + acc * (1 - k);
  return acc;
}

/** Wilder's RSI. Returns null until there are n+1 closes. */
export function rsi(closes: readonly number[], n = 14): number | null {
  if (closes.length < n + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const delta = (closes[i] as number) - (closes[i - 1] as number);
    if (delta >= 0) gain += delta;
    else loss -= delta;
  }
  let avgGain = gain / n;
  let avgLoss = loss / n;
  for (let i = n + 1; i < closes.length; i++) {
    const delta = (closes[i] as number) - (closes[i - 1] as number);
    const g = delta > 0 ? delta : 0;
    const l = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (n - 1) + g) / n;
    avgLoss = (avgLoss * (n - 1) + l) / n;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function simpleReturns(values: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1] as number;
    if (prev === 0) { out.push(0); continue; }
    out.push((values[i] as number) / prev - 1);
  }
  return out;
}

export function mean(xs: readonly number[]): number {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n-1). */
export function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let acc = 0;
  for (const x of xs) acc += (x - m) ** 2;
  return Math.sqrt(acc / (xs.length - 1));
}

/** Annualised realised volatility from the trailing `window` daily returns. */
export function realizedVol(closes: readonly number[], window = 20): number | null {
  const rets = simpleReturns(closes);
  if (rets.length < window) return null;
  return stdev(rets.slice(-window)) * Math.sqrt(TRADING_DAYS);
}

export interface Drawdown {
  maxDrawdown: number;   // negative fraction, e.g. -0.2312
  peakIndex: number;
  troughIndex: number;
  currentDrawdown: number;
}

export function drawdown(values: readonly number[]): Drawdown {
  if (!values.length) return { maxDrawdown: 0, peakIndex: 0, troughIndex: 0, currentDrawdown: 0 };
  let peak = values[0] as number;
  let peakIdx = 0;
  let worst = 0;
  let worstPeak = 0;
  let worstTrough = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] as number;
    if (v > peak) { peak = v; peakIdx = i; }
    const dd = peak === 0 ? 0 : v / peak - 1;
    if (dd < worst) { worst = dd; worstPeak = peakIdx; worstTrough = i; }
  }
  let runningPeak = values[0] as number;
  for (const v of values) if (v > runningPeak) runningPeak = v;
  const current = runningPeak === 0 ? 0 : (last(values) as number) / runningPeak - 1;
  return { maxDrawdown: worst, peakIndex: worstPeak, troughIndex: worstTrough, currentDrawdown: current };
}

/** Total return over the trailing n bars. */
export function momentum(closes: readonly number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  const start = closes[closes.length - 1 - n] as number;
  if (start === 0) return null;
  return (last(closes) as number) / start - 1;
}

/** Momentum measured against a benchmark over the same window. */
export function relativeStrength(closes: readonly number[], bench: readonly number[], n: number): number | null {
  const a = momentum(closes, n);
  const b = momentum(bench, n);
  if (a === null || b === null) return null;
  return a - b;
}

export function correlation(a: readonly number[], b: readonly number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const x = a.slice(-n);
  const y = b.slice(-n);
  const mx = mean(x);
  const my = mean(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const ex = (x[i] as number) - mx;
    const ey = (y[i] as number) - my;
    num += ex * ey; dx += ex * ex; dy += ey * ey;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

export function beta(assetReturns: readonly number[], benchReturns: readonly number[]): number | null {
  const n = Math.min(assetReturns.length, benchReturns.length);
  if (n < 3) return null;
  const x = benchReturns.slice(-n);
  const y = assetReturns.slice(-n);
  const mx = mean(x);
  const my = mean(y);
  let cov = 0, varx = 0;
  for (let i = 0; i < n; i++) {
    cov += ((x[i] as number) - mx) * ((y[i] as number) - my);
    varx += ((x[i] as number) - mx) ** 2;
  }
  if (varx === 0) return null;
  return cov / varx;
}

/** Annualised Sharpe from a series of periodic returns. rf is annual. */
export function sharpe(returns: readonly number[], rfAnnual = 0, periods = TRADING_DAYS): number | null {
  if (returns.length < 2) return null;
  const rfPeriod = rfAnnual / periods;
  const excess = returns.map((r) => r - rfPeriod);
  const sd = stdev(excess);
  if (sd === 0) return null;
  return (mean(excess) / sd) * Math.sqrt(periods);
}

/** Downside-deviation variant. Only returns below the target penalise the score. */
export function sortino(returns: readonly number[], rfAnnual = 0, periods = TRADING_DAYS): number | null {
  if (returns.length < 2) return null;
  const rfPeriod = rfAnnual / periods;
  const excess = returns.map((r) => r - rfPeriod);
  const downside = excess.filter((r) => r < 0);
  if (!downside.length) return null;
  let acc = 0;
  for (const d of downside) acc += d * d;
  const dd = Math.sqrt(acc / excess.length);
  if (dd === 0) return null;
  return (mean(excess) / dd) * Math.sqrt(periods);
}

/** Compound a return series into a growth-of-1 index. */
export function cumulativeReturn(returns: readonly number[]): number {
  let acc = 1;
  for (const r of returns) acc *= 1 + r;
  return acc - 1;
}

export function annualize(totalReturn: number, days: number): number | null {
  if (days <= 0) return null;
  return (1 + totalReturn) ** (TRADING_DAYS / days) - 1;
}

/** Least-squares slope of values against index, normalised by mean level (per-bar drift). */
export function trendSlope(values: readonly number[], n: number): number | null {
  if (values.length < n || n < 3) return null;
  const y = values.slice(-n);
  const mx = (n - 1) / 2;
  const my = mean(y);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * ((y[i] as number) - my);
    den += (i - mx) ** 2;
  }
  if (den === 0 || my === 0) return null;
  return num / den / my;
}

export function percentileRank(values: readonly number[], value: number): number | null {
  if (!values.length) return null;
  let below = 0;
  for (const v of values) if (v <= value) below++;
  return below / values.length;
}
