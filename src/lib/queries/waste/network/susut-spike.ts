// ============================================================
//  W11 — Paritas Susut & Trial: susut spike builder (PURE)
//  --------------------------------------------------------
//  Business question (findings-DEEPWASTE2-B §2 W11): "susut spike
//  terlihat in-app" — outlet mana yang SUSUT-nya (bukan waste-nya)
//  melonjak dibanding riwayat sendiri? Susut Rp 29,65 M vs waste
//  Rp 16,37 M live (1,8×) — detektor waste saja tidak melihat
//  pergerakan susut.
//
//  Input  : WasteMonthlyRow[] — the SAME monthly rows already
//           assembled by queryWasteNetwork (per (outlet, bulan)
//           same-week aggregates incl. susut, sales, dqError).
//           No SQL, no db — a pure second pass (house compute/
//           classify split, same as ./persistence.ts W2). ZERO
//           extra SQL round trips.
//  Output : per-outlet { susutSpikeMonths } merged ADDITIVELY onto
//           WasteOutletRow by ./query.ts (optional field — the pure
//           buildWasteOutlets path never computes it).
//
//  METHODOLOGICAL DECISIONS (pinned by tests):
//   1. EXACT metric-swap twin of the SQL waste spike detector
//      (query.ts CTE outlet_stats/monthly_final — the "hist twins
//      metric-swapped" precedent from rule-evaluation/zscore-rules.ts):
//      susutToSales = susut/sales per month with sales > 0; baseline =
//      mean + WASTE_SPIKE_SIGMA(2) × STDDEV_SAMP over the outlet's own
//      valid months; a month spikes when its ratio EXCEEDS the baseline
//      STRICTLY; guards: n ≥ WASTE_SPIKE_MIN_MONTHS(3) AND σ > 0.
//   2. "Valid month" = sales > 0 (ratio defined) — mirroring the SQL
//      waste spike's NULL-skip discipline (BUGHUNT-R1 FIX 7: forced-0
//      sales months would deflate the mean and crush σ, manufacturing
//      fake spikes). DQ-error months are NOT excluded — the SQL waste
//      spike does not exclude them either; the susut twin stays
//      byte-faithful to its sibling so the two badges (2σ×n waste vs
//      S2σ×n susut) are directly comparable on the profile table.
//      (W2 persistence's stricter !dqError active-month discipline was
//      a different feature's documented decision — not imported here.)
//   3. Output carries susutRatioMonths (the baseline n) for
//      transparency: a 1-spike reading over 3 valid months is weaker
//      evidence than over 9.
// ============================================================
import { WASTE_SPIKE_MIN_MONTHS, WASTE_SPIKE_SIGMA } from '../shared';
import type { WasteMonthlyRow, WasteOutletSusutSpike } from './types';

// ------------------------------------------------------------
// Pure transform (exported for vitest)
// ------------------------------------------------------------

/**
 * Per-outlet susut spike months from the network monthly rows — the
 * metric-swap twin of the SQL waste spike (susutToSales vs wasteToSales).
 * PURE: no mutation, no DB.
 */
export function buildSusutSpike(monthly: WasteMonthlyRow[]): WasteOutletSusutSpike[] {
  const byOutlet = new Map<string, WasteMonthlyRow[]>();
  for (const r of monthly) {
    const list = byOutlet.get(r.outletCode);
    if (list) list.push(r);
    else byOutlet.set(r.outletCode, [r]);
  }
  const outlets: WasteOutletSusutSpike[] = [];
  for (const [outletCode, rows] of byOutlet) {
    // Valid months: sales > 0 (ratio defined). sales = 0 months are
    // skipped entirely — FIX 7 discipline (see header decision 2).
    const ratios: number[] = [];
    for (const r of rows) {
      if (r.sales > 0) ratios.push(r.susut / r.sales);
    }
    const n = ratios.length;
    if (n < WASTE_SPIKE_MIN_MONTHS) {
      // Guard: not enough baseline months — no spike claim possible.
      outlets.push({ outletCode, susutSpikeMonths: 0, susutRatioMonths: n });
      continue;
    }
    const mean = ratios.reduce((a, x) => a + x, 0) / n;
    // STDDEV_SAMP equivalent (the SQL twin uses STDDEV_SAMP): two-pass
    // sample variance with the n-1 denominator; n ≥ 3 here so n-1 > 0.
    const variance = ratios.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1);
    const std = Math.sqrt(variance);
    if (!(std > 0)) {
      // Guard: zero variance (e.g. identical ratios) — a constant series
      // cannot spike above its own mean by any margin (strict >).
      outlets.push({ outletCode, susutSpikeMonths: 0, susutRatioMonths: n });
      continue;
    }
    const threshold = mean + WASTE_SPIKE_SIGMA * std;
    const susutSpikeMonths = ratios.filter((x) => x > threshold).length;
    outlets.push({ outletCode, susutSpikeMonths, susutRatioMonths: n });
  }
  return outlets;
}
