'use client';

// ============================================================
//  DashboardTab — the "Dashboard" overview tab.
//  --------------------------------------------------------
//  VH-1 (Visual Hierarchy restructure): the narrative sections
//  (ExecutiveSummary + HealthAlert, Item Prioritas, Resto
//  Prioritas, Insights, Growth + Deviation Breakdown + Price
//  Effect, Top Growth, Loss vs Surplus) were LIFTED OUT of this
//  tab into the always-visible DashboardNarrative above the tab
//  strip (see narrative/DashboardNarrative.tsx). What remains
//  here are the deep-analysis sections that VH-2 will promote
//  into their own tabs (Area, Item, Historical, Heatmap) — kept
//  as-is in the interim.
//  All heavy chart components stay lazy-loaded via next/dynamic
//  (Recharts = 5.4MB out of the main bundle).
//  PERF-FE: wrapped in React.memo — the parent (page.tsx) re-renders
//  on any Zustand state change (e.g., opening a modal). Without
//  memo, this subtree re-renders on every one of those even though
//  its only prop (`data`) hasn't changed.
// ============================================================

import { memo } from 'react';
import dynamic from 'next/dynamic';
import { BarChart3, Calendar, History, MapPin } from 'lucide-react';
import {
  OutletHealthRanking, ItemConsistencyAnalysis, AreaComparison,
} from '@/components/dashboard/AdvancedAnalysis';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import {
  LoadingChart, SectionHeader,
} from '@/components/dashboard/shared';
import type { AnalysisData } from '@/hooks/useAnalysis';

// Phase 4: Lazy-load heavy chart components (Recharts = 5.4MB)
// ssr: false — charts are client-only (use ResponsiveContainer which needs window)
const MultiPeriodComparisonCard = dynamic(() => import('@/components/dashboard/AnalysisCards').then(m => m.MultiPeriodComparisonCard), { ssr: false, loading: () => <LoadingChart /> });
const HistoricalZScoreCard = dynamic(() => import('@/components/dashboard/HistoricalZScoreCard').then(m => m.HistoricalZScoreCard), { ssr: false, loading: () => <LoadingChart /> });
const BomCorrelationCard = dynamic(() => import('@/components/dashboard/BomCorrelationCard').then(m => m.BomCorrelationCard), { ssr: false, loading: () => <LoadingChart /> });
const AreaItemHeatmap = dynamic(() => import('@/components/dashboard/AreaItemHeatmap').then(m => m.AreaItemHeatmap), { ssr: false, loading: () => <LoadingChart /> });

export interface DashboardTabProps {
  data: AnalysisData;
}

export const DashboardTab = memo(function DashboardTab({ data }: DashboardTabProps) {
  return (
    <div className="space-y-4 min-w-0">
      {/* Section: Multi-Period Comparison */}
      <section>
        <SectionHeader
          icon={<Calendar className="h-4 w-4 text-muted-foreground" />}
          title="Perbandingan Multi-Periode"
        />
        <ErrorBoundary label="Multi-Period Comparison">
          <MultiPeriodComparisonCard data={data} />
        </ErrorBoundary>
      </section>

      {/* Section: Area Comparison + Outlet Health Ranking */}
      {/* FIX (UI-15): removed redundant sm:grid-cols-1 (default behavior). */}
      <section className="grid lg:grid-cols-2 gap-4 min-w-0">
        <div>
          <SectionHeader
            icon={<MapPin className="h-4 w-4 text-muted-foreground" />}
            title="Perbandingan Area"
          />
          <ErrorBoundary label="Area Comparison">
            <AreaComparison data={data} />
          </ErrorBoundary>
        </div>
        <div>
          <SectionHeader
            icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
            title="Ranking Kondisi Resto"
          />
          <ErrorBoundary label="Outlet Health Ranking">
            <OutletHealthRanking data={data} />
          </ErrorBoundary>
        </div>
      </section>

      {/* Section: Item Consistency */}
      <section>
        <SectionHeader
          icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
          title="Pola Item (Massal / Regional / Lokal)"
        />
        <ErrorBoundary label="Item Consistency Analysis">
          <ItemConsistencyAnalysis data={data} />
        </ErrorBoundary>
      </section>

      {/* Section: Historical Z-Score + BOM Correlation (replaces Area Trend) */}
      <section>
        <SectionHeader
          icon={<History className="h-4 w-4 text-muted-foreground" />}
          title="Analisis Historis (Z-Score + Korelasi BOM)"
        />
        <div className="space-y-4">
          <ErrorBoundary label="Historical Z-Score">
            <HistoricalZScoreCard data={data} />
          </ErrorBoundary>
          <ErrorBoundary label="BOM Correlation">
            <BomCorrelationCard data={data} />
          </ErrorBoundary>
        </div>
      </section>

      {/* Section: Heatmap Area × Item (standalone fetch, not dependent on analysis data) */}
      <ErrorBoundary label="Heatmap Area × Item">
        <AreaItemHeatmap />
      </ErrorBoundary>
    </div>
  );
});
