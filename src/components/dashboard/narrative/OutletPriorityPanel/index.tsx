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
//    - Perubahan (CHANGE-1): /api/change-analysis, LENS-GATED fetch —
//      outlets whose CURRENT deviation move strays from their own
//      average move (same-week chain). Row click EXPANDS the item
//      attribution inline (ChangeItemTable) instead of navigating;
//      the Resto deep-dive bridge stays available inside the expansion.
//
//  UX-NAVLINK-1: no "lihat semua →" button — full versions stay
//  reachable via the tab bar. Row click → setFocusOutlet (Resto deep
//  dive — same Navigation Bridge as every other outlet row).
//
//  SPLIT-G: this folder holds the split modules — lens-model.ts
//  (types + constants + classifiers), use-lens-data.ts (the four
//  lens fetches), build-display-rows.ts (the pure display-rows
//  builder), compact-row.tsx (one row + pulse placeholder). This
//  file is the thin orchestrator. Import path
//  '@/components/dashboard/narrative/OutletPriorityPanel' resolves
//  here (folder + index.tsx) — caller imports unchanged.
// ============================================================

import { memo, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Building2, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { COMPACT_MAX, TOOLTIP_TEXT, type CompactRow, type Lens } from './lens-model';
import { useLensData } from './use-lens-data';
import { buildDisplayRows } from './build-display-rows';
import { CompactRowView, PulseRow } from './compact-row';

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
  // CHANGE-1: the Perubahan lens expands ONE row's item attribution inline.
  const [expandedOutlet, setExpandedOutlet] = useState<string | null>(null);

  const handleLensChange = (v: string) => {
    setLens(v === 'kondisi' ? 'kondisi' : v === 'peluang' ? 'peluang' : v === 'perubahan' ? 'perubahan' : 'prioritas');
    setExpanded(false);
    setExpandedOutlet(null);
  };

  // ============================================================
  //  Lens data — the four fetches + derived memos (use-lens-data).
  //  All hooks called unconditionally, exactly like the pre-split
  //  component.
  // ============================================================
  const {
    recommendations, recLoading, recError, recRefetch,
    defaultCount, totalDev,
    healthRanking,
    oppResp, oppLoading, oppError, oppRefetch, opportunities,
    chgResp, chgLoading, chgError, chgRefetch, changeOutlets,
  } = useLensData({ lens, data, outletCode, monthLabel, currentWeek, kelompok });

  // ------------------------------------------------------------
  //  Display rows per lens + shared mini-bar scale.
  // ------------------------------------------------------------
  const limit = expanded ? COMPACT_MAX : Math.min(defaultCount, COMPACT_MAX);

  const { shown, maxValue, totalCount, footer } = useMemo(
    () => buildDisplayRows({ lens, expanded, limit, recommendations, healthRanking, opportunities, oppResp, changeOutlets, chgResp, totalDev }),
    [lens, recommendations, healthRanking, opportunities, changeOutlets, chgResp, expanded, limit, totalDev, oppResp],
  );

  // Row click: Perubahan lens toggles the inline item attribution;
  // every other lens opens the Resto deep dive (Navigation Bridge).
  const handleRowClick = (r: CompactRow) => {
    if (lens === 'perubahan') setExpandedOutlet((c) => (c === r.outletCode ? null : r.outletCode));
    else setFocusOutlet(r.outletCode);
  };

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
        <p className="text-xs text-muted-foreground ml-9"><span className="font-medium text-foreground/70">Resto mana yang perlu perhatian duluan?</span> — empat lensa prioritas</p>
        {/* Lens toggle — same Tabs pattern as ItemPriorityPanel (D5-b). */}
        <div className="ml-9">
          <Tabs value={lens} onValueChange={handleLensChange}>
            <TabsList className="grid h-8 w-full grid-cols-4">
              <TabsTrigger value="prioritas" className="text-xs">Prioritas</TabsTrigger>
              <TabsTrigger value="kondisi" className="text-xs">Kondisi</TabsTrigger>
              <TabsTrigger value="peluang" className="text-xs">Peluang Rp</TabsTrigger>
              <TabsTrigger value="perubahan" className="text-xs">Perubahan</TabsTrigger>
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
          // P23 D5: "Error: … || 'Unknown'" → Indonesian headline + fallback.
          <p className="py-4 text-center text-xs text-red-600 dark:text-red-400">Gagal memuat peluang perbaikan — {oppResp.error || 'Tidak diketahui'}</p>
        ) : lens === 'perubahan' && chgLoading && shown.length === 0 ? (
          Array.from({ length: 3 }).map((_, i) => <PulseRow key={i} />)
        ) : lens === 'perubahan' && chgError ? (
          <div className="py-4 text-center space-y-2">
            <p className="text-xs text-red-600 dark:text-red-400">Gagal memuat analisa perubahan.</p>
            <Button onClick={() => chgRefetch()} variant="outline" size="sm">
              <RotateCcw className="h-3.5 w-3.5" /> Coba Lagi
            </Button>
          </div>
        ) : lens === 'perubahan' && chgResp && !chgResp.success ? (
          // P23 D5: "Error: … || 'Unknown'" → Indonesian headline + fallback.
          <p className="py-4 text-center text-xs text-red-600 dark:text-red-400">Gagal memuat analisa perubahan — {chgResp.error || 'Tidak diketahui'}</p>
        ) : shown.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {lens === 'prioritas' && 'Tidak ada resto prioritas pada periode ini.'}
            {lens === 'kondisi' && 'Tidak ada data outlet dengan deviasi pada periode ini.'}
            {lens === 'peluang' && (oppResp && oppResp.totalOpportunityRp === 0
              ? 'Tidak ada peluang — semua resto sudah di bawah median areanya.'
              : 'Tidak ada data peluang pada periode ini.')}
            {lens === 'perubahan' && (chgResp && chgResp.outlets.length === 0
              ? 'Belum ada data perubahan pada periode ini.'
              : `Semua resto masih riwayat kurang — butuh ≥ ${chgResp?.thresholds?.minPairs ?? 4} pasangan same-week.`)}
          </p>
        ) : shown.map((r, i) => (
          <CompactRowView
            key={r.key}
            r={r}
            index={i}
            lens={lens}
            maxValue={maxValue}
            expandedOutlet={expandedOutlet}
            monthLabel={monthLabel}
            currentWeek={currentWeek}
            kelompok={kelompok}
            onRowClick={handleRowClick}
            onOpenResto={setFocusOutlet}
          />
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
