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
import { Loader2, TrendingDown, Package, Store, MapPin, Users, Boxes, RotateCcw } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ParetoDevBomCard, GapAnalysisCard } from '@/components/dashboard/TopItems';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { DIM_LABELS, QUADRANT_TOOLTIPS } from './constants';
import { QuadrantCard } from './QuadrantCard';
import { NestedItemToOutlet } from './NestedItemToOutlet';
import { GeneralizedNested } from './GeneralizedNested';
import { ActionPlanFooter } from './ActionPlanFooter';
import type { ParetoData, ParetoDimension } from './types';

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
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
          <TrendingDown className="h-4 w-4" />
        </span>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold">Pareto 80/20 Analysis</h2>
          <p className="text-xs text-muted-foreground">
            Top contributors yang menyumbang 80% total deviation
            {paretoData.durationMs != null && ` · ${paretoData.durationMs}ms`}
          </p>
        </div>
        {/* FIX #42: parent + child dimension selectors for the generalized
            nested breakdown. Backend supports any (parentDim, childDim)
            combination where the two differ. */}
        <div className="flex items-center gap-2">
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
      </div>

      {/* 5-Quadrant Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <QuadrantCard
          title="Top Items (80% Deviation)"
          icon={<Package className="h-3.5 w-3.5" />}
          data={paretoData.byItem}
          color="bg-amber-100 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400"
          barColor="bg-amber-500"
          tooltip={QUADRANT_TOOLTIPS['Top Items (80% Deviation)']}
        />
        <QuadrantCard
          title="Top Outlets (80% Deviation)"
          icon={<Store className="h-3.5 w-3.5" />}
          data={paretoData.byOutlet}
          color="bg-emerald-100 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400"
          barColor="bg-emerald-500"
          tooltip={QUADRANT_TOOLTIPS['Top Outlets (80% Deviation)']}
        />
        <QuadrantCard
          title="Top Kelompok (80% Deviation)"
          icon={<Boxes className="h-3.5 w-3.5" />}
          data={paretoData.byKelompok}
          color="bg-cyan-100 dark:bg-cyan-950/40 text-cyan-600 dark:text-cyan-400"
          barColor="bg-cyan-500"
          tooltip={QUADRANT_TOOLTIPS['Top Kelompok (80% Deviation)']}
        />
        <QuadrantCard
          title="Top Areas (80% Deviation)"
          icon={<MapPin className="h-3.5 w-3.5" />}
          data={paretoData.byArea}
          color="bg-violet-100 dark:bg-violet-950/40 text-violet-600 dark:text-violet-400"
          barColor="bg-violet-500"
          tooltip={QUADRANT_TOOLTIPS['Top Areas (80% Deviation)']}
        />
        <QuadrantCard
          title="Top PIC (80% Deviation)"
          icon={<Users className="h-3.5 w-3.5" />}
          data={paretoData.byPIC}
          color="bg-red-100 dark:bg-red-950/40 text-red-600 dark:text-red-400"
          barColor="bg-red-500"
          tooltip={QUADRANT_TOOLTIPS['Top PIC (80% Deviation)']}
        />
      </div>

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
