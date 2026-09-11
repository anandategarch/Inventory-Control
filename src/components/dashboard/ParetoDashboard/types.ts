// ============================================================
//  ParetoDashboard — Type Definitions
//  --------------------------------------------------------
//  Mirrors backend response shape (see /api/pareto and
//  src/lib/queries/pareto.ts).
// ============================================================

// FIX #42: ParetoDimension mirror of backend enum (see src/lib/queries/pareto.ts)
export type ParetoDimension = 'item' | 'outlet' | 'area' | 'kelompok' | 'pic';

// FIX #42: nestedGeneralized child row shape (mirrors NestedParetoResultItem.children)
export interface NestedChild {
  name: string;
  // H-12 (nested-Pareto twin merge): outlet children also carry their display
  // columns from the backend (label = outlet name, area). Optional because
  // cache rows predating the merge don't have them.
  label?: string | null;
  area?: string | null;
  totalAbsNominal: number;
  nominalDeviasi: number;
  qtyDeviasi: number;
  sharePct: number;
  cumPct: number;
}
// FIX #42: nestedGeneralized parent row shape (mirrors NestedParetoResultItem)
export interface NestedGeneralizedItem {
  name: string;
  totalAbsNominal: number;
  nominalDeviasi: number;
  qtyDeviasi: number;
  outletCount: number;
  sharePct: number;
  cumPct: number;
  children: NestedChild[];
}

export interface ParetoRow {
  name: string;
  code?: string;
  outletCount?: number;
  totalAbsNominal: number;
  nominalDeviasi: number;
  qtyDeviasi: number; // SIGNED sum for display
  sharePct: number;
  cumPct: number;
  histAvg?: number | null;
  zScore?: number | null;
  histN?: number;
}
export interface ParetoResult {
  drivers: ParetoRow[];
  remainderCount: number;
  remainderPct: number;
  totalAbsNominal: number;
  totalCount: number;
}
export interface NestedOutlet {
  outletCode: string;
  outletName: string;
  area: string;
  totalAbsNominal: number;
  nominalDeviasi: number;
  qtyDeviasi: number;
  sharePct: number;
  cumPct: number;
}
export interface NestedItem {
  itemName: string;
  totalAbsNominal: number;
  nominalDeviasi: number;
  qtyDeviasi: number;
  outletCount: number;
  sharePct: number;
  cumPct: number;
  outlets: NestedOutlet[];
}
export interface ParetoData {
  success: boolean;
  byItem: ParetoResult;
  byOutlet: ParetoResult;
  byArea: ParetoResult;
  byKelompok: ParetoResult;
  byPIC: ParetoResult;
  nested: { items: NestedItem[]; totalAbsNominal: number };
  // FIX #42: optional generalized nested response (set when both parentDim +
  // childDim query params are sent to /api/pareto)
  nestedGeneralized?: {
    items: NestedGeneralizedItem[];
    totalAbsNominal: number;
    parentDim: ParetoDimension;
    childDim: ParetoDimension;
  };
  parentDim?: ParetoDimension;
  childDim?: ParetoDimension;
  durationMs?: number;
}
