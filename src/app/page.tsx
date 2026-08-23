'use client';

import { useEffect, useState } from 'react';
import { useDashboard } from '@/hooks/useDashboard';
import { useAnalysis, useStatus } from '@/hooks/useAnalysis';
import { FilterBar } from '@/components/filters/FilterBar';
import { ExecutiveSummary, HealthAlert } from '@/components/dashboard/ExecutiveSummary';
import { TopItemsByNominal, TopItemsByDevBom, TopOutlets } from '@/components/dashboard/TopItems';
import { InsightsPanel } from '@/components/dashboard/InsightsPanel';
import {
  OutletHealthRanking, ItemConsistencyAnalysis, AreaComparison,
} from '@/components/dashboard/AdvancedAnalysis';
import { ErrorBoundary } from '@/components/ui/error-boundary';
// Phase 4 FIX: RestoAnalysis lazy-loaded — it pulls in PrioritySummaryCard →
// SignalChart → recharts (5.4MB). Without lazy-load, Recharts is in the main
// bundle despite the other dynamic() calls.
const RestoAnalysis = dynamic(() => import('@/components/dashboard/RestoAnalysis').then(m => m.RestoAnalysis), { ssr: false, loading: () => <LoadingChart /> });
import { RestoRecommendationCard } from '@/components/dashboard/RestoRecommendationCard';
import { ExportDialog } from '@/components/dashboard/ExportDialog';
// CostAccounting components removed — tab Cost Accounting dihapus
import { DrillDownDrawer } from '@/components/drilldown/DrillDownDrawer';
import { SourceDataModal } from '@/components/drilldown/SourceDataModal';
import { CardDrillDown } from '@/components/dashboard/CardDrillDown';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

// Phase 4: Lazy-load heavy chart components (Recharts = 5.4MB)
// ssr: false — charts are client-only (use ResponsiveContainer which needs window)
import dynamic from 'next/dynamic';

const LoadingChart = () => (
  <div className="flex flex-col items-center justify-center h-48 space-y-3">
    <Skeleton className="h-full w-full rounded-lg" />
  </div>
);

const GrowthComparison = dynamic(() => import('@/components/dashboard/Charts').then(m => m.GrowthComparison), { ssr: false, loading: () => <LoadingChart /> });
const DeviationBreakdownChart = dynamic(() => import('@/components/dashboard/Charts').then(m => m.DeviationBreakdownChart), { ssr: false, loading: () => <LoadingChart /> });
const LossVsSurplusChart = dynamic(() => import('@/components/dashboard/Charts').then(m => m.LossVsSurplusChart), { ssr: false, loading: () => <LoadingChart /> });
const TrendChart = dynamic(() => import('@/components/dashboard/Charts').then(m => m.TrendChart), { ssr: false, loading: () => <LoadingChart /> });
const MultiPeriodComparisonCard = dynamic(() => import('@/components/dashboard/AnalysisCards').then(m => m.MultiPeriodComparisonCard), { ssr: false, loading: () => <LoadingChart /> });
const HistoricalZScoreCard = dynamic(() => import('@/components/dashboard/HistoricalZScoreCard').then(m => m.HistoricalZScoreCard), { ssr: false, loading: () => <LoadingChart /> });
const AreaTrendChart = dynamic(() => import('@/components/dashboard/AreaTrendChart').then(m => m.AreaTrendChart), { ssr: false, loading: () => <LoadingChart /> });
const PeerComparison = dynamic(() => import('@/components/dashboard/PeerComparison').then(m => m.PeerComparison), { ssr: false, loading: () => <LoadingChart /> });
const ItemDeepDive = dynamic(() => import('@/components/dashboard/ItemDeepDive').then(m => m.ItemDeepDive), { ssr: false, loading: () => null });
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import {
  Activity, Boxes, BarChart3, ShieldAlert,
  MapPin,
  Calendar, Loader2, Store,
  FileDown, Upload, CloudDownload, Sparkles,
  History,
  ArrowUp,
  RefreshCw,
} from 'lucide-react';

function EmptyState() {
  return (
    <div className="relative flex flex-col items-center justify-center py-20 px-4 text-center">
      {/* Ambient backdrop glow */}
      <div
        className="absolute inset-x-0 top-0 h-64 bg-gradient-to-b from-amber-50/70 via-amber-50/20 to-transparent dark:from-amber-950/30 dark:via-amber-950/10 pointer-events-none"
        aria-hidden
      />
      <div className="relative mb-6">
        <div className="absolute inset-0 rounded-3xl bg-gradient-to-br from-amber-300/40 to-orange-300/30 dark:from-amber-700/30 dark:to-orange-700/20 blur-2xl" aria-hidden />
        <div className="relative flex h-20 w-20 items-center justify-center rounded-3xl border border-amber-200/70 dark:border-amber-900/60 bg-gradient-to-br from-amber-50 to-amber-100/60 dark:from-amber-950/60 dark:to-amber-900/30 shadow-lg shadow-amber-500/10">
          <Boxes className="h-10 w-10 text-amber-600 dark:text-amber-400" />
        </div>
      </div>
      <h3 className="text-xl font-semibold tracking-tight text-foreground">Belum Ada Data Inventory</h3>
      <p className="text-sm text-muted-foreground mt-2 max-w-md leading-relaxed">
        Database masih kosong. Mulai dengan upload file Excel rekoniliasi atau import langsung dari Google Drive untuk analisis pertama.
      </p>
      {/* CTA buttons */}
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <a
          href="#filter-bar"
          onClick={(e) => {
            e.preventDefault();
            document.dispatchEvent(new CustomEvent('open-upload-dialog'));
          }}
          className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg text-xs font-medium bg-amber-600 text-white shadow-sm hover:bg-amber-700 hover:shadow active:scale-95 transition-all"
        >
          <Upload className="h-3.5 w-3.5" />
          Upload File
        </a>
        <a
          href="#filter-bar"
          onClick={(e) => {
            e.preventDefault();
            document.dispatchEvent(new CustomEvent('open-drive-dialog'));
          }}
          className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg text-xs font-medium border border-border bg-background hover:bg-muted/60 hover:shadow-sm active:scale-95 transition-all"
        >
          <CloudDownload className="h-3.5 w-3.5" />
          Import dari Drive
        </a>
      </div>
      <p className="mt-4 text-[11px] text-muted-foreground/70 flex items-center gap-1.5">
        <Sparkles className="h-3 w-3 text-amber-500" />
        Tip: format nama file BULAN TAHUN.xlsx (contoh: JULI 2026.xlsx)
      </p>
    </div>
  );
}

function LoadingState({ text = 'Memuat data analisis...' }: { text?: string }) {
  return (
    <div className="space-y-4 animate-in fade-in duration-300">
      {/* Loading banner */}
      <div className="flex items-center justify-center gap-2.5 py-2.5 text-sm text-muted-foreground rounded-xl border border-amber-200/60 dark:border-amber-900/50 bg-amber-50/40 dark:bg-amber-950/20 shadow-sm">
        <Loader2 className="h-4 w-4 animate-spin text-amber-600 dark:text-amber-400" />
        <span className="font-medium">{text}</span>
      </div>
      {/* Skeleton grid — KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card p-4 space-y-2 shadow-sm">
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
      <div className="rounded-xl border bg-card p-5 space-y-3 shadow-sm">
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
          <div key={i} className="rounded-xl border bg-card p-5 space-y-3 shadow-sm">
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
          <div key={i} className="rounded-xl border bg-card p-5 space-y-2 shadow-sm">
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
  const isNoData = message.includes('Tidak ada data untuk periode ini');
  return (
    <Card className={isNoData
      ? 'border-amber-200/70 bg-gradient-to-br from-amber-50 to-amber-50/30 dark:from-amber-950/40 dark:to-amber-950/10 dark:border-amber-900/70 shadow-sm'
      : 'border-red-200/70 bg-gradient-to-br from-red-50 to-red-50/30 dark:from-red-950/40 dark:to-red-950/10 dark:border-red-900/70 shadow-sm'}>
      <CardContent className="p-6">
        <div className="flex items-start gap-3">
          <div className={`shrink-0 flex h-9 w-9 items-center justify-center rounded-lg ${
            isNoData
              ? 'bg-amber-100 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400'
              : 'bg-red-100 dark:bg-red-950/60 text-red-600 dark:text-red-400'
          }`}>
            {isNoData ? <Calendar className="h-5 w-5" /> : <ShieldAlert className="h-5 w-5" />}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className={`text-base font-semibold ${isNoData ? 'text-amber-700 dark:text-amber-400' : 'text-red-700 dark:text-red-400'}`}>
              {isNoData ? 'Data Belum Tersedia' : 'Gagal Memuat Analisis'}
            </h3>
            <p className={`text-sm mt-1 leading-relaxed ${isNoData ? 'text-amber-600/90 dark:text-amber-400/80' : 'text-red-600/90 dark:text-red-400/80'}`}>
              {message}
            </p>
            {/* Fix #12: Actionable empty state — CTA buttons */}
            {isNoData && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => document.dispatchEvent(new CustomEvent('open-upload-dialog'))}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-medium bg-amber-600 text-white shadow-sm hover:bg-amber-700 transition-all"
                >
                  <Upload className="h-3.5 w-3.5" />
                  Upload File
                </button>
                <button
                  onClick={() => window.location.reload()}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-medium border border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30 transition-all"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Refresh
                </button>
              </div>
            )}
            {!isNoData && (
              <p className="text-xs text-red-600/60 dark:text-red-400/50 mt-2">
                Periksa koneksi jaringan atau coba refresh halaman. Jika berlanjut, hubungi administrator.
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SectionHeader({ icon, title, badge, isFetching }: { icon: React.ReactNode; title: string; badge?: string; isFetching?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 mb-3 pt-4 border-t border-border/40 first:border-t-0 first:pt-0">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg border bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground shrink-0">
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
    <div className={`relative transition-all duration-200 ${isFetching ? 'opacity-60 pointer-events-none' : 'opacity-100'}`}>
      {isFetching && (
        <div className="absolute inset-0 z-10 flex items-start justify-end p-2">
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

// Fix #10: Scroll to Top button — appears after scrolling down 300px
function ScrollToTop() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const handleScroll = () => setVisible(window.scrollY > 300);
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);
  if (!visible) return null;
  return (
    <button
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      className="fixed bottom-6 right-6 z-40 flex h-10 w-10 items-center justify-center rounded-full border bg-background shadow-lg hover:bg-muted/50 transition-all duration-200 group"
      aria-label="Scroll to top"
    >
      <ArrowUp className="h-4 w-4 text-muted-foreground group-hover:text-foreground" />
    </button>
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
    } catch (e: unknown) {
      toast({ title: '❌ Export gagal', description: (e instanceof Error ? e.message : 'Unknown error'), variant: 'destructive' });
    } finally {
      setIsExporting(false);
    }
  };

  const isLoading = analysis.isLoading || analysis.isFetching;
  const statusLoaded = status !== undefined;
  const hasData = statusLoaded && Boolean(status?.stats?.totalRecords && status.stats.totalRecords > 0);

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-background to-muted/20 dark:from-background dark:to-zinc-950">
      {/* Header — sticky with brand accent bar */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60 shadow-sm shadow-black/[0.03] dark:shadow-black/20">
        {/* Brand accent bar — warm amber→emerald gradient (NO blue/indigo) */}
        <div className="h-0.5 bg-gradient-to-r from-amber-500 via-orange-500 to-emerald-500" aria-hidden />
        <div className="px-4 sm:px-6 py-3 flex items-center justify-between gap-3 max-w-[1600px] mx-auto">
          <div className="flex items-center gap-3 min-w-0">
            {/* Logo — premium gradient with soft shadow + ring */}
            <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 dark:from-amber-400 dark:to-orange-500 text-white shadow-md shadow-amber-500/20 ring-1 ring-amber-500/20 shrink-0">
              <Boxes className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-[15px] font-semibold tracking-tight truncate leading-tight text-foreground">
                Inventory Control Intelligence
              </h1>
              <p className="text-[11px] text-muted-foreground/80 truncate font-normal">
                {status?.stats ? (
                  <span className="tabular-nums font-medium text-muted-foreground">{status.stats.totalOutlets} Outlet · </span>
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
                variant="default"
                size="sm"
                className="h-8 gap-1.5 text-xs font-medium shadow-sm hover:shadow-md bg-amber-600 hover:bg-amber-700 text-white transition-all active:scale-95"
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
        {/* Fix #11: Sticky filter bar — stays visible when scrolling */}
        <div className="sticky top-0 z-30 -mx-4 sm:-mx-6 px-4 sm:px-6 py-2 bg-background/95 backdrop-blur-sm border-b border-border/40">
          <FilterBar />
        </div>

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
            <TabsList className="w-full justify-start overflow-x-auto h-auto flex-wrap bg-muted/40 dark:bg-zinc-900/40 p-1 gap-1 rounded-xl border border-border/60 shadow-sm">
              <TabsTrigger value="dashboard" className="text-xs font-medium gap-1.5 data-[state=active]:bg-background data-[state=active]:shadow-sm data-[state=active]:text-amber-700 dark:data-[state=active]:text-amber-400">
                <BarChart3 className="h-3.5 w-3.5" /> Dashboard
              </TabsTrigger>
              <TabsTrigger value="resto" className="text-xs font-medium gap-1.5 data-[state=active]:bg-background data-[state=active]:shadow-sm data-[state=active]:text-amber-700 dark:data-[state=active]:text-amber-400">
                <Store className="h-3.5 w-3.5" /> Resto Analysis
              </TabsTrigger>
              <TabsTrigger value="peer" className="text-xs font-medium gap-1.5 data-[state=active]:bg-background data-[state=active]:shadow-sm data-[state=active]:text-amber-700 dark:data-[state=active]:text-amber-400">
                <Activity className="h-3.5 w-3.5" /> Peer Comparison
              </TabsTrigger>
            </TabsList>

            {/* ====== DASHBOARD TAB (Overview + Network) ====== */}
            <TabsContent value="dashboard" className="space-y-4 mt-2 animate-fade-in-up">
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
                  <ErrorBoundary label="Health Alert">
                    <HealthAlert data={analysis.data} />
                  </ErrorBoundary>
                  <ErrorBoundary label="Growth Comparison">
                    <GrowthComparison data={analysis.data} />
                  </ErrorBoundary>
                  <ErrorBoundary label="Deviation Breakdown">
                    <DeviationBreakdownChart data={analysis.data} />
                  </ErrorBoundary>
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

              {/* Section: Historical Z-Score + Area Trend */}
              <section>
                <SectionHeader
                  icon={<History className="h-4 w-4 text-muted-foreground" />}
                  title="Analisis Historis (Z-Score + Trend per Area)"
                  isFetching={analysis.isFetching}
                />
                <FetchAware isFetching={analysis.isFetching}>
                  <div className="space-y-4">
                    <ErrorBoundary label="Historical Z-Score">
                      <HistoricalZScoreCard data={analysis.data} />
                    </ErrorBoundary>
                    <ErrorBoundary label="Area Trend">
                      <AreaTrendChart data={analysis.data} />
                    </ErrorBoundary>
                  </div>
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
            <TabsContent value="resto" className="space-y-4 mt-2 animate-fade-in-up">
              <RestoAnalysis analysisData={analysis.data} />
            </TabsContent>

            {/* ====== PEER COMPARISON TAB ====== */}
            <TabsContent value="peer" className="space-y-4 mt-2 animate-fade-in-up">
              <PeerComparison />
            </TabsContent>
          </Tabs>
        ) : null}
      </main>

      {/* Footer (sticky bottom) */}
      <footer className="mt-auto border-t border-border/60 bg-background/80 backdrop-blur">
        <div className="px-4 sm:px-6 py-2.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground max-w-[1600px] mx-auto">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 font-medium text-foreground/80">
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
            <span className="hidden sm:inline text-muted-foreground flex items-center gap-1">
              <Activity className="h-3 w-3" />
              Klik baris mana saja untuk drill-down ke sumber
            </span>
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

      {/* Fix #10: Scroll to Top button */}
      <ScrollToTop />
    </div>
  );
}
