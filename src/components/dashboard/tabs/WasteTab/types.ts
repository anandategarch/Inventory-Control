// ============================================================
//  WasteTab types — Deep Waste Analysis (DEEP-WASTE-1/2)
//  Client-side mirrors of the /api/waste-series +
//  /api/waste-top-items + /api/waste-peer-zscore payloads.
//  Kept local to the tab (same pattern as AreaItemHeatmap/types.ts
//  + resto-analysis/types.ts) — no cross-tab sharing today.
//  W2 (Kronis vs Episodik): field + tipe persistence ditambahkan
//  ADDITIF (optional — respons cache lama pra-W2 tidak memilikinya;
//  semua konsumen W2 wajib guard undefined).
//  W10 (Atribusi + Skenario Sensitivitas Residual): field + tipe
//  attribution ditambahkan ADDITIF (optional — guard cache lama).
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
  /** W10 (Atribusi + Skenario Sensitivitas Residual) — additive network-level attribution block. */
  attribution?: WasteAttributionResult;
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

// ------------------------------------------------------------
// W10 — Atribusi + Skenario Sensitivitas Residual: attribution types
// (mirror of the /api/waste-series additive `attribution` block;
// server source of truth: src/lib/queries/waste/network/attribution.ts
// + types.ts — kept structurally identical so the decomposition card
// can also recompute the SAME block locally from `monthly` via the
// pure builder without a second request)
// ------------------------------------------------------------

/** W10: one measured component of the loss-side composition. */
export interface WasteAttributionComponent {
  key: 'waste' | 'susut' | 'trial';
  label: string;
  /** Window Σ|nominal| of the component (measured). */
  nominal: number;
  /** nominal / totalLoss (0 when totalLoss = 0). */
  shareOfLoss: number;
  /** Measured aggregate (house epistemic convention). */
  epistemicLabel: 'TERUKUR';
}

/** W10: one hypothesis row of the p-grid — never a measurement. */
export interface WasteAttributionScenario {
  /** Fraction of the loss-side residual assumed to be unrecorded waste. */
  p: number;
  /** W + p·residual (the assumed true waste). */
  trueWaste: number;
  /** trueWaste / sales (0 when sales = 0) — implied waste/sales. */
  impliedWasteToSales: number;
  /** trueWaste / totalLoss (0 when totalLoss = 0) — implied share of loss. */
  impliedWasteShareOfLoss: number;
  /** Outlets moving ≥ 1 decile of wasteToSales when waste is re-estimated at p. */
  decileShifts: number;
  /** Hypothesis, not measurement (house epistemic convention). */
  epistemicLabel: 'HIPOTESIS';
}

/** W10: the headline decile-shift index (the p = 50% scenario row). */
export interface WasteAttributionDecile {
  p: number;
  /** Ranking population = outlets with sales > 0 (ratio defined). */
  outletsRanked: number;
  /** Outlets excluded from the deciles (sales = 0 — ratio undefined). */
  outletsExcluded: number;
  /** Outlets whose decile changed at this p. */
  outletsMoved: number;
  /** outletsMoved / outletsRanked (0 when no ranked outlets). */
  movedShare: number;
  /** Derived from the scenario hypothesis — never a measurement. */
  epistemicLabel: 'HIPOTESIS';
}

/** W10: the top-level `attribution` response block. */
export interface WasteAttributionResult {
  sales: number;
  waste: number;
  susut: number;
  trial: number;
  residual: number;
  totalLoss: number;
  /** W + S + T. */
  explainedNominal: number;
  /** (W+S+T) / totalLoss (0 when totalLoss = 0). */
  explainedShare: number;
  /** residual / totalLoss (0 when totalLoss = 0) — ≈ 1 BY CONSTRUCTION on loss rows. */
  residualShare: number;
  components: WasteAttributionComponent[];
  /** p ∈ {0, 0.3, 0.5, 0.7} — WASTE_ATTRIBUTION_SCENARIO_P order. */
  scenarios: WasteAttributionScenario[];
  decile: WasteAttributionDecile;
  /** Mandatory structural disclosure — render on every W10 surface. */
  disclosure: string;
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
