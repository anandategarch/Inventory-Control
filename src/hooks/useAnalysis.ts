'use client';

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import type { ExecutiveSummary, InvestigationItem } from '@/types/inventory';

// ============================================================
//  Item-level top-N ranking shapes (mirror of API response)
//  Source: src/lib/queries/items.ts + src/app/api/analysis/route.ts
// ============================================================

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
  rankBom: number;
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
  [key: string]: unknown;
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
  absNominal: number;
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

export interface HistoricalAnalysisResult {
  criticalItems: Array<{ itemName: string; outletCode: string; area: string; currentDevBom: number; historicalAvg: number; zScore: number; absNominal: number }>;
}

export interface AnalysisData {
  success: boolean;
  period: { monthLabel: string; weekLabel: string; comparisonWeek: string | null; comparisonMonth: string | null };
  filters: { area: string | null; outletCode: string | null; itemName: string | null };
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
  // FIX: removed investigationWorklist (dead field — not consumed by any component)
  // investigationWorklist: InvestigationItem[];
  trend: Array<{ weekLabel: string; devBom: number; sales: number; nominal: number }>;
  // Extended analytical fields (computed server-side, optional for backward compat)
  areaAnalysis?: AreaAnalysis[];
  varianceAnalysis?: { topWorsened: VarianceItem[]; topImproved: VarianceItem[] };
  outletHealthRanking?: OutletHealthRanking[];
  costImpact?: CostImpact;
  itemConsistencyAnalysis?: ItemConsistencyResult;
  netCostTrend?: NetCostTrendPoint[];
  growthDrivers?: GrowthDriverMetric[];
  durationMs: number;
  cached?: boolean;
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

async function fetchAnalysis(params: URLSearchParams): Promise<AnalysisData> {
  const res = await fetch(`/api/analysis?${params.toString()}`);
  // FIX: Check content-type — server crash returns HTML, not JSON
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error(`Server error (HTTP ${res.status}). Server mungkin crash atau timeout. Coba refresh halaman.`);
  }
  if (!res.ok) {
    const e = (await res.json().catch(() => ({ message: 'Request failed' }))) as { message?: string };
    throw new Error(e.message || `HTTP ${res.status}`);
  }
  return res.json();
}

export function useAnalysis(params: {
  month: string | null;
  week: string | null;
  compareWeek: string | null;
  compareMonth?: string | null;
  area: string | null;
  outlet: string | null;
  item: string | null;
  pic?: string | null;
}) {
  const p = new URLSearchParams();
  if (params.month) p.set('month', params.month);
  if (params.week) p.set('week', params.week);
  // Encode cross-month compare as "WEEK|||Month" so server can resolve month
  if (params.compareWeek) {
    if (params.compareMonth && params.compareMonth !== params.month) {
      p.set('compareWeek', `${params.compareWeek}|||${params.compareMonth}`);
    } else {
      p.set('compareWeek', params.compareWeek);
    }
  }
  if (params.area) p.set('area', params.area);
  if (params.outlet) p.set('outlet', params.outlet);
  if (params.item) p.set('item', params.item);
  if (params.pic) p.set('pic', params.pic);

  return useQuery({
    queryKey: ['analysis', params],
    queryFn: () => fetchAnalysis(p),
    enabled: Boolean(params.month && params.week),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

// ============================================================
//  Source file metadata — mirrors /api/status SourceFile select.
// ============================================================
export interface SourceFileInfo {
  fileName: string;
  monthLabel: string;
  monthKey: string;
  rowCount: number;
  dqStatus: string;
  importedAt: string;
}

export interface StatusData {
  success: boolean;
  files: SourceFileInfo[];
  months: Array<{ label: string; key: string }>;
  weeksByMonth: Record<string, string[]>;
  outlets: Array<{ code: string; name: string; area: string; pic: string | null }>;
  areas: string[];
  pics: string[];
  stats: { totalFiles: number; totalOutlets: number; totalItems: number; totalRecords: number };
  warning?: string;
  cached?: boolean;
}

export function useStatus() {
  return useQuery({
    queryKey: ['status'],
    queryFn: async () => {
      const res = await fetch('/api/status');
      // Guard: server crashes return HTML, not JSON
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error(`Server error (HTTP ${res.status}). Server mungkin crash atau timeout. Coba refresh halaman.`);
      }
      if (!res.ok) {
        const e = (await res.json().catch(() => ({ message: 'Request failed' }))) as { message?: string };
        throw new Error(e.message || `HTTP ${res.status}`);
      }
      return res.json() as Promise<StatusData>;
    },
    staleTime: 5 * 60 * 1000, // Phase 1d: 5 min (was 30s) — data rarely changes
  });
}

// ============================================================
//  Drilldown record — mirrors /api/drilldown record mapper.
// ============================================================
export interface DrilldownRecord {
  id: number;
  outlet: { code: string; name: string; area: string };
  item: { name: string; satuan: string | null };
  period: { monthLabel: string; weekLabel: string };
  source: { fileName: string };
  qty: {
    bom: number | null;
    com: number | null;
    deviasi: number | null;
    waste: number | null;
    susut: number | null;
    trial: number | null;
    lossSurplus: number | null;
    wasteSusut: number | null;
  };
  nominal: {
    deviasi: number | null;
    waste: number | null;
    susut: number | null;
    trial: number | null;
    lossSurplus: number | null;
    sales: number | null;
  };
  derived: {
    direction: string;
    residualQty: number | null;
    residualRatio: number | null;
    absQtyDeviasi: number | null;
    absNominalDeviasi: number | null;
    pctQtyDeviasiToBom: number | null;
    pctWasteSusut: number | null;
    tolerancePct: number | null;
    toleranceRaw: string | null;
    avgPrice: number | null;
    [key: string]: unknown;
  };
  bulan: string | null;
  bulan2: string | null;
}

export interface DrilldownData {
  success: boolean;
  count: number;
  records: DrilldownRecord[];
}

export function useDrilldown(params: { outletCode?: string | null; itemName?: string | null; weekLabel?: string | null; monthLabel?: string | null }) {
  const p = new URLSearchParams();
  if (params.outletCode) p.set('outletCode', params.outletCode);
  if (params.itemName) p.set('itemName', params.itemName);
  if (params.weekLabel) p.set('weekLabel', params.weekLabel);
  if (params.monthLabel) p.set('monthLabel', params.monthLabel);

  return useQuery({
    queryKey: ['drilldown', params],
    queryFn: async () => {
      const res = await fetch(`/api/drilldown?${p.toString()}`);
      // Guard: server crashes return HTML, not JSON
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error(`Server error (HTTP ${res.status}). Server mungkin crash atau timeout. Coba refresh halaman.`);
      }
      if (!res.ok) {
        const e = (await res.json().catch(() => ({ message: 'Request failed' }))) as { message?: string };
        throw new Error(e.message || `HTTP ${res.status}`);
      }
      return res.json() as Promise<DrilldownData>;
    },
    enabled: Boolean(params.outletCode || params.itemName),
  });
}
