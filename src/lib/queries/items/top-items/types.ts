// ============================================================
//  Top Items — Shared Types
//  --------------------------------------------------------
//  Split out of the original src/lib/queries/items/top-items.ts
//  (722 LOC) to keep types separate from query logic. Re-exported
//  via the top-items/index.ts barrel — all existing
//  `@/lib/queries/items/top-items` imports keep working unchanged.
// ============================================================

export interface TopItemRow {
  itemName: string;
  outletCode: string;
  absNominal: number;
  direction: string;
}

// ============================================================
//  Pareto Dev/BOM — driver/outlet row types
//  --------------------------------------------------------
//  Used by queryParetoByDevBom (in ./by-other-metric) which returns
//  a Pareto 80/20 result of ITEMS with |Dev/BOM| > threshold,
//  each with a nested outlet breakdown.
// ============================================================
export interface ParetoDevBomOutletRow {
  outletCode: string;
  outletName: string;
  area: string;
  devBom: number;
  devBomAbs: number;
  nominalDeviasi: number;
  absNominal: number;
  sharePct: number;
  cumPct: number;
}

export interface ParetoDevBomRow {
  itemName: string;
  outletCount: number;
  devBom: number;
  devBomAbs: number;
  nominalDeviasi: number;
  absNominal: number;
  sharePct: number;
  cumPct: number;
  outlets: ParetoDevBomOutletRow[];
}

export interface ParetoDevBomResult {
  drivers: ParetoDevBomRow[];
  remainderCount: number;
  remainderPct: number;
  totalAbsNominal: number;
  totalCount: number;
  thresholdPct: number;
}
