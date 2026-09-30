// ============================================================
//  WasteTab types — Deep Waste Analysis (DEEP-WASTE-1/2)
//  Client-side mirrors of the /api/waste-series +
//  /api/waste-top-items + /api/waste-peer-zscore payloads.
//  Kept local to the tab (same pattern as AreaItemHeatmap/types.ts
//  + resto-analysis/types.ts) — no cross-tab sharing today.
// ============================================================

export interface WasteMonthMeta {
  monthKey: string;
  monthLabel: string;
  dqError: boolean;
  dqErrorCount: number;
}

export interface WasteMonthlyRow {
  outletCode: string;
  outletName: string;
  area: string;
  monthKey: string;
  monthLabel: string;
  sales: number;
  waste: number;
  susut: number;
  trial: number;
  residual: number;
  totalLoss: number;
  totalSurplus: number;
  wasteToSales: number;
  wasteShareOfLoss: number;
  residualShare: number;
  spike: boolean;
  dqError: boolean;
  dqErrorCount: number;
}

export interface WasteOutletRow {
  outletCode: string;
  outletName: string;
  area: string;
  months: number;
  sales: number;
  waste: number;
  susut: number;
  trial: number;
  residual: number;
  totalLoss: number;
  totalSurplus: number;
  wasteToSales: number;
  wasteShareOfLoss: number;
  residualShare: number;
  spikeMonths: number;
  rankWasteToSales: number;
  zeroWasteBigLoss: boolean;
  underRecording: boolean;
  residualDominant: boolean;
}

export interface WasteKpis {
  outlets: number;
  months: number;
  sales: number;
  waste: number;
  susut: number;
  trial: number;
  residual: number;
  totalLoss: number;
  totalSurplus: number;
  wasteToSales: number;
  zeroWasteBigLossOutlets: number;
  underRecordingOutlets: number;
  residualDominantOutlets: number;
  spikeCells: number;
}

export interface WasteSeriesResponse {
  success: boolean;
  week?: string;
  months?: WasteMonthMeta[];
  monthly?: WasteMonthlyRow[];
  outlets?: WasteOutletRow[];
  kpis?: WasteKpis;
  error?: string;
}

export interface WasteItemOutletBreakdown {
  outletCode: string;
  outletName: string;
  area: string;
  waste: number;
  monthsActive: number;
  shareOfItem: number;
}

export interface WasteTopItemRow {
  itemId: number;
  itemName: string;
  satuan: string | null;
  totalWaste: number;
  wasteQty: number;
  outletsActive: number;
  monthsActive: number;
  share: number;
  cumulativeShare: number;
  lastMonthWaste: number;
  prevMonthWaste: number;
  sistematik: boolean;
  byOutlet: WasteItemOutletBreakdown[];
}

export interface WasteTopItemsResponse {
  success: boolean;
  week?: string;
  limit?: number;
  items?: WasteTopItemRow[];
  populationTotal?: number;
  lastMonthKey?: string | null;
  prevMonthKey?: string | null;
  /** BUGHUNT-R1 FIX 2 (additive): ACTUAL months in the window (≤ 12) — the
   *  sistematik threshold is ceil(windowMonths/2), not the cap's 6. */
  windowMonths?: number;
  error?: string;
}

export interface WastePeerZScoreRow {
  monthKey: string;
  monthLabel: string;
  targetSales: number;
  waste: number;
  wasteToSales: number;
  rankWasteToSales: number;
  bandSize: number;
  bandMean: number;
  bandStd: number;
  zScore: number | null;
}

export interface WastePeerZScoreSummary {
  monthsTracked: number;
  avgZ: number | null;
  monthsZAbove1: number;
  monthsZAbove2: number;
  monthsHighestWaste: number;
  salesGrowth: number | null;
  paradox: boolean;
  lastMonthLabel: string | null;
  lastWasteToSales: number | null;
  lastRankWasteToSales: number | null;
  lastZScore: number | null;
  lastBandSize: number | null;
}

export interface WastePeerZScoreResponse {
  success: boolean;
  records?: WastePeerZScoreRow[];
  summary?: WastePeerZScoreSummary;
  error?: string;
}
