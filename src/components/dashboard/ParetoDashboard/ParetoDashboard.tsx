'use client';

// ============================================================
//  ParetoDashboard — 80/20 analysis (inline tab component, not modal)
//  4-quadrant view + nested Item→Outlet breakdown
//  --------------------------------------------------------
//  Main orchestrator component. Owns the react-query fetch,
//  dimension state, and loading/error/empty states. Delegates
//  rendering of each card to sibling sub-components.
// ============================================================

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Loader2, TrendingDown, Package, Store, MapPin, Users, Boxes, RotateCcw, ChevronsUpDown } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ParetoDevBomCard, GapAnalysisCard } from '@/components/dashboard/TopItems';
import { SectionHeader } from '@/components/dashboard/shared';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { DIM_LABELS, QUADRANT_TOOLTIPS } from './constants';
import { QuadrantCard } from './QuadrantCard';
import { ConcentrationStrip } from './ConcentrationStrip';
import { NestedItemToOutlet } from './NestedItemToOutlet';
import { GeneralizedNested } from './GeneralizedNested';
import { ActionPlanFooter } from './ActionPlanFooter';
import type { ParetoData, ParetoDimension, ParetoResult } from './types';

export function ParetoDashboard({ analysisData }: { analysisData?: any }) {
  const { monthLabel, currentWeek, area, kelompok, pic } = useDashboard(useShallow((s) => ({
    monthLabel: s.monthLabel,
    currentWeek: s.currentWeek,
    area: s.area,
    kelompok: s.kelompok,
    pic: s.pic,
  })));
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  // FIX #42: parent + child dimension state for the generalized nested query.
  // Defaults to 'item' → 'outlet' (same as the hardcoded nested breakdown).
  const [parentDim, setParentDim] = useState<ParetoDimension>('item');
  const [childDim, setChildDim] = useState<ParetoDimension>('outlet');
  const [expandedGen, setExpandedGen] = useState<Set<string>>(new Set());

  // Reset expanded items when filter changes (stale state cleanup)
  const filterKey = `${monthLabel}|${currentWeek}|${area}|${kelompok}|${pic}|${parentDim}|${childDim}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (prevFilterKey !== filterKey) {
    setPrevFilterKey(filterKey);
    setExpandedItems(new Set());
    setExpandedGen(new Set());
  }

  const { data: paretoData, isLoading, error, refetch } = useQuery<ParetoData>({
    queryKey: ['pareto', monthLabel, currentWeek, area, kelompok, pic, parentDim, childDim],
    queryFn: async () => {
      const p = new URLSearchParams({
        month: monthLabel!,
        week: currentWeek!,
      });
      if (area && area !== 'all') p.set('area', area);
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      if (pic) p.set('pic', pic);
      // FIX: only send parentDim/childDim when NOT default (item→outlet)
      // to avoid unnecessary queryParetoNested call on every request.
      if (parentDim !== 'item' || childDim !== 'outlet') {
        p.set('parentDim', parentDim);
        p.set('childDim', childDim);
      }
      const res = await fetch(`/api/pareto?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: Boolean(monthLabel && currentWeek),
    staleTime: 120_000,
  });

  const toggleItem = (name: string) => {
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  const toggleGen = (name: string) => {
    setExpandedGen(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const nestedItems = paretoData?.nested?.items || [];
  const nestedGen = paretoData?.nestedGeneralized;

  // ANA-1-C: Pareto result for the ACTIVE dimension — the parentDim selector
  // drives both the nested query and the concentration strip, so the strip
  // reacts to dimension changes without touching the query/payload.
  const activePareto: ParetoResult | undefined =
    parentDim === 'item' ? paretoData?.byItem
    : parentDim === 'outlet' ? paretoData?.byOutlet
    : parentDim === 'area' ? paretoData?.byArea
    : parentDim === 'kelompok' ? paretoData?.byKelompok
    : paretoData?.byPIC;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-amber-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-red-600 dark:text-red-400 font-medium">Gagal memuat Pareto: {error.message}</p>
        <p className="text-xs text-muted-foreground mt-1">Coba refresh halaman atau ganti periode.</p>
        {/* FIX #29: retry button using the dead RotateCcw import */}
        <Button onClick={() => refetch()} variant="outline" size="sm" className="mt-3">
          <RotateCcw className="h-3.5 w-3.5" /> Coba Lagi
        </Button>
      </div>
    );
  }

  if (!paretoData || !paretoData.success) {
    return <div className="text-center text-muted-foreground text-sm py-12">Tidak ada data</div>;
  }

  return (
    <div className="space-y-4">
      {/* Header — VH-7: hand-rolled header replaced by the shared SectionHeader
          (description + action slot) so the tab interior matches the other L6
          tabs. Select bodies kept byte-identical — only the wrapper moved. */}
      <SectionHeader
        icon={<TrendingDown className="h-4 w-4 text-muted-foreground" />}
        title="Pareto 80/20 Analysis"
        description={`Kontributor teratas yang menyumbang 80% total deviasi — per item, outlet, kelompok, area, dan PIC.${paretoData.durationMs != null ? ` · ${paretoData.durationMs}ms` : ''}`}
        action={(
          <div className="flex items-center gap-2">
            {/* FIX #42 selectors — moved into SectionHeader action slot (VH-7) */}
            <Select value={parentDim} onValueChange={(v) => setParentDim(v as ParetoDimension)}>
              <SelectTrigger className="h-8 w-[120px] text-xs">
                <SelectValue placeholder="Parent" />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(DIM_LABELS) as ParetoDimension[]).map((d) => (
                  <SelectItem key={d} value={d}>{DIM_LABELS[d]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">→</span>
            <Select value={childDim} onValueChange={(v) => setChildDim(v as ParetoDimension)}>
              <SelectTrigger className="h-8 w-[120px] text-xs">
                <SelectValue placeholder="Child" />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(DIM_LABELS) as ParetoDimension[])
                  .filter((d) => d !== parentDim)
                  .map((d) => (
                    <SelectItem key={d} value={d}>{DIM_LABELS[d]}</SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        )}
      />

      {/* ANA-1-C: concentration strip (CR3/CR5/N80 + level chip) for the
          active dimension — slim summary row between the header and the
          quadrant grid; pure frontend derivation from the same payload. */}
      <ConcentrationStrip dimension={parentDim} data={activePareto} />

      {/* 5-Quadrant Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <QuadrantCard
          title="Top Items (80% Deviation)"
          icon={<Package className="h-3.5 w-3.5" />}
          data={paretoData.byItem}
          color="bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground"

          tooltip={QUADRANT_TOOLTIPS['Top Items (80% Deviation)']}
        />
        <QuadrantCard
          title="Top Outlets (80% Deviation)"
          icon={<Store className="h-3.5 w-3.5" />}
          data={paretoData.byOutlet}
          color="bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground"

          tooltip={QUADRANT_TOOLTIPS['Top Outlets (80% Deviation)']}
        />
        <QuadrantCard
          title="Top Kelompok (80% Deviation)"
          icon={<Boxes className="h-3.5 w-3.5" />}
          data={paretoData.byKelompok}
          color="bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground"

          tooltip={QUADRANT_TOOLTIPS['Top Kelompok (80% Deviation)']}
        />
        <QuadrantCard
          title="Top Areas (80% Deviation)"
          icon={<MapPin className="h-3.5 w-3.5" />}
          data={paretoData.byArea}
          color="bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground"

          tooltip={QUADRANT_TOOLTIPS['Top Areas (80% Deviation)']}
        />
        <QuadrantCard
          title="Top PIC (80% Deviation)"
          icon={<Users className="h-3.5 w-3.5" />}
          data={paretoData.byPIC}
          color="bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground"

          tooltip={QUADRANT_TOOLTIPS['Top PIC (80% Deviation)']}
        />
      </div>

      {/* VH-7: nested-breakdown section header — progressive disclosure
          context (what expanding a contributor reveals). */}
      <SectionHeader
        icon={<ChevronsUpDown className="h-4 w-4 text-muted-foreground" />}
        title="Breakdown Bertingkat"
        description="Perluas kontributor teratas untuk melihat sebarannya ke dimensi berikutnya (mis. item → outlet)."
      />

      {/* Nested Item → Outlet Breakdown */}
      <NestedItemToOutlet
        nestedItems={nestedItems}
        expandedItems={expandedItems}
        toggleItem={toggleItem}
      />

      {/* FIX #42: Generalized nested breakdown (parentDim → childDim) —
          rendered when the user-selected combo differs from the default
          Item→Outlet (which is already shown by the card above). */}
      <GeneralizedNested
        nestedGen={nestedGen}
        parentDim={parentDim}
        childDim={childDim}
        expandedGen={expandedGen}
        toggleGen={toggleGen}
      />

      {/* Pareto Item Abnormal (|Dev/BOM| > 50%) — full width, below Nested Breakdown */}
      <ParetoDevBomCard data={analysisData} />

      {/* Gap Analysis: Rank BOM vs Rank Nasional — full width */}
      <GapAnalysisCard data={analysisData} />

      {/* Insight Footer — Action Plan */}
      <ActionPlanFooter paretoData={paretoData} />
    </div>
  );
}
