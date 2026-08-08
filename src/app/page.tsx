'use client';

import { useEffect } from 'react';
import { useDashboard } from '@/hooks/useDashboard';
import { useAnalysis, useStatus } from '@/hooks/useAnalysis';
import { FilterBar } from '@/components/filters/FilterBar';
import { ExecutiveSummary, HealthAlert } from '@/components/dashboard/ExecutiveSummary';
import { GrowthComparison, DeviationBreakdownChart, LossVsSurplusChart, TrendChart } from '@/components/dashboard/Charts';
import { TopItemsByNominal, TopItemsByDevBom, TopOutlets, InvestigationWorklist } from '@/components/dashboard/TopItems';
import { NarrativePanel, RecommendationPanel } from '@/components/dashboard/Narrative';
import { DrillDownDrawer } from '@/components/drilldown/DrillDownDrawer';
import { SourceDataModal } from '@/components/drilldown/SourceDataModal';
import { CardDrillDown } from '@/components/dashboard/CardDrillDown';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Activity, Boxes, BarChart3, ShieldAlert, FileSearch, Brain, Lightbulb, TrendingUp } from 'lucide-react';

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <Boxes className="h-12 w-12 text-muted-foreground/50 mb-4" />
      <h3 className="text-lg font-semibold">No Data Ingested Yet</h3>
      <p className="text-sm text-muted-foreground mt-2 max-w-md">
        Place your monthly Excel files in <code className="px-1 py-0.5 rounded bg-muted text-xs">data/inventory/</code> folder,
        then click &quot;Refresh Data&quot; to ingest.
      </p>
      <p className="text-xs text-muted-foreground mt-4">
        Sample file already loaded: <code className="px-1 py-0.5 rounded bg-muted">Juli 2026.xlsx</code>
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
      </div>
      <Skeleton className="h-32" />
      <div className="grid lg:grid-cols-2 gap-4">
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
      </div>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <Card className="border-red-200 bg-red-50 dark:bg-red-950/20 dark:border-red-900">
      <CardContent className="p-6">
        <h3 className="text-base font-semibold text-red-700 dark:text-red-400 mb-1">Analysis Error</h3>
        <p className="text-sm text-red-600 dark:text-red-400/90">{message}</p>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const { monthLabel, currentWeek, comparisonWeek, comparisonMonth, area, outletCode, itemName, setMonth, setWeek } = useDashboard();
  const { data: status } = useStatus();

  // Auto-select first available month/week on mount
  useEffect(() => {
    if (!monthLabel && status?.months?.length) {
      setMonth(status.months[status.months.length - 1].label);
    }
  }, [status, monthLabel, setMonth]);

  useEffect(() => {
    if (monthLabel && !currentWeek && status?.weeksByMonth) {
      const m = status.months.find((mm) => mm.label === monthLabel);
      if (m) {
        const weeks = status.weeksByMonth[m.key];
        if (weeks?.length) setWeek(weeks[weeks.length - 1]);
      }
    }
  }, [status, monthLabel, currentWeek, setWeek]);

  const analysis = useAnalysis({
    month: monthLabel,
    week: currentWeek,
    compareWeek: comparisonWeek,
    compareMonth: comparisonMonth,
    area,
    outlet: outletCode,
    item: itemName,
  });

  const isLoading = analysis.isLoading || analysis.isFetching;
  const hasData = status?.stats?.totalRecords && status.stats.totalRecords > 0;

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-40">
        <div className="px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Boxes className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-base font-semibold tracking-tight">Inventory Control Intelligence</h1>
              <p className="text-xs text-muted-foreground">19-Outlet F&amp;B Network · Reconciliation &amp; Anomaly Detection</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {analysis.data && (
              <Badge variant="outline" className="text-[10px] hidden sm:inline-flex">
                <Activity className="h-3 w-3 mr-1" />
                {analysis.data.cached ? 'cached' : 'live'} · {analysis.data.durationMs}ms
              </Badge>
            )}
            {analysis.data?.narrativeSource === 'llm' && (
              <Badge variant="default" className="text-[10px] hidden sm:inline-flex">
                <Brain className="h-3 w-3 mr-1" /> AI Narrative
              </Badge>
            )}
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 px-4 sm:px-6 py-4 space-y-4 max-w-[1600px] w-full mx-auto">
        <FilterBar />

        {!hasData ? (
          <EmptyState />
        ) : isLoading && !analysis.data ? (
          <LoadingState />
        ) : analysis.error ? (
          <ErrorState message={analysis.error.message} />
        ) : analysis.data ? (
          <>
            {/* Section: Executive Summary */}
            <section>
              <ExecutiveSummary data={analysis.data} />
            </section>

            {/* Section: Health + Growth */}
            <section className="grid lg:grid-cols-3 gap-4">
              <HealthAlert data={analysis.data} />
              <GrowthComparison data={analysis.data} />
              <DeviationBreakdownChart data={analysis.data} />
            </section>

            {/* Section: Top Items */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-lg font-semibold tracking-tight">Top Priority Items</h2>
              </div>
              <div className="grid lg:grid-cols-3 gap-4">
                <TopItemsByNominal data={analysis.data} />
                <TopItemsByDevBom data={analysis.data} />
                <TopOutlets data={analysis.data} />
              </div>
            </section>

            {/* Section: Loss/Surplus + Trend */}
            <section className="grid lg:grid-cols-2 gap-4">
              <LossVsSurplusChart data={analysis.data} />
              <TrendChart data={analysis.data} />
            </section>

            {/* Section: Investigation Worklist */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <FileSearch className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-lg font-semibold tracking-tight">Investigation Worklist</h2>
                <Badge variant="outline" className="text-xs">{analysis.data.investigationWorklist.length} items</Badge>
              </div>
              <InvestigationWorklist data={analysis.data} />
            </section>

            {/* Section: Narrative + Recommendation */}
            <section className="grid lg:grid-cols-2 gap-4">
              <NarrativePanel data={analysis.data} />
              <RecommendationPanel data={analysis.data} />
            </section>
          </>
        ) : null}
      </main>

      {/* Footer (sticky bottom) */}
      <footer className="mt-auto border-t bg-background/95 backdrop-blur">
        <div className="px-4 sm:px-6 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <ShieldAlert className="h-3 w-3" />
              Deterministic Engine + AI Narrative
            </span>
            {status?.stats && (
              <span className="hidden sm:inline">
                {status.stats.totalOutlets} outlets · {status.stats.totalItems} items · {status.stats.totalRecords.toLocaleString()} records
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {analysis.data && (
              <span>
                Last analysis: {analysis.data.durationMs}ms · {analysis.data.cached ? 'cached' : 'fresh'}
              </span>
            )}
            <span>Click any row to drill-down to source</span>
          </div>
        </div>
      </footer>

      {/* Drill-down drawer */}
      <DrillDownDrawer />
      <SourceDataModal />
      <CardDrillDown data={analysis.data} />
    </div>
  );
}
