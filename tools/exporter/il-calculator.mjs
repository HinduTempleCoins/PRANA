// il-calculator.mjs — impermanent-loss math for an honest LP UI.
//
// PUBLIC, dependency-free, pure functions. These are the standard constant-product
// (Uniswap-V2, x*y=k) relations between holding an LP position and just HODLing the
// two underlying assets after the price of one moves.
//
// Conventions
// -----------
//  r  = priceRatio = (new price of asset A in terms of B) / (initial price of A in B).
//       r = 1  -> price unchanged.
//       r = 2  -> asset A doubled vs B.
//       r = 0.5 -> asset A halved vs B.
//
//  Impermanent loss is symmetric in r and 1/r, and is always <= 0 (you never beat HODL).

/**
 * Impermanent loss as a fraction (negative = loss) for a V2 LP vs HODL.
 *
 *   IL(r) = 2*sqrt(r)/(1+r) - 1
 *
 * @param {number} priceRatio  r > 0 (new price / initial price of asset A in B).
 * @returns {number} fractional change vs HODL. e.g. -0.0572 means the LP is worth
 *                   5.72% less than holding. r=1 -> 0.
 */
export function ilPercent(priceRatio) {
  const r = Number(priceRatio);
  if (!Number.isFinite(r) || r <= 0) {
    throw new RangeError(`priceRatio must be a positive finite number, got ${priceRatio}`);
  }
  return (2 * Math.sqrt(r)) / (1 + r) - 1;
}

/**
 * Value of a V2 LP position (and the HODL baseline) after the price of asset A moves.
 *
 * Starting from an LP of `initialA` units of A and `initialB` units of B (which, for a
 * correctly-priced V2 deposit, are equal in value), this returns the position's value
 * and the HODL value, both denominated in asset B at the NEW price.
 *
 * Derivation: k = A0*B0 is constant. At new price p_new (of A in B), the pool rebalances
 * to A1 = sqrt(k / p_new), B1 = sqrt(k * p_new). Value_LP = A1*p_new + B1 = 2*sqrt(k*p_new).
 * HODL keeps the original units: Value_HODL = A0*p_new + B0.
 *
 * @param {number|bigint} initialA  units of asset A initially deposited.
 * @param {number|bigint} initialB  units of asset B initially deposited.
 * @param {number} newPriceRatio    r = new price / initial price of A in B (>0).
 * @returns {{ lpValue:number, hodlValue:number, ilFraction:number, ilVsHodl:number }}
 *          all values denominated in B at the new price; `ilVsHodl` = lpValue - hodlValue.
 */
export function positionValue(initialA, initialB, newPriceRatio) {
  const A0 = Number(initialA);
  const B0 = Number(initialB);
  const r = Number(newPriceRatio);
  if (!Number.isFinite(A0) || A0 < 0) throw new RangeError(`initialA must be >= 0`);
  if (!Number.isFinite(B0) || B0 < 0) throw new RangeError(`initialB must be >= 0`);
  if (!Number.isFinite(r) || r <= 0) throw new RangeError(`newPriceRatio must be > 0`);

  // Initial price of A in B implied by a balanced deposit: p0 = B0 / A0.
  // New price p_new = p0 * r. Work in B-units throughout.
  const p0 = A0 === 0 ? 0 : B0 / A0;
  const pNew = p0 * r;

  const k = A0 * B0; // invariant (in A*B units)
  // New pool reserves at price pNew (per the constant-product rebalance).
  const A1 = pNew === 0 ? A0 : Math.sqrt(k / pNew);
  const B1 = Math.sqrt(k * pNew);

  const lpValue = A1 * pNew + B1; // = 2*sqrt(k*pNew)
  const hodlValue = A0 * pNew + B0; // original units, new price

  const ilFraction = hodlValue === 0 ? 0 : lpValue / hodlValue - 1;
  return { lpValue, hodlValue, ilFraction, ilVsHodl: lpValue - hodlValue };
}

/**
 * Fee APR (as a fraction) the pool must earn over `days` to break even on the IL of a
 * given price move — i.e. the trading-fee yield that exactly offsets the impermanent loss.
 *
 *   breakeven_total_fee = |IL(r)|         (fees needed over the holding period)
 *   breakeven_fee_apr    = |IL(r)| * 365 / days
 *
 * @param {number} r     price ratio (>0).
 * @param {number} days  holding period in days (>0).
 * @returns {number} required fee APR as a fraction (e.g. 0.12 = 12% APR). r=1 -> 0.
 */
export function breakevenFeeApr(r, days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) throw new RangeError(`days must be > 0, got ${days}`);
  const il = Math.abs(ilPercent(r)); // loss magnitude over the period
  return (il * 365) / d;
}
