// ============================================================
//  AreaItemHeatmap — Type Definitions
//  --------------------------------------------------------
//  Mirrors backend response shape (see /api/area-item-heatmap
//  and src/lib/queries/heatmap.ts).
//  Pure types — no React, no 'use client', tree-shakeable.
// ============================================================

export type HeatmapMetric =
  | 'absNominalDeviasi'
  | 'nominalWaste'
  | 'nominalSusut'
  | 'pctQtyDeviasiToBom'
  | 'recordCount';

export type ItemSelectMode = 'pareto80' | 'top';

export interface HeatmapCell {
  area: string;
  itemName: string;
  value: number;
  recordCount: number;
  outletCount: number;
  qtyBom: number;
  qtyDeviasi: number;
  qtyWaste: number;
  qtySusut: number;
  qtyTrial: number;
  nominalDeviasi: number;
  nominalLossSurplus: number;
}

export interface ParetoInfo {
  totalItems: number;
  selectedItems: number;
  cumulativePct: number;
  totalMagnitude: number;
}

export interface HeatmapResponse {
  success: boolean;
  areas: string[];
  items: string[];
  cells: HeatmapCell[];
  metric: HeatmapMetric;
  maxValue: number;
  itemSelectMode: ItemSelectMode;
  paretoInfo: ParetoInfo;
}

// PERF-FE: CellDetailRow + CellDetailSheet moved to AreaItemHeatmapSheet.tsx
// (lazy-loaded via next/dynamic in index.tsx).
