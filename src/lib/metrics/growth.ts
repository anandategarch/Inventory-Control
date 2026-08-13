// ============================================================
//  GROWTH METRICS — Single Implementation
//  --------------------------------------------------------
//  Growth = (Current - Previous) / ABS(Previous)
//
//  Two variants:
//   1. calcGrowth (signed): untuk nominal/sales — direction matters
//   2. calcGrowthAbs (magnitude): untuk BOM/COM (negative consumption) — use absolute
//
//  Master context #31: Growth = (curr - prev) / |prev|
//  Master context #31: Jangan mengandalkan growth saja pada signed value
//  saat sign berubah (flip-flop) — flag sebagai direction change
// ============================================================

export interface GrowthResult {
  /** Growth ratio: (curr - prev) / |prev| — null if prev = 0 */
  growth: number | null;
  /** Is this a direction flip? (sign changed from prev to curr) */
  isDirectionFlip: boolean;
  /** Trend classification */
  trend: 'INCREASING' | 'DECREASING' | 'STABLE' | 'NEW' | 'RESOLVED' | 'UNKNOWN';
}

/**
 * Compute growth (signed) — for nominal/sales where direction matters
 *
 * Formula: (curr - prev) / |prev|
 * Returns null if prev = 0 (can't compute from zero base)
 * Returns 0 if both curr and prev are 0
 */
export function calcGrowth(curr: number | null, prev: number | null): number | null {
  if (curr == null || prev == null) return null;
  if (prev === 0) return curr === 0 ? 0 : null;
  return (curr - prev) / Math.abs(prev);
}

/**
 * Compute growth (magnitude) — for BOM/COM (negative consumption)
 *
 * Formula: (|curr| - |prev|) / |prev|
 * Returns null if |prev| = 0
 */
export function calcGrowthAbs(curr: number | null, prev: number | null): number | null {
  if (curr == null || prev == null) return null;
  const ac = Math.abs(curr);
  const ap = Math.abs(prev);
  if (ap === 0) return ac === 0 ? 0 : null;
  return (ac - ap) / ap;
}

/**
 * Compute nominal deviation growth (magnitude) — for nominalDeviasi
 *
 * FIX (audit issue #11): calcGrowth() is signed, which is misleading for
 * nominalDeviasi. Going from -10M (SURPLUS) to -20M (SURPLUS) gives
 * calcGrowth = (-20M - (-10M)) / |-10M| = -100% (decreasing), but the
 * MAGNITUDE of deviation actually INCREASED 100% (got worse).
 *
 * This function uses magnitude: (|curr| - |prev|) / |prev|
 * — positive = magnitude increasing (worse)
 * — negative = magnitude decreasing (better)
 * — handles sign flips correctly (LOSS→SURPLUS still shows magnitude change)
 *
 * Returns null if |prev| = 0 (can't compute from zero base)
 * Returns 0 if both |curr| and |prev| are 0
 */
export function computeNominalDeviationGrowth(
  curr: number | null,
  prev: number | null,
): number | null {
  return calcGrowthAbs(curr, prev);
}

/**
 * Compute comprehensive growth result with direction flip detection
 *
 * Master context #31: Jangan mengandalkan growth saja pada signed value
 * saat sign berubah. Jika sign berubah → flag sebagai direction flip.
 */
export function computeGrowthResult(
  curr: number | null,
  prev: number | null,
  threshold: number = 0.1, // 10% change = significant
): GrowthResult {
  const growth = calcGrowth(curr, prev);

  // Direction flip detection (sign change)
  const isDirectionFlip = curr != null && prev != null
    && prev !== 0
    && Math.sign(curr) !== Math.sign(prev)
    && curr !== 0;

  // Trend classification
  let trend: GrowthResult['trend'] = 'UNKNOWN';
  if (growth != null) {
    if (growth > threshold) trend = 'INCREASING';
    else if (growth < -threshold) trend = 'DECREASING';
    else trend = 'STABLE';
  } else if (curr != null && (prev == null || prev === 0)) {
    trend = curr !== 0 ? 'NEW' : 'STABLE';
  } else if (curr == null && prev != null && prev !== 0) {
    trend = 'RESOLVED';
  }

  return { growth, isDirectionFlip, trend };
}

/**
 * Safe ratio: num / denom, null if denom = 0
 */
export function safeRatio(num: number | null, denom: number | null): number | null {
  if (num == null || denom == null || denom === 0) return null;
  return num / denom;
}

/**
 * Average price: |nominal / qty|
 * Returns null if qty = 0
 */
export function calcAvgPrice(nominal: number | null, qty: number | null): number | null {
  if (nominal == null || qty == null || qty === 0) return null;
  return Math.abs(nominal / qty);
}

// ============================================================
//  Price Effect Decomposition (multiplicative — exact)
//  Master context #13: Avg Price — Nominal effect = Quantity effect × Price effect
//
//  FIX (audit issue #12): Previous version used additive model
//  (nominalGrowth ≈ volumeEffect + priceEffect + operationalEffect)
//  which is an approximation. For volume+20% and price+10%, additive
//  gives +30% but true multiplicative is (1.2×1.1)-1 = +32%.
//
//  Now uses multiplicative decomposition:
//    nominalGrowth = (1+volumeEffect) × (1+priceEffect) × (1+operationalEffect) - 1
//    operationalEffect = nominalGrowth / ((1+volumeEffect) × (1+priceEffect)) - 1
//
//  This is EXACT: the three effects multiply to give total nominal growth.
//  operationalEffect = residual (what's left after volume and price explain).
// ============================================================

export interface PriceEffectResult {
  /** Price growth: (currPrice - prevPrice) / |prevPrice| */
  priceGrowth: number | null;
  /** Volume effect: growth in BOM/consumption volume (multiplicative factor - 1) */
  volumeEffect: number | null;
  /** Price effect: growth in average price (multiplicative factor - 1) */
  priceEffect: number | null;
  /** Operational effect: residual multiplicative factor - 1
   *  = nominalGrowth / ((1+volumeEffect) × (1+priceEffect)) - 1
   *  Positive = operational inefficiency (deviation grew beyond volume+price)
   *  Negative = operational improvement (deviation shrank beyond volume+price)
   */
  operationalEffect: number | null;
}

/**
 * Compute price effect decomposition (multiplicative — exact)
 *
 * Volume Effect = bomGrowth (how much volume changed)
 * Price Effect = priceGrowth (how much price changed)
 * Operational Effect = nominalGrowth / ((1+volumeEffect) × (1+priceEffect)) - 1
 *
 * All three effects are multiplicative:
 *   (1+nominalGrowth) = (1+volumeEffect) × (1+priceEffect) × (1+operationalEffect)
 */
export function computePriceEffect(
  nominalDeviasiGrowth: number | null,
  bomGrowth: number | null,
  currAvgPrice: number | null,
  prevAvgPrice: number | null,
): PriceEffectResult {
  const priceGrowth = calcGrowth(currAvgPrice, prevAvgPrice);

  const volumeEffect = bomGrowth;
  const priceEffect = priceGrowth;

  // Multiplicative: operationalEffect = nominalGrowth / (volume × price) - 1
  // Guard against division by zero or null
  const operationalEffect = (nominalDeviasiGrowth != null && volumeEffect != null && priceEffect != null)
    ? (() => {
        const volFactor = 1 + volumeEffect;
        const priceFactor = 1 + priceEffect;
        const combined = volFactor * priceFactor;
        if (combined === 0) return null;
        return (1 + nominalDeviasiGrowth) / combined - 1;
      })()
    : null;

  return { priceGrowth, volumeEffect, priceEffect, operationalEffect };
}
