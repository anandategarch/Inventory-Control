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
// ============================================================

import { memo, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Card, CardContent, CardHeader, CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Target, Info, Loader2, AlertCircle, Store } from 'lucide-react';
import { fmtIDR, fmtNum, fmtPctAbs } from '@/lib/format';
import {
  EfficiencyScoreCard,
  GapAnalysisCard,
  ScatterPlotCard,
  RankingSummaryCard,
  AnomalyFlags,
  computeAnomalyFlags,
} from '@/components/dashboard/shared/peer-comparison-cards';
import type { GapRow, RankItem, ScatterPoint } from '@/components/dashboard/shared/peer-comparison-cards';

// ------------------------------------------------------------
//  Types — defined LOCALLY (do NOT import from the backend API
//  route, which is being built in parallel by another agent).
//  TODO: share types with backend once API is stable.
// ------------------------------------------------------------

/** One row in the item peer comparison (target + each peer outlet). */
export interface ItemPeerRow {
  outletCode: string;
  outletName: string;
  area: string;
  pic: string | null;
  qtyBom: number;
  /** Signed — negative = LOSS, positive = SURPLUS. */
  qtyDeviasi: number;
  qtyWaste: number;
  qtySusut: number;
  qtyTrial: number;
  qtyLossSurplus: number;
  /** Signed nominal deviation (negative = LOSS). */
  nominalDeviasi: number;
  /** Absolute nominal deviation — for sorting + scatter Y axis. */
  absNominalDeviasi: number;
  /** Signed Dev/BOM ratio (negative = LOSS ratio). Null when BOM=0. */
  devBom: number | null;
  /** LOSS / SURPLUS / NEUTRAL. */
  direction: string;
  isTarget: boolean;
}

/** Per-peer average object — emitted by the API. */
export interface ItemPeerAverages {
  qtyBom: number;
  absQtyDeviasi: number;
  absNominalDeviasi: number;
  devBom: number;
  qtyWaste: number;
  qtySusut: number;
  qtyTrial: number;
  qtyLossSurplus: number;
  lossOutlets: number;
  surplusOutlets: number;
}

/** Response shape of `/api/item-peer-comparison`.
 *  FIX (BUG-2-09): added optional `cached` + `stale` fields that the backend
 *  adds conditionally (SWR pattern from withCacheAndDedup). */
export interface ItemPeerComparisonResponse {
  success: boolean;
  item: { itemName: string };
  period: { month: string; week: string };
  target: ItemPeerRow | null;
  peers: ItemPeerRow[];
  peerAverages: ItemPeerAverages;
  autoSelected: boolean;
  durationMs: number;
  /** Backend adds these when the response came from cache (SWR pattern). */
  cached?: boolean;
  stale?: boolean;
}

export interface ItemPeerComparisonProps {
  itemName: string;
  month: string;
  week: string;
  /** From FilterBar outletCode — if set, the API uses this outlet as
   *  the target. If omitted, the API auto-selects the worst outlet. */
  targetOutletCode?: string | null;
  area?: string | null;
  kelompok?: string | null;
  pic?: string | null;
  /** Called when the user clicks a peer outlet row. The parent
   *  typically wires this to `setFocusOutlet(code)` which switches
   *  to the Resto Analysis tab with the clicked outlet focused. */
  onOutletClick?: (_outletCode: string) => void;
}

// ------------------------------------------------------------
//  Efficiency score — composite 0-100 based on target vs peer avg.
//  Penalty: |devBom| above peer avg (50pts), |nominalDeviasi| above peer
//  avg (50pts). Higher = better.
//  FIX (BUG-2-03): use ABS values for comparison — devBom is SIGNED (neg=LOSS,
//  pos=SURPLUS); comparing signed values would penalize SURPLUS targets (wrong
//  direction — SURPLUS is good, not bad).
// ------------------------------------------------------------

function computeEfficiencyScore(target: ItemPeerRow, peerAvg: ItemPeerAverages): number {
  const safeDiv = (a: number, b: number) => (b > 0 ? a / b : 0);
  // FIX (BUG-2-03): compare ABSOLUTE magnitudes, not signed values.
  const targetAbsDevBom = target.devBom != null ? Math.abs(target.devBom) : 0;
  const peerAbsDevBom = Math.abs(peerAvg.devBom);
  const devBomPenalty = target.devBom != null
    ? Math.min(50, Math.max(0, safeDiv(targetAbsDevBom - peerAbsDevBom, peerAbsDevBom) * 25))
    : 0;
  const nominalPenalty = Math.min(
    50,
    Math.max(0, safeDiv(target.absNominalDeviasi - peerAvg.absNominalDeviasi, peerAvg.absNominalDeviasi) * 25),
  );
  const raw = 100 - (devBomPenalty + nominalPenalty);
  return Math.max(0, Math.min(100, raw));
}

// ------------------------------------------------------------
//  Rank color helper (matches Peer Tab style + the worst!=1 guard
//  for the Item Tab's small peer sets).
// ------------------------------------------------------------

function rankColor(r: number, t: number): string {
  if (r === 1) return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400';
  if (r === t && t > 1) return 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400';
  if (r <= t / 2) return 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400';
  return 'bg-muted text-muted-foreground';
}

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
  const { data, isLoading, error } = useQuery<ItemPeerComparisonResponse>({
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
    return (
      <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
          <span className="ml-2 text-xs text-muted-foreground">Memuat peer comparison...</span>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <AlertCircle className="h-6 w-6 text-red-500 mb-2" />
          <p className="text-sm text-red-600 dark:text-red-400">Gagal memuat peer comparison</p>
          <p className="text-xs text-muted-foreground mt-1">{error.message}</p>
        </CardContent>
      </Card>
    );
  }

  // FIX (BUG-2-07): also check for 0 peers (target exists but no other
  // outlets in BOM ±50% range). Without this, cards render degenerate
  // values (EfficiencyScore=100, GapAnalysis vs 0, empty ScatterPlot,
  // #1/1 ranking).
  // FIX (BUG-2-10): improved empty state message — covers all "no data"
  // cases (item not found, no peers, kelompok/PIC mismatch), not just
  // the "no peer (BOM ±50%)" case.
  if (!data || !data.success || !data.target || data.peers.filter(p => !p.isTarget).length === 0) {
    const reason = !data?.target
      ? `Item "${itemName}" tidak ditemukan di periode ${month} · ${week}.`
      : `Tidak ada peer outlet dengan QTY BOM ±50% di periode ${month} · ${week}.`;
    return (
      <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <Info className="h-6 w-6 text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">Tidak ada data peer comparison</p>
          <p className="text-xs text-muted-foreground/70 mt-1">{reason}</p>
          {!data?.target && (
            <p className="text-[11px] text-muted-foreground/60 mt-1">
              Kemungkinan: item tidak memiliki deviasi di periode ini, atau filter area/kelompok/PIC tidak cocok.
            </p>
          )}
        </CardContent>
      </Card>
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

  // --- Gap Analysis rows ---
  // Peer BEST = lowest absolute nominal deviation (closest to zero = best).
  // FIX (BUG-2-04): exclude target from peer BEST search — target is now
  // included in peers[] (server-side change), but "peer best" should be
  // the best NON-target outlet.
  const nonTargetPeers = peers.filter(p => !p.isTarget);
  const absValues = nonTargetPeers.map(p => p.absNominalDeviasi);
  const bestAbsNominal = absValues.length > 0 ? Math.min(...absValues) : 0;
  const bestPeer = nonTargetPeers.find(p => p.absNominalDeviasi === bestAbsNominal);

  const gapRows: GapRow[] = [
    {
      label: 'Nominal Deviasi',
      targetVal: target.absNominalDeviasi,
      bestVal: bestAbsNominal,
      avgVal: peerAvg.absNominalDeviasi,
      format: fmtIDR,
      higherBetter: false,
    },
    {
      label: 'QTY Deviasi',
      targetVal: Math.abs(target.qtyDeviasi),
      bestVal: bestPeer ? Math.abs(bestPeer.qtyDeviasi) : 0,
      avgVal: peerAvg.absQtyDeviasi,
      format: fmtNum,
      higherBetter: false,
    },
    {
      label: 'Dev/BOM',
      targetVal: target.devBom != null ? Math.abs(target.devBom) : 0,
      bestVal: bestPeer && bestPeer.devBom != null ? Math.abs(bestPeer.devBom) : 0,
      // FIX (BUG-2-04): use ABS peer avg — devBom is signed, but we compare
      // magnitudes (all targetVal/bestVal are already ABS).
      avgVal: Math.abs(peerAvg.devBom),
      format: fmtPctAbs,
      higherBetter: false,
    },
  ];

  // --- Scatter Plot points ---
  // FIX (PATTERN-2): add "vs peer avg" comparison to tooltip using TargetComparison.
  // Shows how each outlet's |Nominal| compares to peer average — context for
  // interpreting the scatter plot (above/below avg).
  const scatterPoints: ScatterPoint[] = peers.map(p => ({
    x: p.qtyBom,
    y: p.absNominalDeviasi,
    label: p.outletName,
    direction: p.direction,
    isTarget: p.outletCode === target.outletCode,
    tooltipLines: [
      { label: 'QTY BOM', value: fmtNum(p.qtyBom) },
      { label: '|Nominal|', value: fmtIDR(p.absNominalDeviasi) },
      // FIX (PATTERN-2): add vs peer avg comparison line.
      // downIsGood=true (higher |Nominal| = worse → up = bad).
      {
        label: 'vs peer avg',
        value: peerAvg.absNominalDeviasi > 0
          ? `${p.absNominalDeviasi > peerAvg.absNominalDeviasi ? '+' : ''}${((p.absNominalDeviasi - peerAvg.absNominalDeviasi) / peerAvg.absNominalDeviasi * 100).toFixed(1).replace('.', ',')}%`
          : '—',
      },
    ],
  }));

  // --- Ranking Summary items ---
  const total = peers.length;
  // Rank by |nominalDeviasi| ascending (lowest = best = rank 1).
  const sorted = [...peers].sort((a, b) => a.absNominalDeviasi - b.absNominalDeviasi);
  const rank = sorted.findIndex(p => p.outletCode === target.outletCode) + 1;
  const worst = rank === total && total > 1;
  const best = rank === 1;
  const percentile = total > 0 ? (rank / total) * 100 : 100;

  const rankItems: RankItem[] = [
    {
      label: 'Rank |Nominal|',
      badgeContent: `#${rank}/${total}`,
      badgeClass: rankColor(rank, total),
      // FIX (UI-18): standardized to 'outline' for cleaner look.
      variant: 'outline',
      star: best,
      warn: worst,
    },
    {
      label: 'Percentile',
      badgeContent: `p${percentile.toFixed(0)}`,
      variant: 'outline',
    },
    {
      label: 'LOSS outlets',
      badgeContent: String(peers.filter(p => p.direction === 'LOSS').length),
      badgeClass: 'text-red-700 dark:text-red-400',
      variant: 'outline',
    },
    {
      label: 'SURPLUS outlets',
      badgeContent: String(peers.filter(p => p.direction === 'SURPLUS').length),
      badgeClass: 'text-emerald-700 dark:text-emerald-400',
      variant: 'outline',
    },
  ];

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
              Auto-selected: worst outlet
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
        <div className="grid gap-3 sm:grid-cols-2">
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

// ------------------------------------------------------------
//  Peer table row — memo'd to avoid re-rendering all rows when
//  only one row's hover state changes.
// ------------------------------------------------------------

interface PeerTableRowProps {
  row: ItemPeerRow;
  peerAvg: ItemPeerAverages;
  isTargetRow?: boolean;
  onOutletClick?: (outletCode: string) => void;
}

const PeerTableRow = memo(function PeerTableRow({
  row,
  peerAvg,
  isTargetRow,
  onOutletClick,
}: PeerTableRowProps) {
  // FIX (BUG-2-11): use `direction` field (NET from SUM(nominalLossSurplus))
  // instead of `nominalDeviasi` sign (GROSS from SUM(nominalDeviasi)). These
  // two can differ when surplus items outweigh loss items in the same bucket
  // — the row color should match the direction badge, not the gross sign.
  const isLoss = row.direction === 'LOSS';
  const flags = useMemo(
    () => computeAnomalyFlags({
      devBom: row.devBom,
      peerAvgDevBom: peerAvg.devBom,
      absNominal: row.absNominalDeviasi,
      peerAvgNominal: peerAvg.absNominalDeviasi,
      direction: row.direction,
      signedNominal: row.nominalDeviasi,
    }),
    [row, peerAvg],
  );
  return (
    <TableRow
      className={`transition-colors border-b ${
        onOutletClick ? 'cursor-pointer' : ''
      } ${
        isTargetRow
          ? 'bg-amber-50 dark:bg-amber-950/20 hover:bg-amber-100 dark:hover:bg-amber-950/30 border-l-4 border-l-amber-500'
          : 'hover:bg-muted/40'
      }`}
      onClick={onOutletClick ? () => onOutletClick(row.outletCode) : undefined}
    >
      <TableCell className="text-xs px-3 py-2">
        <div className="flex items-center gap-1.5">
          {onOutletClick && <Store className="h-3 w-3 text-muted-foreground shrink-0" />}
          <div className="min-w-0">
            {/* FIX (UI-06): added max-w-[180px] so truncate has an explicit
                max-width — without it, truncate never kicks in on flex children. */}
            <div className="font-medium leading-tight truncate max-w-[180px]" title={row.outletName}>{row.outletName}</div>
            <div className="text-[10px] text-muted-foreground">{row.outletCode}</div>
          </div>
        </div>
      </TableCell>
      <TableCell className="text-xs px-3 py-2 text-muted-foreground">{row.area}</TableCell>
      <TableCell className="text-xs px-3 py-2 text-muted-foreground">{row.pic || '—'}</TableCell>
      <TableCell className="text-xs px-3 py-2 text-right tabular-nums">{fmtNum(row.qtyBom)}</TableCell>
      <TableCell className={`text-xs px-3 py-2 text-right tabular-nums ${isLoss ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
        {fmtNum(row.qtyDeviasi)}
      </TableCell>
      <TableCell className={`text-xs px-3 py-2 text-right tabular-nums ${isLoss ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
        {row.devBom != null ? fmtPctAbs(row.devBom) : '—'}
      </TableCell>
      <TableCell className={`text-xs px-3 py-2 text-right tabular-nums font-medium ${isLoss ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
        {fmtIDR(row.nominalDeviasi)}
      </TableCell>
      <TableCell className="text-xs px-3 py-2 text-center">
        <Badge
          variant="outline"
          className={`text-[10px] h-5 px-1.5 font-medium ${
            row.direction === 'LOSS'
              ? 'text-red-700 dark:text-red-400 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30'
              : row.direction === 'SURPLUS'
                ? 'text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30'
                : 'text-muted-foreground'
          }`}
        >
          {row.direction}
        </Badge>
      </TableCell>
      <TableCell className="text-xs px-3 py-2 text-center">
        <AnomalyFlags flags={flags} textSize="10px" />
      </TableCell>
    </TableRow>
  );
});

export const ItemPeerComparison = memo(ItemPeerComparisonImpl);
