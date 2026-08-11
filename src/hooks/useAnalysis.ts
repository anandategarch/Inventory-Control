'use client';

import { useQuery, keepPreviousData } from '@tanstack/react-query';

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

export interface ParetoResult {
  classACount: number;
  classAPctOfCost: number;
  totalItems: number;
  totalAbsNominal: number;
  items: Array<{ itemName: string; outletCode: string; absNominal: number; cumPct: number }>;
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
  executiveSummary: any;
  healthStatus: {
    normal: number;
    warning: number;
    abnormal: number;
    breakdown?: {
      byCategory: Record<string, number>;
      byRule: Record<string, number>;
    };
  };
  dqStatus: { ok: number; warnings: number; errors: number; issues: any[] };
  growthComparison: { salesGrowth: number | null; bomGrowth: number | null; qtyDeviasiGrowth: number | null; nominalDeviasiGrowth: number | null; priceGrowth: number | null; deviationToSalesRatio: number | null; deviationToBomRatio: number | null; historicalAnalysis?: HistoricalAnalysisResult } & Record<string, any>;
  topItemsByNominal: any[];
  topItemsByDevBom: any[];
  topOutlets: any[];
  topOutletsBySales: any[];
  topItemsByWaste: any[];
  topItemsBySusut: any[];
  topItemsByTrial: any[];
  topItemsByLossSurplus: any[];
  deviationBreakdown: { waste: number; susut: number; trial: number; residual: number; total: number };
  lossVsSurplus: { loss: number; surplus: number; lossNominal: number; surplusNominal: number };
  investigationWorklist: any[];
  narrative: string;
  narrativeSource: string;
  recommendation: Array<{ why: string; what: string[]; priority: string }>;
  trend: Array<{ weekLabel: string; devBom: number; sales: number; nominal: number }>;
  priorities: any[];
  // Extended analytical fields (computed server-side, optional for backward compat)
  areaAnalysis?: AreaAnalysis[];
  varianceAnalysis?: { topWorsened: VarianceItem[]; topImproved: VarianceItem[] };
  outletHealthRanking?: OutletHealthRanking[];
  pareto?: ParetoResult;
  costImpact?: CostImpact;
  itemConsistencyAnalysis?: ItemConsistencyResult;
  netCostTrend?: NetCostTrendPoint[];
  durationMs: number;
  cached?: boolean;
  message?: string;
}

async function fetchAnalysis(params: URLSearchParams): Promise<AnalysisData> {
  const res = await fetch(`/api/analysis?${params.toString()}`);
  // FIX: Check content-type — server crash returns HTML, not JSON
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error(`Server error (HTTP ${res.status}). Server mungkin crash atau timeout. Coba refresh halaman.`);
  }
  if (!res.ok) {
    const e = await res.json().catch(() => ({ message: 'Request failed' }));
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

export interface StatusData {
  success: boolean;
  files: any[];
  months: Array<{ label: string; key: string }>;
  weeksByMonth: Record<string, string[]>;
  outlets: Array<{ code: string; name: string; area: string; pic: string | null }>;
  areas: string[];
  pics: string[];
  stats: { totalFiles: number; totalOutlets: number; totalItems: number; totalRecords: number };
}

export function useStatus() {
  return useQuery({
    queryKey: ['status'],
    queryFn: async () => {
      const res = await fetch('/api/status');
      return res.json() as Promise<StatusData>;
    },
    staleTime: 5 * 60 * 1000, // Phase 1d: 5 min (was 30s) — data rarely changes
  });
}

export interface DrilldownData {
  success: boolean;
  count: number;
  records: any[];
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
      return res.json() as Promise<DrilldownData>;
    },
    enabled: Boolean(params.outletCode || params.itemName),
  });
}
