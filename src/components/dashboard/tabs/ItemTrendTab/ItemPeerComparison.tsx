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
//  Patterns reused from peer-comparison/*:
//    - EfficiencyScoreCard scoring formula (deviation-based penalty)
//    - GapAnalysisCard layout (target vs best vs avg)
//    - ScatterPlotCard dot rendering (Cell + per-point fill)
//    - RankingSummaryCard rank computation
//    - AnomalyFlags per-row badge composition
// ============================================================

import { memo, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Card, CardContent, CardHeader, CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, ResponsiveContainer, Cell,
} from 'recharts';
import { Gauge, Target, Sparkles, Award, Info, Loader2, AlertCircle, Store } from 'lucide-react';
import { fmtIDR, fmtNum, fmtPctAbs } from '@/lib/format';

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

/** Response shape of `/api/item-peer-comparison`. */
export interface ItemPeerComparisonResponse {
  success: boolean;
  item: { itemName: string };
  period: { month: string; week: string };
  target: ItemPeerRow | null;
  peers: ItemPeerRow[];
  peerAverages: ItemPeerAverages;
  autoSelected: boolean;
  durationMs: number;
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
//  Small inline sub-components (kept in this file — not large
//  enough to warrant a separate file, and ItemPeerComparison
//  is the only consumer).
// ------------------------------------------------------------

/** Efficiency score — composite 0-100 based on target vs peer avg.
 *  Penalty: |devBom| above peer avg (50pts), |nominalDeviasi| above peer
 *  avg (50pts). Higher = better.
 *  FIX (BUG-2-03): use ABS values for comparison — devBom is SIGNED (neg=LOSS,
 *  pos=SURPLUS); comparing signed values would penalize SURPLUS targets (wrong
 *  direction — SURPLUS is good, not bad). */
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

function EfficiencyScoreCard({ target, peerAvg }: { target: ItemPeerRow; peerAvg: ItemPeerAverages }) {
  const score = useMemo(() => computeEfficiencyScore(target, peerAvg), [target, peerAvg]);
  const color = score > 70 ? 'bg-emerald-500' : score >= 50 ? 'bg-amber-500' : 'bg-red-500';
  const textColor = score > 70 ? 'text-emerald-600' : score >= 50 ? 'text-amber-600' : 'text-red-600';
  const label = score > 70 ? 'Di atas peer average' : score >= 50 ? 'Sekitar peer average' : 'Di bawah peer average';

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 shrink-0">
            <Gauge className="h-3.5 w-3.5" />
          </span>
          Efficiency Score
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-end justify-between">
          <div>
            <span className={`text-3xl font-bold tabular-nums ${textColor}`}>{score.toFixed(0)}</span>
            <span className="text-sm text-muted-foreground ml-0.5">/100</span>
          </div>
          <div className="text-right text-xs">
            <div className="text-muted-foreground tabular-nums">Peer Avg: 100/100 (baseline)</div>
            <div className={`font-medium ${textColor}`}>{label}</div>
          </div>
        </div>
        <div
          className="relative h-3 w-full rounded-full bg-muted overflow-hidden"
          role="progressbar"
          aria-valuenow={score}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className={`h-full ${color} transition-all duration-500`} style={{ width: `${score}%` }} />
          <div className="absolute top-0 h-full w-0.5 bg-foreground/40" style={{ right: '0%' }} title="Peer avg baseline (100)" />
        </div>
        <p className="text-xs text-muted-foreground">
          Komposit dari Dev/BOM (50%) + Nominal Deviasi (50%). Higher = better.
        </p>
      </CardContent>
    </Card>
  );
}

/** Gap Analysis — target vs peer avg vs peer BEST (lowest |nominalDeviasi|). */
function GapAnalysisCard({ target, peers, peerAvg }: {
  target: ItemPeerRow;
  peers: ItemPeerRow[];
  peerAvg: ItemPeerAverages;
}) {
  // Peer BEST = lowest absolute nominal deviation (closest to zero = best).
  // FIX (BUG-2-04): exclude target from peer BEST search — target is now
  // included in peers[] (server-side change), but "peer best" should be
  // the best NON-target outlet.
  const nonTargetPeers = peers.filter(p => !p.isTarget);
  const absValues = nonTargetPeers.map(p => p.absNominalDeviasi);
  const bestAbsNominal = absValues.length > 0 ? Math.min(...absValues) : 0;
  const bestPeer = nonTargetPeers.find(p => p.absNominalDeviasi === bestAbsNominal);

  const rows: Array<{ label: string; targetVal: number; bestVal: number; avgVal: number; format: (_v: number) => string; higherBetter: boolean }> = [
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

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 shrink-0">
            <Target className="h-3.5 w-3.5" />
          </span>
          Gap Analysis (vs Peer Best)
        </CardTitle>
        <p className="text-[11px] text-muted-foreground ml-9">
          Membandingkan target dengan peer TERBAIK (|nominal| terendah) + rata-rata.
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2">
          {rows.map(r => {
            const gap = r.targetVal - r.bestVal;
            const isWorse = r.higherBetter ? gap < 0 : gap > 0;
            return (
              <div key={r.label} className="rounded-lg border bg-muted/20 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-muted-foreground">{r.label}</span>
                  <Badge
                    variant="outline"
                    className={`text-[11px] h-4 font-medium ${
                      isWorse
                        ? 'text-red-700 dark:text-red-400 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30'
                        : 'text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30'
                    }`}
                  >
                    {isWorse ? 'di bawah best' : 'di atas best'}
                  </Badge>
                </div>
                <div className="mt-1 text-xs font-mono tabular-nums">
                  <span className="font-semibold">{r.format(r.targetVal)}</span>
                  <span className="text-muted-foreground"> vs best </span>
                  <span className="text-emerald-600 dark:text-emerald-400">{r.format(r.bestVal)}</span>
                  <span className="text-muted-foreground"> · avg </span>
                  <span className="text-muted-foreground">{r.format(r.avgVal)}</span>
                </div>
                <div className={`text-[11px] font-semibold tabular-nums ${isWorse ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                  {gap >= 0 ? '+' : ''}{r.format(gap)}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

interface ScatterPoint {
  qtyBom: number;
  absNominalDeviasi: number;
  outletName: string;
  outletCode: string;
  direction: string;
  isTarget: boolean;
}

/** Scatter Plot — X=qtyBom, Y=absNominalDeviasi. Dot color by direction.
 *  Target outlet highlighted (larger dot + amber ring). */
function ScatterPlotCard({ peers, targetCode }: { peers: ItemPeerRow[]; targetCode?: string | null }) {
  const data: ScatterPoint[] = peers.map(p => ({
    qtyBom: p.qtyBom,
    absNominalDeviasi: p.absNominalDeviasi,
    outletName: p.outletName,
    outletCode: p.outletCode,
    direction: p.direction,
    isTarget: p.outletCode === targetCode,
  }));

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <Sparkles className="h-3.5 w-3.5" />
          </span>
          QTY BOM vs |Nominal Deviasi|
        </CardTitle>
        <p className="text-[11px] text-muted-foreground ml-9">
          Setiap titik = 1 outlet. Target ditandai amber + ring. Merah = LOSS, hijau = SURPLUS.
        </p>
      </CardHeader>
      <CardContent>
        <div className="h-[200px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 10, right: 16, bottom: 24, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" className="opacity-60" />
              <XAxis
                type="number"
                dataKey="qtyBom"
                name="QTY BOM"
                tickFormatter={(v: number) => fmtNum(v)}
                tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                stroke="var(--border)"
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                type="number"
                dataKey="absNominalDeviasi"
                name="|Nominal|"
                tickFormatter={(v: number) => fmtIDR(v)}
                tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                stroke="var(--border)"
                tickLine={false}
                axisLine={false}
                width={48}
              />
              <RTooltip
                cursor={{ strokeDasharray: '3 3' }}
                content={({ active, payload }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  const d = payload[0].payload as ScatterPoint;
                  return (
                    <div className="rounded-lg border bg-popover p-2.5 text-[11px] shadow-lg">
                      <div className="font-semibold border-b pb-1 mb-1">{d.outletName}</div>
                      <div className="text-muted-foreground tabular-nums">QTY BOM: {fmtNum(d.qtyBom)}</div>
                      <div className="text-muted-foreground tabular-nums">|Nominal|: {fmtIDR(d.absNominalDeviasi)}</div>
                      <div className="text-muted-foreground">Direction: {d.direction}</div>
                      {d.isTarget && <div className="text-amber-600 dark:text-amber-400 font-semibold mt-1">TARGET</div>}
                    </div>
                  );
                }}
              />
              <Scatter data={data}>
                {data.map((entry, i) => {
                  // Direction-based fill: red = LOSS, green = SURPLUS, gray = NEUTRAL.
                  // Target gets amber ring (handled by separate Scatter? Simpler: larger r + amber fill override).
                  let fill = '#71717a'; // gray-500 (NEUTRAL)
                  if (entry.direction === 'LOSS') fill = '#dc2626'; // red-600
                  else if (entry.direction === 'SURPLUS') fill = '#10b981'; // emerald-500
                  if (entry.isTarget) fill = '#f59e0b'; // amber-500 — target highlighted
                  return (
                    <Cell
                      key={`cell-${i}`}
                      fill={fill}
                      stroke={entry.isTarget ? '#fbbf24' : 'var(--background)'}
                      strokeWidth={entry.isTarget ? 2 : 1}
                      r={entry.isTarget ? 7 : 4}
                    />
                  );
                })}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </div>
        <div className="flex items-center justify-center gap-4 text-xs text-muted-foreground mt-2 flex-wrap">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-500" /> Target
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-red-600" /> LOSS
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500" /> SURPLUS
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

/** Ranking Summary — target's rank by |nominalDeviasi| among peers. */
function RankingSummaryCard({ target, peers }: { target: ItemPeerRow; peers: ItemPeerRow[] }) {
  const total = peers.length;
  // Rank by |nominalDeviasi| ascending (lowest = best = rank 1).
  const sorted = useMemo(
    () => [...peers].sort((a, b) => a.absNominalDeviasi - b.absNominalDeviasi),
    [peers],
  );
  const rank = sorted.findIndex(p => p.outletCode === target.outletCode) + 1;
  const worst = rank === total && total > 1;
  const best = rank === 1;
  const percentile = total > 0 ? (rank / total) * 100 : 100;

  const rankColor = (r: number, t: number) => {
    if (r === 1) return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400';
    if (r === t && t > 1) return 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400';
    if (r <= t / 2) return 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400';
    return 'bg-muted text-muted-foreground';
  };

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
            <Award className="h-3.5 w-3.5" />
          </span>
          Ranking Summary
        </CardTitle>
        <p className="text-[11px] text-muted-foreground ml-9">
          <span className="font-medium text-foreground">{target.outletName}</span> ranked di antara{' '}
          <span className="font-medium tabular-nums">{total}</span> peer (by |nominal deviasi|).
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col items-center justify-between rounded-lg border bg-muted/20 px-2.5 py-2">
            <span className="text-[11px] text-muted-foreground">Rank |Nominal|</span>
            <Badge className={`text-xs h-5 font-medium tabular-nums ${rankColor(rank, total)}`} variant="secondary">
              #{rank}/{total}
              {best && ' ★'}
              {worst && ' ⚠'}
            </Badge>
          </div>
          <div className="flex flex-col items-center justify-between rounded-lg border bg-muted/20 px-2.5 py-2">
            <span className="text-[11px] text-muted-foreground">Percentile</span>
            <Badge className="text-xs h-5 font-medium tabular-nums" variant="outline">
              p{percentile.toFixed(0)}
            </Badge>
          </div>
          <div className="flex flex-col items-center justify-between rounded-lg border bg-muted/20 px-2.5 py-2">
            <span className="text-[11px] text-muted-foreground">LOSS outlets</span>
            <Badge className="text-xs h-5 font-medium tabular-nums text-red-700 dark:text-red-400" variant="outline">
              {peers.filter(p => p.direction === 'LOSS').length}
            </Badge>
          </div>
          <div className="flex flex-col items-center justify-between rounded-lg border bg-muted/20 px-2.5 py-2">
            <span className="text-[11px] text-muted-foreground">SURPLUS outlets</span>
            <Badge className="text-xs h-5 font-medium tabular-nums text-emerald-700 dark:text-emerald-400" variant="outline">
              {peers.filter(p => p.direction === 'SURPLUS').length}
            </Badge>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Anomaly flag per row — 🔴 Dev/BOM tinggi / 🔴 LOSS tinggi / 🟢 Normal.
 *  Pattern reused from peer-comparison/anomaly-flags.tsx. */
function anomalyFlags(row: ItemPeerRow, peerAvg: ItemPeerAverages): Array<{ emoji: string; text: string; color: string }> {
  const flags: Array<{ emoji: string; text: string; color: string }> = [];
  const checkRatio = (targetVal: number, avg: number) => (avg > 0 ? targetVal / avg : 0);

  // FIX (BUG-2-05/06): use ABS(peerAvg.devBom) for threshold — devBom is
  // SIGNED (neg=LOSS, pos=SURPLUS). Using signed peerAvg would suppress
  // flags when peers are in LOSS (peerAvg < 0 → checkRatio returns 0).
  const peerAbsDevBom = Math.abs(peerAvg.devBom);

  // 🔴 Dev/BOM tinggi — abs dev/bom > 1.5× peer avg.
  if (row.devBom != null && checkRatio(Math.abs(row.devBom), peerAbsDevBom) > 1.5) {
    flags.push({ emoji: '🔴', text: 'Dev/BOM tinggi', color: 'text-red-600 bg-red-50 dark:bg-red-950/30' });
  }
  // 🔴 LOSS tinggi — nominal < 0 AND abs > 1.5× peer avg.
  if (row.nominalDeviasi < 0 && checkRatio(row.absNominalDeviasi, peerAvg.absNominalDeviasi) > 1.5) {
    flags.push({ emoji: '🔴', text: 'LOSS tinggi', color: 'text-red-600 bg-red-50 dark:bg-red-950/30' });
  }
  // 🟢 Normal — no flags + within ±20% of peer avg on both metrics.
  if (flags.length === 0) {
    // FIX (BUG-2-05): use ABS(peerAvg.devBom) for the ±20% threshold.
    const devBomNear = row.devBom == null || Math.abs(Math.abs(row.devBom) - peerAbsDevBom) <= peerAbsDevBom * 0.2;
    const nominalNear = Math.abs(row.absNominalDeviasi - peerAvg.absNominalDeviasi) <= peerAvg.absNominalDeviasi * 0.2;
    if (devBomNear && nominalNear) {
      flags.push({ emoji: '🟢', text: 'Normal', color: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30' });
    }
  }

  return flags;
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
  if (!data || !data.success || !data.target || data.peers.filter(p => !p.isTarget).length === 0) {
    return (
      <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <Info className="h-6 w-6 text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">Tidak ada data peer comparison</p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            Item <span className="font-medium">{itemName}</span> di {month} · {week} tidak memiliki peer (BOM ±50%).
          </p>
        </CardContent>
      </Card>
    );
  }

  const target = data.target;
  const peers = data.peers;
  const peerAvg = data.peerAverages;

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
        {/* 4 analysis cards — 2x2 grid on desktop */}
        <div className="grid gap-3 md:grid-cols-2">
          <EfficiencyScoreCard target={target} peerAvg={peerAvg} />
          <GapAnalysisCard target={target} peers={peers} peerAvg={peerAvg} />
          <ScatterPlotCard peers={peers} targetCode={target.outletCode} />
          <RankingSummaryCard target={target} peers={peers} />
        </div>

        {/* Peer table */}
        <div className="rounded-lg border overflow-hidden">
          <div className="max-h-[400px] overflow-auto">
            <Table className="min-w-[1100px]">
              <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                <TableRow className="border-b hover:bg-transparent">
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-9">Outlet</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-9">Area</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-9">PIC</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-9">QTY BOM</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-9">QTY Deviasi</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-9">Dev/BOM</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-9">Nominal</TableHead>
                  <TableHead className="text-center text-xs font-semibold uppercase tracking-wider h-9">Dir</TableHead>
                  <TableHead className="text-center text-xs font-semibold uppercase tracking-wider h-9">Flags</TableHead>
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
  const isLoss = row.nominalDeviasi < 0;
  const flags = anomalyFlags(row, peerAvg);
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
            <div className="font-medium leading-tight truncate" title={row.outletName}>{row.outletName}</div>
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
        <div className="flex flex-col items-center gap-0.5">
          {flags.length === 0 ? (
            <span className="text-muted-foreground text-xs">—</span>
          ) : (
            flags.map((f, i) => (
              <span
                key={i}
                className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium ${f.color}`}
                title={f.text}
              >
                <span aria-hidden>{f.emoji}</span>
                <span className="sr-only">{f.text}</span>
              </span>
            ))
          )}
        </div>
      </TableCell>
    </TableRow>
  );
});

export const ItemPeerComparison = memo(ItemPeerComparisonImpl);
