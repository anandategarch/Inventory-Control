// ============================================================
//  Pareto Analysis — Shared Types
//  --------------------------------------------------------
//  Split out of the original src/lib/queries/pareto.ts (794 LOC)
//  to keep types separate from query logic. Re-exported via the
//  pareto/index.ts barrel — all existing `@/lib/queries/pareto`
//  imports keep working unchanged.
// ============================================================

export interface ParetoRow {
  name: string;
  code?: string;
  totalAbsNominal: number;
  nominalDeviasi: number;
  qtyDeviasi: number; // SIGNED sum — for display (negative=LOSS, positive=SURPLUS)
  outletCount?: number;
  sharePct: number;
  cumPct: number;
}

export interface ParetoResult {
  drivers: ParetoRow[];
  remainderCount: number;
  remainderPct: number;
  totalAbsNominal: number;
  totalCount: number;
}

export type ParetoDimension = 'item' | 'outlet' | 'area' | 'kelompok' | 'pic';

export interface DimensionExpr {
  /** SQL fragment for GROUP BY + SELECT alias. Bare identifier or expression. */
  groupExpr: string;
  /** JOIN "Item" ... clause, or '' if not needed for this dimension. */
  joinItem: string;
  /** JOIN "Outlet" ... clause, or '' if not needed. */
  joinOutlet: string;
  /** LEFT JOIN "OutletPIC" ... clause, or '' if not needed. */
  joinPIC: string;
}

export interface NestedParetoItem {
  itemName: string;
  totalAbsNominal: number;
  nominalDeviasi: number;
  qtyDeviasi: number;
  outletCount: number;
  sharePct: number;
  cumPct: number;
  outlets: Array<{
    outletCode: string;
    outletName: string;
    area: string;
    totalAbsNominal: number;
    nominalDeviasi: number;
    qtyDeviasi: number;
    sharePct: number;
    cumPct: number;
  }>;
}

export interface NestedParetoResultItem {
  name: string;
  totalAbsNominal: number;
  nominalDeviasi: number;
  qtyDeviasi: number;
  outletCount: number;
  sharePct: number;
  cumPct: number;
  children: Array<{
    name: string;
    /**
     * Display label for outlet children (o.name — e.g. "Bandung Setiabudhi"),
     * filled when childDim='outlet' (H-12 nested-Pareto twin merge — lets
     * the legacy NestedParetoItem shape derive from the generalized core
     * without a second query). Null for every other child dimension.
     */
    label: string | null;
    /** Display area for outlet children (o.area). Null for other child dims. */
    area: string | null;
    totalAbsNominal: number;
    nominalDeviasi: number;
    qtyDeviasi: number;
    sharePct: number;
    cumPct: number;
  }>;
}
