'use client';

// ============================================================
//  RestoRecommendationCard — L3 "PRIORITY ACTIONS" (VH-3; SPEC-1 rename)
//  --------------------------------------------------------
//  Reskinned into the compact priority panel from
//  MASTER-CONTEXT-VISUAL-HIERARCHY.md §4 L3 / D6:
//    - default TOP-3 rows; when the top-3 cumulative share of
//      total deviation is < 50% the default ADAPTS to 5 (D6)
//    - compact row anatomy: round rank badge (h-7 w-7, #1
//      inverted), name + area meta, priority score on the
//      right (red >=55 / amber >=30 / emerald), proportional
//      mini-bar, min-h-11, click → setFocusOutlet (existing)
//    - footer: coverage caption only (UX-NAVLINK-1: the "Top N dari X
//      outlet · lihat semua →" jump-to-tab button was removed per user
//      request; the Resto tab + its new Filter Resto picker is the
//      full-list entry point)
//
//  Data sources are UNCHANGED: the recommendations themselves
//  stay self-fetched via useRecommendations (same hook, same
//  queryKey, same limit). The analysis `data` prop is used
//  ONLY for footer/adaptive statistics that already ride the
//  /api/analysis payload (costImpact.totalCost = Σ|nominal
//  deviasi|, outletHealthRanking.length = outlet count).
// ============================================================

import { useState, useMemo } from 'react';
import { Loader2, AlertTriangle, Target, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { useRecommendations, type RestoRecommendation } from '@/hooks/useRecommendations';
import type { RecommendationHistory } from './priority-summary/types';
import { fmtIDR, fmtPct } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';
import type { AnalysisData } from '@/hooks/useAnalysis';

// FIX #15: PRIORITY_TOOLTIP extracted as a const so it can be reused across
// the recommendation card + PrioritySummaryCard without text drift.
export const PRIORITY_TOOLTIP =
  'Priority Score (0-100) = weighted combination of Dev/BOM ratio, nominal loss, residual ratio, direction flip, trend deterioration, tolerance breach count, anomaly count, dan benchmark deviation. TINGGI (>=55), SEDANG (>=30), RENDAH (<30).';

// Priority score color — server threshold aligned (FIX FE-7: 55/30).
function scoreColor(score: number): string {
  if (score >= 55) return 'text-red-600 dark:text-red-400';
  if (score >= 30) return 'text-amber-600 dark:text-amber-400';
  return 'text-emerald-600 dark:text-emerald-400';
}

function scoreBarColor(score: number): string {
  if (score >= 55) return 'bg-red-500';
  if (score >= 30) return 'bg-amber-500';
  return 'bg-emerald-500';
}

// ANA-1-D: hover explanation for the recurrence chip — plain language.
// The < 4 note flags thin history (GRAIN: same-week cross-month is the only
// valid series, so a short window is a real confidence limitation).
function recurrenceTitle(h: RecommendationHistory): string {
  let t = `Bermasalah di ${h.abnormalCount} dari ${h.periodCount} bulan sebelumnya (Dev/BOM di atas toleransi atau loss di atas threshold)`;
  if (h.periodCount < 4) t += ' · data historis masih terbatas';
  return t;
}

export interface RestoRecommendationCardProps {
  /** Analysis payload — footer share/outlet-count stats + the D6 adaptive rule. */
  data: AnalysisData;
}

export function RestoRecommendationCard({ data }: RestoRecommendationCardProps) {
  const { outletCode, setFocusOutlet } = useDashboard(useShallow((s) => ({
    outletCode: s.outletCode,
    setFocusOutlet: s.setFocusOutlet,
  })));

  // H-11 (#4b): shared fetch — same queryKey + limit as the Resto tab's
  // scoped query, so identical scopes dedupe into ONE request and ONE
  // server cache row. UNCHANGED by the VH-3 reskin.
  const { data: resp, isLoading, isFetching, error, refetch } = useRecommendations(outletCode);

  // P3-HYG-7a: pin the list identity — `resp?.recommendations ?? []` would
  // create a fresh empty array on every render while undefined, defeating
  // the defaultCount memo below.
  const recommendations = useMemo<RestoRecommendation[]>(() => resp?.recommendations ?? [], [resp?.recommendations]);

  // ------------------------------------------------------------
  //  D6 adaptive default (top-3, or 5 when top-3 < 50% of total
  //  deviation). Total deviation = costImpact.totalCost (Σ|nominal
  //  deviasi| over all records, same payload the InsightsPanel
  //  "Biaya Bocor" rule reads). Falls back to plain 3 when the
  //  optional field is absent (old payloads).
  // ------------------------------------------------------------
  const totalDev = data.costImpact?.totalCost ?? null;
  const defaultCount = useMemo(() => {
    if (recommendations.length <= 3) return 3;
    if (totalDev != null && totalDev > 0) {
      const top3 = recommendations.slice(0, 3).reduce((sum, r) => sum + Math.abs(r.metrics.nominalDeviasi), 0);
      if (top3 / totalDev < 0.5) return 5;
    }
    return 3;
  }, [recommendations, totalDev]);

  const [expanded, setExpanded] = useState(false);
  const shownCount = expanded ? recommendations.length : Math.min(defaultCount, recommendations.length);
  const shown = recommendations.slice(0, shownCount);

  // Footer stats — honest guards: share only when the optional total is
  // present (capped at 100% for the outlet-filtered edge case), outlet
  // count from the analysis payload with the returned list as fallback.
  const shownAbsSum = useMemo(
    () => shown.reduce((sum, r) => sum + Math.abs(r.metrics.nominalDeviasi), 0),
    [shown],
  );
  const shareLabel = totalDev != null && totalDev > 0
    ? fmtPct(Math.min(1, shownAbsSum / totalDev), false, 0)
    : null;
  const totalOutlets = data.outletHealthRanking?.length ?? recommendations.length;

  if (isLoading) {
    return (
      <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 shrink-0">
              <Target className="h-3.5 w-3.5" />
            </span>
            Resto Prioritas
            <InfoTooltip content={PRIORITY_TOOLTIP} />
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground ml-auto" />
          </CardTitle>
          <p className="text-xs text-muted-foreground ml-9">Memuat rekomendasi...</p>
        </CardHeader>
        <CardContent className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex min-h-11 items-center gap-3 rounded-lg border p-3">
              <span className="h-7 w-7 rounded-full bg-muted animate-pulse shrink-0" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3.5 w-32 bg-muted rounded animate-pulse" />
                <div className="h-2.5 w-20 bg-muted rounded animate-pulse" />
              </div>
              <div className="h-6 w-10 bg-muted rounded animate-pulse" />
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  if (error || !resp?.success) {
    // DU-02 FIX: Show inline error card with retry instead of silent return null
    return (
      <Card className="border-amber-200 dark:border-amber-900">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Target className="h-4 w-4 text-amber-600" />
            Resto Prioritas
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

  if (recommendations.length === 0) {
    // UI-05 FIX: Show empty-state card instead of vanishing silently
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Target className="h-4 w-4 text-amber-600" />
            Resto Prioritas
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

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 shrink-0">
            <Target className="h-3.5 w-3.5" />
          </span>
          Resto Prioritas
          <InfoTooltip content={PRIORITY_TOOLTIP} />
          {isFetching && !isLoading && (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground ml-auto" />
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Skor priority tertinggi — klik outlet untuk deep dive
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {shown.map((r, i) => (
          <div
            key={r.outletCode}
            className="min-h-11 rounded-lg border bg-card p-3 cursor-pointer transition-colors hover:bg-muted/40 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            {...clickableRowProps(() => setFocusOutlet(r.outletCode))}
          >
            <div className="flex items-center gap-3">
              {/* Rank badge — round; #1 inverted (spec §4 L3) */}
              <span className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold shrink-0 tabular-nums ${
                i === 0 ? 'bg-foreground text-background' : 'border bg-muted/50 text-muted-foreground'
              }`}>
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold leading-tight truncate" title={r.outletName}>{r.outletName}</p>
                {/* Meta line + ANA-1-D chips. The text <p> truncates first
                    (overflow-hidden makes its flex min-width 0) so the small
                    chips stay visible at 375px without breaking row rhythm. */}
                <div className="mt-0.5 flex min-w-0 items-center gap-1">
                  <p className="text-xs text-muted-foreground truncate">
                    {r.outletCode} · {r.area} ·{' '}
                    <span className={`font-medium tabular-nums ${r.metrics.nominalDeviasi < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                      {fmtIDR(r.metrics.nominalDeviasi)}
                    </span>
                  </p>
                  {/* ANA-1-D recurrence chip — hidden when STABIL, when no
                      historical month exists, or when `history` is absent
                      (payload cached before the field was added). */}
                  {r.history && r.history.periodCount > 0 && r.history.classification !== 'STABIL' && (
                    <span
                      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-px text-[10px] font-medium leading-4 ${
                        r.history.classification === 'REKUREN'
                          ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-400'
                          : 'border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400'
                      }`}
                      title={recurrenceTitle(r.history)}
                    >
                      {/* sr-only: readable form of the "⟳ x/y bln" glyph text */}
                      <span className="sr-only">Bermasalah di {r.history.abnormalCount} dari {r.history.periodCount} bulan sebelumnya</span>
                      <span aria-hidden>⟳ {r.history.abnormalCount}/{r.history.periodCount} bln</span>
                    </span>
                  )}
                  {/* Trend chip — pure frontend, rides the existing
                      signals.trendDeteriorating field (no API change). */}
                  {r.signals.trendDeteriorating && (
                    <span
                      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-red-300 px-1.5 py-px text-[10px] font-medium leading-4 text-red-600 dark:border-red-800 dark:text-red-400"
                      title="Nominal deviasi naik >20% dibanding periode sebelumnya atau rata-rata historis (same-week)"
                    >
                      ↗ Memburuk
                    </span>
                  )}
                </div>
              </div>
              <div className="text-right shrink-0">
                <p className={`text-lg font-bold leading-none tabular-nums ${scoreColor(r.priorityScore)}`}>{r.priorityScore}</p>
                <p className={`text-[10px] font-semibold uppercase tracking-wider mt-0.5 ${scoreColor(r.priorityScore)}`}>{r.priorityLevel}</p>
              </div>
            </div>
            {/* Proportional mini-bar — priority score / 100, level color */}
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
              <div className={`h-full ${scoreBarColor(r.priorityScore)}`} style={{ width: `${Math.min(100, Math.max(0, r.priorityScore))}%` }} />
            </div>
          </div>
        ))}

        {/* Expand / collapse — only when more rows exist beyond the default */}
        {recommendations.length > shownCount && !expanded && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            aria-expanded={false}
          >
            <ChevronDown className="h-3.5 w-3.5" />
            Tampilkan {recommendations.length - shownCount} lagi
          </button>
        )}
        {expanded && recommendations.length > defaultCount && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            aria-expanded
          >
            <ChevronRight className="h-3.5 w-3.5" />
            Tampilkan lebih sedikit
          </button>
        )}

        {/* Footer — D6 coverage summary (UX-NAVLINK-1: the "lihat semua →"
            jump button was removed per user request — the Resto tab is
            reachable from the tab bar and now has its own Filter Resto). */}
        <div className="flex flex-wrap items-center border-t pt-2.5">
          <p className="text-xs text-muted-foreground tabular-nums">
            Top {shownCount} dari {totalOutlets} outlet
            {shareLabel && <> — <span className="font-medium text-foreground">{shareLabel}</span> dari deviasi</>}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
