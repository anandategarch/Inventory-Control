// ============================================================
//  WasteTab types — Deep Waste Analysis (DEEP-WASTE-1/2)
//  Client-side mirrors of the /api/waste-series +
//  /api/waste-top-items + /api/waste-peer-zscore payloads.
//  Kept local to the tab (same pattern as AreaItemHeatmap/types.ts
//  + resto-analysis/types.ts) — no cross-tab sharing today.
//  W2 (Kronis vs Episodik): field + tipe persistence ditambahkan
//  ADDITIF (optional — respons cache lama pra-W2 tidak memilikinya;
//  semua konsumen W2 wajib guard undefined).
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
  // ---- W2 (Kronis vs Episodik) — additive optional fields ----
  /** Comparable months: not DQ-error AND sales > 0 (ratio defined). */
  activeMonths?: number;
  /** DQ-error months — counted SEPARATELY as invalid, never above/below. */
  invalidMonths?: number;
  /** Non-DQ months with sales = 0 (wasteToSales undefined — excluded from the share denominator). */
  zeroSalesMonths?: number;
  /** Active months with wasteToSales above that month's network median. */
  monthsAboveMedian?: number;
  /** monthsAboveMedian / activeMonths (0 when activeMonths = 0). */
  aboveMedianShare?: number;
  /** Spike (2σ) months among ACTIVE months only (DQ months excluded). */
  activeSpikeMonths?: number;
  /** KRONIS / EPISODIK / SEHAT / TERBATAS — always INDIKASI. */
  persistenceClass?: WastePersistenceClass;
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
  /** W2 (Kronis vs Episodik) — additive network-level persistence block. */
  persistence?: WastePersistenceBlock;
  error?: string;
}

// ------------------------------------------------------------
// W2 — Kronis vs Episodik: persistence types (mirror of the
// /api/waste-series additive fields; server source of truth:
// src/lib/queries/waste/network/persistence.ts + types.ts)
// ------------------------------------------------------------

/** W2: per-outlet persistence class. All classes are INDIKASI (statistical indication, not proof). */
export type WastePersistenceClass = 'KRONIS' | 'EPISODIK' | 'SEHAT' | 'TERBATAS';

/** W2: per-month network median of wasteToSales over the month's ACTIVE outlets (seasonality control). */
export interface WasteMonthMedian {
  monthKey: string;
  monthLabel: string;
  medianWasteToSales: number;
  /** Active outlets that month (the median's n). */
  activeOutlets: number;
}

/** W2: network-level persistence summary — the numbers behind the "Kronis vs Episodik" card. */
export interface WastePersistenceSummary {
  transitionHH: number;
  transitionHL: number;
  transitionLH: number;
  transitionLL: number;
  transitionPairs: number;
  /** HH / (HH + HL); null when no high-start pairs. */
  pHighNextGivenHigh: number | null;
  /** LH / (LH + LL); null when no low-start pairs. */
  pHighNextGivenLow: number | null;
  /** [HH/(HH+HL)] / [LH/(LH+LL)]; null when undefined (never ±Infinity). */
  persistenceRatio: number | null;
  /** Two-sided Fisher exact p on [[HH, HL], [LH, LL]]; null when no pairs. */
  fisherP: number | null;
  monthsWithMedian: number;
  /** Smallest active-outlet count among months with a median (surfaces degenerate n=1 months). */
  minActiveOutletsPerMonth: number;
  classDistribution: {
    kronis: number;
    episodik: number;
    sehat: number;
    terbatas: number;
  };
  /** Epistemic label (house convention): indication, not proof. */
  epistemicLabel: 'INDIKASI';
}

/** W2: the top-level `persistence` response block — summary + per-month medians. */
export interface WastePersistenceBlock {
  summary: WastePersistenceSummary;
  medians: WasteMonthMedian[];
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
