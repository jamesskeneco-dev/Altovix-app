import test from "node:test";
import assert from "node:assert/strict";
import {
  sma, ema, rsi, simpleReturns, stdev, realizedVol, drawdown, momentum,
  relativeStrength, correlation, beta, sharpe, sortino, cumulativeReturn,
  trendSlope, percentileRank, mean,
} from "../src/core/indicators/index.ts";

const close = (a: number | null, b: number, eps = 1e-9) => {
  assert.notEqual(a, null);
  assert.ok(Math.abs((a as number) - b) < eps, `${a} !~= ${b}`);
};

test("sma", () => {
  close(sma([1, 2, 3, 4, 5], 5), 3);
  close(sma([1, 2, 3, 4, 5], 2), 4.5);
  assert.equal(sma([1, 2], 5), null);
});

test("ema seeds from sma and steps correctly", () => {
  close(ema([1, 2, 3, 4, 5], 5), 3);
  // seed 3, k = 2/6; next = 6*(1/3) + 3*(2/3) = 4
  close(ema([1, 2, 3, 4, 5, 6], 5), 4, 1e-12);
});

test("rsi hits its known boundaries", () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const down = Array.from({ length: 30 }, (_, i) => 100 - i);
  const flat = Array.from({ length: 30 }, () => 100);
  close(rsi(up, 14), 100);
  close(rsi(down, 14), 0);
  close(rsi(flat, 14), 50);
  assert.equal(rsi([1, 2, 3], 14), null);
});

test("rsi of a symmetric zigzag sits at 50", () => {
  const zig = Array.from({ length: 200 }, (_, i) => 100 + (i % 2));
  const v = rsi(zig, 14) as number;
  assert.ok(Math.abs(v - 50) < 3, `zigzag rsi ${v}`);
});

test("returns and dispersion", () => {
  const r = simpleReturns([100, 110, 99]);
  assert.equal(r.length, 2);
  close(r[0] as number, 0.1, 1e-12);
  close(r[1] as number, -0.1, 1e-12);
  close(mean([1, 2, 3]), 2);
  close(stdev([2, 4, 4, 4, 5, 5, 7, 9]), 2.138089935299395, 1e-12);
});

test("drawdown finds the worst peak-to-trough", () => {
  const d = drawdown([100, 120, 90, 130]);
  close(d.maxDrawdown, -0.25, 1e-12);
  assert.equal(d.peakIndex, 1);
  assert.equal(d.troughIndex, 2);
  close(d.currentDrawdown, 0, 1e-12);
});

test("drawdown reports an unrecovered current drawdown", () => {
  const d = drawdown([100, 200, 150]);
  close(d.currentDrawdown, -0.25, 1e-12);
});

test("momentum and relative strength", () => {
  close(momentum([100, 110], 1), 0.1, 1e-12);
  close(relativeStrength([100, 110], [100, 104], 1), 0.06, 1e-12);
  assert.equal(momentum([100], 5), null);
});

test("correlation and beta on exact relationships", () => {
  close(correlation([1, 2, 3, 4], [2, 4, 6, 8]), 1, 1e-12);
  close(correlation([1, 2, 3, 4], [8, 6, 4, 2]), -1, 1e-12);
  close(beta([2, 4, 6, 8], [1, 2, 3, 4]), 2, 1e-12);
});

test("sharpe is null without dispersion and finite otherwise", () => {
  assert.equal(sharpe([0.01, 0.01, 0.01]), null);
  const s = sharpe([0.01, -0.01, 0.02, 0.0]) as number;
  close(s, (0.005 / 0.012909944487358056) * Math.sqrt(252), 1e-9);
});

test("sortino only penalises downside", () => {
  assert.equal(sortino([0.01, 0.02, 0.03]), null); // no downside at all
  const s = sortino([0.02, -0.01, 0.03, -0.02]) as number;
  assert.ok(s > 0);
});

test("compounding and annualising", () => {
  close(cumulativeReturn([0.1, -0.1]), -0.01, 1e-12);
  close(cumulativeReturn([]), 0);
});

test("trend slope of a straight line", () => {
  close(trendSlope([1, 2, 3, 4, 5], 5), 1 / 3, 1e-12);
  close(trendSlope([5, 5, 5, 5, 5], 5), 0, 1e-12);
});

test("percentile rank", () => {
  close(percentileRank([1, 2, 3, 4], 3), 0.75, 1e-12);
});

test("realized vol scales with dispersion", () => {
  const calm = Array.from({ length: 40 }, (_, i) => 100 * (1 + 0.0005 * i));
  const wild = Array.from({ length: 40 }, (_, i) => 100 * (1 + 0.03 * ((i % 2) - 0.5)));
  const a = realizedVol(calm, 20) as number;
  const b = realizedVol(wild, 20) as number;
  assert.ok(b > a * 5, `${b} vs ${a}`);
});
