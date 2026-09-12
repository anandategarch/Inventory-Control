'use client';

// ============================================================
//  Shared dashboard components — extracted from page.tsx
//  (architecture split: reduce page.tsx size)
//  VH-1: LayerHeader (narrative-layer eyebrow) lives in
//  ./LayerHeader and is re-exported here for convenience.
// ============================================================

import { useState, useEffect, memo } from 'react';
export { LayerHeader } from './LayerHeader';
export type { LayerHeaderProps } from './LayerHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
// QW hygiene: Button import removed — every CTA here is a raw <button>
// (custom amber styling), the shadcn Button was never referenced.
import { Badge } from '@/components/ui/badge';
import { Loader2, Calendar, ShieldAlert, Upload, RefreshCw, ArrowUp, Boxes, CloudDownload, Sparkles } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';

export const EmptyState = memo(function EmptyState() {
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
      {/* VH-4 (spec §10 — no level skips): this state REPLACES the whole main
          content (same role as a layer heading) → h2, sitting directly under
          the h1 without skipping h2. */}
      <h2 className="text-xl font-semibold tracking-tight text-foreground">Belum Ada Data Inventory</h2>
      <p className="text-sm text-muted-foreground mt-2 max-w-md leading-relaxed">
        Database masih kosong. Mulai dengan upload file Excel rekoniliasi atau import langsung dari Google Drive untuk analisis pertama.
      </p>
      {/* CTA buttons — QW-D: converted from <a href="#filter-bar"> to real
          <button> elements. The old anchors pointed at an id that never
          existed (dead href) and prevented default on every click — a
          button is the correct semantics for a JS-only action. */}
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={() => document.dispatchEvent(new CustomEvent('open-upload-dialog'))}
          className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg text-xs font-medium bg-amber-600 text-white shadow-sm hover:bg-amber-700 hover:shadow active:scale-95 transition-all"
        >
          <Upload className="h-3.5 w-3.5" />
          Upload File
        </button>
        <button
          type="button"
          onClick={() => document.dispatchEvent(new CustomEvent('open-drive-dialog'))}
          className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg text-xs font-medium border border-border bg-background hover:bg-muted/60 hover:shadow-sm active:scale-95 transition-all"
        >
          <CloudDownload className="h-3.5 w-3.5" />
          Import dari Drive
        </button>
      </div>
      <p className="mt-4 text-[11px] text-muted-foreground/70 flex items-center gap-1.5">
        <Sparkles className="h-3 w-3 text-amber-500" />
        Tip: format nama file BULAN TAHUN.xlsx (contoh: JULI 2026.xlsx)
      </p>
    </div>
  );
});



export function LoadingState({ text = 'Memuat data analisis...' }: { text?: string }) {
  // FIX (LOADING-TIMEOUT): show elapsed time so user knows it's progressing, not stuck.
  // After 15s, show "memakan waktu lebih lama" warning.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);
  const isSlow = elapsed >= 15;
  return (
    <div className="space-y-4 animate-in fade-in duration-300">
      {/* Loading banner */}
      <div className={`flex items-center justify-between gap-2.5 py-2.5 px-3 text-sm rounded-xl border shadow-sm transition-colors ${
        isSlow
          ? 'border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400'
          : 'border-amber-200/60 dark:border-amber-900/50 bg-amber-50/40 dark:bg-amber-950/20 text-muted-foreground'
      }`}>
        <div className="flex items-center gap-2.5">
          <Loader2 className="h-4 w-4 animate-spin text-amber-600 dark:text-amber-400" />
          <span className="font-medium">{isSlow ? `${text} (memakan waktu lebih lama dari biasanya)` : text}</span>
        </div>
        <span className="text-xs tabular-nums font-mono opacity-70">{elapsed}s</span>
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



export function ErrorState({ message }: { message: string }) {
  const isNoData = message.includes('Tidak ada data untuk periode ini');
  const isTimeout = message.includes('504') || message.includes('timeout') || message.includes('Server error');
  // FIX (504-RETRY): invalidate analysis query to trigger refetch
  const queryClient = useQueryClient();
  const handleRetry = () => {
    queryClient.invalidateQueries({ queryKey: ['analysis'] });
    // FIX (H-14/T2): retry must also work when the STATUS query itself
    // failed (status-error branch in page.tsx) — without this, the button
    // was a no-op there. Harmless for analysis errors (status refetch is
    // a cheap lightweight call).
    queryClient.invalidateQueries({ queryKey: ['status'] });
  };
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
            <h2 className={`text-base font-semibold ${isNoData ? 'text-amber-700 dark:text-amber-400' : 'text-red-700 dark:text-red-400'}`}>
              {isNoData ? 'Data Belum Tersedia' : 'Gagal Memuat Analisis'}
            </h2>
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
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  onClick={handleRetry}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-medium bg-red-600 text-white shadow-sm hover:bg-red-700 transition-all active:scale-95"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Coba Lagi
                </button>
                <p className="text-xs text-red-600/60 dark:text-red-400/50">
                  {isTimeout
                    ? 'Server timeout (query berat dengan filter). Mencoba ulang biasanya berhasil.'
                    : 'Periksa koneksi jaringan atau coba refresh halaman.'}
                </p>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}



export function SectionHeader({ icon, title, badge }: { icon: React.ReactNode; title: string; badge?: string }) {
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
    </div>
  );
}


export function ScrollToTop() {
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
      // QW-C: bottom-16 (was bottom-6) — the 40px button used to overlap
      // the ~38px sticky footer (z-30) right where the footer's hint text
      // lives. 64px lifts it clear above the footer while staying in the
      // bottom-right corner thumb zone.
      className="fixed bottom-16 right-6 z-40 flex h-10 w-10 items-center justify-center rounded-full border bg-background shadow-lg hover:bg-muted/50 transition-all duration-200 group"
      aria-label="Scroll to top"
    >
      <ArrowUp className="h-4 w-4 text-muted-foreground group-hover:text-foreground" />
    </button>
  );
}

// ============================================================
//  LoadingChart — used as the `loading` fallback for next/dynamic
//  imports of heavy chart components (Recharts = 5.4MB). The min-h
//  reserves layout space so the page doesn't shift when the chunk
//  finishes loading.
// ============================================================
export function LoadingChart() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[520px] space-y-3">
      <Skeleton className="h-full w-full rounded-lg" />
    </div>
  );
}

// ============================================================
//  FetchAware was removed (PERF-FE PAKET A). It dimmed sections +
//  set `pointer-events-none` during every background refetch,
//  freezing the dashboard while stale data was still usable, and
//  its `isFetching` input defeated React.memo on the tab wrappers
//  (10+ sections re-rendered twice per fetch cycle). The refresh
//  indicator now lives only in DashboardHeader (global, single).
// ============================================================



