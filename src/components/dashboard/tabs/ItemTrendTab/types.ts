// ============================================================
//  ItemTrendTab — Types & Constants
//  --------------------------------------------------------
//  Pure type + constant module shared across the ItemTrendTab
//  sub-components. No 'use client', no React imports — fully
//  tree-shakeable.
// ============================================================

import type { ItemTrendMetric, ItemTrendPeriod } from '@/hooks/useAnalysis';

// ----------------------------------------------------------------
//  Metric selector config — 4 options matching /api/item-trend.
// ----------------------------------------------------------------

export interface MetricOption {
  value: ItemTrendMetric;
  label: string;
  /** Field on ItemTrendPeriod to plot on the left Y axis. */
  field: keyof ItemTrendPeriod;
  /** Whether the field is signed (use qtyDeviasiSigned for Deviasi). */
  signed?: boolean;
  shortLabel: string;
}

export const METRICS: MetricOption[] = [
  { value: 'qtyDeviasi', label: 'QTY Deviasi', field: 'qtyDeviasiSigned', signed: true, shortLabel: 'Deviasi' },
  { value: 'qtyWaste', label: 'QTY Waste', field: 'qtyWaste', shortLabel: 'Waste' },
  { value: 'qtySusut', label: 'QTY Susut', field: 'qtySusut', shortLabel: 'Susut' },
  { value: 'qtyTrial', label: 'QTY Trial', field: 'qtyTrial', shortLabel: 'Trial' },
];

// ----------------------------------------------------------------
//  Autocomplete (uses /api/item-search?mode=autocomplete — same
//  pattern as GlobalItemSearchModal).
// ----------------------------------------------------------------

export interface AutocompleteResult {
  itemName: string;
  outletCount: number;
  totalAbsNominal: number;
}

// ----------------------------------------------------------------
//  Sort keys for the data table.
// ----------------------------------------------------------------

export type SortKey = 'period' | 'qtyBom' | 'qtyDeviasiSigned' | 'zScore' | 'outletCount' | 'recordCount' | 'flip';
export type SortDir = 'asc' | 'desc';

// ----------------------------------------------------------------
//  Flip detection (Phase A+B / FLIP-FE) — re-export for convenience.
//  The actual implementation lives in ./flipHelpers (pure module,
//  no 'use client'). Callers importing from
//  '@/components/dashboard/tabs/ItemTrendTab' can access these types
//  without needing to know about the internal helper file layout.
// ----------------------------------------------------------------
export type { FlipAnalysis, ItemFlipScore } from './flipHelpers';
