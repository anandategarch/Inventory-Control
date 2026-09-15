'use client';

// ============================================================
//  useRecommendations — THE single /api/recommendations fetch (H-11 / #4b)
//  --------------------------------------------------------
//  Before H-11 the SAME endpoint was fetched twice with DIFFERENT keys:
//    - RestoRecommendationCard (Dashboard tab): limit 5, global scope
//    - RestoAnalysis (Resto tab): limit 1 + outletCode=<active outlet>
//  The server cache key includes `limit`, so the two variants
//  double-computed queryRestoRecommendations even for the same scope,
//  and clicking a top-5 outlet in the dashboard re-fetched (limit 1)
//  data the dashboard card already had.
//
//  This hook unifies BOTH consumers onto ONE query shape:
//    - limit is now a CONSTANT (5) for every caller → identical server
//      cache key + identical react-query key for the same scope
//    - the queryKey is built by ONE builder (recommendationsKey) so
//      the two call sites can never drift
//    - RestoAnalysis additionally PEEKS the shared (unscoped) response
//      via queryClient.getQueryData — when the focused outlet is already
//      in the dashboard card's cached top-5, the outlet-scoped fetch is
//      disabled entirely (dashboard → Resto tab = zero extra requests).
// ============================================================

import { useQuery, keepPreviousData, useQueryClient } from '@tanstack/react-query';
import { useShallow } from 'zustand/shallow';
import { useDashboard } from './useDashboard';
import type { Recommendation } from '@/components/dashboard/PrioritySummaryCard';

/** Single source of truth for the request limit — DO NOT vary per caller
 *  (the server route-level cache key includes `limit`; a per-caller limit
 *  would split the cache into duplicate rows). 5 covers the dashboard card;
 *  an outlet-scoped request returns at most 1 row anyway. */
export const RECOMMENDATIONS_LIMIT = 5;

/**
 * Canonical recommendation row (superset of PrioritySummaryCard's
 * `Recommendation` — the server also returns `area`, which the Dashboard
 * card renders). Kept here so both consumers share ONE type.
 */
export interface RestoRecommendation extends Recommendation {
  area: string;
}

export interface RecommendationsResponse {
  success: boolean;
  recommendations: RestoRecommendation[];
  /** FIX (BUG-2-a #3, contract with BUG-2-c/server): total outlets the engine
   *  flags as priority (level TINGGI/SEDANG) BEFORE the display `limit`
   *  slice — so the ExecutiveStatus hero can show the REAL count instead of
   *  the capped list length (RECOMMENDATIONS_LIMIT = 5). Optional until the
   *  server ships it; consumers must fall back to `recommendations.length`. */
  priorityCount?: number;
  error?: string;
  cached?: boolean;
  stale?: boolean;
}

/** The dashboard-scope fields that key the recommendations query. */
export interface RecommendationsScope {
  monthLabel: string | null;
  currentWeek: string | null;
  comparisonWeek: string | null;
  comparisonMonth: string | null;
  area: string | null;
  kelompok: string | null;
  pic: string | null;
}

/**
 * ONE queryKey builder for every /api/recommendations consumer.
 * `outletCode` null = global scope (dashboard card); a string = scoped
 * to that outlet (Resto tab focus). The `null` placeholder keeps the
 * array shape stable regardless of optional fields.
 */
export function recommendationsKey(scope: RecommendationsScope, outletCode: string | null): unknown[] {
  return [
    'recommendations',
    scope.monthLabel ?? null,
    scope.currentWeek ?? null,
    scope.comparisonWeek ?? null,
    scope.comparisonMonth ?? null,
    scope.area ?? null,
    scope.kelompok ?? null,
    outletCode,
    scope.pic ?? null,
  ];
}

/**
 * Fetch /api/recommendations with the unified key + limit.
 *
 * @param outletCode Optional outlet scope ('all'/null/undefined → global).
 * @param options.enabled Set false to suppress the fetch (e.g. when the
 *        shared unscoped response already contains the wanted outlet).
 */
export function useRecommendations(
  outletCode?: string | null,
  options?: { enabled?: boolean },
) {
  const scope = useDashboard(
    useShallow((s): RecommendationsScope => ({
      monthLabel: s.monthLabel,
      currentWeek: s.currentWeek,
      comparisonWeek: s.comparisonWeek,
      comparisonMonth: s.comparisonMonth,
      area: s.area,
      kelompok: s.kelompok,
      pic: s.pic,
    })),
  );
  const outlet = outletCode && outletCode !== 'all' ? outletCode : null;

  return useQuery<RecommendationsResponse>({
    queryKey: recommendationsKey(scope, outlet),
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('month', scope.monthLabel!);
      p.set('week', scope.currentWeek!);
      if (scope.comparisonWeek) p.set('prevWeek', scope.comparisonWeek);
      if (scope.comparisonMonth) p.set('prevMonth', scope.comparisonMonth);
      if (outlet) p.set('outletCode', outlet);
      p.set('limit', String(RECOMMENDATIONS_LIMIT));
      if (scope.area && scope.area !== 'all') p.set('area', scope.area);
      // FIX (BUG-KELOMPOK-GLOBAL): pass kelompok so recommendations respect
      // the global filter (also scopes the network benchmark).
      if (scope.kelompok && scope.kelompok !== 'all') p.set('kelompok', scope.kelompok);
      if (scope.pic) p.set('pic', scope.pic);
      const res = await fetch(`/api/recommendations?${p.toString()}`);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('Server error');
      // FIX (BUG-H): check res.ok — a 429/5xx from this route is a JSON body
      // ({success:false, error}) with content-type application/json, so the
      // content-type guard above passes and the error body used to be returned
      // as query DATA (error swallowed): consumers fell back to empty/zero
      // lists instead of their error states (OutletPriorityPanel reads
      // `error`, which was never set). Every sibling hook (useAnalysis /
      // useStatus / useDrilldown / useItemTrend / usePriceEffect) checks
      // res.ok — this was the only one that didn't.
      if (!res.ok) {
        const e = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(e?.error || `HTTP ${res.status}`);
      }
      return res.json();
    },
    enabled: (options?.enabled ?? true) && Boolean(scope.monthLabel && scope.currentWeek),
    staleTime: 60_000,
    // FIX (BUG-FE-5): keepPreviousData so the card shows stale data during
    // refetch (smooth transition) instead of flashing skeletons.
    placeholderData: keepPreviousData,
  });
}

/**
 * Peek the shared (unscoped) recommendations response WITHOUT fetching.
 *
 * Returns the given outlet's row when the dashboard card's cached
 * top-5 response already contains it — letting the Resto tab render the
 * Priority Summary with ZERO extra requests. Pure cache read: no
 * subscription, no fetch, returns null on miss.
 */
export function useSharedRecommendationForOutlet(outletCode: string | null): RestoRecommendation | null {
  const queryClient = useQueryClient();
  const scope = useDashboard(
    useShallow((s): RecommendationsScope => ({
      monthLabel: s.monthLabel,
      currentWeek: s.currentWeek,
      comparisonWeek: s.comparisonWeek,
      comparisonMonth: s.comparisonMonth,
      area: s.area,
      kelompok: s.kelompok,
      pic: s.pic,
    })),
  );
  if (!outletCode || outletCode === 'all') return null;
  const shared = queryClient.getQueryData<RecommendationsResponse>(
    recommendationsKey(scope, null),
  );
  if (!shared?.recommendations) return null;
  return shared.recommendations.find((r) => r.outletCode === outletCode) ?? null;
}
