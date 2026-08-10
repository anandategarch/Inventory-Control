'use client';

import { useEffect } from 'react';
import { useDashboard } from '@/hooks/useDashboard';
import { useAnalysis, useStatus } from '@/hooks/useAnalysis';
import { FilterBar } from '@/components/filters/FilterBar';
import { ExecutiveSummary, HealthAlert } from '@/components/dashboard/ExecutiveSummary';
import { GrowthComparison, DeviationBreakdownChart, LossVsSurplusChart, TrendChart } from '@/components/dashboard/Charts';
import { TopItemsByNominal, TopItemsByDevBom, TopOutlets, InvestigationWorklist } from '@/components/dashboard/TopItems';
import { NarrativePanel, RecommendationPanel } from '@/components/dashboard/Narrative';
import {
  HealthDistributionDonut,
  DeviationCategoryDonut,
  AreaContributionBar,
  TopItemsHorizontalBar,
  VarianceDivergingBar,
  OutletRadarChart,
  DirectionDistributionPie,
  CumulativeDeviationArea,
  AreaLossSalesComparison,
} from '@/components/dashboard/ExtraCharts';
import { InsightsPanel } from '@/components/dashboard/InsightsPanel';
import { DrillDownDrawer } from '@/components/drilldown/DrillDownDrawer';
import { SourceDataModal } from '@/components/drilldown/SourceDataModal';
import { CardDrillDown } from '@/components/dashboard/CardDrillDown';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import {
  Activity, Boxes, BarChart3, ShieldAlert, FileSearch, Brain, Lightbulb,
  TrendingUp, MapPin, Coins, PieChart as PieChartIcon,
} from 'lucide-react';

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <Boxes className="h-12 w-12 text-muted-foreground/50 mb-4" />
      <h3 className="text-lg font-semibold">Tidak Ada Data Tersedia</h3>
      <p className="text-sm text-muted-foreground mt-2 max-w-md">
        Tidak ada data inventory di database. Hubungi administrator untuk import data.
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
        <h3 className="text-base font-semibold text-red-700 dark:text-red-400 mb-1">Error Analisis</h3>
        <p className="text-sm text-red-600 dark:text-red-400/90">{message}</p>
      </CardContent>
    </Card>
  );
}

function SectionHeader({ icon, title, badge }: { icon: React.ReactNode; title: string; badge?: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      {icon}
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {badge && <Badge variant="outline" className="text-xs">{badge}</Badge>}
    </div>
  );
}

export default function DashboardPage() {
  const { monthLabel, currentWeek, comparisonWeek, comparisonMonth, area, outletCode, itemName, pic, setMonth, setWeek, activeTab, setActiveTab } = useDashboard();
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
    pic,
  });

  const isLoading = analysis.isLoading || analysis.isFetching;
  const statusLoaded = status !== undefined;
  const hasData = statusLoaded && Boolean(status?.stats?.totalRecords && status.stats.totalRecords > 0);

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
              <p className="text-xs text-muted-foreground">
                {status?.stats ? `${status.stats.totalOutlets} Outlet · ` : ''}F&amp;B Network · Rekonsiliasi &amp; Deteksi Anomali
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {analysis.data && (
              <Badge variant="outline" className="text-[10px] hidden sm:inline-flex">
                <Activity className="h-3 w-3 mr-1" />
                {analysis.data.cached ? 'cache' : 'langsung'} · {analysis.data.durationMs}ms
              </Badge>
            )}
            {analysis.data?.narrativeSource === 'llm' && (
              <Badge variant="default" className="text-[10px] hidden sm:inline-flex">
                <Brain className="h-3 w-3 mr-1" /> Narasi AI
              </Badge>
            )}
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 px-4 sm:px-6 py-4 space-y-4 max-w-[1600px] w-full mx-auto">
        <FilterBar />

        {!statusLoaded ? (
          <LoadingState />
        ) : !hasData ? (
          <EmptyState />
        ) : isLoading && !analysis.data ? (
          <LoadingState />
        ) : analysis.error ? (
          <ErrorState message={analysis.error.message} />
        ) : analysis.data ? (
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="w-full justify-start overflow-x-auto h-auto flex-wrap">
              <TabsTrigger value="dashboard" className="text-xs">
                <BarChart3 className="h-3.5 w-3.5" /> Dashboard
              </TabsTrigger>
              <TabsTrigger value="insight" className="text-xs">
                <Lightbulb className="h-3.5 w-3.5" /> Insight
              </TabsTrigger>
              <TabsTrigger value="investigasi" className="text-xs">
                <FileSearch className="h-3.5 w-3.5" /> Investigasi
              </TabsTrigger>
              <TabsTrigger value="area" className="text-xs">
                <MapPin className="h-3.5 w-3.5" /> Area
              </TabsTrigger>
              <TabsTrigger value="cost" className="text-xs">
                <Coins className="h-3.5 w-3.5" /> Cost Accounting
              </TabsTrigger>
            </TabsList>

            {/* ====== DASHBOARD TAB ====== */}
            <TabsContent value="dashboard" className="space-y-4 mt-2">
              {/* Section: Executive Summary */}
              <section>
                <ExecutiveSummary data={analysis.data} />
              </section>

              {/* Section: Insights Panel */}
              <section>
                <InsightsPanel data={analysis.data} />
              </section>

              {/* Section: Distribusi Visual (3 donuts) */}
              <section>
                <SectionHeader
                  icon={<PieChartIcon className="h-4 w-4 text-muted-foreground" />}
                  title="Distribusi Visual"
                />
                <div className="grid md:grid-cols-3 gap-4">
                  <HealthDistributionDonut data={analysis.data} />
                  <DirectionDistributionPie data={analysis.data} />
                  <DeviationCategoryDonut data={analysis.data} />
                </div>
              </section>

              {/* Section: Health + Growth */}
              <section className="grid lg:grid-cols-3 gap-4">
                <HealthAlert data={analysis.data} />
                <GrowthComparison data={analysis.data} />
                <DeviationBreakdownChart data={analysis.data} />
              </section>

              {/* Section: Top Items */}
              <section>
                <SectionHeader
                  icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
                  title="Item Prioritas"
                />
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

              {/* Section: Cumulative Deviation */}
              <section>
                <CumulativeDeviationArea data={analysis.data} />
              </section>

              {/* Section: Ranking Visual */}
              <section>
                <SectionHeader
                  icon={<TrendingUp className="h-4 w-4 text-muted-foreground" />}
                  title="Ranking Visual"
                />
                <div className="grid lg:grid-cols-2 gap-4">
                  <TopItemsHorizontalBar data={analysis.data} />
                  <VarianceDivergingBar data={analysis.data} />
                </div>
              </section>

              {/* Section: Outlet Radar */}
              <section>
                <OutletRadarChart data={analysis.data} />
              </section>

              {/* Section: Daftar Investigasi */}
              <section>
                <SectionHeader
                  icon={<FileSearch className="h-4 w-4 text-muted-foreground" />}
                  title="Daftar Investigasi"
                  badge={`${analysis.data.investigationWorklist.length} item`}
                />
                <InvestigationWorklist data={analysis.data} />
              </section>

              {/* Section: Narrative + Recommendation */}
              <section className="grid lg:grid-cols-2 gap-4">
                <NarrativePanel data={analysis.data} />
                <RecommendationPanel data={analysis.data} />
              </section>
            </TabsContent>

            {/* ====== INSIGHT TAB ====== */}
            <TabsContent value="insight" className="space-y-4 mt-2">
              <InsightsPanel data={analysis.data} />

              <section className="grid md:grid-cols-2 gap-4">
                <HealthDistributionDonut data={analysis.data} />
                <DeviationCategoryDonut data={analysis.data} />
              </section>

              <section className="grid lg:grid-cols-2 gap-4">
                <TopItemsHorizontalBar data={analysis.data} />
                <VarianceDivergingBar data={analysis.data} />
              </section>

              <OutletRadarChart data={analysis.data} />

              <CumulativeDeviationArea data={analysis.data} />

              <section className="grid lg:grid-cols-2 gap-4">
                <NarrativePanel data={analysis.data} />
                <RecommendationPanel data={analysis.data} />
              </section>
            </TabsContent>

            {/* ====== INVESTIGATION TAB ====== */}
            <TabsContent value="investigasi" className="space-y-4 mt-2">
              <section>
                <SectionHeader
                  icon={<FileSearch className="h-4 w-4 text-muted-foreground" />}
                  title="Daftar Investigasi"
                  badge={`${analysis.data.investigationWorklist.length} item`}
                />
                <InvestigationWorklist data={analysis.data} />
              </section>

              <section className="grid lg:grid-cols-2 gap-4">
                <TopItemsByNominal data={analysis.data} />
                <TopItemsByDevBom data={analysis.data} />
              </section>

              <section className="grid lg:grid-cols-2 gap-4">
                <TopItemsHorizontalBar data={analysis.data} />
                <VarianceDivergingBar data={analysis.data} />
              </section>
            </TabsContent>

            {/* ====== AREA TAB ====== */}
            <TabsContent value="area" className="space-y-4 mt-2">
              <section>
                <SectionHeader
                  icon={<MapPin className="h-4 w-4 text-muted-foreground" />}
                  title="Perbandingan Area"
                />
                <div className="grid lg:grid-cols-2 gap-4">
                  <AreaContributionBar data={analysis.data} />
                  <AreaLossSalesComparison data={analysis.data} />
                </div>
              </section>

              <section>
                <SectionHeader
                  icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
                  title="Top Outlet"
                />
                <TopOutlets data={analysis.data} />
              </section>

              <OutletRadarChart data={analysis.data} />
            </TabsContent>

            {/* ====== COST TAB ====== */}
            <TabsContent value="cost" className="space-y-4 mt-2">
              <section>
                <SectionHeader
                  icon={<Coins className="h-4 w-4 text-muted-foreground" />}
                  title="Analisis Cost Accounting"
                />
                <CumulativeDeviationArea data={analysis.data} />
              </section>

              <section className="grid lg:grid-cols-2 gap-4">
                <LossVsSurplusChart data={analysis.data} />
                <TrendChart data={analysis.data} />
              </section>

              <section className="grid lg:grid-cols-2 gap-4">
                <TopItemsHorizontalBar data={analysis.data} />
                <AreaContributionBar data={analysis.data} />
              </section>
            </TabsContent>
          </Tabs>
        ) : null}
      </main>

      {/* Footer (sticky bottom) */}
      <footer className="mt-auto border-t bg-background/95 backdrop-blur">
        <div className="px-4 sm:px-6 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <ShieldAlert className="h-3 w-3" />
              Mesin Deterministik + Narasi AI
            </span>
            {status?.stats && (
              <span className="hidden sm:inline">
                {status.stats.totalOutlets} outlet · {status.stats.totalItems} item · {status.stats.totalRecords.toLocaleString()} record
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {analysis.data && (
              <span>
                Analisis terakhir: {analysis.data.durationMs}ms · {analysis.data.cached ? 'cache' : 'segar'}
              </span>
            )}
            <span>Klik baris mana saja untuk drill-down ke sumber</span>
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
