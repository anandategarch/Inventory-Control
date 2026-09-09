'use client';

// ============================================================
//  DashboardTab — the main "Dashboard" overview tab extracted
//  from page.tsx (lines 504-645 of the original god file).
//  --------------------------------------------------------
//  Renders 10+ analytical sections wrapped in ErrorBoundary.
//  Heavy chart components are lazy-loaded via next/dynamic to
//  keep Recharts (5.4MB) out of the main bundle.
//  PERF-FE: wrapped in React.memo — the parent (page.tsx) re-renders
//  on any Zustand state change (e.g., opening a modal). Without
//  memo, DashboardTab re-renders on every one of those even though
//  its only prop (`data`) hasn't changed. Since DashboardTab
//  contains 10+ sections, skipping unnecessary re-renders is a
//  meaningful win.
//  PERF-FE (PAKET A): the `isFetching` prop and the FetchAware
//  wrappers were removed. Every background refetch toggled the
//  prop false→true→false, defeating React.memo and re-rendering
//  10+ sections twice per cycle; FetchAware also dimmed the
//  sections and set `pointer-events-none`, freezing the whole
//  dashboard while stale data was still perfectly usable. The
//  global refresh indicator lives in DashboardHeader
//  (`analysisFetching`) — that is the single source of truth now.
// ============================================================

import { memo } from 'react';
import dynamic from 'next/dynamic';
import { BarChart3, Calendar, History, MapPin } from 'lucide-react';
import { ExecutiveSummary, HealthAlert } from '@/components/dashboard/ExecutiveSummary';
import { TopItemsByNominal, TopItemsByDevBom, TopOutlets } from '@/components/dashboard/TopItems';
import { InsightsPanel } from '@/components/dashboard/InsightsPanel';
import {
  OutletHealthRanking, ItemConsistencyAnalysis, AreaComparison,
} from '@/components/dashboard/AdvancedAnalysis';
import { RestoRecommendationCard } from '@/components/dashboard/RestoRecommendationCard';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import {
  LoadingChart, SectionHeader,
} from '@/components/dashboard/shared';
import type { AnalysisData } from '@/hooks/useAnalysis';

// Phase 4: Lazy-load heavy chart components (Recharts = 5.4MB)
// ssr: false — charts are client-only (use ResponsiveContainer which needs window)
const GrowthComparison = dynamic(() => import('@/components/dashboard/Charts').then(m => m.GrowthComparison), { ssr: false, loading: () => <LoadingChart /> });
const DeviationBreakdownChart = dynamic(() => import('@/components/dashboard/Charts').then(m => m.DeviationBreakdownChart), { ssr: false, loading: () => <LoadingChart /> });
const LossVsSurplusChart = dynamic(() => import('@/components/dashboard/Charts').then(m => m.LossVsSurplusChart), { ssr: false, loading: () => <LoadingChart /> });
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
      {/* Section: Executive Summary */}
      <ErrorBoundary label="Executive Summary">
        <ExecutiveSummary data={data} />
      </ErrorBoundary>

      {/* Section: Resto Recommendation Engine */}
      <ErrorBoundary label="Resto Prioritas Analisa">
        <RestoRecommendationCard />
      </ErrorBoundary>

      {/* Section: Insights Panel */}
      <ErrorBoundary label="Insights Panel">
        <InsightsPanel data={data} />
      </ErrorBoundary>

      {/* Section: Health + Growth */}
      <section className="grid lg:grid-cols-3 gap-4 min-w-0">
        <ErrorBoundary label="Health Alert">
          <HealthAlert data={data} />
        </ErrorBoundary>
        <ErrorBoundary label="Growth Comparison">
          <GrowthComparison data={data} />
        </ErrorBoundary>
        <ErrorBoundary label="Deviation Breakdown">
          <DeviationBreakdownChart data={data} />
        </ErrorBoundary>
      </section>

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

      {/* Section: Top Items + Top Outlets */}
      <section>
        <SectionHeader
          icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
          title="Item Prioritas & Top Resto"
        />
        {/* FIX (UI-05): added min-w-0 to grid wrapper to prevent overflow.
            FIX (UI-15): removed redundant sm:grid-cols-1 (default behavior). */}
        <div className="grid lg:grid-cols-3 gap-4 min-w-0">
          <ErrorBoundary label="Top Items & Outlets">
            <TopItemsByNominal data={data} />
            <TopItemsByDevBom data={data} />
            <TopOutlets data={data} />
          </ErrorBoundary>
        </div>
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

      {/* Section: Loss/Surplus (TrendChart removed per user request) */}
      {/* FIX (UI-05): added min-w-0 to grid wrapper. */}
      <section className="grid lg:grid-cols-1 gap-4 min-w-0">
        <ErrorBoundary label="Loss vs Surplus">
          <LossVsSurplusChart data={data} />
        </ErrorBoundary>
      </section>

      {/* Section: Heatmap Area × Item (standalone fetch, not dependent on analysis data) */}
      <ErrorBoundary label="Heatmap Area × Item">
        <AreaItemHeatmap />
      </ErrorBoundary>
    </div>
  );
});
