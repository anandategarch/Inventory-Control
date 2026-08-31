'use client';

// ============================================================
//  useDrilldown — TanStack Query hook for /api/drilldown
//  --------------------------------------------------------
//  Source: extracted from src/hooks/useAnalysis.ts (split by
//  Task ID 3-a). Self-contained — defines its own response
//  types (DrilldownRecord, DrilldownData) next to the hook.
// ============================================================
import { useQuery, keepPreviousData } from '@tanstack/react-query';

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
  // PERF-CACHE-09 (SWR): cached + stale flags from withCacheAndDedup.
  cached?: boolean;
  stale?: boolean;
}

export function useDrilldown(params: { outletCode?: string | null; itemName?: string | null; weekLabel?: string | null; monthLabel?: string | null; limit?: number; enabled?: boolean; area?: string; kelompok?: string; pic?: string }) {
  const p = new URLSearchParams();
  if (params.outletCode) p.set('outletCode', params.outletCode);
  if (params.itemName) p.set('itemName', params.itemName);
  if (params.weekLabel) p.set('weekLabel', params.weekLabel);
  if (params.monthLabel) p.set('monthLabel', params.monthLabel);
  // FIX H6 (AUDIT-4): allow callers to request more records (default 50, max 500).
  // ItemDeepDive needs up to 500 to count ALL outlets with an item, not just top-10.
  if (params.limit) p.set('limit', String(params.limit));
  // Pass dashboard filters so drill-down respects active filter
  if (params.area) p.set('area', params.area);
  if (params.kelompok) p.set('kelompok', params.kelompok);
  if (params.pic) p.set('pic', params.pic);

  return useQuery({
    queryKey: ['drilldown', params.outletCode, params.itemName, params.weekLabel, params.monthLabel, params.limit, params.area, params.kelompok, params.pic],
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
    // PERF-FE: drilldown is a user-initiated lookup — no need to refetch when
    // the user switches tabs. The 30s staleTime covers the case where the user
    // closes + reopens the drawer quickly.
    refetchOnWindowFocus: false,
  });
}
