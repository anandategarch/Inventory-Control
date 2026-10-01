'use client';

// ============================================================
//  WasteTab — "Waste" tab content (DEEP-WASTE-1/2)
//  --------------------------------------------------------
//  Deep Waste Analysis: the in-app generalization of the offline
//  "Analisa-Deep-Waste-Area-1" report to ANY scope (global Area /
//  Kelompok / PIC filters apply — the tab re-fetches when they
//  change). Six cards:
//    1. WasteKpiStrip        — window KPIs + severity chips
//    2. WasteProfileTable    — per-outlet profile (rank waste/sales)
//    3. WastePersistenceCard — W2: kronis vs episodik (transisi + Fisher)
//    4. WasteMatrixCard      — outlet × month color-scale matrix
//    5. LossDecompositionCard— explained (waste/susut/trial) vs residual
//    6. WasteParetoCard      — item 80/20 + sistematik + breakdown
//    7. WasteQuadrantCard    — W3: kuadran sistemik-vs-insiden (scatter)
//    8. WasteRateLeagueCard  — W1: liga waste-rate per bahan (waste÷BOM)
//    9. WasteAnomalyCard     — findings list ber-severity
//  ONE /api/waste-series request feeds the props-driven cards (1, 2, 3, 4,
//  5, 9 — HeatmapTab-style self-fetch — no `data` prop from page.tsx);
//  the Pareto + Quadrant cards self-fetch /api/waste-top-items (shared
//  queryKey → react-query dedups both into one request); the RateLeague
//  card self-fetches /api/waste-rate-league.
//  PERF-FE: memo — page.tsx re-renders on any Zustand change.
// ============================================================

import { memo } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { CalendarClock } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { WasteKpiStrip } from './kpi-strip';
import { WasteProfileTable } from './profile-table';
import { WastePersistenceCard } from './persistence-card';
import { WasteMatrixCard } from './matrix-card';
import { LossDecompositionCard } from './decomposition-card';
import { WasteParetoCard } from './pareto-card';
import { WasteQuadrantCard } from './quadrant-card';
import { WasteRateLeagueCard } from './rate-league-card';
import { WasteAnomalyCard } from './anomaly-card';
import type { WasteSeriesResponse } from './types';

export const WasteTab = memo(function WasteTab() {
  // FILTERDROP-1 (opsi A): outletCode removed — the global outlet filter no
  // longer exists; the Waste tab always analyzes the full population
  // (network/area/kelompok/pic scoped).
  const { monthLabel, currentWeek, area, kelompok, pic } = useDashboard(useShallow((s) => ({
    monthLabel: s.monthLabel,
    currentWeek: s.currentWeek,
    area: s.area,
    kelompok: s.kelompok,
    pic: s.pic,
  })));

  // Normalize 'all' → null ONCE (same convention as the routes — raw 'all'
  // would match nothing and poison the query key).
  const areaParam = area && area !== 'all' ? area : null;
  const kelompokParam = kelompok && kelompok !== 'all' ? kelompok : null;
  const picParam = pic && pic !== 'all' ? pic : null;

  const { data, isLoading, error } = useQuery<WasteSeriesResponse>({
    queryKey: ['waste-series', monthLabel, currentWeek, areaParam, kelompokParam, picParam],
    queryFn: async () => {
      const p = new URLSearchParams();
      // enabled guards null/empty — the '' fallbacks below never reach the wire.
      p.set('month', monthLabel || '');
      p.set('week', currentWeek || '');
      if (areaParam) p.set('area', areaParam);
      if (kelompokParam) p.set('kelompok', kelompokParam);
      if (picParam) p.set('pic', picParam);
      const res = await fetch(`/api/waste-series?${p.toString()}`);
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        throw new Error(`Server error (HTTP ${res.status}). ${text.slice(0, 200)}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<WasteSeriesResponse>;
    },
    enabled: Boolean(monthLabel && currentWeek),
    // PERF-FE (PAKET A) convention: only changes on ingest / manual refresh
    // (invalidateAllData lists ['waste-series']).
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });

  if (!monthLabel || !currentWeek) {
    return (
      <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
        <CardContent className="py-10 text-center">
          <CalendarClock className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">Pilih Bulan dan Minggu pada filter atas untuk memuat analisis waste.</p>
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Memuat analisis waste multi-bulan…
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
        <CardContent className="py-10 text-center text-sm text-red-600 dark:text-red-400">
          {error.message}
        </CardContent>
      </Card>
    );
  }

  const months = data?.months || [];
  const monthly = data?.monthly || [];
  const outlets = data?.outlets || [];
  const kpis = data?.kpis;

  return (
    <div className="space-y-4 min-w-0">
      {kpis && <WasteKpiStrip kpis={kpis} week={currentWeek} monthsCount={months.length} />}
      <WasteProfileTable outlets={outlets} />
      <WastePersistenceCard outlets={outlets} persistence={data?.persistence} />
      <WasteMatrixCard monthly={monthly} months={months} />
      <LossDecompositionCard monthly={monthly} />
      <WasteParetoCard
        monthLabel={monthLabel}
        currentWeek={currentWeek}
        area={areaParam}
        kelompok={kelompokParam}
        pic={picParam}
      />
      <WasteQuadrantCard
        monthLabel={monthLabel}
        currentWeek={currentWeek}
        area={areaParam}
        kelompok={kelompokParam}
        pic={picParam}
      />
      <WasteRateLeagueCard
        monthLabel={monthLabel}
        currentWeek={currentWeek}
        area={areaParam}
        kelompok={kelompokParam}
        pic={picParam}
      />
      <WasteAnomalyCard outlets={outlets} monthly={monthly} />
    </div>
  );
});
