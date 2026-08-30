'use client';

// ============================================================
//  ParetoTab — "Pareto" (80/20) analysis tab. Extracted from
//  page.tsx lines 671-681.
//  --------------------------------------------------------
//  ParetoDashboard is statically imported (it's not recharts-heavy
//  on its own). Wrapped in FetchAware per FIX #32 so the dashboard
//  refetch indicator stays visible.
//  PERF-FE: wrapped in React.memo — skips re-render when parent
//  re-renders for unrelated Zustand state (modal/drawer toggles).
// ============================================================

import { memo } from 'react';
import { ParetoDashboard } from '@/components/dashboard/ParetoDashboard';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import { FetchAware } from '@/components/dashboard/shared';
import type { AnalysisData } from '@/hooks/useAnalysis';

export interface ParetoTabProps {
  data: AnalysisData;
  isFetching: boolean;
}

export const ParetoTab = memo(function ParetoTab({ data, isFetching }: ParetoTabProps) {
  return (
    <>
      {/* FIX #32: FetchAware wraps ParetoDashboard — the component
          previously had no awareness of the dashboard refetch
          (its own query has staleTime 120s and doesn't refetch on
          global filter change). */}
      <FetchAware isFetching={isFetching}>
        <ErrorBoundary label="Pareto Dashboard">
          <ParetoDashboard analysisData={data} />
        </ErrorBoundary>
      </FetchAware>
    </>
  );
});
