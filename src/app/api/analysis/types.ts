// ============================================================
//  ANALYSIS API — Shared TypeScript interfaces
//  All modules under /api/analysis import types from here.
// ============================================================

/** Per-item-outlet aggregate row produced by the main AGG_SQL query. */
export interface AggRow {
  outletCode: string;
  outletName: string;
  area: string;
  itemName: string;
  satuan: string;
  qtyBom: number;
  qtyDeviasi: number;
  qtyWaste: number;
  qtySusut: number;
  qtyTrial: number;
  qtyLossSurplus: number;
  nominalDeviasi: number;
  nominalWaste: number;
  nominalSusut: number;
  nominalTrial: number;
  nominalLossSurplus: number;
  residualQty: number;
  tolerancePct: number | null;
  avgPrice: number | null;
  direction: string | null;
}

/** Raw per-record fields (used for investigation worklist). */
export interface RawRow {
  direction: string | null;
  nominalDeviasi: number | null;
  absNominalDeviasi: number | null;
  qtyDeviasi: number | null;
  absQtyDeviasi: number | null;
  residualQty: number | null;
  residualRatio: number | null;
  tolerancePct: number | null;
  toleranceRaw: string | null;
  pctQtyDeviasiToBom: number | null;
  qtyBom: number | null;
}

/** Deviation direction derived from the sign of nominalDeviasi. */
export type Direction = 'LOSS' | 'SURPLUS' | 'NEUTRAL';

/** API filter parameters extracted from query string. */
export interface FilterParams {
  monthLabel: string | null;
  weekLabel: string | null;
  area: string | null;
  outletCode: string | null;
  pic: string | null;
}

/** Per-outlet aggregate built in-memory from AggRow stream. */
export interface OutletAgg {
  sales: number;
  absNominal: number;
  absQtyDev: number;
  qtyBom: number;
  direction: string | null;
  /** Signed sum of qtyDeviasi — used to derive direction (FIX P0-1 per §9) */
  signedQtyDev: number;
}

/** Cumulative totals across all AggRows (consumed by multiple modules). */
export interface Totals {
  totalSales: number;
  qtyBomTotal: number;
  qtyDeviasiTotal: number;
  qtyWasteTotal: number;
  qtySusutTotal: number;
  qtyTrialTotal: number;
  qtyLossSurplusTotal: number;
  nomDeviasiTotal: number;
  totalLoss: number;
  totalSurplus: number;
  residualLossQty: number;
}

/** A value-with-growth object (current/previous/growth) used in exec summary. */
export interface GrowthSlot {
  current: number;
  previous: number | null;
  growth: number | null;
}

/** Executive summary object returned in the API response. */
export interface ExecutiveSummary {
  period: {
    monthLabel: string | null;
    weekLabel: string | null;
    comparisonWeek: string | null;
  };
  sales: GrowthSlot;
  nominalDeviasi: GrowthSlot;
  qtyBom: GrowthSlot;
  qtyDeviasi: GrowthSlot;
  qtyWaste: GrowthSlot;
  qtySusut: GrowthSlot;
  qtyTrial: GrowthSlot;
  qtyLossSurplus: GrowthSlot;
  totalLoss: number;
  totalSurplus: number;
  lossToSales: number | null;
  surplusToSales: number | null;
  deviationToBom: number | null;
  residualLossQty: number;
  residualLossPct: number | null;
}

/** Compare-mode flag returned in API response period block. */
export type CompareMode = 'auto' | 'manual';

/** Result of resolving the comparison period (auto or manual). */
export interface CompareResolution {
  compareWeek: string | null;
  compareMonth: string | null;
  compareMode: CompareMode;
}

// ------------------------------------------------------------
//  Top-item / top-outlet shapes
// ------------------------------------------------------------

export interface TopItemByNominal {
  itemName: string;
  outletCode: string;
  absNominal: number;
  direction: Direction;
}

export interface TopItemByDevBom {
  itemName: string;
  outletCode: string;
  devBom: number;
  tolerance: number | null;
}

export interface TopItemByBom {
  itemName: string;
  outletCode: string;
  qtyBom: number;
  satuan: string;
}

export interface TopItemByWaste {
  itemName: string;
  outletCode: string;
  qtyWaste: number;
  nominalWaste: number;
}

export interface TopItemBySusut {
  itemName: string;
  outletCode: string;
  qtySusut: number;
  nominalSusut: number;
}

export interface TopItemByTrial {
  itemName: string;
  outletCode: string;
  qtyTrial: number;
  nominalTrial: number;
}

export interface TopItemByLossSurplus {
  itemName: string;
  outletCode: string;
  qtyLossSurplus: number;
  nominalLossSurplus: number;
  direction: Direction;
}

export interface TopOutlet {
  outletCode: string;
  outletName: string;
  area: string;
  absNominal: number;
  devBom: number;
  areaAvg: number;
  direction: Direction;
  sales: number;
  /** FIX P1-1: derived flag — true when devBom > BENCHMARK_AREA_FACTOR × areaAvg */
  aboveArea?: boolean;
  /** P1-4: derived flag — true when devBom > BENCHMARK_NETWORK_FACTOR × networkAvg */
  aboveNetwork?: boolean;
}

export interface TopOutletBySales {
  outletCode: string;
  outletName: string;
  area: string;
  sales: number;
  absNominal: number;
  devToSalesRatio: number | null;
}

// ------------------------------------------------------------
//  Breakdown / loss-vs-surplus / health / dq
// ------------------------------------------------------------

export interface DeviationBreakdown {
  waste: number;
  susut: number;
  trial: number;
  residual: number;
  total: number;
}

export interface LossVsSurplus {
  loss: number;
  surplus: number;
  lossNominal: number;
  surplusNominal: number;
}

export interface HealthBreakdown {
  normal: number;
  warning: number;
  abnormal: number;
}

export interface DqStatus {
  ok: number;
  warnings: number;
  errors: number;
  /** FIX §27: Duplicate records (same outlet+item+week+akunPenyesuaian) */
  duplicates?: number;
  /** FIX §27: Sales mismatch (same outlet, different sales values across rows) */
  salesMismatch?: number;
}

export interface WorklistItem {
  priority: 'P1' | 'P2' | 'P3';
  outletCode: string;
  outletName: string;
  area: string;
  itemName: string;
  issue: string;
  evidence: string;
  recommendedAction: string;
  ruleCodes: string[];
  absNominalDeviasi: number;
  deviationToBom: number | null;
  direction: Direction;
  /** FIX §24: New fields */
  /** Metric snapshot (e.g. "Residual: 95%" / "Nominal: Rp 75.000.000") */
  metric: string;
  /** Benchmark reference (e.g. "Threshold: 70% (RESIDUAL_LOSS_HIGH_PCT)") */
  benchmark: string;
  /** Possible cause narrative for the detected anomaly */
  possibleCause: string;
  /** Investigation status — always 'OPEN' when first emitted by the engine */
  status: 'OPEN' | 'INVESTIGATING' | 'RESOLVED';
}

// ------------------------------------------------------------
//  Trend / growth / variance / advanced analysis shapes
// ------------------------------------------------------------

export interface TrendPoint {
  weekLabel: string;
  devBom: number;
  sales: number;
  nominal: number;
}

export interface GrowthComparison {
  salesGrowth: number | null;
  bomGrowth: number | null;
  qtyDeviasiGrowth: number | null;
  nominalDeviasiGrowth: number | null;
  priceGrowth: number | null;
  deviationToSalesRatio: number | null;
  deviationToBomRatio: number | null;
  /** FIX §12: Growth Gap = nominalDeviasiGrowth − salesGrowth */
  growthGap: number | null;
  /** FIX §12: Deviation/Sales ratio for previous period */
  deviationToSalesPreviousRatio: number | null;
  /** FIX §12: Ratio Change = current ratio − previous ratio */
  ratioChange: number | null;
  /** P0-3: Trend Decomposition — three-effect breakdown of nominalDeviasiGrowth */
  volumeEffect: number | null;       // qtyDeviasiGrowth × avgPrice_prev
  priceEffect: number | null;        // priceGrowth × qtyDeviasi_prev
  operationalEffect: number | null;  // nominalDeviasiGrowth − volumeEffect − priceEffect
  /** P0-2: Historical Z-Score analysis per outlet */
  historicalAnalysis: HistoricalAnalysisItem[];
  /** P1-1: Multi-Period Comparison trend table */
  multiPeriodComparison: MultiPeriodRow[];
}

/** P0-2: Historical Z-Score result per outlet */
export interface HistoricalAnalysisItem {
  outletCode: string;
  outletName: string;
  area: string;
  /** Current-period absolute nominal deviation */
  current: number;
  /** Mean of historical |nominalDeviasi| over the lookback window */
  avg: number;
  /** Standard deviation of historical |nominalDeviasi| */
  stdDev: number;
  /** Z-score = (current − avg) / stdDev (null when stdDev is 0) */
  zScore: number | null;
  /** Number of historical weeks used in the calculation */
  weeksUsed: number;
  /** True when zScore > HISTORICAL_ZSCORE_WARN */
  isAbnormal: boolean;
  /** True when zScore > HISTORICAL_ZSCORE_HIGH (critical) */
  isCritical: boolean;
}

/** P1-1: Multi-Period Comparison row */
export interface MultiPeriodRow {
  /** Period label (e.g. "Week 4 Januari 2026") */
  period: string;
  /** Period offset from current (0 = current, 1 = previous, etc.) */
  offset: number;
  sales: number;
  bom: number;
  deviation: number;
  /** Absolute nominal deviation */
  absDeviation: number;
  /** Deviation/BOM ratio */
  devBomRatio: number | null;
  /** Growth % vs the previous row (null for first row) */
  growthPct: number | null;
}

export interface VarianceItem {
  itemName: string;
  outletCode: string;
  outletName: string;
  currentNominal: number;
  previousNominal: number;
  change: number;
  changePct: number | null;
  /** FIX P1-5: classification — WORSENED / IMPROVED / DIRECTION_REVERSAL / NEW / DISAPPEARED / STABLE */
  classification: 'WORSENED' | 'IMPROVED' | 'DIRECTION_REVERSAL' | 'NEW' | 'DISAPPEARED' | 'STABLE';
  /** Previous direction (LOSS/SURPLUS/NEUTRAL) */
  prevDirection?: string;
  /** Current direction (LOSS/SURPLUS/NEUTRAL) */
  currDirection?: string;
}

export interface VarianceAnalysis {
  topWorsened: VarianceItem[];
  topImproved: VarianceItem[];
  /** FIX P1-6: items that appeared in current but not in previous */
  newItems: VarianceItem[];
  /** FIX P1-6: items that disappeared from current (were in previous) */
  disappearedItems: VarianceItem[];
  /** FIX P1-5: items where direction flipped (LOSS↔SURPLUS) */
  directionReversals: VarianceItem[];
  /** P2-6: items with |change| < 500K IDR — classified as STABLE (not surfaced elsewhere) */
  stableItems: VarianceItem[];
}

export interface OutletHealthRank {
  outletCode: string;
  outletName: string;
  area: string;
  healthScore: number;
  devBomRatio: number;
  residualPct: number;
  lossToSales: number;
  abnormalCount: number;
  totalNominalDeviasi: number;
  rank: number;
}

export type ItemConsistencyLevel = 'SYSTEMIC' | 'WIDESPREAD' | 'ISOLATED';

export interface ItemConsistency {
  itemName: string;
  satuan: string;
  outletCount: number;
  totalAbsNominal: number;
  avgDevBom: number;
  lossOutlets: number;
  surplusOutlets: number;
  consistency: ItemConsistencyLevel;
}

export interface AreaAnalysisItem {
  area: string;
  outletCount: number;
  totalSales: number;
  totalAbsNominal: number;
  avgDevBom: number;
  lossToSales: number;
}

export interface Recommendation {
  why: string;
  what: string[];
  priority: 'P1' | 'P2' | 'P3';
}

/** Full top-items bundle returned by computeTopItems. */
export interface TopItemsBundle {
  topItemsByNominal: TopItemByNominal[];
  topItemsByDevBom: TopItemByDevBom[];
  topItemsByBom: TopItemByBom[];
  topItemsByWaste: TopItemByWaste[];
  topItemsBySusut: TopItemBySusut[];
  topItemsByTrial: TopItemByTrial[];
  topItemsByLossSurplus: TopItemByLossSurplus[];
}

/** Full top-outlets bundle returned by computeTopOutlets. */
export interface TopOutletsBundle {
  topOutlets: TopOutlet[];
  topOutletsBySales: TopOutletBySales[];
}

/** Bundle of aggregate outputs used by narrative + recommendations. */
export interface ExecSummaryBundle {
  execSummary: ExecutiveSummary;
  byOutlet: Map<string, OutletAgg>;
  totals: Totals;
  salesByOutlet: Map<string, number>;
}
