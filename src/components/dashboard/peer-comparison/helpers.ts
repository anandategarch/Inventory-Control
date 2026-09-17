// ============================================================
//  Peer Comparison — shared helpers & static constants
// ============================================================

import { fmtIDR, fmtNum, fmtPctAbs } from '@/lib/format';
import type { MetricDef } from './types';

/**
 * Static metric column definitions for the peer table.
 * Drives both the table header (PeerTable) and the gap/ranking cards.
 *
 * `higherBetter`:
 *   true  → higher value = better (e.g. Sales, Total SURPLUS, Item Count)
 *   false → lower value = better (e.g. Dev/BOM, Total LOSS, QTY Waste)
 */
export const COLUMNS: MetricDef[] = [
  { key: 'sales',          label: 'Sales',          format: fmtIDR,                       higherBetter: true  },
  { key: 'nominalDeviasi', label: 'Nominal Deviasi', format: fmtIDR,                      higherBetter: false },
  { key: 'devBom',         label: 'Dev/BOM',        format: (v: number) => fmtPctAbs(v),  higherBetter: false },
  { key: 'totalLoss',      label: 'Total LOSS',     format: fmtIDR,                       higherBetter: false },
  { key: 'totalSurplus',   label: 'Total SURPLUS',  format: fmtIDR,                       higherBetter: true  },
  { key: 'qtyWaste',       label: 'QTY Waste',      format: fmtNum,                       higherBetter: false },
  { key: 'qtySusut',       label: 'QTY Susut',      format: fmtNum,                       higherBetter: false },
  { key: 'qtyTrial',       label: 'QTY Trial',      format: fmtNum,                       higherBetter: false },
  { key: 'qtyLossSurplus', label: 'QTY LS',         format: fmtNum,                       higherBetter: false },
  { key: 'residualQty',    label: 'Residual',       format: fmtNum,                       higherBetter: false },
  { key: 'itemCount',      label: 'Item Count',     format: (v: number) => String(v),     higherBetter: true  },
];

/**
 * Tailwind class for highlighting the target row's cells against peer average.
 *
 * - Empty string when there are no peers (peerCount === 0).
 * - `text-muted-foreground` when target ≈ avg (within 0.001 absolute).
 * - `text-emerald-600 dark:text-emerald-400 font-semibold` when target is *better* than avg.
 * - `text-red-600 dark:text-red-400 font-semibold` when target is *worse* than avg.
 *
 * P23 A1: MAGNITUDE comparison — compare |target| vs |avg|, not signed
 * difference. `nominalDeviasi` (and other signed sums) are deviations from
 * zero, so "better" = smaller |value| regardless of sign. The old signed
 * diff inverted the typical all-loss band: deeper-loss-than-avg rendered
 * EMERALD ("lebih baik") and less-loss rendered RED. Mirrors the FE-26
 * magnitude-gap approach in items-table.tsx + card-compute.ts abs-ranking.
 *
 * "Better" depends on `higherIsBetter`:
 *   true  → |target| > |avg| (target above avg) = better
 *   false → |target| < |avg| (target below avg) = better
 */
export function colorCell(
  targetVal: number,
  avgVal: number,
  peerCount: number,
  higherIsBetter: boolean = false,
): string {
  if (peerCount === 0) return '';
  // P23 A1: magnitude gap (|target| − |avg|) — for all-positive metrics
  // (sales, devBom, totalLoss, …) this is identical to the old signed diff;
  // for signed sums it correctly treats bigger deviation as worse.
  const diff = Math.abs(targetVal) - Math.abs(avgVal);
  if (Math.abs(diff) < 0.001) return 'text-muted-foreground';
  const isBetter = higherIsBetter ? diff > 0 : diff < 0;
  // P23 A1: dark: variants were missing on both semantic classes.
  return isBetter
    ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
    : 'text-red-600 dark:text-red-400 font-semibold';
}
