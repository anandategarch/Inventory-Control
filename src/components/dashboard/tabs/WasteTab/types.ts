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
//  W11 (Paritas Susut & Trial): field susutSpikeMonths (waste-series)
//  + field/tipe fingerprint & trial-screen & metric (waste-top-items)
//  ditambahkan ADDITIF (optional — guard cache pra-W11).
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
  // ---- W11 (Paritas Susut & Trial) — additive optional field ----
  /** Months with susut/sales > mean + 2σ of the outlet's own valid months
   *  (sales > 0; min 3, σ > 0 — the waste spike's discipline, metric-swapped
   *  to susut). Absent on pre-W11 cached responses. */
  susutSpikeMonths?: number;
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
  /** W11 (additive): per-outlet susut on the item (absent on pre-W11 caches). */
  susut?: number;
  /** W11 (additive): per-outlet trial on the item. */
  trial?: number;
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
  // ---- W11 (Paritas Susut & Trial) — additive optional fields (the
  // server fills them always; optional here for pre-W11 cached
  // responses, 5-min TTL — consumers guard undefined). ----
  /** Σ|nominalSusut| over the window. */
  susutNominal?: number;
  /** Σ|qtySusut| over the window. */
  susutQty?: number;
  /** Σ|nominalTrial| over the window. */
  trialNominal?: number;
  /** Σ|qtyTrial| over the window. */
  trialQty?: number;
  /** Σ|qtyBom| over the window (trial-screen ratio denominator). */
  bomQty?: number;
  /** Distinct months with trial > 0. */
  trialMonthsActive?: number;
  /** susutNominal / Σ|nominalSusut| scope. */
  susutShare?: number;
  /** trialNominal / Σ|nominalTrial| scope. */
  trialShare?: number;
  /** Running Σ susutShare in the metric order. */
  susutCumulativeShare?: number;
  /** Running Σ trialShare in the metric order. */
  trialCumulativeShare?: number;
  /** W/S/T fingerprint (shares of explained loss + class). */
  fingerprint?: WasteItemFingerprint | null;
}

export interface WasteTopItemsResponse {
  success: boolean;
  week?: string;
  limit?: number;
  /** W11: the ordering metric echo (default 'waste'). */
  metric?: WasteMetric;
  items?: WasteTopItemRow[];
  populationTotal?: number;
  /** W11: Σ|nominalSusut| across all items in scope (parity context). */
  susutPopulationTotal?: number;
  /** W11: Σ|nominalTrial| across all items in scope. */
  trialPopulationTotal?: number;
  lastMonthKey?: string | null;
  prevMonthKey?: string | null;
  /** BUGHUNT-R1 FIX 2 (additive): ACTUAL months in the window (≤ 12) — the
   *  sistematik threshold is ceil(windowMonths/2), not the cap's 6. */
  windowMonths?: number;
  /** W11: network-level fingerprint summary (class distribution). */
  fingerprint?: WasteFingerprintSummary | null;
  /** W11: trial-abuse screen rows over the returned items. */
  trialScreen?: WasteTrialScreenItem[];
  error?: string;
}

// ------------------------------------------------------------
// W11 — Paritas Susut & Trial: fingerprint + trial screen types
// (mirror of the /api/waste-top-items additive fields; server source
// of truth: src/lib/queries/waste/waste-top-items/{types,fingerprint}.ts)
// ------------------------------------------------------------

/** W11: the metric the top-N is ordered by. */
export type WasteMetric = 'waste' | 'susut' | 'trial';

/** W11: the dominant component of an item's explained loss (max-share). */
export type WasteFingerprintClass = 'W-DOMINANT' | 'S-DOMINANT' | 'T-DOMINANT';

/** W11: per-item W/S/T fingerprint (shares of the explained loss w+s+t). */
export interface WasteItemFingerprint {
  shareW: number;
  shareS: number;
  shareT: number;
  explainedNominal: number;
  /** Null when explained == 0 (TANPA EXPLAINED). */
  fingerprintClass: WasteFingerprintClass | null;
}

/** W11: network-level fingerprint summary. */
export interface WasteFingerprintSummary {
  classCounts: {
    wDominant: number;
    sDominant: number;
    tDominant: number;
    tanpaExplained: number;
  };
  epistemicLabel: 'INDIKASI';
}

/** W11: one trial-abuse screen row (3 signals AND; always INDIKASI). */
export interface WasteTrialScreenItem {
  itemId: number;
  itemName: string;
  satuan: string | null;
  trialNominal: number;
  trialQty: number;
  bomQty: number;
  /** trialQty / bomQty; null when bomQty = 0 (no usage basis). */
  trialToBom: number | null;
  trialMonthsActive: number;
  fingerprintClass: WasteFingerprintClass | null;
  epistemicLabel: 'INDIKASI';
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
