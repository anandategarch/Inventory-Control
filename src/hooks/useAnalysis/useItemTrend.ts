'use client';

// ============================================================
//  Item Trend (TREND-BACKEND → TREND-FRONTEND)
//  --------------------------------------------------------
//  Per-item QTY fluctuation timeline across ALL periods (monthLabel
//  × weekLabel) with Z-Score + historical baseline. Powers the new
//  "Trend Item" tab.
//
//  Source: src/app/api/item-trend/route.ts
//    GET /api/item-trend?itemName=&metric=&month=&week=&area=&kelompok=&outlet=&pic=
//
//  Cache: 5-min DB cache + SWR (stale-while-revalidate) on the
//  server; client staleTime matches (5 min). Metric is part of the
//  cache key (server-side) and the query key (client-side) so two
//  requests with different metrics get separate entries.
//
//  File extracted from src/hooks/useAnalysis.ts (split by Task ID
//  3-a). Self-contained — defines its own response types next to
//  the hook.
// ============================================================
import { useQuery, keepPreviousData } from '@tanstack/react-query';

export interface ItemTrendPeriod {
  monthLabel: string;
  weekLabel: string;
  /** FIX (BUG-FLIP-03): aligned with query interface — monthKey can be null
   *  when SourceFile is missing (LEFT JOIN returns null). Was declared as
   *  non-null `string` in the hook, masking potential null access. */
  monthKey: string | null;
  /** FIX (SATUAN-BUG): item's unit of measure (e.g. "KG", "PCS", "LTR").
   *  Used by Flip column/matrix tooltips to display the correct unit instead
   *  of hardcoded "kg" (which was wrong for non-KG items). */
  satuan: string | null;
  qtyBom: number;
  /** ABS magnitude — for sort/comparison (always positive). */
  qtyDeviasi: number;
  /** Signed — for direction display (negative = LOSS, positive = SURPLUS). */
  qtyDeviasiSigned: number;
  qtyWaste: number;
  qtySusut: number;
  qtyTrial: number;
  nominalDeviasi: number;
  outletCount: number;
  recordCount: number;
  /** SIGNED Z-Score (positive = above mean = worse, negative = below = better).
   *  Null when sampleSize < HISTORICAL_MIN_WEEKS (4) or stdDev === 0. */
  zScore: number | null;
  /** Mean of ABS weekly values from same-week OTHER periods (cumulative
   *  weeks pattern: W4 Juli vs [W4 Mei, W4 Juni]). */
  historicalMean: number;
  historicalStdDev: number;
  sampleSize: number;
}

export interface ItemTrendData {
  success: boolean;
  period: { month: string; week: string };
  itemName: string;
  metric: string;
  periods: ItemTrendPeriod[];
  durationMs: number;
  cached?: boolean;
  /** SWR flag — true when served from expired cache (background recompute runs). */
  stale?: boolean;
}

export type ItemTrendMetric = 'qtyDeviasi' | 'qtyWaste' | 'qtySusut' | 'qtyTrial';

export interface ItemTrendParams {
  itemName: string | null;
  metric?: ItemTrendMetric;
  area?: string | null;
  kelompok?: string | null;
  outletCode?: string | null;
  pic?: string | null;
  /** Optional month/week context — included in cache key (server-side)
   *  so trend fetches scoped to a "current period" share entries. */
  month?: string | null;
  week?: string | null;
}

export function useItemTrend(params: ItemTrendParams) {
  const p = new URLSearchParams();
  if (params.itemName) p.set('itemName', params.itemName);
  const metric: ItemTrendMetric = params.metric ?? 'qtyDeviasi';
  p.set('metric', metric);
  if (params.month) p.set('month', params.month);
  if (params.week) p.set('week', params.week);
  if (params.area && params.area !== 'all') p.set('area', params.area);
  if (params.kelompok && params.kelompok !== 'all') p.set('kelompok', params.kelompok);
  if (params.outletCode && params.outletCode !== 'all') p.set('outlet', params.outletCode);
  if (params.pic) p.set('pic', params.pic);

  return useQuery({
    queryKey: ['item-trend', params.itemName, metric, params.area, params.kelompok, params.outletCode, params.pic, params.month, params.week],
    queryFn: async () => {
      const res = await fetch(`/api/item-trend?${p.toString()}`);
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error(`Server error (HTTP ${res.status}). Server mungkin crash atau timeout. Coba refresh halaman.`);
      }
      if (!res.ok) {
        const e = (await res.json().catch(() => ({ message: 'Request failed' }))) as { message?: string; error?: string };
        throw new Error(e.message || e.error || `HTTP ${res.status}`);
      }
      return res.json() as Promise<ItemTrendData>;
    },
    // Only fire when an item is selected — avoids burning a request on tab mount.
    enabled: Boolean(params.itemName),
    // 5-min staleTime matches the server DB cache TTL — repeat tab visits
    // within 5 min don't refetch (data is stable).
    staleTime: 5 * 60 * 1000,
    // 10-min gcTime — keep the data in memory across tab switches.
    gcTime: 10 * 60 * 1000,
    // keepPreviousData so the chart/table don't go blank while switching
    // between items (shows previous item's data with a "loading" indicator
    // until the new item's data arrives).
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
  });
}
