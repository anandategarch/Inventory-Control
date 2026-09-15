'use client';

// ============================================================
//  ItemPeerComparison — Phase 2 drill-down panel
//  --------------------------------------------------------
//  Shown below the ItemTrendTable when the user has selected an
//  item AND clicked a period row/dot. Fetches per-outlet peer
//  comparison for the clicked (item, month, week) tuple from
//  /api/item-peer-comparison and renders:
//
//    1. Header — item name + period label + target outlet chip
//       (or "Auto-selected: worst outlet" note when the backend
//       picked the target automatically because no outletCode
//       was provided).
//    2. 4 analysis cards (grid 2 cols on desktop):
//       a. Efficiency Score (0-100) — composite of target vs peer
//          averages. Penalty: devBom + nominalDeviasi above peer avg.
//          Color: green >70 / amber 50-70 / red <50.
//       b. Gap Analysis — target vs peer avg vs peer BEST (lowest
//          |nominalDeviasi|). Gap in QTY + Nominal + Dev/BOM.
//       c. Scatter Plot (mini Recharts) — X=qtyBom, Y=absNominalDeviasi,
//          dot color by direction (red=LOSS / green=SURPLUS). Target
//          outlet highlighted (larger dot + amber ring).
//       d. Ranking Summary — target rank #N of M by |nominalDeviasi|.
//    3. Peer Table — Outlet | Area | PIC | QTY BOM | QTY Deviasi |
//       Dev/BOM | Nominal | Dir | Flags. Target row highlighted
//       (amber bg + left border). Rows clickable → onOutletClick.
//    4. Footer note explaining the peer definition + click hint.
//
//  Data flow:
//    useQuery → /api/item-peer-comparison?item=&month=&week=&outletCode=&...
//    Stale time: 5 min (matches server DB cache).
//
//  Cards are SHARED with PeerComparison.tsx (Peer Tab) via
//  @/components/dashboard/shared/peer-comparison-cards. Each
//  caller computes its own pre-computed values (different
//  formulas per consumer) and passes them to the presentational
//  cards.
//
//  SPLIT-B folder split (pure move, no behavior change):
//    ./types           — ItemPeerRow / ItemPeerAverages /
//                        ItemPeerComparisonResponse / Props
//    ./ItemPeerStates  — loading / error / no-data cards
//    ./PeerTableRow    — memo'd peer table row
//    ./card-compute    — pure pre-compute for the 4 analysis cards
//    ../item-peer-compute — computeEfficiencyScore + rankColor
//                        (REFACTOR-1-b, unchanged)
// ============================================================

import { memo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Card, CardContent, CardHeader, CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Target, Info } from 'lucide-react';
import { fmtNum, fmtIDR } from '@/lib/format';
import {
  EfficiencyScoreCard,
  GapAnalysisCard,
  ScatterPlotCard,
  RankingSummaryCard,
} from '@/components/dashboard/shared/peer-comparison-cards';
// REFACTOR-1-b — pure compute helpers moved out of this file.
import { computeEfficiencyScore } from '../item-peer-compute';
// SPLIT-B — pure move from this file (no behavior change).
import { ItemPeerLoadingState, ItemPeerErrorState, ItemPeerNoDataState } from './ItemPeerStates';
import { PeerTableRow } from './PeerTableRow';
import { buildPeerCardData } from './card-compute';
import type { ItemPeerComparisonProps, ItemPeerComparisonResponse } from './types';

// Re-export the locally-defined types so existing imports from
// './ItemPeerComparison' (folder path — e.g. the Tab barrel and
// ../item-peer-compute) keep resolving unchanged.
export type {
  ItemPeerRow,
  ItemPeerAverages,
  ItemPeerComparisonResponse,
  ItemPeerComparisonProps,
} from './types';

// ------------------------------------------------------------
//  Main component
// ------------------------------------------------------------

function ItemPeerComparisonImpl({
  itemName,
  month,
  week,
  targetOutletCode,
  area,
  kelompok,
  pic,
  onOutletClick,
}: ItemPeerComparisonProps) {
  const { data, isLoading, error, refetch } = useQuery<ItemPeerComparisonResponse>({
    queryKey: [
      'item-peer-comparison',
      itemName,
      month,
      week,
      targetOutletCode,
      area,
      kelompok,
      pic,
    ],
    queryFn: async () => {
      const p = new URLSearchParams({ item: itemName, month, week });
      if (targetOutletCode) p.set('outletCode', targetOutletCode);
      if (area && area !== 'all') p.set('area', area);
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      if (pic) p.set('pic', pic);
      const res = await fetch(`/api/item-peer-comparison?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<ItemPeerComparisonResponse>;
    },
    enabled: Boolean(itemName && month && week),
    staleTime: 5 * 60 * 1000, // 5 min
  });

  // ----------------------------------------------------------
  //  Loading / error / empty states
  // ----------------------------------------------------------

  if (isLoading) {
    return <ItemPeerLoadingState />;
  }

  if (error) {
    return <ItemPeerErrorState message={error.message} onRetry={() => { void refetch(); }} />;
  }

  // FIX (BUG-2-07): also check for 0 peers (target exists but no other
  // outlets in BOM ±50% range). Without this, cards render degenerate
  // values (EfficiencyScore=100, GapAnalysis vs 0, empty ScatterPlot,
  // #1/1 ranking).
  // FIX (BUG-2-10): improved empty state message — covers all "no data"
  // cases (item not found, no peers, kelompok/PIC mismatch), not just
  // the "no peer (BOM ±50%)" case.
  if (!data || !data.success || !data.target || data.peers.filter(p => !p.isTarget).length === 0) {
    return (
      <ItemPeerNoDataState
        itemName={itemName}
        month={month}
        week={week}
        noTarget={!data?.target}
      />
    );
  }

  const target = data.target;
  const peers = data.peers;
  const peerAvg = data.peerAverages;

  // ----------------------------------------------------------
  //  Pre-compute values for the 4 analysis cards
  //  (each caller computes its own — Item Tab vs Peer Tab have
  //  different metrics + formulas).
  // ----------------------------------------------------------

  // --- Efficiency Score ---
  const score = computeEfficiencyScore(target, peerAvg);

  // --- Gap rows / scatter points / ranking items (pure compute) ---
  const { gapRows, scatterPoints, rankItems, total } = buildPeerCardData(target, peers, peerAvg);

  // ----------------------------------------------------------
  //  Render
  // ----------------------------------------------------------

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5 flex-wrap">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
            <Target className="h-3.5 w-3.5" />
          </span>
          Item Peer Comparison
          <span className="text-muted-foreground text-xs font-normal">—</span>
          <span className="text-xs font-medium text-foreground">{itemName}</span>
          <span className="text-muted-foreground text-xs font-normal">·</span>
          <span className="text-xs text-muted-foreground">{month} {week}</span>
          {data.autoSelected && (
            <Badge variant="outline" className="text-[10px] font-normal text-amber-600 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30 h-5">
              Terpilih otomatis: outlet terburuk
            </Badge>
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Target: <span className="font-medium text-foreground">{target.outletName}</span> ({target.outletCode})
          {target.pic && <> · PIC: {target.pic}</>}
          {' · '}
          {/* FIX: peers[] includes target (server-side); show non-target count */}
          {peers.filter(p => !p.isTarget).length} peer outlet (QTY BOM ±50%)
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* 4 analysis cards — 2x2 grid on desktop
            FIX (UI-13): changed md:grid-cols-2 → sm:grid-cols-2 so cards
            pair up earlier on tablet / small desktop. */}
        <div className="grid gap-3 grid-cols-2">
          <EfficiencyScoreCard
            score={score}
            footnote="Komposit dari Dev/BOM (50%) + Nominal Deviasi (50%). Higher = better."
          />
          <GapAnalysisCard
            rows={gapRows}
            subtitle="Membandingkan target dengan peer TERBAIK (|nominal| terendah) + rata-rata."
            gridCols={1}
          />
          <ScatterPlotCard
            points={scatterPoints}
            title="QTY BOM vs |Nominal Deviasi|"
            subtitle="Setiap titik = 1 outlet. Target ditandai amber + ring. Merah = LOSS, hijau = SURPLUS."
            height={200}
            xLabel="QTY BOM"
            yLabel="|Nominal|"
            formatX={fmtNum}
            formatY={fmtIDR}
            colorMode="direction-based"
            legend={[
              { label: 'Target', color: 'bg-amber-500' },
              { label: 'LOSS', color: 'bg-red-600' },
              { label: 'SURPLUS', color: 'bg-emerald-500' },
            ]}
          />
          <RankingSummaryCard
            items={rankItems}
            subtitle={
              <>
                <span className="font-medium text-foreground">{target.outletName}</span> ranked di antara{' '}
                <span className="font-medium tabular-nums">{total}</span> peer (by |nominal deviasi|).
              </>
            }
            gridCols={2}
            itemLayout="vertical"
          />
        </div>

        {/* Peer table */}
        <div className="rounded-lg border overflow-hidden">
          <div className="max-h-[400px] overflow-auto">
            <Table className="min-w-[1100px]">
              <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                <TableRow className="border-b hover:bg-transparent">
                  {/* FIX (UI-21): h-9 → h-8 so header matches body row height better. */}
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">Outlet</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">Area</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">PIC</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">QTY BOM</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">QTY Deviasi</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Dev/BOM</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Nominal</TableHead>
                  <TableHead className="text-center text-xs font-semibold uppercase tracking-wider h-8">Dir</TableHead>
                  <TableHead className="text-center text-xs font-semibold uppercase tracking-wider h-8">Flags</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* Target row FIRST — highlighted */}
                <PeerTableRow
                  row={target}
                  peerAvg={peerAvg}
                  isTargetRow
                  onOutletClick={onOutletClick}
                />
                {/* Peer rows — exclude the target (already rendered above) */}
                {peers
                  .filter(p => !p.isTarget)
                  .map((p, i) => (
                    <PeerTableRow
                      key={`${p.outletCode}-${i}`}
                      row={p}
                      peerAvg={peerAvg}
                      onOutletClick={onOutletClick}
                    />
                  ))}
              </TableBody>
            </Table>
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
          <Info className="h-3 w-3 shrink-0 mt-0.5" />
          <span>
            Peer = outlet dengan QTY BOM ±50% untuk item ini. Klik baris untuk deep dive ke Resto Analysis.
          </span>
        </p>
      </CardContent>
    </Card>
  );
}

export const ItemPeerComparison = memo(ItemPeerComparisonImpl);
