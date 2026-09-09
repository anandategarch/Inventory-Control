'use client';

// ============================================================
//  ParetoTab — "Pareto" (80/20) analysis tab. Extracted from
//  page.tsx lines 671-681.
//  --------------------------------------------------------
//  ParetoDashboard is statically imported (it's not recharts-heavy
//  on its own).
//  PERF-FE: wrapped in React.memo — skips re-render when parent
//  re-renders for unrelated Zustand state (modal/drawer toggles).
//  PERF-FE (PAKET A): `isFetching` prop + FetchAware wrapper removed
//  — the prop toggled on every background refetch (defeating memo)
//  and FetchAware froze clicks while stale data was still usable.
//  Global refresh indicator lives in DashboardHeader.
// ============================================================

import { memo } from 'react';
import { ParetoDashboard } from '@/components/dashboard/ParetoDashboard';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import type { AnalysisData } from '@/hooks/useAnalysis';

export interface ParetoTabProps {
  data: AnalysisData;
}

export const ParetoTab = memo(function ParetoTab({ data }: ParetoTabProps) {
  return (
    <ErrorBoundary label="Pareto Dashboard">
      <ParetoDashboard analysisData={data} />
    </ErrorBoundary>
  );
});
