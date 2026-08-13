// ============================================================
//  GROWTH METRICS — Single Implementation
//  --------------------------------------------------------
//  Growth = (Current - Previous) / ABS(Previous)
//
//  Two variants:
//   1. calcGrowth (signed): untuk nominal/sales — direction matters
//   2. calcGrowthAbs (magnitude): untuk BOM/COM (negative consumption) — use absolute
//
//  Master context #60: Growth = (curr - prev) / |prev|
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
//  Price Effect Decomposition
//  Master context #22, #55: Nominal effect = Quantity effect + Price effect
// ============================================================

export interface PriceEffectResult {
  /** Price growth: (currPrice - prevPrice) / |prevPrice| */
  priceGrowth: number | null;
  /** Volume effect: growth in BOM/consumption volume */
  volumeEffect: number | null;
  /** Price effect: growth in average price */
  priceEffect: number | null;
  /** Operational effect: residual = nominalGrowth - volumeEffect - priceEffect */
  operationalEffect: number | null;
}

/**
 * Compute price effect decomposition
 *
 * Volume Effect = bomGrowth (how much volume changed)
 * Price Effect = priceGrowth (how much price changed)
 * Operational Effect = nominalDeviasiGrowth - volumeEffect - priceEffect
 *                    (remaining = operational inefficiency)
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

  // Operational = total nominal growth - volume - price
  const operationalEffect = (nominalDeviasiGrowth != null && volumeEffect != null && priceEffect != null)
    ? nominalDeviasiGrowth - volumeEffect - priceEffect
    : null;

  return { priceGrowth, volumeEffect, priceEffect, operationalEffect };
}
