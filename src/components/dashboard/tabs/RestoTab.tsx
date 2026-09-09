'use client';

// ============================================================
//  RestoTab — "Resto Analysis" tab content (per-outlet deep
//  dive). Extracted from page.tsx lines 648-656.
//  --------------------------------------------------------
//  RestoAnalysis is lazy-loaded (it pulls in PrioritySummaryCard
//  → SignalChart → recharts ~5.4MB) so the LoadingChart fallback
//  reserves layout space while the chunk streams in.
//  PERF-FE: wrapped in React.memo — page.tsx re-renders on any
//  Zustand state change; without memo, RestoTab (and its lazy
//  RestoAnalysis chunk) would re-render unnecessarily.
//  PERF-FE (PAKET A): `isFetching` prop + FetchAware wrapper removed
//  — the prop toggled on every background refetch (defeating memo)
//  and FetchAware froze clicks while stale data was still usable.
//  Global refresh indicator lives in DashboardHeader.
// ============================================================

import { memo } from 'react';
import dynamic from 'next/dynamic';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import { LoadingChart } from '@/components/dashboard/shared';
import type { AnalysisData } from '@/hooks/useAnalysis';

// Phase 4 FIX: RestoAnalysis lazy-loaded — it pulls in PrioritySummaryCard →
// SignalChart → recharts (5.4MB). Without lazy-load, Recharts is in the main
// bundle despite the other dynamic() calls.
const RestoAnalysis = dynamic(() => import('@/components/dashboard/RestoAnalysis').then(m => m.RestoAnalysis), { ssr: false, loading: () => <LoadingChart /> });

export interface RestoTabProps {
  data: AnalysisData;
}

export const RestoTab = memo(function RestoTab({ data }: RestoTabProps) {
  return (
    <ErrorBoundary label="Resto Analysis">
      <RestoAnalysis analysisData={data} />
    </ErrorBoundary>
  );
});
