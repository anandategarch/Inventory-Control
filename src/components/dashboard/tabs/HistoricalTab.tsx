'use client';

// ============================================================
//  HistoricalTab — "Historical" tab (VH-2, D4): the historical
//  cluster promoted from the old DashboardTab:
//    1. HistoricalZScoreCard (abnormal vs historical baseline)
//    2. MultiPeriodComparisonCard (per-period comparison)
//    3. BomCorrelationCard (BOM deviation correlation)
//  --------------------------------------------------------
//  Lazy-loaded at page level (React.lazy + Suspense + TabSkeleton).
//  The chart components stay next/dynamic + ssr:false with a
//  LoadingChart fallback (pattern carried over from the old
//  DashboardTab — Recharts = 5.4MB stays out of the main bundle).
//  PERF-FE: wrapped in React.memo — page.tsx re-renders on any
//  Zustand state change; without memo this subtree re-renders
//  unnecessarily.
// ============================================================

import { memo } from 'react';
import dynamic from 'next/dynamic';
import { History } from 'lucide-react';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import { LoadingChart, SectionHeader } from '@/components/dashboard/shared';
import type { AnalysisData } from '@/hooks/useAnalysis';

// Phase 4: Lazy-load heavy chart components (Recharts = 5.4MB)
// ssr: false — charts are client-only (use ResponsiveContainer which needs window)
const MultiPeriodComparisonCard = dynamic(() => import('@/components/dashboard/AnalysisCards').then(m => m.MultiPeriodComparisonCard), { ssr: false, loading: () => <LoadingChart /> });
const HistoricalZScoreCard = dynamic(() => import('@/components/dashboard/HistoricalZScoreCard').then(m => m.HistoricalZScoreCard), { ssr: false, loading: () => <LoadingChart /> });
const BomCorrelationCard = dynamic(() => import('@/components/dashboard/BomCorrelationCard').then(m => m.BomCorrelationCard), { ssr: false, loading: () => <LoadingChart /> });

export interface HistoricalTabProps {
  data: AnalysisData;
}

export const HistoricalTab = memo(function HistoricalTab({ data }: HistoricalTabProps) {
  return (
    <div className="space-y-4 min-w-0">
      {/* VH-7: section header — the tab interior opens with the question the
          three historical modules answer ("Enrich with Context"). */}
      <SectionHeader
        icon={<History className="h-4 w-4 text-muted-foreground" />}
        title="Analisa vs Baseline Historis"
        description="Apakah kondisi periode ini abnormal dibanding baseline historisnya sendiri (same-week lintas bulan)?"
      />

      {/* Section: Historical Z-Score (replaces Area Trend) */}
      <ErrorBoundary label="Historical Z-Score">
        <HistoricalZScoreCard data={data} />
      </ErrorBoundary>

      {/* Section: Multi-Period Comparison */}
      <ErrorBoundary label="Multi-Period Comparison">
        <MultiPeriodComparisonCard data={data} />
      </ErrorBoundary>

      {/* Section: BOM Correlation */}
      <ErrorBoundary label="BOM Correlation">
        <BomCorrelationCard data={data} />
      </ErrorBoundary>
    </div>
  );
});
