// il-calculator.test.mjs — offline golden-value tests for the IL math.

import { test } from "node:test";
import assert from "node:assert/strict";

import { ilPercent, positionValue, breakevenFeeApr } from "./il-calculator.mjs";

const near = (a, b, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (tol ${tol})`);

test("ilPercent golden values (r = 1, 2, 4)", () => {
  // r = 1 -> no price change -> exactly 0% IL.
  near(ilPercent(1), 0, 1e-12);
  // r = 2 -> classic -5.72% (2*sqrt(2)/3 - 1).
  near(ilPercent(2), -0.0572, 1e-4);
  // r = 4 -> classic -20.0% (2*2/5 - 1 = -1/5).
  near(ilPercent(4), -0.2, 1e-9);
});

test("ilPercent is symmetric in r and 1/r", () => {
  near(ilPercent(2), ilPercent(0.5), 1e-12);
  near(ilPercent(4), ilPercent(0.25), 1e-12);
  near(ilPercent(10), ilPercent(0.1), 1e-12);
});

test("ilPercent is always <= 0 and 0 only at r = 1", () => {
  for (const r of [0.1, 0.5, 0.9, 1, 1.1, 2, 5, 100]) {
    assert.ok(ilPercent(r) <= 1e-12, `IL(${r}) should be <= 0`);
  }
  assert.ok(ilPercent(1.5) < 0, "IL away from 1 is strictly negative");
});

test("ilPercent rejects non-positive / non-finite input", () => {
  assert.throws(() => ilPercent(0), RangeError);
  assert.throws(() => ilPercent(-1), RangeError);
  assert.throws(() => ilPercent(NaN), RangeError);
});

test("positionValue: r=1 means LP == HODL (no loss)", () => {
  const v = positionValue(100, 100, 1);
  near(v.lpValue, v.hodlValue, 1e-9);
  near(v.ilFraction, 0, 1e-9);
  near(v.ilVsHodl, 0, 1e-9);
});

test("positionValue: ilFraction matches the closed-form ilPercent", () => {
  for (const r of [0.25, 0.5, 2, 4, 9]) {
    const v = positionValue(100, 100, r);
    near(v.ilFraction, ilPercent(r), 1e-9);
    // LP underperforms HODL whenever the price moved.
    assert.ok(v.lpValue <= v.hodlValue + 1e-9, `LP <= HODL at r=${r}`);
  }
});

test("positionValue: r=4 gives the -20% relation in absolute terms", () => {
  // Balanced 100/100 deposit, price of A quadruples.
  const v = positionValue(100, 100, 4);
  // HODL: 100*p_new + 100; p0=1 so p_new=4 -> 100*4+100 = 500.
  near(v.hodlValue, 500, 1e-6);
  // LP = 2*sqrt(k*pNew) = 2*sqrt(10000*4) = 2*200 = 400.
  near(v.lpValue, 400, 1e-6);
  near(v.ilFraction, -0.2, 1e-9);
});

test("breakevenFeeApr golden values", () => {
  // r=1 -> no IL -> 0 fee APR needed, any horizon.
  near(breakevenFeeApr(1, 30), 0, 1e-12);
  // r=2 over 365 days: APR == |IL| = 5.72%.
  near(breakevenFeeApr(2, 365), 0.0572, 1e-4);
  // r=4 over 365 days: APR == 20%.
  near(breakevenFeeApr(4, 365), 0.2, 1e-9);
  // Shorter horizon scales the required APR up: 30 days -> |IL|*365/30.
  near(breakevenFeeApr(4, 30), (0.2 * 365) / 30, 1e-9);
});

test("breakevenFeeApr rejects non-positive days", () => {
  assert.throws(() => breakevenFeeApr(2, 0), RangeError);
  assert.throws(() => breakevenFeeApr(2, -5), RangeError);
});
