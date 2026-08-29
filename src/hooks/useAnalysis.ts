'use client';

import { useQuery, keepPreviousData, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { ExecutiveSummary } from '@/types/inventory';
// FIX (AUDIT7-FE-5): import TrendProjection + PatternDetection so the API
// response fields (`trendProjection`, `patterns`) emitted by /api/analysis
// (analysis/route.ts:989-990) are properly typed on the frontend. Previously
// computed + sent but never typed — dead data per worklog FORECAST-3.
import type { TrendProjection } from '@/lib/metrics/forecast';
import type { PatternDetection } from '@/engine/analysis/patternEngine';

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

export interface HistoricalAnalysisResult {
  criticalItems: Array<{
    itemName: string; outletCode: string; area: string;
    currentDevBom: number; historicalAvg: number; zScore: number; absNominal: number;
    // Phase B-1: Multi-metric current values
    currentWaste: number; currentSusut: number; currentTrial: number;
  }>;
}

// NEW: Area trend row for AreaTrendChart (Dev/BOM% per area × period)
export interface AreaTrendRow {
  area: string;
  monthLabel: string;
  weekLabel: string;
  monthKey: string | null;
  sales: number;
  avgDevBom: number;
  totalAbsNominal: number;
  outletCount: number;
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
  // NEW: area trend for AreaTrendChart
  areaTrend?: AreaTrendRow[];
  growthDrivers?: GrowthDriverMetric[];
  // FIX (AUDIT7-FE-5): trend projection + pattern detection emitted by
  // /api/analysis (analysis/route.ts:989-990) — were missing from the type.
  // Optional + nullable so consumers can render a no-data state when the
  // backend returns null (insufficient historical weeks for regression).
  trendProjection?: TrendProjection | null;
  patterns?: PatternDetection[];
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
  // FIX (LOADING-TIMEOUT): AbortController — if server doesn't respond in 90s,
  // abort the fetch so TanStack Query can retry (instead of infinite loading).
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(`/api/analysis?${params.toString()}`, {
      signal: controller.signal,
    });
    // FIX: Check content-type — server crash returns HTML, not JSON
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error(`Server error (HTTP ${res.status}). Server mungkin crash atau timeout. Coba refresh halaman.`);
    }
    if (!res.ok) {
      const e = (await res.json().catch(() => ({ message: 'Request failed' }))) as { message?: string; error?: string; success?: boolean };
      // FIX: 404 with "No records found" is NOT always a missing-data issue.
      // It can also mean the user selected contradictory filters (e.g.,
      // kelompok=BDG + outlet=JKT, or kelompok=BDG + area=JAWA TIMUR 1 where
      // no BDG outlets exist in that area). The old message ("Upload file Excel")
      // was misleading — it hinted at missing data when the real cause was
      // filter conflict. Now we check if any filter is active and tailor the
      // message accordingly.
      // FIX (BUG-FE-6 / BUG-EDGE-11): improved error message for contradictory filters.
      if (res.status === 404 && e.message?.includes('No records found')) {
        const url = new URL(res.url);
        const hasFilter = url.searchParams.get('area') || url.searchParams.get('kelompok')
          || url.searchParams.get('outlet') || url.searchParams.get('pic') || url.searchParams.get('item');
        if (hasFilter) {
          throw new Error(`Tidak ada data untuk kombinasi filter ini. Periksa apakah filter Area, Kelompok, Outlet, atau PIC saling bertentangan (mis: kelompok=BDG + outlet di luar BDG). Coba reset filter atau ubah kombinasi.`);
        }
        throw new Error(`Tidak ada data untuk periode ini. Upload file Excel untuk bulan/week yang dipilih.`);
      }
      throw new Error(e.message || e.error || `HTTP ${res.status}`);
    }
    return res.json();
  } catch (err: unknown) {
    // AbortError = timeout — throw a friendly message
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Server timeout (90s). Query terlalu berat — coba lagi atau persempit filter.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
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

// PERF-OPT: Build the URLSearchParams for an analysis request.
// Mirrors the param-building logic that used to live inline in useAnalysis
// so prefetch + live fetch produce identical query strings.
function buildAnalysisSearchParams(params: AnalysisParams): URLSearchParams {
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
  if (params.kelompok) p.set('kelompok', params.kelompok);
  if (params.outlet) p.set('outlet', params.outlet);
  if (params.item) p.set('item', params.item);
  if (params.pic) p.set('pic', params.pic);
  return p;
}

// PERF-OPT: build the canonical analysis query key.
// Exported so prefetch callers can use the EXACT same key shape as useAnalysis.
export function buildAnalysisQueryKey(params: AnalysisParams) {
  return ['analysis', params] as const;
}

// PERF-OPT: staleTime + gcTime constants. Bumped from 60s → 120s staleTime
// (analysis is heavy — 6-8s cold) and added 10-min gcTime so the data stays
// in memory across tab switches / filter toggles.
export const ANALYSIS_STALE_TIME = 120_000; // 2 min
export const ANALYSIS_GC_TIME = 600_000;     // 10 min

export function useAnalysis(params: AnalysisParams) {
  // NOTE (BUG-FE-10): the old comment claimed this was "memoized" via useMemo,
  // but it's just a plain const. TanStack Query caches by queryKey (not queryFn
  // reference), so this is functionally fine — the queryFn closure captures
  // searchParams, and since queryKey includes all params, a param change
  // triggers a new queryFn invocation with the updated searchParams. No fix needed.
  const searchParams = buildAnalysisSearchParams(params);

  return useQuery({
    queryKey: buildAnalysisQueryKey(params),
    queryFn: () => fetchAnalysis(searchParams),
    enabled: Boolean(params.month && params.week),
    placeholderData: keepPreviousData,
    // FIX (504-RETRY): retry once on 504/timeout — gateway proxy may timeout
    // before the heavy query (with outlet filter) completes. The 2nd attempt
    // usually hits the in-flight cache or completes faster (DB warm).
    // FIX (BUG6-POOL): also retry on ECHECKOUTRETRIES (connection pool exhaustion).
    retry: (failureCount, error) => {
      if (failureCount >= 3) return false; // max 3 retries (was 2 — increased for pool errors)
      const msg = error instanceof Error ? error.message : '';
      // Retry on 504, 502, 503, timeout, Server error, or connection pool errors
      return msg.includes('504') || msg.includes('502') || msg.includes('503') ||
        msg.includes('timeout') || msg.includes('Server error') ||
        msg.includes('ECHECKOUTRETRIES') || msg.includes('connection');
    },
    retryDelay: (attemptIndex) => Math.min(2000 * (attemptIndex + 1), 5000), // 2s, 4s, 5s — longer delays for pool recovery
    // PERF-OPT: staleTime 60s → 120s. Analysis is expensive (6-8s cold,
    // 100ms warm). 2 min keeps the data fresh enough for filter toggles
    // without re-fetching on every tab switch.
    staleTime: ANALYSIS_STALE_TIME,
    // PERF-OPT: gcTime 5min (default) → 10min. Keeps the data in memory
    // longer so navigating back to a previously-viewed period is instant.
    gcTime: ANALYSIS_GC_TIME,
  });
}

// ============================================================
//  PERF-OPT: prefetchAnalysis
//  --------------------------------------------------------
//  Used by:
//    1. FilterBar — on hover over a month/week dropdown option,
//       prefetch the analysis for that period so the click is instant.
//    2. page.tsx — on first successful status load, prefetch the
//       default (latest) period so the dashboard's first paint
//       doesn't wait for the user to interact.
//
//  Implementation: queryClient.prefetchQuery with the SAME queryKey
//  shape as useAnalysis. TanStack Query dedupes — if a real useAnalysis
//  call is already in flight for the same key, prefetch is a no-op.
// ============================================================
export function prefetchAnalysis(
  queryClient: QueryClient,
  params: AnalysisParams,
): void {
  if (!params.month || !params.week) return;
  const searchParams = buildAnalysisSearchParams(params);
  void queryClient.prefetchQuery({
    queryKey: buildAnalysisQueryKey(params),
    queryFn: () => fetchAnalysis(searchParams),
    staleTime: ANALYSIS_STALE_TIME,
    gcTime: ANALYSIS_GC_TIME,
  });
}

// ============================================================
//  PERF-OPT: usePrefetchAnalysis — React hook wrapper around
//  prefetchAnalysis. Returns a stable callback that can be passed
//  to onMouseEnter handlers without re-creating closures every render.
// ============================================================
export function usePrefetchAnalysis() {
  const queryClient = useQueryClient();
  return useCallback(
    (params: AnalysisParams) => prefetchAnalysis(queryClient, params),
    [queryClient],
  );
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
  // FIX (AUDIT8-ROLLBACK-1, Item 12): backend EMPTY_STATE returns setupRequired:true
  // when DB tables are not yet created — frontend uses this to redirect to /setup.
  setupRequired?: boolean;
  files: SourceFileInfo[];
  months: Array<{ label: string; key: string }>;
  weeksByMonth: Record<string, string[]>;
  outlets: Array<{ code: string; name: string; area: string; pic: string | null }>;
  areas: string[];
  pics: string[];
  kelompokOptions?: Array<{ kelompok: string; outletCount: number; area: string }>;
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
  // FIX H5 (AUDIT-4): nested objects made optional — API mapper now guards with
  // `?? '—'` fallbacks, but frontend should also be type-safe against partial data
  // (e.g. soft-deleted relations, future schema changes).
  outlet?: { code: string; name: string; area: string };
  item?: { name: string; satuan: string | null };
  period?: { monthLabel: string; weekLabel: string };
  source?: { fileName: string };
  qty?: {
    bom: number | null;
    com: number | null;
    deviasi: number | null;
    waste: number | null;
    susut: number | null;
    trial: number | null;
    lossSurplus: number | null;
    wasteSusut: number | null;
  };
  nominal?: {
    deviasi: number | null;
    waste: number | null;
    susut: number | null;
    trial: number | null;
    lossSurplus: number | null;
    sales: number | null;
  };
  derived?: {
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
  // FIX Medium #2: pagination metadata from cursor-based pagination.
  nextCursor: number | null;
  hasMore: boolean;
  records: DrilldownRecord[];
}

export function useDrilldown(params: { outletCode?: string | null; itemName?: string | null; weekLabel?: string | null; monthLabel?: string | null; limit?: number; enabled?: boolean }) {
  const p = new URLSearchParams();
  if (params.outletCode) p.set('outletCode', params.outletCode);
  if (params.itemName) p.set('itemName', params.itemName);
  if (params.weekLabel) p.set('weekLabel', params.weekLabel);
  if (params.monthLabel) p.set('monthLabel', params.monthLabel);
  // FIX H6 (AUDIT-4): allow callers to request more records (default 50, max 500).
  // ItemDeepDive needs up to 500 to count ALL outlets with an item, not just top-10.
  if (params.limit) p.set('limit', String(params.limit));

  return useQuery({
    queryKey: ['drilldown', params.outletCode, params.itemName, params.weekLabel, params.monthLabel, params.limit],
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
    // UI-03 FIX: allow callers to pass `enabled` override (e.g., SourceDataModal
    // passes `enabled: sourceModalOpen` to avoid redundant 500-row fetch when modal is closed).
    enabled: params.enabled !== undefined ? params.enabled : Boolean(params.outletCode || params.itemName),
    // FIX M6 (AUDIT-4): add staleTime so reopening the drawer for the same item doesn't refetch.
    staleTime: 30_000,
    // UI-02 FIX: keepPreviousData prevents drawer from going blank when switching
    // items while drawer is open (shows old data until new data arrives).
    placeholderData: keepPreviousData,
  });
}
