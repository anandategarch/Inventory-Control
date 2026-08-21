'use client';

import { useEffect, useState } from 'react';
import { useDashboard } from '@/hooks/useDashboard';
import { useAnalysis, useStatus } from '@/hooks/useAnalysis';
import { FilterBar } from '@/components/filters/FilterBar';
import { ExecutiveSummary, HealthAlert } from '@/components/dashboard/ExecutiveSummary';
import { GrowthComparison, DeviationBreakdownChart, LossVsSurplusChart, TrendChart } from '@/components/dashboard/Charts';
import { TopItemsByNominal, TopItemsByDevBom, TopOutlets } from '@/components/dashboard/TopItems';
import { InsightsPanel } from '@/components/dashboard/InsightsPanel';
import {
  OutletHealthRanking, ItemConsistencyAnalysis, AreaComparison,
} from '@/components/dashboard/AdvancedAnalysis';
import {
  MultiPeriodComparisonCard,
} from '@/components/dashboard/AnalysisCards';
import { RestoAnalysis } from '@/components/dashboard/RestoAnalysis';
import { RestoRecommendationCard } from '@/components/dashboard/RestoRecommendationCard';
import { PeerComparison } from '@/components/dashboard/PeerComparison';
import { ItemDeepDive } from '@/components/dashboard/ItemDeepDive';
import { ExportDialog } from '@/components/dashboard/ExportDialog';
// CostAccounting components removed — tab Cost Accounting dihapus
import { DrillDownDrawer } from '@/components/drilldown/DrillDownDrawer';
import { SourceDataModal } from '@/components/drilldown/SourceDataModal';
import { CardDrillDown } from '@/components/dashboard/CardDrillDown';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import {
  Activity, Boxes, BarChart3, ShieldAlert,
  MapPin,
  Calendar, Loader2, Store,
  FileDown,
} from 'lucide-react';

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 px-4 text-center">
      <div className="relative mb-6">
        <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-amber-200/40 to-red-200/40 dark:from-amber-900/20 dark:to-red-900/20 blur-2xl" aria-hidden />
        <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border bg-gradient-to-br from-muted/80 to-muted/40 dark:from-zinc-800 dark:to-zinc-900 shadow-sm">
          <Boxes className="h-8 w-8 text-muted-foreground/70" />
        </div>
      </div>
      <h3 className="text-lg font-semibold tracking-tight">Tidak Ada Data Tersedia</h3>
      <p className="text-sm text-muted-foreground mt-2 max-w-md leading-relaxed">
        Belum ada data inventory di database. Hubungi administrator untuk import data pertama kali.
      </p>
    </div>
  );
}

function LoadingState({ text = 'Memuat data analisis...' }: { text?: string }) {
  return (
    <div className="space-y-4">
      {/* Loading banner */}
      <div className="flex items-center justify-center gap-2.5 py-3 text-sm text-muted-foreground rounded-lg border bg-muted/30">
        <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
        <span className="font-medium">{text}</span>
      </div>
      {/* Skeleton grid — KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card p-4 space-y-2">
            <div className="flex items-center justify-between">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-8 rounded-full" />
            </div>
            <Skeleton className="h-6 w-28" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
      {/* Skeleton — recommendation card */}
      <div className="rounded-xl border bg-card p-5 space-y-3">
        <Skeleton className="h-5 w-48" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-lg border p-3 space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-2 w-full" />
          </div>
        ))}
      </div>
      {/* Skeleton — insights + health */}
      <div className="grid lg:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card p-5 space-y-3">
            <Skeleton className="h-5 w-32" />
            {Array.from({ length: 4 }).map((_, j) => (
              <Skeleton key={j} className="h-3 w-full" />
            ))}
          </div>
        ))}
      </div>
      {/* Skeleton — top items tables */}
      <div className="grid lg:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card p-5 space-y-2">
            <Skeleton className="h-5 w-40" />
            {Array.from({ length: 6 }).map((_, j) => (
              <Skeleton key={j} className="h-3 w-full" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <Card className="border-red-200/70 bg-gradient-to-br from-red-50 to-red-50/30 dark:from-red-950/40 dark:to-red-950/10 dark:border-red-900/70 shadow-sm">
      <CardContent className="p-6">
        <div className="flex items-start gap-3">
          <div className="shrink-0 flex h-9 w-9 items-center justify-center rounded-lg bg-red-100 dark:bg-red-950/60 text-red-600 dark:text-red-400">
            <ShieldAlert className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-red-700 dark:text-red-400">Gagal Memuat Analisis</h3>
            <p className="text-sm text-red-600/90 dark:text-red-400/80 mt-1 leading-relaxed">{message}</p>
            <p className="text-xs text-red-600/60 dark:text-red-400/50 mt-2">
              Periksa koneksi jaringan atau coba refresh halaman. Jika berlanjut, hubungi administrator.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SectionHeader({ icon, title, badge, isFetching }: { icon: React.ReactNode; title: string; badge?: string; isFetching?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 mb-3">
      <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground shrink-0">
        {icon}
      </span>
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      {badge && (
        <Badge variant="outline" className="text-[10px] font-medium text-muted-foreground/80 h-5">
          {badge}
        </Badge>
      )}
      {isFetching && (
        <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-300/70 dark:text-amber-400 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30 h-5">
          <Loader2 className="h-2.5 w-2.5 mr-0.5 animate-spin" />
          Memperbarui
        </Badge>
      )}
    </div>
  );
}

// Wrapper that shows loading overlay when fetching
function FetchAware({ isFetching, children }: { isFetching: boolean; children: React.ReactNode }) {
  return (
    <div className={`relative transition-all duration-200 ${isFetching ? 'opacity-95' : 'opacity-100'}`}>
      {isFetching && (
        <div className="absolute -top-1 right-1 z-10">
          <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-300/70 dark:text-amber-400 dark:border-amber-800/70 bg-background/85 backdrop-blur-sm h-5 shadow-sm">
            <Loader2 className="h-2.5 w-2.5 mr-0.5 animate-spin" />
            Memperbarui
          </Badge>
        </div>
      )}
      {children}
    </div>
  );
}

export default function DashboardPage() {
  const { monthLabel, currentWeek, comparisonWeek, comparisonMonth, area, outletCode, itemName, pic, setMonth, setWeek, setCompareWeek, activeTab, setActiveTab } = useDashboard();
  const { data: status } = useStatus();

  // Auto-select first available month/week on mount
  useEffect(() => {
    if (!monthLabel && status?.months?.length) {
      setMonth(status.months[status.months.length - 1].label);
    }
  }, [status, monthLabel, setMonth]);

  useEffect(() => {
    if (monthLabel && !currentWeek && status?.weeksByMonth && status?.months) {
      const m = status.months.find((mm) => mm.label === monthLabel);
      if (m) {
        const weeks = status.weeksByMonth[m.key];
        if (weeks?.length) setWeek(weeks[weeks.length - 1]);
      }
    }
  }, [status, monthLabel, currentWeek, setWeek]);

  // Auto-set default periode pembanding = SAME weekLabel in previous month (cumulative weeks)
  // FIX (BUG 1): Was using chronological previous (W4→W2 same month = false positive growth).
  // Now finds same weekLabel in most recent month BEFORE current (W4 Juli → W4 Juni).
  useEffect(() => {
    if (monthLabel && currentWeek && !comparisonWeek && status?.weeksByMonth && status?.months) {
      const allPeriods: Array<{ monthLabel: string; weekLabel: string; sortKey: string }> = [];
      for (const m of status.months) {
        const ws = status.weeksByMonth[m.key] || [];
        for (const w of ws) {
          allPeriods.push({ monthLabel: m.label, weekLabel: w, sortKey: `${m.key}|${String(parseInt(w.replace(/\D/g, '')) || 0).padStart(2, '0')}` });
        }
      }
      allPeriods.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
      const currentIdx = allPeriods.findIndex((p) => p.monthLabel === monthLabel && p.weekLabel === currentWeek);
      if (currentIdx >= 0) {
        // Search backwards for same weekLabel in a DIFFERENT month
        let found: { monthLabel: string; weekLabel: string } | null = null;
        for (let i = currentIdx - 1; i >= 0; i--) {
          if (allPeriods[i].weekLabel === currentWeek && allPeriods[i].monthLabel !== monthLabel) {
            found = allPeriods[i];
            break;
          }
        }
        // Fallback: chronological previous period
        if (!found && currentIdx > 0) {
          found = allPeriods[currentIdx - 1];
        }
        if (found) setCompareWeek(found.weekLabel, found.monthLabel);
      }
    }
  }, [status, monthLabel, currentWeek, comparisonWeek, setCompareWeek]);

  // Bug 8 fix: validate currentWeek belongs to monthLabel — reset if invalid
  useEffect(() => {
    if (monthLabel && currentWeek && status?.weeksByMonth && status?.months) {
      const m = status.months.find((mm) => mm.label === monthLabel);
      if (m) {
        const weeks = status.weeksByMonth[m.key] || [];
        if (!weeks.includes(currentWeek)) {
          // currentWeek doesn't belong to this month — reset to last available week
          setWeek(weeks.length > 0 ? weeks[weeks.length - 1] : null);
        }
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

  const { toast } = useToast();
  const [isExporting, setIsExporting] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);

  const handleExport = async (selectedSections: string[]) => {
    if (!analysis.data) return;
    setExportDialogOpen(false);
    setIsExporting(true);
    try {
      const params = new URLSearchParams({ month: monthLabel || '', week: currentWeek || '' });
      if (comparisonWeek) params.set('compareWeek', comparisonWeek);
      if (comparisonMonth) params.set('compareMonth', comparisonMonth);
      if (area) params.set('area', area);
      if (outletCode) params.set('outlet', outletCode);
      if (itemName) params.set('item', itemName);
      if (pic) params.set('pic', pic);
      params.set('sections', selectedSections.join(','));

      const res = await fetch(`/api/export-report?${params.toString()}`);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Laporan_Analisis_${(monthLabel || 'unknown').replace(/\s+/g, '_')}_${currentWeek || ''}.docx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({ title: '✅ Export berhasil', description: `${selectedSections.length} section di-export ke Word` });
    } catch (e: any) {
      toast({ title: '❌ Export gagal', description: e?.message || 'Unknown error', variant: 'destructive' });
    } finally {
      setIsExporting(false);
    }
  };

  const isLoading = analysis.isLoading || analysis.isFetching;
  const statusLoaded = status !== undefined;
  const hasData = statusLoaded && Boolean(status?.stats?.totalRecords && status.stats.totalRecords > 0);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60 sticky top-0 z-40">
        <div className="px-4 sm:px-6 py-3 flex items-center justify-between gap-3 max-w-[1600px] mx-auto">
          <div className="flex items-center gap-3 min-w-0">
            <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-zinc-900 to-zinc-700 dark:from-zinc-100 dark:to-zinc-300 text-primary-foreground shadow-sm shrink-0">
              <Boxes className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-semibold tracking-tight truncate leading-tight">Inventory Control Intelligence</h1>
              <p className="text-[11px] text-muted-foreground truncate">
                {status?.stats ? (
                  <span className="tabular-nums">{status.stats.totalOutlets} Outlet · </span>
                ) : null}
                F&amp;B Network · Rekonsiliasi &amp; Deteksi Anomali
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {analysis.isFetching && analysis.data && (
              <Badge variant="outline" className="text-[11px] h-7 gap-1 border-amber-300/70 dark:border-amber-800/70 text-amber-700 dark:text-amber-400 bg-amber-50/60 dark:bg-amber-950/30">
                <Loader2 className="h-3 w-3 animate-spin" />
                Memperbarui...
              </Badge>
            )}
            {analysis.data && (
              <Badge variant="outline" className="text-[11px] h-7 hidden sm:inline-flex gap-1 text-muted-foreground">
                <Activity className="h-3 w-3" />
                <span className="tabular-nums">{analysis.data.cached ? 'cache' : 'langsung'} · {analysis.data.durationMs}ms</span>
              </Badge>
            )}
            {analysis.data && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs font-medium shadow-sm hover:shadow transition-all"
                disabled={isExporting}
                onClick={() => setExportDialogOpen(true)}
                aria-label="Export laporan Word"
              >
                {isExporting ? (
                  <><Loader2 className="h-3.5 w-3.5 animate-spin" /> <span className="hidden sm:inline">Exporting...</span></>
                ) : (
                  <><FileDown className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Export Word</span></>
                )}
              </Button>
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
            <TabsList className="w-full justify-start overflow-x-auto h-auto flex-wrap bg-muted/40 dark:bg-zinc-900/40 p-1 gap-1">
              <TabsTrigger value="dashboard" className="text-xs font-medium gap-1.5 data-[state=active]:bg-background data-[state=active]:shadow-sm">
                <BarChart3 className="h-3.5 w-3.5" /> Dashboard
              </TabsTrigger>
              <TabsTrigger value="resto" className="text-xs font-medium gap-1.5 data-[state=active]:bg-background data-[state=active]:shadow-sm">
                <Store className="h-3.5 w-3.5" /> Resto Analysis
              </TabsTrigger>
              <TabsTrigger value="peer" className="text-xs font-medium gap-1.5 data-[state=active]:bg-background data-[state=active]:shadow-sm">
                <Activity className="h-3.5 w-3.5" /> Peer Comparison
              </TabsTrigger>
            </TabsList>

            {/* ====== DASHBOARD TAB (Overview + Network) ====== */}
            <TabsContent value="dashboard" className="space-y-4 mt-2">
              {/* Section: Executive Summary */}
              <FetchAware isFetching={analysis.isFetching}>
                <ExecutiveSummary data={analysis.data} />
              </FetchAware>

              {/* Section: Resto Recommendation Engine */}
              <RestoRecommendationCard />

              {/* Section: Insights Panel */}
              <FetchAware isFetching={analysis.isFetching}>
                <InsightsPanel data={analysis.data} />
              </FetchAware>

              {/* Section: Health + Growth */}
              <FetchAware isFetching={analysis.isFetching}>
                <section className="grid lg:grid-cols-3 gap-4">
                  <HealthAlert data={analysis.data} />
                  <GrowthComparison data={analysis.data} />
                  <DeviationBreakdownChart data={analysis.data} />
                </section>
              </FetchAware>

              {/* Section: Multi-Period Comparison */}
              <section>
                <SectionHeader
                  icon={<Calendar className="h-4 w-4 text-muted-foreground" />}
                  title="Perbandingan Multi-Periode"
                  isFetching={analysis.isFetching}
                />
                <FetchAware isFetching={analysis.isFetching}>
                  <MultiPeriodComparisonCard data={analysis.data} />
                </FetchAware>
              </section>

              {/* Section: Top Items + Top Outlets */}
              <section>
                <SectionHeader
                  icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
                  title="Item Prioritas & Top Resto"
                  isFetching={analysis.isFetching}
                />
                <FetchAware isFetching={analysis.isFetching}>
                  <div className="grid lg:grid-cols-3 gap-4">
                    <TopItemsByNominal data={analysis.data} />
                    <TopItemsByDevBom data={analysis.data} />
                    <TopOutlets data={analysis.data} />
                  </div>
                </FetchAware>
              </section>

              {/* Section: Area Comparison + Outlet Health Ranking */}
              <section className="grid lg:grid-cols-2 gap-4">
                <div>
                  <SectionHeader
                    icon={<MapPin className="h-4 w-4 text-muted-foreground" />}
                    title="Perbandingan Area"
                    isFetching={analysis.isFetching}
                  />
                  <FetchAware isFetching={analysis.isFetching}>
                    <AreaComparison data={analysis.data} />
                  </FetchAware>
                </div>
                <div>
                  <SectionHeader
                    icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
                    title="Ranking Kondisi Resto"
                    isFetching={analysis.isFetching}
                  />
                  <FetchAware isFetching={analysis.isFetching}>
                    <OutletHealthRanking data={analysis.data} />
                  </FetchAware>
                </div>
              </section>

              {/* Section: Item Consistency */}
              <section>
                <SectionHeader
                  icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
                  title="Pola Item (Systemic / Widespread / Isolated)"
                  isFetching={analysis.isFetching}
                />
                <FetchAware isFetching={analysis.isFetching}>
                  <ItemConsistencyAnalysis data={analysis.data} />
                </FetchAware>
              </section>

              {/* Section: Loss/Surplus + Trend */}
              <FetchAware isFetching={analysis.isFetching}>
                <section className="grid lg:grid-cols-2 gap-4">
                  <LossVsSurplusChart data={analysis.data} />
                  <TrendChart data={analysis.data} />
                </section>
              </FetchAware>
            </TabsContent>

            {/* ====== RESTO ANALYSIS TAB (Deep Dive per Resto) ====== */}
            <TabsContent value="resto" className="space-y-4 mt-2">
              <RestoAnalysis analysisData={analysis.data} />
            </TabsContent>

            {/* ====== PEER COMPARISON TAB ====== */}
            <TabsContent value="peer" className="space-y-4 mt-2">
              <PeerComparison />
            </TabsContent>
          </Tabs>
        ) : null}
      </main>

      {/* Footer (sticky bottom) */}
      <footer className="mt-auto border-t bg-background/80 backdrop-blur">
        <div className="px-4 sm:px-6 py-2.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground max-w-[1600px] mx-auto">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1 font-medium">
              <ShieldAlert className="h-3 w-3 text-amber-500" />
              Inventory Control Intelligence
            </span>
            {status?.stats && (
              <span className="hidden sm:inline tabular-nums">
                {status.stats.totalOutlets} outlet · {status.stats.totalItems} item · {status.stats.totalRecords.toLocaleString()} record
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {analysis.data && (
              <span className="tabular-nums">
                Analisis terakhir: {analysis.data.durationMs}ms · {analysis.data.cached ? 'cache' : 'segar'}
              </span>
            )}
            <span className="hidden sm:inline text-muted-foreground/80">Klik baris mana saja untuk drill-down ke sumber</span>
          </div>
        </div>
      </footer>

      {/* Drill-down drawer */}
      <DrillDownDrawer />
      <SourceDataModal />
      <CardDrillDown data={analysis.data} />
      <ItemDeepDive data={analysis.data} />
      <ExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        onExport={handleExport}
        isExporting={isExporting}
      />
    </div>
  );
}
