'use client';

// ============================================================
//  OutletPriorityPanel — L3 left column, compact multi-lens (PANEL-1 / A3)
//  --------------------------------------------------------
//  Replaces the narrative's RestoRecommendationCard (audit A3: the
//  "outlet mana yang perlu perhatian?" question was answered by 4-5
//  ranking lenses scattered across 3 tabs). ONE compact panel with a
//  lens toggle — the SAME pattern ItemPriorityPanel uses for items
//  (D5-b toggle + top-3/expand + click row):
//
//    - Prioritas (default): /api/recommendations via useRecommendations
//      (the SHARED hook — dedupes with ExecutiveStatus + the Resto tab's
//      scoped query; same outletCode scoping as the old card).
//    - Kondisi: analysis payload outletHealthRanking, worst-first —
//      the full table lives on in the Area tab (untouched).
//    - Peluang Rp: /api/benchmark-opportunity, LENS-GATED fetch (fires
//      only when the lens is first activated — no new eager initial
//      load; the full card lives on in the Peer tab, untouched).
//
//  UX-NAVLINK-1: no "lihat semua →" button — full versions stay
//  reachable via the tab bar. Row click → setFocusOutlet (Resto deep
//  dive — same Navigation Bridge as every other outlet row).
// ============================================================

import { memo, useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Building2, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { fmtIDR, fmtPct } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { useRecommendations, type RestoRecommendation } from '@/hooks/useRecommendations';
import type { RecommendationHistory } from '@/components/dashboard/priority-summary/types';
import { healthScoreBg, healthScoreColor } from '@/components/dashboard/advanced-analysis/health-badges';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';
import type { BenchmarkOpportunityResponse } from '@/components/dashboard/peer-comparison/benchmark-opportunity-card';
import type { AnalysisData, OutletHealthRanking } from '@/hooks/useAnalysis';

type Lens = 'prioritas' | 'kondisi' | 'peluang';

/** Compact panel shows 3 by default, at most 8 when expanded
 *  (progressive disclosure — same rule as ItemPriorityPanel). */
const COMPACT_MAX = 8;

const TOOLTIP_TEXT =
  'Satu panel, tiga lensa untuk "resto mana yang perlu perhatian dulu?": Prioritas = skor 14 sinyal (loss, deviasi, anomali, dsb); Kondisi = health score dari campuran normal/warning/abnormal; Peluang Rp = loss yang bisa ditekan jika turun ke median areanya. Klik resto untuk buka analisa lengkapnya; versi penuh tiap lensa ada di tab Resto / Area / Peer.';

/** Normalized display row (lens-agnostic) — keeps the three payload
 *  list types out of the render path and the mini-bar scale simple. */
interface CompactRow {
  key: string;
  outletCode: string;
  outletName: string;
  area: string;
  magnitude: number;
  valueLabel: string;
  valueCls: string;
  barCls: string;
  subLabel: string;
  /** ANA-1-D chips (Prioritas lens only) — carried over 1:1 from the old
   *  RestoRecommendationCard rows so the compact panel loses no signal. */
  history?: RecommendationHistory;
  trendDeteriorating?: boolean;
}

/** Tooltip for the recurrence chip (verbatim from the old card — ANA-1-D). */
function recurrenceTitle(h: RecommendationHistory): string {
  let t = `Bermasalah di ${h.abnormalCount} dari ${h.periodCount} bulan sebelumnya (Dev/BOM di atas toleransi atau loss di atas threshold)`;
  if (h.periodCount < 4) t += ' · data historis masih terbatas';
  return t;
}

function levelValueCls(level: RestoRecommendation['priorityLevel']): string {
  if (level === 'TINGGI') return 'text-red-600 dark:text-red-400';
  if (level === 'SEDANG') return 'text-amber-600 dark:text-amber-400';
  return 'text-zinc-500 dark:text-zinc-400';
}

function levelBarCls(level: RestoRecommendation['priorityLevel']): string {
  if (level === 'TINGGI') return 'bg-red-500';
  if (level === 'SEDANG') return 'bg-amber-500';
  return 'bg-zinc-400';
}

/** Small pulse placeholder row (loading state — mirrors the old card's). */
function PulseRow() {
  return (
    <div className="flex min-h-11 items-center gap-3 rounded-lg border p-3">
      <span className="h-7 w-7 rounded-full bg-muted animate-pulse shrink-0" />
      <div className="flex-1 space-y-1.5">
        <div className="h-3.5 w-32 bg-muted rounded animate-pulse" />
        <div className="h-2.5 w-20 bg-muted rounded animate-pulse" />
      </div>
      <div className="h-4 w-14 bg-muted rounded animate-pulse shrink-0" />
    </div>
  );
}

export const OutletPriorityPanel = memo(function OutletPriorityPanel({ data }: { data: AnalysisData }) {
  const { outletCode, kelompok, monthLabel, currentWeek, setFocusOutlet } = useDashboard(useShallow((s) => ({
    outletCode: s.outletCode,
    kelompok: s.kelompok,
    monthLabel: s.monthLabel,
    currentWeek: s.currentWeek,
    setFocusOutlet: s.setFocusOutlet,
  })));

  const [lens, setLens] = useState<Lens>('prioritas');
  const [expanded, setExpanded] = useState(false);

  const handleLensChange = (v: string) => {
    setLens(v === 'kondisi' ? 'kondisi' : v === 'peluang' ? 'peluang' : 'prioritas');
    setExpanded(false);
  };

  // ------------------------------------------------------------
  //  Lens 1 — Prioritas (shared recommendations fetch; same queryKey
  //  + outletCode scoping as the old RestoRecommendationCard, so it
  //  dedupes with ExecutiveStatus + the Resto tab's scoped query).
  // ------------------------------------------------------------
  const { data: resp, isLoading: recLoading, error: recError, refetch: recRefetch } = useRecommendations(outletCode);
  // P3-HYG-7a: pin list identities so the memos below are stable.
  const recommendations = useMemo<RestoRecommendation[]>(() => resp?.recommendations ?? [], [resp?.recommendations]);

  // D6 adaptive default (same rule as the old card + ItemPriorityPanel):
  // top-3, or 5 when the top-3's |nominal deviasi| is < 50% of the
  // network total (costImpact.totalCost; fallback plain 3 when absent).
  const totalDev = data.costImpact?.totalCost ?? null;
  const defaultCount = useMemo(() => {
    if (recommendations.length <= 3) return 3;
    if (totalDev != null && totalDev > 0) {
      const top3 = recommendations.slice(0, 3).reduce((sum, r) => sum + Math.abs(r.metrics.nominalDeviasi), 0);
      if (top3 / totalDev < 0.5) return 5;
    }
    return 3;
  }, [recommendations, totalDev]);

  // ------------------------------------------------------------
  //  Lens 2 — Kondisi (analysis payload; worst-first like the Area
  //  tab's full table — lowest healthScore first).
  // ------------------------------------------------------------
  const healthRanking = useMemo(
    () => (data.outletHealthRanking || []).slice().sort((a, b) => a.healthScore - b.healthScore),
    [data.outletHealthRanking],
  );

  // ------------------------------------------------------------
  //  Lens 3 — Peluang Rp (LENS-GATED fetch: enabled only when the
  //  lens is active — no new eager initial-load request. Same params
  //  + staleTime as the Peer tab's BenchmarkOpportunityCard query,
  //  so an already-visited Peer tab shares the cache entry.)
  // ------------------------------------------------------------
  const isPeluang = lens === 'peluang';
  const { data: oppResp, isLoading: oppLoading, error: oppError, refetch: oppRefetch } = useQuery<BenchmarkOpportunityResponse>({
    queryKey: ['peer-comparison', 'benchmark-opportunity', monthLabel, currentWeek, kelompok],
    queryFn: async () => {
      if (!monthLabel || !currentWeek) throw new Error('Periode belum dipilih');
      const p = new URLSearchParams();
      p.set('month', monthLabel);
      p.set('week', currentWeek);
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      const res = await fetch(`/api/benchmark-opportunity?${p.toString()}`);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('Server error');
      return res.json() as Promise<BenchmarkOpportunityResponse>;
    },
    enabled: isPeluang && Boolean(monthLabel && currentWeek),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });
  const opportunities = useMemo(
    () => (oppResp?.topOutlets || []).slice().sort((a, b) => b.opportunityRp - a.opportunityRp),
    [oppResp?.topOutlets],
  );

  // ------------------------------------------------------------
  //  Display rows per lens + shared mini-bar scale.
  // ------------------------------------------------------------
  const limit = expanded ? COMPACT_MAX : Math.min(defaultCount, COMPACT_MAX);

  const { shown, maxValue, totalCount, footer } = useMemo(() => {
    let list: CompactRow[] = [];
    let count = 0;
    let foot = '';

    if (lens === 'prioritas') {
      count = recommendations.length;
      list = recommendations.slice(0, expanded ? COMPACT_MAX : limit).map((r) => ({
        key: r.outletCode,
        outletCode: r.outletCode,
        outletName: r.outletName,
        area: r.area,
        magnitude: r.priorityScore,
        valueLabel: String(Math.round(r.priorityScore)),
        valueCls: levelValueCls(r.priorityLevel),
        barCls: levelBarCls(r.priorityLevel),
        subLabel: `Loss ${fmtIDR(r.metrics.totalLoss)} · Dev ${fmtIDR(r.metrics.nominalDeviasi)}`,
        history: r.history,
        trendDeteriorating: r.signals.trendDeteriorating,
      }));
      // Footer — coverage share only when the optional network total is
      // present (same honest guard as the old card; capped at 100%).
      const shownAbsSum = list.reduce((sum, r) => {
        const rec = recommendations.find((x) => x.outletCode === r.outletCode);
        return sum + Math.abs(rec?.metrics.nominalDeviasi ?? 0);
      }, 0);
      const share = totalDev != null && totalDev > 0
        ? fmtPct(Math.min(1, shownAbsSum / totalDev), false, 0)
        : null;
      foot = share != null
        ? `Top ${list.length} dari ${count} resto · mewakili ${share} total deviasi`
        : `Top ${list.length} dari ${count} resto`;
    } else if (lens === 'kondisi') {
      count = healthRanking.length;
      list = healthRanking.slice(0, expanded ? COMPACT_MAX : limit).map((o: OutletHealthRanking) => ({
        key: o.outletCode,
        outletCode: o.outletCode,
        outletName: o.outletName,
        area: o.area,
        magnitude: o.healthScore,
        valueLabel: String(Math.round(o.healthScore)),
        valueCls: healthScoreColor(o.healthScore),
        barCls: healthScoreBg(o.healthScore),
        subLabel: `${o.abnormal} abnormal · ${o.warning} warning · ${o.normal} normal`,
      }));
      foot = `${count} resto dengan deviasi non-nol · ranking lengkap di tab Area`;
    } else {
      count = opportunities.length;
      list = opportunities.slice(0, expanded ? COMPACT_MAX : limit).map((o) => ({
        key: o.outletCode,
        outletCode: o.outletCode,
        outletName: o.outletName,
        area: o.area,
        magnitude: o.opportunityRp,
        valueLabel: fmtIDR(o.opportunityRp),
        valueCls: 'text-amber-600 dark:text-amber-400',
        barCls: 'bg-amber-500',
        subLabel: `Loss ${fmtIDR(o.lossNominal)} · median area ${fmtIDR(o.areaMedianLoss)}`,
      }));
      foot = oppResp?.totalOpportunityRp != null
        ? `Total peluang ${fmtIDR(oppResp.totalOpportunityRp)} · ${oppResp.areaCount ?? 0} area (median resto satu area)`
        : '';
    }

    const max = Math.max(...list.map((r) => r.magnitude), 0);
    return { shown: list, maxValue: max, totalCount: count, footer: foot };
  }, [lens, recommendations, healthRanking, opportunities, expanded, limit, totalDev, oppResp]);

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 shrink-0">
            <Building2 className="h-3.5 w-3.5" />
          </span>
          Prioritas Outlet
          <InfoTooltip content={TOOLTIP_TEXT} />
        </CardTitle>
        {/* VH-7 (§21): question-first subtitle. */}
        <p className="text-xs text-muted-foreground ml-9"><span className="font-medium text-foreground/70">Resto mana yang perlu perhatian duluan?</span> — tiga lensa prioritas</p>
        {/* Lens toggle — same Tabs pattern as ItemPriorityPanel (D5-b). */}
        <div className="ml-9">
          <Tabs value={lens} onValueChange={handleLensChange}>
            <TabsList className="grid h-8 w-full grid-cols-3">
              <TabsTrigger value="prioritas" className="text-xs">Prioritas</TabsTrigger>
              <TabsTrigger value="kondisi" className="text-xs">Kondisi</TabsTrigger>
              <TabsTrigger value="peluang" className="text-xs">Peluang Rp</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* Loading / error states per lens (error before !data — B1/B2-01 convention). */}
        {lens === 'prioritas' && recLoading && shown.length === 0 ? (
          Array.from({ length: 3 }).map((_, i) => <PulseRow key={i} />)
        ) : lens === 'prioritas' && recError ? (
          <div className="py-4 text-center space-y-2">
            <p className="text-xs text-red-600 dark:text-red-400">Gagal memuat rekomendasi.</p>
            <Button onClick={() => recRefetch()} variant="outline" size="sm">
              <RotateCcw className="h-3.5 w-3.5" /> Coba Lagi
            </Button>
          </div>
        ) : lens === 'peluang' && oppLoading && shown.length === 0 ? (
          Array.from({ length: 3 }).map((_, i) => <PulseRow key={i} />)
        ) : lens === 'peluang' && oppError ? (
          <div className="py-4 text-center space-y-2">
            <p className="text-xs text-red-600 dark:text-red-400">Gagal memuat peluang perbaikan.</p>
            <Button onClick={() => oppRefetch()} variant="outline" size="sm">
              <RotateCcw className="h-3.5 w-3.5" /> Coba Lagi
            </Button>
          </div>
        ) : lens === 'peluang' && oppResp && !oppResp.success ? (
          <p className="py-4 text-center text-xs text-red-600 dark:text-red-400">Error: {oppResp.error || 'Unknown'}</p>
        ) : shown.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {lens === 'prioritas' && 'Tidak ada resto prioritas pada periode ini.'}
            {lens === 'kondisi' && 'Tidak ada data outlet dengan deviasi pada periode ini.'}
            {lens === 'peluang' && (oppResp && oppResp.totalOpportunityRp === 0
              ? 'Tidak ada peluang — semua resto sudah di bawah median areanya.'
              : 'Tidak ada data peluang pada periode ini.')}
          </p>
        ) : shown.map((r, i) => (
          <div
            key={r.key}
            className="min-h-11 rounded-lg border bg-card p-3 cursor-pointer transition-colors hover:bg-muted/40 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            {...clickableRowProps(() => setFocusOutlet(r.outletCode))}
            title="Klik untuk buka analisa resto ini"
          >
            <div className="flex items-center gap-3">
              {/* Rank badge — round; #1 inverted (matches ItemPriorityPanel). */}
              <span className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold shrink-0 tabular-nums ${
                i === 0 ? 'bg-foreground text-background' : 'border bg-muted/50 text-muted-foreground'
              }`}>
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold leading-tight truncate" title={r.outletName}>{r.outletName}</p>
                {/* Meta line + ANA-1-D chips (carried from the old card — the
                    text <p> truncates first so the small chips stay visible
                    at 375px without breaking row rhythm). */}
                <div className="mt-0.5 flex min-w-0 items-center gap-1">
                  <p className="text-xs text-muted-foreground truncate">{r.area} · {r.outletCode}</p>
                  {/* Recurrence chip — hidden when STABIL, when no historical
                      month exists, or when `history` is absent (payload cached
                      before the field was added). */}
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
                  {r.trendDeteriorating && (
                    <span
                      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-red-300 px-1.5 py-px text-[10px] font-medium leading-4 text-red-600 dark:border-red-800 dark:text-red-400"
                      title="Nominal deviasi naik >20% dibanding periode sebelumnya atau rata-rata historis (same-week)"
                    >
                      ↗ Memburuk
                    </span>
                  )}
                </div>
              </div>
              {/* Main number + lens-specific sub-caption. */}
              <div className="shrink-0 text-right">
                <span className={`text-sm font-bold tabular-nums ${r.valueCls}`}>{r.valueLabel}</span>
                <p className="text-[10px] text-muted-foreground tabular-nums truncate max-w-[150px]" title={r.subLabel}>{r.subLabel}</p>
              </div>
            </div>
            {/* Proportional mini-bar — value relative to the top row. */}
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
              <div className={`h-full ${r.barCls}`} style={{ width: `${maxValue > 0 ? Math.min(100, (r.magnitude / maxValue) * 100) : 0}%` }} />
            </div>
          </div>
        ))}

        {/* Expand / collapse — only when more rows exist beyond the current limit. */}
        {totalCount > shown.length && !expanded && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            aria-expanded={false}
          >
            <ChevronDown className="h-3.5 w-3.5" />
            Tampilkan {Math.min(COMPACT_MAX, totalCount) - shown.length} lagi
          </button>
        )}
        {expanded && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            aria-expanded
          >
            <ChevronRight className="h-3.5 w-3.5" />
            Ringkas
          </button>
        )}

        {/* Footer coverage caption (UX-NAVLINK-1: no "lihat semua" — the
            full versions stay reachable via the tab bar). */}
        {footer && shown.length > 0 ? (
          <p className="pt-1 text-[10px] text-muted-foreground border-t">{footer}</p>
        ) : null}
      </CardContent>
    </Card>
  );
});
