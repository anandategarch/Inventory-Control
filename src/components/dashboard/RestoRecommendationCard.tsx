'use client';

import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Target, Loader2, AlertTriangle, TrendingUp, TrendingDown, RefreshCw } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { fmtIDR, fmtPctAbs } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';

// FIX #15: PRIORITY_TOOLTIP extracted as a const so it can be reused across
// the recommendation card + PrioritySummaryCard without text drift.
export const PRIORITY_TOOLTIP =
  'Priority Score (0-100) = weighted combination of Dev/BOM ratio, nominal loss, residual ratio, direction flip, trend deterioration, tolerance breach count, anomaly count, dan benchmark deviation. TINGGI (>=55), SEDANG (>=30), RENDAH (<30).';

// FIX #15: signal consolidation — show top 3 signals by severity, hide the
// rest behind an overflow chip (clickable to toggle expansion).
type SignalBadge = {
  key: string;
  label: string;
  tone: 'red' | 'amber' | 'emerald' | 'neutral';
  rank: number; // lower = more important (rendered first)
};

function buildSignalBadges(r: RestoRecommendation): SignalBadge[] {
  const badges: SignalBadge[] = [];
  // Direction is always rendered (rank 0)
  badges.push({
    key: 'direction',
    label: r.metrics.direction,
    tone: r.metrics.direction === 'LOSS' ? 'red' : r.metrics.direction === 'SURPLUS' ? 'emerald' : 'neutral',
    rank: 0,
  });
  if (r.signals.directionFlip)
    badges.push({ key: 'flip', label: 'Flip', tone: 'amber', rank: 10 });
  if (r.signals.trendDeteriorating)
    badges.push({ key: 'memburuk', label: 'Memburuk', tone: 'red', rank: 11 });
  if (r.signals.residualRatio > 0.4)
    badges.push({ key: 'residual', label: `Residual ${(r.signals.residualRatio * 100).toFixed(0)}%`, tone: 'red', rank: 12 });
  if (r.signals.toleranceBreachHighCount > 0)
    badges.push({ key: 'tol', label: `Tol Breach: ${r.signals.toleranceBreachHighCount}`, tone: 'red', rank: 13 });
  if (r.signals.overExplainedCount > 0)
    badges.push({ key: 'anomali', label: `Anomali: ${r.signals.overExplainedCount}`, tone: 'red', rank: 14 });
  if (r.signals.highLossItemCount > 0)
    badges.push({ key: 'highloss', label: `High Loss: ${r.signals.highLossItemCount}`, tone: 'red', rank: 15 });
  if (r.signals.noToleranceItems > 0)
    badges.push({ key: 'notol', label: `No Tol: ${r.signals.noToleranceItems}`, tone: 'amber', rank: 16 });
  // NOTE: benchmarkHighCount deliberately omitted — BUG2-RESTO-3 removed
  // Benchmark High from the backend signal groups; the frontend branch was
  // dead code that produced misleading badges.
  return badges.sort((a, b) => a.rank - b.rank);
}

const TONE_CLASS: Record<SignalBadge['tone'], string> = {
  red: 'text-red-600 border-red-200 dark:text-red-400 dark:border-red-900',
  amber: 'text-amber-600 border-amber-200 dark:text-amber-400 dark:border-amber-900',
  emerald: 'text-emerald-600 border-emerald-200 dark:text-emerald-400 dark:border-emerald-900',
  neutral: '',
};

interface RestoRecommendation {
  outletCode: string;
  outletName: string;
  area: string;
  priorityScore: number;
  priorityLevel: 'TINGGI' | 'SEDANG' | 'RENDAH';
  signals: {
    devBomRatio: number;
    deviasiGrowth: number | null;
    abnormalCount: number;
    residualRatio: number;
    lossToSales: number;
    directionFlip: boolean;
    trendDeteriorating: boolean;
    itemConcentration: number;
    toleranceBreachCount: number;
    toleranceBreachHighCount: number;
    zScoreAbnormalCount: number;
    overExplainedCount: number;
    highLossItemCount: number;
    noToleranceItems: number;
    benchmarkHighCount: number;
  };
  metrics: {
    sales: number;
    nominalDeviasi: number;
    devBom: number;
    totalLoss: number;
    totalSurplus: number;
    residualQty: number;
    itemCount: number;
    direction: string;
    topItem: string | null;
    topItemNominal: number;
  };
  analysis: string[];
}

export function RestoRecommendationCard() {
  const { monthLabel, currentWeek, comparisonWeek, comparisonMonth, area, kelompok, outletCode, pic, setFocusOutlet } = useDashboard(useShallow((s) => ({
    monthLabel: s.monthLabel,
    currentWeek: s.currentWeek,
    comparisonWeek: s.comparisonWeek,
    comparisonMonth: s.comparisonMonth,
    area: s.area,
    kelompok: s.kelompok,
    outletCode: s.outletCode,
    pic: s.pic,
    setFocusOutlet: s.setFocusOutlet,
  })));
  const [expandedSignals, setExpandedSignals] = useState<Set<string>>(new Set());
  const toggleSignals = (key: string) =>
    setExpandedSignals((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['recommendations', monthLabel, currentWeek, comparisonWeek, comparisonMonth, area, kelompok, outletCode, pic],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('month', monthLabel!);
      p.set('week', currentWeek!);
      if (comparisonWeek) p.set('prevWeek', comparisonWeek);
      if (comparisonMonth) p.set('prevMonth', comparisonMonth);
      p.set('limit', '5');
      if (area && area !== 'all') p.set('area', area);
      // FIX (BUG-KELOMPOK-GLOBAL): pass kelompok so recommendations respect the global filter
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      if (outletCode && outletCode !== 'all') p.set('outletCode', outletCode);
      if (pic) p.set('pic', pic);
      const res = await fetch(`/api/recommendations?${p.toString()}`);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('Server error');
      return res.json();
    },
    enabled: Boolean(monthLabel && currentWeek),
    staleTime: 60_000,
    // FIX (BUG-FE-5): keepPreviousData so the card shows stale data during refetch
    // (smooth transition) instead of flashing full-screen skeletons when kelompok changes.
    placeholderData: keepPreviousData,
  });

  if (isLoading) {
    return (
      <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 shrink-0">
              <Target className="h-3.5 w-3.5" />
            </span>
            Resto Prioritas Analisa
            <InfoTooltip content={PRIORITY_TOOLTIP} />
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground ml-auto" />
          </CardTitle>
          <p className="text-xs text-muted-foreground ml-9">Memuat rekomendasi...</p>
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-lg border p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-muted-foreground">#{i + 1}</span>
                  <div className="space-y-1">
                    <div className="h-3 w-24 bg-muted rounded animate-pulse" />
                    <div className="h-2 w-16 bg-muted rounded animate-pulse" />
                  </div>
                </div>
                <div className="h-6 w-12 bg-muted rounded animate-pulse" />
              </div>
              <div className="flex gap-2">
                <div className="h-2 flex-1 bg-muted rounded animate-pulse" />
                <div className="h-2 flex-1 bg-muted rounded animate-pulse" />
                <div className="h-2 flex-1 bg-muted rounded animate-pulse" />
              </div>
              <div className="space-y-1">
                <div className="h-2 w-full bg-muted rounded animate-pulse" />
                <div className="h-2 w-3/4 bg-muted rounded animate-pulse" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  if (error || !data?.success) {
    // DU-02 FIX: Show inline error card with retry instead of silent return null
    return (
      <Card className="border-amber-200 dark:border-amber-900">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Target className="h-4 w-4 text-amber-600" />
            Resto Prioritas Analisa
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900">
            <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-amber-900 dark:text-amber-200">Gagal memuat rekomendasi</p>
              <p className="text-[11px] text-amber-700 dark:text-amber-400 truncate">
                {error instanceof Error ? error.message : 'Terjadi kesalahan server'}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs shrink-0 border-amber-300 dark:border-amber-800 hover:bg-amber-100 dark:hover:bg-amber-950/50"
              onClick={() => refetch()}
            >
              <RefreshCw className="h-3 w-3 mr-1" />
              Coba Lagi
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const recommendations: RestoRecommendation[] = data.recommendations || [];

  if (recommendations.length === 0) {
    // UI-05 FIX: Show empty-state card instead of vanishing silently
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Target className="h-4 w-4 text-amber-600" />
            Resto Prioritas Analisa
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900">
            <Target className="h-5 w-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <div>
              <p className="text-xs font-medium text-emerald-900 dark:text-emerald-200">Tidak ada resto prioritas</p>
              <p className="text-[11px] text-emerald-700 dark:text-emerald-400">
                Semua outlet dalam batas normal untuk filter ini. Coba ganti periode atau filter untuk melihat insight lain.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const levelColor = (level: string) => {
    if (level === 'TINGGI') return 'text-red-700 dark:text-red-400 bg-red-100 dark:bg-red-950/40 border-red-300 dark:border-red-800';
    if (level === 'SEDANG') return 'text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-950/40 border-amber-300 dark:border-amber-800';
    return 'text-emerald-700 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-800';
  };

  const levelAccent = (level: string) => {
    if (level === 'TINGGI') return 'bg-red-500';
    if (level === 'SEDANG') return 'bg-amber-500';
    return 'bg-emerald-500';
  };

  const rankBg = (level: string) => {
    if (level === 'TINGGI') return 'bg-gradient-to-br from-red-500 to-red-600 text-white';
    if (level === 'SEDANG') return 'bg-gradient-to-br from-amber-500 to-amber-600 text-white';
    return 'bg-gradient-to-br from-emerald-500 to-emerald-600 text-white';
  };

  const scoreColor = (score: number) => {
    // FIX FE-7: align with server priorityLevel thresholds (55/30, was 60/35)
    if (score >= 55) return 'text-red-600 dark:text-red-400';
    if (score >= 30) return 'text-amber-600 dark:text-amber-400';
    return 'text-emerald-600 dark:text-emerald-400';
  };

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 shrink-0">
            <Target className="h-3.5 w-3.5" />
          </span>
          Resto Prioritas Analisa
          <InfoTooltip content={PRIORITY_TOOLTIP} />
          {isFetching && !isLoading && (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground ml-auto" />
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Top <span className="font-medium tabular-nums">{recommendations.length}</span> resto dengan Priority Score tertinggi — klik untuk deep dive
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {recommendations.map((r, i) => (
          <div
            key={r.outletCode}
            className={`relative rounded-xl border p-3 pl-4 cursor-pointer hover:shadow-lg dark:hover:shadow-black/30 hover:-translate-y-0.5 transition-all duration-200 overflow-hidden shadow-sm ${
              r.priorityLevel === 'TINGGI' ? 'border-red-200/80 dark:border-red-900/60 bg-gradient-to-br from-red-50/40 to-transparent dark:from-red-950/20' :
              r.priorityLevel === 'SEDANG' ? 'border-amber-200/80 dark:border-amber-900/60 bg-gradient-to-br from-amber-50/40 to-transparent dark:from-amber-950/20' :
              'border-border bg-gradient-to-br from-emerald-50/40 to-transparent dark:from-emerald-950/20'
            }`}
            {...clickableRowProps(() => setFocusOutlet(r.outletCode))}
          >
            {/* Left accent bar by priority */}
            <span className={`absolute left-0 top-0 bottom-0 w-1 ${levelAccent(r.priorityLevel)}`} aria-hidden />

            {/* Header row */}
            <div className="flex items-start justify-between gap-2 mb-2.5">
              <div className="flex items-center gap-2.5 min-w-0">
                {/* Rank badge with gradient */}
                <span className={`flex h-7 w-7 items-center justify-center rounded-lg text-[11px] font-bold shrink-0 shadow-sm ${rankBg(r.priorityLevel)}`}>
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate leading-tight">{r.outletName}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{r.outletCode} · {r.area}</p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <div className="text-right">
                  <p className={`text-xl font-bold leading-none tabular-nums ${scoreColor(r.priorityScore)}`}>{r.priorityScore}</p>
                  <p className="text-[11px] text-muted-foreground uppercase tracking-wider mt-0.5">Priority</p>
                </div>
                <Badge variant="outline" className={`text-xs font-semibold border ${levelColor(r.priorityLevel)}`}>
                  {r.priorityLevel}
                </Badge>
              </div>
            </div>

            {/* Quick metrics */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mb-2 text-[11px]">
              <div className="rounded-md border bg-background/60 px-3 py-1.5">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wider">Dev/BOM</p>
                <p className="font-mono font-semibold tabular-nums">{fmtPctAbs(r.metrics.devBom)}</p>
              </div>
              <div className="rounded-md border bg-background/60 px-3 py-1.5">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wider">Nominal</p>
                <p className={`font-mono font-semibold tabular-nums ${r.metrics.nominalDeviasi < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{fmtIDR(r.metrics.nominalDeviasi)}</p>
              </div>
              <div className="rounded-md border bg-background/60 px-3 py-1.5">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wider">Items</p>
                <p className="font-mono font-semibold tabular-nums">{r.metrics.itemCount}</p>
              </div>
              <div className="rounded-md border bg-background/60 px-3 py-1.5 min-w-0">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wider">Top Item</p>
                <p className="font-medium truncate" title={r.metrics.topItem || ''}>{r.metrics.topItem || '—'}</p>
              </div>
            </div>

            {/* Analysis bullets — show all signals (1-15), compact text */}
            <div className="space-y-0.5 mb-2">
              {r.analysis.map((a, j) => (
                <p key={j} className="text-xs text-muted-foreground flex items-start gap-1.5 leading-tight">
                  <span className="text-amber-500 mt-1 shrink-0 text-[8px]">●</span>
                  <span>{a}</span>
                </p>
              ))}
            </div>

            {/* Direction + trend indicators — consolidated (max 3 + overflow) */}
            <div className="flex flex-wrap items-center gap-1 mt-2 pt-2 border-t">
              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mr-1">Signals:</span>
              {(() => {
                const all = buildSignalBadges(r);
                const isExpanded = expandedSignals.has(r.outletCode);
                const visible = isExpanded ? all : all.slice(0, 3);
                const hidden = all.length - visible.length;
                return (
                  <>
                    {visible.map((b) => (
                      <Badge key={b.key} variant="outline" className={`text-[11px] h-4 ${TONE_CLASS[b.tone]}`}>
                        {b.label}
                      </Badge>
                    ))}
                    {hidden > 0 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSignals(r.outletCode);
                        }}
                        className="inline-flex items-center"
                        aria-label={isExpanded ? 'Sembunyikan signal' : `Tampilkan ${hidden} signal lainnya`}
                      >
                        <Badge variant="outline" className="text-[11px] h-4 cursor-pointer hover:bg-muted/50">
                          {isExpanded ? '− Kurang' : `+${hidden} lagi`}
                        </Badge>
                      </button>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
