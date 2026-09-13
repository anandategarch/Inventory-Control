'use client';

// ============================================================
//  FlipDrillPanel — flip pair per-outlet drill-down.
//  --------------------------------------------------------
//  REFACTOR-1-b: pure move from FlipRanking.tsx (no behavior
//  change). Renders BELOW the ranking row when expanded.
//  Fetches per-outlet breakdown for both P1 + P2 from
//  /api/flip-ranking/drilldown and renders two outlet tables
//  (a single unified table — 1 row per outlet with P1 + P2 +
//  delta + net + flip%).
// ============================================================

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2, Shuffle } from 'lucide-react';
import { fmtNum, fmtDecimal } from '@/lib/format';
// H-11 / #4c: per-outlet flip formulas come from the SINGLE shared module
// (same one the backend flip-ranking query + flipHelpers use).
import { isFlipPair, flipDisparityPct } from '@/lib/flip-metrics';
import { categoryBadge, monthPrefix, type FlipPair } from './flip-badges';

// Local types matching /api/flip-ranking/drilldown response.
interface FlipDrillOutlet {
  outletCode: string;
  outletName: string;
  area: string;
  pic: string | null;
  qtyDeviasiSigned: number;
  nominalDeviasi: number;
  absNominalDeviasi: number;
  direction: string;
}

interface FlipDrillPeriod {
  monthLabel: string;
  outlets: FlipDrillOutlet[];
}

interface FlipDrilldownResponse {
  success: boolean;
  item: { itemName: string };
  weekLabel: string;
  period1: FlipDrillPeriod;
  period2: FlipDrillPeriod;
  durationMs?: number;
  cached?: boolean;
  stale?: boolean;
  error?: string;
}

export interface FlipDrillPanelProps {
  item: string;
  flip: FlipPair;
  area: string | null;
  kelompok: string | null;
  outletCode: string | null;
  pic: string | null;
}

export function FlipDrillPanel({ item, flip, area, kelompok, outletCode, pic }: FlipDrillPanelProps) {
  // Pull the month prefix from each short label. The drill-down API uses
  // ILIKE prefix matching so "Jul" matches "Juli 2026".
  const month1 = monthPrefix(flip.period1Label);
  const month2 = monthPrefix(flip.period2Label);

  const { data, isLoading, error } = useQuery<FlipDrilldownResponse>({
    queryKey: ['flip-drilldown', item, flip.weekLabel, month1, month2, area, kelompok, outletCode, pic],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('item', item);
      p.set('week', flip.weekLabel);
      p.set('month1', month1);
      p.set('month2', month2);
      if (area && area !== 'all') p.set('area', area);
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      if (outletCode) p.set('outlet', outletCode);
      if (pic) p.set('pic', pic);
      const res = await fetch(`/api/flip-ranking/drilldown?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: true, // parent only renders this component when expanded
    staleTime: 5 * 60 * 1000, // 5 min — matches API cache
  });

  // FIX (USER-REQ): compute per-outlet flip analysis + sort by disparityPct ASC.
  // Only outlets present in BOTH periods can flip. We compute flip per outlet:
  //   isFlip = sign(P1) !== sign(P2) AND both non-zero
  //   disparity = |P1 + P2| / MAX(|P1|, |P2|)   (0 = perfectly balanced)
  // Then:
  //   - Filter: only show outlets where isFlip === true (hide konsisten outlets)
  //   - Sort: by disparityPct ASC (most balanced flip first — 0% at top)
  // FIX (IDE-3): unified table — each row = 1 outlet with P1 + P2 + delta + net + flip%.
  interface UnifiedFlipRow {
    outletCode: string;
    outletName: string;
    area: string;
    pic: string | null;
    p1Qty: number;
    p2Qty: number;
    delta: number;     // P2 - P1 (magnitude of change)
    net: number;       // P1 + P2 (balance — 0 = perfectly balanced)
    disparityPct: number;
    p1Direction: string;
    p2Direction: string;
  }
  const { unifiedRows, totals } = useMemo(() => {
    if (!data) return { unifiedRows: [] as UnifiedFlipRow[], totals: { p1: 0, p2: 0, net: 0 } };
    const p1Outlets = new Map(data.period1.outlets.map((o) => [o.outletCode, o]));
    const p2Outlets = new Map(data.period2.outlets.map((o) => [o.outletCode, o]));
    const rows: UnifiedFlipRow[] = [];
    for (const [code, o1] of p1Outlets) {
      const o2 = p2Outlets.get(code);
      if (!o2) continue; // outlet only in P1 — can't flip
      const v1 = o1.qtyDeviasiSigned;
      const v2 = o2.qtyDeviasiSigned;
      if (!isFlipPair(v1, v2)) continue; // USER-REQ: hide konsisten outlets
      const net = v1 + v2;
      const delta = v2 - v1;
      const disparityPct = flipDisparityPct(v1, v2);
      rows.push({
        outletCode: code,
        outletName: o1.outletName,
        area: o1.area,
        pic: o1.pic,
        p1Qty: v1,
        p2Qty: v2,
        delta,
        net,
        disparityPct,
        p1Direction: o1.direction,
        p2Direction: o2.direction,
      });
    }
    // Sort ASC by disparityPct (0% = most balanced at top)
    rows.sort((a, b) => a.disparityPct - b.disparityPct);
    // Totals from ALL outlets (including konsisten) — true period aggregate.
    const p1Total = data.period1.outlets.reduce((s, o) => s + o.qtyDeviasiSigned, 0);
    const p2Total = data.period2.outlets.reduce((s, o) => s + o.qtyDeviasiSigned, 0);
    return { unifiedRows: rows, totals: { p1: p1Total, p2: p2Total, net: p1Total + p2Total } };
  }, [data]);

  // Category display name for the subline (e.g. "Dominan").
  const categoryDisplay = flip.category.charAt(0).toUpperCase() + flip.category.slice(1);
  const cb = categoryBadge(flip.category);

  return (
    <div className="bg-purple-50/40 dark:bg-purple-950/10 border-t border-purple-200/60 dark:border-purple-900/40 p-3 space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold text-purple-700 dark:text-purple-400 flex items-center gap-1.5">
          <Shuffle className="h-3.5 w-3.5" />
          Flip Drill-down: <span className="text-foreground">{item}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-foreground tabular-nums">{flip.weekLabel}</span>
        </span>
        {data?.cached && (
          <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground h-5">
            cache
          </Badge>
        )}
        {data?.stale && (
          <Badge variant="outline" className="text-[10px] font-normal text-amber-600 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30 h-5">
            stale
          </Badge>
        )}
      </div>
      {/* Subline: P1 (signed) → P2 (signed) · Disparity X% (category) */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="tabular-nums font-medium">
          <span className="text-muted-foreground">{flip.period1Label}</span>{' '}
          <span className={flip.qtyP1 < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}>
            ({fmtNum(flip.qtyP1, '', false)})
          </span>
        </span>
        <span className="text-muted-foreground">→</span>
        <span className="tabular-nums font-medium">
          <span className="text-muted-foreground">{flip.period2Label}</span>{' '}
          <span className={flip.qtyP2 < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}>
            ({fmtNum(flip.qtyP2, '', false)})
          </span>
        </span>
        <span className="text-muted-foreground">·</span>
        <span className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium ${cb.className}`}>
          <span aria-hidden>{cb.emoji}</span>
          Disparity {fmtDecimal(flip.disparityPct, 1)}% ({categoryDisplay})
        </span>
      </div>

      {/* Body: loading / error / unified flip table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="h-4 w-4 animate-spin text-purple-500" />
          <span className="ml-2 text-xs text-muted-foreground">Memuat per-outlet breakdown...</span>
        </div>
      ) : error ? (
        <div className="text-center text-red-600 dark:text-red-400 text-xs py-4">
          Gagal memuat drill-down: {error.message}
        </div>
      ) : !data ? null : unifiedRows.length === 0 ? (
        <div className="text-center text-muted-foreground text-xs py-4">
          <Shuffle className="h-5 w-5 text-muted-foreground/40 mx-auto mb-1.5" />
          Tidak ada outlet yang flip antara {flip.period1Label} → {flip.period2Label}.
          <p className="text-[10px] text-muted-foreground/70 mt-1">
            Semua outlet konsisten arah (tidak flip) atau hanya muncul di 1 periode.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Sort info banner */}
          <div className="text-[10px] text-muted-foreground flex items-center gap-1.5 px-1 flex-wrap">
            <span aria-hidden>🔀</span>
            <span>
              Diurutkan by <span className="font-medium text-foreground">Flip Disparity %</span> ascending
              (terkecil = paling balanced di atas).
              {' '}
              <span className="text-purple-600 dark:text-purple-400 font-medium tabular-nums">
                {unifiedRows.length} outlet flip
              </span>
              {' '}dari{' '}
              <span className="tabular-nums">{data.period1.outlets.length}</span> outlet P1 /{' '}
              <span className="tabular-nums">{data.period2.outlets.length}</span> outlet P2.
            </span>
          </div>
          {/* FIX (IDE-3): unified table — 1 row per outlet with P1 + P2 + delta + net + flip% */}
          <div className="rounded-md border border-purple-200/60 dark:border-purple-900/40 bg-background/80 dark:bg-zinc-950/40 overflow-hidden">
            {/* Period header */}
            <div className="px-2.5 py-1.5 border-b border-purple-200/60 dark:border-purple-900/40 bg-purple-50/40 dark:bg-purple-950/20 flex items-center justify-between gap-2 flex-wrap">
              <span className="text-xs font-semibold text-purple-700 dark:text-purple-400 tabular-nums">
                {flip.period1Label} → {flip.period2Label} · {flip.weekLabel}
              </span>
              <span className="text-[10px] text-muted-foreground tabular-nums">
                ({unifiedRows.length} outlet flip)
              </span>
            </div>
            {/* Totals */}
            <div className="px-2.5 py-1 text-[10px] text-muted-foreground border-b border-purple-200/40 dark:border-purple-900/30 flex items-center gap-3 flex-wrap tabular-nums">
              <span>
                Total P1:{' '}
                <span className={totals.p1 < 0 ? 'text-red-600 dark:text-red-400 font-medium' : 'text-emerald-600 dark:text-emerald-400 font-medium'}>
                  {fmtNum(totals.p1, '', false)}
                </span>
              </span>
              <span>
                Total P2:{' '}
                <span className={totals.p2 < 0 ? 'text-red-600 dark:text-red-400 font-medium' : 'text-emerald-600 dark:text-emerald-400 font-medium'}>
                  {fmtNum(totals.p2, '', false)}
                </span>
              </span>
              <span>
                Net:{' '}
                <span className={totals.net < 0 ? 'text-red-600 dark:text-red-400 font-medium' : 'text-emerald-600 dark:text-emerald-400 font-medium'}>
                  {fmtNum(totals.net, '', false)}
                </span>
              </span>
            </div>
            {/* Table */}
            <div className="max-h-[280px] overflow-auto">
              <Table className="min-w-[640px]">
                <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                  <TableRow className="border-b hover:bg-transparent">
                    <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8">Outlet</TableHead>
                    <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8">Area</TableHead>
                    <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-8">PIC</TableHead>
                    <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-8">P1 QTY</TableHead>
                    <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-8">P2 QTY</TableHead>
                    <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-8">Δ QTY</TableHead>
                    <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-8">Net</TableHead>
                    <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-8">🔀 Flip %</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {unifiedRows.map((r, i) => {
                    const p1Loss = r.p1Qty < 0;
                    const p2Loss = r.p2Qty < 0;
                    const deltaLoss = r.delta < 0;
                    const netLoss = r.net < 0;
                    // Flip % badge color
                    const flipPct = r.disparityPct;
                    const flipBadgeClass =
                      flipPct < 10 ? 'text-emerald-700 bg-emerald-100 border-emerald-300 dark:bg-emerald-950/60 dark:border-emerald-800 dark:text-emerald-400' :
                      flipPct < 40 ? 'text-amber-700 bg-amber-100 border-amber-300 dark:bg-amber-950/60 dark:border-amber-800 dark:text-amber-400' :
                      'text-red-700 bg-red-100 border-red-300 dark:bg-red-950/60 dark:border-red-800 dark:text-red-400';
                    return (
                      <TableRow
                        key={`${r.outletCode}-${i}`}
                        className={i % 2 === 1 ? 'bg-muted/20 hover:bg-muted/40' : 'hover:bg-muted/40'}
                      >
                        <TableCell className="py-1.5">
                          <div className="flex flex-col leading-tight">
                            <span className="text-[11px] font-medium tabular-nums">{r.outletCode}</span>
                            <span className="text-[11px] text-muted-foreground truncate max-w-[120px]" title={r.outletName}>
                              {r.outletName}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-[11px] text-muted-foreground py-1.5 tabular-nums">{r.area || '—'}</TableCell>
                        <TableCell className="text-[11px] text-muted-foreground py-1.5">{r.pic || '—'}</TableCell>
                        {/* P1 QTY — signed, color-coded */}
                        <TableCell
                          className={`text-right text-[11px] py-1.5 tabular-nums font-medium ${
                            p1Loss ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'
                          }`}
                        >
                          {fmtNum(r.p1Qty, '', false)}
                        </TableCell>
                        {/* P2 QTY — signed, color-coded */}
                        <TableCell
                          className={`text-right text-[11px] py-1.5 tabular-nums font-medium ${
                            p2Loss ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'
                          }`}
                        >
                          {fmtNum(r.p2Qty, '', false)}
                        </TableCell>
                        {/* Δ QTY = P2 - P1 (magnitude of change, signed) */}
                        <TableCell
                          className={`text-right text-[11px] py-1.5 tabular-nums ${
                            deltaLoss ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'
                          }`}
                        >
                          {r.delta >= 0 ? '+' : ''}{fmtNum(r.delta, '', false)}
                        </TableCell>
                        {/* Net = P1 + P2 (balance — 0 = perfectly balanced) */}
                        <TableCell
                          className={`text-right text-[11px] py-1.5 tabular-nums font-medium ${
                            netLoss ? 'text-red-600 dark:text-red-400' : r.net > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'
                          }`}
                        >
                          {fmtNum(r.net, '', false)}
                        </TableCell>
                        {/* Flip % — sort key (ASC = most balanced at top) */}
                        <TableCell className="text-right py-1.5">
                          <Badge variant="outline" className={`text-[9px] h-4 px-1 font-medium tabular-nums ${flipBadgeClass}`}>
                            {fmtDecimal(flipPct, 1)}%
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
