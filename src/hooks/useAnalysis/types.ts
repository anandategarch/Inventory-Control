// ============================================================
//  Analysis Types — shared shapes for /api/analysis consumers
//  --------------------------------------------------------
//  Source: src/hooks/useAnalysis.ts (split into useAnalysis/
//  folder by Task ID 3-a). All exported interfaces here are
//  re-exported from the barrel at useAnalysis/index.ts so
//  `import { type AnalysisData } from '@/hooks/useAnalysis'`
//  keeps working unchanged.
//
//  Item-level top-N ranking shapes (mirror of API response)
//  Source: src/lib/queries/items.ts + src/app/api/analysis/route.ts
// ============================================================
import type { ExecutiveSummary } from '@/types/inventory';
// FIX (AUDIT7-FE-5): import TrendProjection + PatternDetection so the API
// response fields (`trendProjection`, `patterns`) emitted by /api/analysis
// (analysis/route.ts:989-990) are properly typed on the frontend. Previously
// computed + sent but never typed — dead data per worklog FORECAST-3.
import type { TrendProjection } from '@/lib/metrics/forecast';
import type { PatternDetection } from '@/engine/analysis/patternEngine';

/** Top items by nominal deviation. */
export interface TopItemByNominal {
  itemName: string;
  outletCode: string;
  absNominal: number;
  nominalDeviasi: number;
  direction: string;
}

/** Top items by Dev/BOM ratio. */
export interface TopItemByDevBom {
  itemName: string;
  outletCode: string;
  devBom: number;
  devBomAbs: number;
  tolerance: number | null;
}

/** Top outlet (with direction + loss/surplus magnitude). */
export interface TopOutlet {
  outletCode: string;
  outletName: string;
  area: string;
  absNominal: number;      // ABS — for sorting only
  nominalDeviasi: number;  // FIX: signed SUM for display
  devBom: number;
  areaAvg: number;
  sales: number;
  lossAmount: number;
  surplusAmount: number;
  direction: string;
}

/** Top outlets ranked by sales (mode per outlet). */
export interface TopOutletBySales {
  outletCode: string;
  outletName: string;
  area: string;
  sales: number;
  absNominal: number;      // ABS — for sorting only
  nominalDeviasi: number;  // FIX: signed SUM for display
  devToSalesRatio: number | null;
}

/** Top items by Waste / Susut / Trial / LossSurplus (category top-N). */
export interface TopItemByCategory {
  itemName: string;
  outletCode: string;
  /** Maps to qtyWaste / qtySusut / qtyTrial / qtyLossSurplus depending on source. */
  qty: number;
  /** Maps to nominalWaste / nominalSusut / nominalTrial / nominalLossSurplus depending on source. */
  nominal: number;
  direction: string;
}

/** National item ranking (per item-outlet pair) for Deviasi Rank card. */
export interface DeviasiRankItem {
  itemName: string;
  outletCode: string;
  outletName: string;
  pic: string | null;
  satuan: string | null;
  qtyDeviasi: number;
  qtyWaste: number;
  qtyLossSurplus: number;
  pctLossSurplusToBom: number | null;
  qtyBom: number;
  avgDeviasiByBom: number | null;
  nominalDeviasi: number;
  rankNominal: number;
  /** FIX (BUG-1-01): rankBom is NULLABLE — SQL returns NULL for items with
   *  qtyBom=0 (BOM ranking doesn't apply). Was `number` (non-nullable) which
   *  masked null→0 coercion in the query layer. Frontend defends with `> 0`
   *  check but the type contract is now accurate. */
  rankBom: number | null;
}

/** Multi-period comparison row (injected into growthComparison.multiPeriodComparison). */
export interface MultiPeriodComparisonRow {
  period: string;
  sales: number;
  bom: number | null;
  deviation: number;
  absDeviation: number;
  devBomRatio: number;
  growthPct: number | null;
}

export interface AreaAnalysis {
  area: string;
  outletCount: number;
  totalSales: number;
  totalAbsNominal: number;
  avgDevBom: number;
  lossToSales: number | null;
}

export interface VarianceItem {
  itemName: string;
  outletCode: string;
  area: string;
  currentAbsNominal: number;
  previousAbsNominal: number;
  delta: number;
  direction: string;
  // FIX FLOW3-4: add fields emitted by server (rankingService.computeVarianceAnalysis)
  currentNominal?: number;
  previousNominal?: number;
  selisih?: number;
  varianceDirection?: string;
}

export interface OutletHealthRanking {
  outletCode: string;
  outletName: string;
  area: string;
  healthScore: number;
  normal: number;
  warning: number;
  abnormal: number;
  absNominal: number;       // ABS(sum) — for sorting only
  nominalDeviasi?: number;  // FIX: SIGNED sum — for display (negative = LOSS)
  residualPct: number | null;
  lossToSales: number | null;
  devBom: number;
  sales: number;
}

export interface CostImpact {
  totalCost: number;
  pctOfSales: number | null;
  lossNominal: number;
  surplusNominal: number;
}

export interface ItemConsistencyResult {
  systemic: Array<{ itemName: string; outletCode: string; area: string; occurrences: number; avgDevBom: number; absNominal: number }>;
  episodic: Array<{ itemName: string; outletCode: string; area: string; absNominal: number; devBom: number }>;
  items?: Array<{
    itemName: string;
    satuan: string;
    outletCount: number;
    lossOutlets: number;
    surplusOutlets: number;
    totalAbsNominal: number;
    avgDevBom: number;
    consistency: 'SYSTEMIC' | 'WIDESPREAD' | 'ISOLATED';
  }>;
}

export interface NetCostTrendPoint {
  weekLabel: string;
  netCostRatio: number;
  lossNominal: number;
  surplusNominal: number;
  sales: number;
}

export interface HistoricalAnalysisMeta {
  /** # of (monthLabel,weekLabel) pairs used as historical baseline (excluding current). */
  historicalPeriodsCount: number;
  /** Minimum weeks required to evaluate a record (from settings, default 4). */
  minWeeks: number;
  /** zScore > this → WARNING (from settings, default 1.5). */
  zWarnThreshold: number;
  /** zScore > this → ABNORMAL (from settings, default 2). */
  zHighThreshold: number;
  /** Total (outlet,item) pairs in the historical stats map. */
  statsCount: number;
  /** Pairs with stdDev > 0 AND n >= minWeeks (eligible for Z-Score). */
  validStatsCount: number;
  /** Total current records evaluated. */
  evaluatedCount: number;
  /** Records flagged by HISTORICAL_* rules. */
  flaggedCount: number;
  /** Pre-computed reason for empty criticalItems (frontend uses for empty-state copy). */
  reason:
    | 'NO_HISTORICAL_DATA'
    | 'INSUFFICIENT_WEEKS'
    | 'NO_VALID_STATS'
    | 'NO_ANOMALIES'
    | 'ALL_FILTERED_BOM'
    | 'NON_EMPTY';
}

export interface HistoricalAnalysisResult {
  criticalItems: Array<{
    itemName: string; outletCode: string; area: string;
    currentDevBom: number; historicalAvg: number; zScore: number; absNominal: number;
    // QTY Deviasi: current value SIGNED (nilai asli), Z-Score uses ABS magnitude per PRD §5.2
    currentQtyDeviasi: number; qtyDeviasiZScore: number; qtyDeviasiHistoricalAvg: number;
    // Phase B-1: Multi-metric current values + zScores + historical avgs
    currentWaste: number; currentSusut: number; currentTrial: number;
    wasteZScore: number; susutZScore: number; trialZScore: number;
    wasteHistoricalAvg: number; susutHistoricalAvg: number; trialHistoricalAvg: number;
  }>;
  // FX-HIST-EMPTY: diagnostics for the frontend empty state. Lets the card
  // show accurate feedback instead of the generic "minimal 4 bulan" tip.
  meta?: HistoricalAnalysisMeta;
}

// ============================================================
//  BOM Correlation Findings — per-record rule fire details
//  --------------------------------------------------------
//  FIX-BOM-UI (CONFIG-02): mirrors BomCorrelationFinding in
//  src/app/api/analysis/services/post-process.ts. Kept in sync
//  with the API response shape so BomCorrelationCard can render
//  per-record rule fires (not just aggregate growth alignment).
// ============================================================
export interface BomCorrelationFinding {
  outletId: number;
  outletName: string;
  itemId: number;
  itemName: string;
  akunPenyesuaian: string | null;
  ruleCode: string;
  rulePriority: number;
  severity: string;
  bomGrowth: number | null;
  /** Growth of the metric relevant to the rule (waste/susut/trial/qtyDeviasi). */
  metricGrowth: number | null;
  /** qtyDeviasiGrowth / bomGrowth (only meaningful when bomGrowth > 0). */
  deviationBomRatio: number | null;
}

export interface BomCorrelationCounts {
  WASTE_BOM_MISMATCH: number;
  SUSUT_BOM_MISMATCH: number;
  TRIAL_BOM_MISMATCH: number;
  BOM_DEVIATION_DISPROPORTIONATE: number;
  BOM_DEVIATION_MISMATCH: number;
  BOM_DOWN_DEV_UP: number;
}

export interface AnalysisData {
  success: boolean;
  period: { monthLabel: string; weekLabel: string; comparisonWeek: string | null; comparisonMonth: string | null };
  // FIX (AUDIT7-FE-4): backend emits 5 fields (area, kelompok, outletCode,
  // itemName, pic) in `filters` (analysis/route.ts:951) — frontend type was
  // missing `kelompok` + `pic`. Made all 5 nullable for back-compat with
  // mock/test data that omits them.
  filters: {
    area: string | null;
    kelompok: string | null;
    outletCode: string | null;
    itemName: string | null;
    pic: string | null;
  };
  executiveSummary: ExecutiveSummary;
  healthStatus: {
    normal: number;
    warning: number;
    abnormal: number;
    breakdown?: {
      byCategory: Record<string, number>;
      byRule: Record<string, number>;
    };
  };
  // FIX FLOW3-5: dqStatus type drift — server emits only { errors, warnings } (no ok/issues)
  dqStatus: { errors: number; warnings: number; ok?: number; issues?: unknown[] };
  growthComparison: {
    salesGrowth: number | null;
    bomGrowth: number | null;
    qtyDeviasiGrowth: number | null;
    nominalDeviasiGrowth: number | null;
    deviationToSalesRatio: number | null;
    deviationToBomRatio: number | null;
    multiPeriodComparison?: MultiPeriodComparisonRow[];
    historicalAnalysis?: HistoricalAnalysisResult;
  };
  topItemsByNominal: TopItemByNominal[];
  topItemsByDevBom: TopItemByDevBom[];
  // Pareto 80/20 for items with |Dev/BOM| > 50%
  paretoDevBom?: {
    drivers: Array<{
      itemName: string;
      outletCount: number;
      devBom: number;
      devBomAbs: number;
      nominalDeviasi: number;
      absNominal: number;
      sharePct: number;
      cumPct: number;
      outlets: Array<{
        outletCode: string;
        outletName: string;
        area: string;
        devBom: number;
        devBomAbs: number;
        nominalDeviasi: number;
        absNominal: number;
        sharePct: number;
        cumPct: number;
      }>;
    }>;
    remainderCount: number;
    remainderPct: number;
    totalAbsNominal: number;
    totalCount: number;
    thresholdPct: number;
  };
  topOutlets: TopOutlet[];
  topOutletsBySales: TopOutletBySales[];
  topItemsByWaste: TopItemByCategory[];
  topItemsBySusut: TopItemByCategory[];
  topItemsByTrial: TopItemByCategory[];
  topItemsByLossSurplus: TopItemByCategory[];
  topDeviasiRank?: DeviasiRankItem[];
  deviationBreakdown: { waste: number; susut: number; trial: number; residual: number; total: number };
  // NEW: 80% Pareto per deviation category — powers Deviation Breakdown drill-down
  deviationDrivers?: DeviationDriverCategory[];
  lossVsSurplus: { loss: number; surplus: number; lossNominal: number; surplusNominal: number };
  trend: Array<{ weekLabel: string; devBom: number; sales: number; nominal: number }>;
  // Extended analytical fields (computed server-side, optional for backward compat)
  areaAnalysis?: AreaAnalysis[];
  varianceAnalysis?: { topWorsened: VarianceItem[]; topImproved: VarianceItem[] };
  outletHealthRanking?: OutletHealthRanking[];
  costImpact?: CostImpact;
  itemConsistencyAnalysis?: ItemConsistencyResult;
  netCostTrend?: NetCostTrendPoint[];
  growthDrivers?: GrowthDriverMetric[];
  // FIX (AUDIT7-FE-5): trend projection + pattern detection emitted by
  // /api/analysis (analysis/route.ts:989-990) — were missing from the type.
  // Optional + nullable so consumers can render a no-data state when the
  // backend returns null (insufficient historical weeks for regression).
  trendProjection?: TrendProjection | null;
  patterns?: PatternDetection[];
  // FIX-BOM-UI (CONFIG-02): per-record BOM correlation findings (top 50 by
  // priority) + per-rule counts. Optional for back-compat with mock/test data.
  bomCorrelationFindings?: BomCorrelationFinding[];
  bomCorrelationCounts?: BomCorrelationCounts;
  durationMs: number;
  cached?: boolean;
  // PERF-CACHE-09 (SWR): present when the response was served from an expired
  // DB cache entry (stale-while-revalidate). The client MAY use this to show a
  // "data might be stale" indicator or trigger a sooner refetch. Currently set
  // by withCacheAndDedup on the 7 routes that use it (pareto, recommendations,
  // resto-bahan-matrix, outlet-items, item-history, drilldown, heatmap).
  // /api/analysis has its own pipeline (not using withCacheAndDedup yet) so it
  // does not set this flag — added here for type-safety + future use.
  stale?: boolean;
  message?: string;
}

// FIX: Growth Drivers — Pareto 80% per metric
export interface GrowthDriver {
  item: string;
  delta: number;
  pct: number;
  cumPct: number;
  sharePct: number;
}
export interface GrowthDriverMetric {
  metric: string;
  label: string;
  groupBy: 'outlet' | 'item';
  up: { drivers: GrowthDriver[]; remainderCount: number; remainderPct: number };
  down: { drivers: GrowthDriver[]; remainderCount: number; remainderPct: number };
}

// NEW: Deviation Drivers — Pareto 80% per deviation category (waste/susut/trial/residual)
export interface DeviationDriver {
  item: string;
  qty: number;
  nominal: number;
  sharePct: number;
  cumPct: number;
}
export interface DeviationDriverCategory {
  category: 'waste' | 'susut' | 'trial' | 'residual';
  label: string;
  drivers: DeviationDriver[];
  remainderCount: number;
  remainderPct: number;
}

// ============================================================
//  PERF-OPT: analysis query params shape (shared by useAnalysis +
//  prefetchAnalysis). Keeping this in one place guarantees the query
//  key matches exactly between the live hook and the prefetch helper.
// ============================================================
export interface AnalysisParams {
  month: string | null;
  week: string | null;
  compareWeek: string | null;
  compareMonth?: string | null;
  area: string | null;
  kelompok?: string | null;
  outlet: string | null;
  item: string | null;
  pic?: string | null;
}
