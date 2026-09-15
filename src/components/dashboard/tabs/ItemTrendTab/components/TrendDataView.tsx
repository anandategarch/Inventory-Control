'use client';

// ============================================================
//  TrendDataView — ItemTrendTab loaded-data composition
//  --------------------------------------------------------
//  SPLIT-B (pure move from ItemTrendTab/index.tsx — no behavior
//  change). Rendered once the trend query has ≥1 period. Layout:
//    1. FlipSummaryCard (Phase A+B / FLIP-FE) — compact aggregate
//    2. Period Status Tracker (TREMOR Pattern 3) — per-period
//       Z-Score status blocks
//    3. Main line chart (Recharts, lazy-loaded via next/dynamic)
//       + compact ItemTrendRankChart (Phase 3, inverted Y-axis)
//    4. ItemTrendTable (sortable data table)
//    5. FlipMatrix (Phase B — week × month grid)
//    6. ItemPeerComparison drill-down panel (Phase 2)
// ============================================================

import dynamic from 'next/dynamic';
import { Loader2 } from 'lucide-react';
import type { ItemTrendMetric, ItemTrendPeriod } from '@/hooks/useAnalysis';
import { fmtDecimal } from '@/lib/format';
import { Tracker } from '@/components/dashboard/shared/Tracker';
import type { FlipAnalysis, ItemFlipScore } from '../flipHelpers';
import { FlipMatrix } from '../FlipMatrix';
import { ItemTrendTable } from '../ItemTrendTable';
import { ItemPeerComparison } from '../ItemPeerComparison';
import { ItemTrendRankChart } from '../ItemTrendRankChart';
import { FlipSummaryCard } from '../FlipSummaryCard';
import type { SortKey, SortDir } from '../types';
import type { DrillPeriod } from '../hooks/useDrillPeriodSync';
import type { ItemTrendRankPeriod } from '../hooks/useItemRankTrend';

// Recharts is 5.4MB — lazy-load the chart component so it stays out of
// the main bundle. LoadingChart fallback reserves layout space.
const ItemTrendLineChart = dynamic(() => import('@/components/dashboard/tabs/ItemTrendLineChart').then(m => m.ItemTrendLineChart), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-72">
      <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
    </div>
  ),
});

interface TrendDataViewProps {
  selectedItem: string | null;
  /** Unsorted periods (stable memo ref) — used for length gating. */
  periods: ItemTrendPeriod[];
  /** Chronologically sorted periods — chart + tracker + matrix. */
  chronological: ItemTrendPeriod[];
  metric: ItemTrendMetric;
  flips: FlipAnalysis[];
  flipScore: ItemFlipScore;
  satuan: string | null;
  rankPeriods: ItemTrendRankPeriod[];
  sortedRows: ItemTrendPeriod[];
  sortKey: SortKey;
  sortDir: SortDir;
  toggleSort: (key: SortKey) => void;
  drillPeriod: DrillPeriod | null;
  setDrillPeriod: (p: DrillPeriod | null) => void;
  /** Phase 2 drill callback — chart dot click + table row click. */
  onPeriodDrill: (p: ItemTrendPeriod) => void;
  /** Dashboard filters — scope the ItemPeerComparison panel. */
  outletCode: string | null;
  area: string | null;
  kelompok: string | null;
  pic: string | null;
  onOutletClick: (outletCode: string) => void;
}

export function TrendDataView({
  selectedItem,
  periods,
  chronological,
  metric,
  flips,
  flipScore,
  satuan,
  rankPeriods,
  sortedRows,
  sortKey,
  sortDir,
  toggleSort,
  drillPeriod,
  setDrillPeriod,
  onPeriodDrill,
  outletCode,
  area,
  kelompok,
  pic,
  onOutletClick,
}: TrendDataViewProps) {
  return (
    <div className="space-y-3">
      {/* FIX (UI-10): Flip Summary Card moved here from CardHeader so
          the header stays compact (header already has 4 stacked rows:
          title+badges, search+metric, selected-item summary, rank badge).
          Padding px-4 pt-2 aligns it with the chart + table grid below. */}
      {selectedItem && periods.length > 1 && (
        <div className="px-4 pt-2">
          <FlipSummaryCard score={flipScore} />
        </div>
      )}

      {/* TREMOR Pattern 3 — Tracker: per-period status blocks.
          Each block colored by Z-Score: emerald (z<-1, baik),
          amber (-1..1, normal), red (z>1, abnormal), zinc (null,
          no baseline). Tooltip shows monthLabel + weekLabel + Z. */}
      {selectedItem && periods.length > 1 && (
        <div className="px-4 pt-3 pb-1">
          <p className="text-[10px] text-muted-foreground mb-1.5 flex items-center gap-1.5">
            <span aria-hidden>📊</span> Period Status Tracker
            <span className="text-muted-foreground/60">(hijau=baik, amber=normal, merah=abnormal, abu=tanpa data)</span>
          </p>
          <Tracker
            blocks={chronological.map((p) => {
              const z = p.zScore;
              return {
                color: z == null ? 'zinc' : z < -1 ? 'emerald' : z > 1 ? 'red' : 'amber',
                tooltip: `${p.monthLabel} ${p.weekLabel}: Z-Score ${z != null ? fmtDecimal(z, 2) : '—'}`,
              };
            })}
          />
        </div>
      )}

      {/* Chart section */}
      {/* FIX (UI-01): added pb-3 so chart bottom doesn't touch table border-t */}
      <div className="px-4 pt-2 pb-3">
        <ItemTrendLineChart
          periods={chronological}
          metric={metric}
          onDotClick={onPeriodDrill}
          flips={flips}
        />

        {/* Phase 3 — Rank Trend chart (compact, below main chart).
            Shows the item's national rank (by |nominalDeviasi|)
            per period with an INVERTED Y-axis (rank #1 at top =
            worst). Only rendered when there are ≥2 rank periods
            (the chart can't draw a trend line from a single point). */}
        {/* FIX (BUG-3-03): render when >= 1 period so the chart's own
            1-period message shows (was > 1 which caused silent failure
            — no chart AND no message for 1-period items). */}
        {rankPeriods.length >= 1 && (
          <div className="mt-2 pt-2 border-t">
            <ItemTrendRankChart
              periods={rankPeriods}
              onDotClick={(p) => setDrillPeriod({ month: p.monthLabel, week: p.weekLabel })}
            />
          </div>
        )}
      </div>

      {/* Data table */}
      <ItemTrendTable
        sortedRows={sortedRows}
        sortKey={sortKey}
        sortDir={sortDir}
        toggleSort={toggleSort}
        metric={metric}
        onRowClick={onPeriodDrill}
        drillPeriod={drillPeriod}
        flips={flips}
        satuan={satuan}
      />

      {/* Phase B (FLIP-FE) — Flip Matrix (week × month grid).
          Renders below the table + above the ItemPeerComparison
          drill panel. Only renders when there are ≥2 periods
          (a single period can't form a pair). */}
      {selectedItem && periods.length >= 2 && (
        <div className="px-4 pt-3 pb-2">
          <FlipMatrix periods={chronological} flips={flips} satuan={satuan} />
        </div>
      )}

      {/* Phase 2 — ItemPeerComparison drill-down panel.
          Renders when both selectedItem + drillPeriod are set. */}
      {selectedItem && drillPeriod && (
        <div className="px-4 pb-4 pt-3">
          <ItemPeerComparison
            itemName={selectedItem}
            month={drillPeriod.month}
            week={drillPeriod.week}
            targetOutletCode={outletCode}
            area={area}
            kelompok={kelompok}
            pic={pic}
            onOutletClick={onOutletClick}
          />
        </div>
      )}
    </div>
  );
}
