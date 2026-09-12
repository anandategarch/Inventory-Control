'use client';

// ============================================================
//  ItemDetailModal — Historical timeline + Benchmark per bahan
//  Shown when user clicks an item row in RestoAnalysis or
//  MenuAnalysis. Uses /api/item-history.
//  (split from RestoAnalysis.tsx — Phase 3)
// ============================================================

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2, AlertTriangle } from 'lucide-react';
import type { ItemHistoryResponse, ItemHistoryTimelineRow } from './types';
import {
  fmtIDR, fmtNum, fmtPct,
  fmtGrowth, growthColor, priorityColor, directionColor,
  Row, SummaryCard,
} from './helpers';
import { fmtDecimal } from '@/lib/format';

export function ItemDetailModal({ outletCode, itemName, month, week, onClose }: {
  outletCode: string; itemName: string; month: string; week: string; onClose: () => void;
}) {
  const { data, isLoading, error } = useQuery<ItemHistoryResponse>({
    queryKey: ['item-history', outletCode, itemName, month, week],
    queryFn: async () => {
      const p = new URLSearchParams({ outletCode, itemName, month, week });
      const res = await fetch(`/api/item-history?${p.toString()}`);
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        throw new Error(`Server error (HTTP ${res.status}). ${text.slice(0, 200)}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<ItemHistoryResponse>;
    },
    // FIX #18: cache for 5 min so reopening the modal doesn't refetch
    staleTime: 300_000,
  });

  return (
    <Dialog open={true} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-[800px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-5 w-5" />
            {itemName}
            {data?.outlet && <span className="text-muted-foreground text-sm">— {data.outlet.name} ({data.outlet.code})</span>}
            {data?.priority && (
              <Badge variant="outline" className={`text-xs ${priorityColor(data.priority)} border-current`}>
                {data.priority}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            Historical timeline + benchmark per bahan
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">Memuat historical...</span>
          </div>
        ) : error || !data?.success ? (
          <div className="py-8 text-center text-red-600 text-sm">
            Error: {error?.message || data?.error || 'Unknown'}
          </div>
        ) : (
          <div className="space-y-4">
            {/* Summary Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <SummaryCard label="Dev/BOM" value={fmtPct(data.current?.devBom)} sub={data.historical?.zScore != null ? `zScore: ${fmtDecimal(data.historical.zScore, 2)}` : ''} color={data.current?.devBom != null && Math.abs(data.current.devBom) > 0.10 ? 'text-red-600' : ''} />
              <SummaryCard label="Nominal" value={fmtIDR(data.current?.nominalLossSurplus)} color={directionColor(data.current?.direction || '')} />
              <SummaryCard label="Residual%" value={fmtPct(data.current?.residualRatio)} sub={data.current?.residualRatio != null && data.current.residualRatio > 0.5 ? 'TINGGI' : ''} color={data.current?.residualRatio != null && data.current.residualRatio > 0.5 ? 'text-red-600' : ''} />
              <SummaryCard label="Trend" value={data.historical?.trend || '—'} color={data.historical?.trend === 'DETERIORATING' ? 'text-red-600' : data.historical?.trend === 'IMPROVING' ? 'text-emerald-600' : ''} />
            </div>

            {/* Benchmark */}
            <Card className="shadow-md shadow-black/5 dark:shadow-black/20">
              <CardHeader className="pb-2"><CardTitle className="text-sm">Benchmark (Current Period)</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                <Row label="Outlet Dev/BOM" value={fmtPct(data.benchmark?.outletDevBom)} />
                <Row label="Area Avg Dev/BOM" value={fmtPct(data.benchmark?.areaAvgDevBom)} />
                <Row label="Semua Resto Avg" value={fmtPct(data.benchmark?.allRestoAvgDevBom)} />
                <Row label="Best Outlet" value={fmtPct(data.benchmark?.bestDevBom)} />
                <Row label="Area Multiplier" value={data.benchmark?.areaMultiplier != null ? `${fmtDecimal(data.benchmark.areaMultiplier, 2)}×` : '—'} />
                <Row label="Semua Resto Multiplier" value={data.benchmark?.allRestoMultiplier != null ? `${fmtDecimal(data.benchmark.allRestoMultiplier, 2)}×` : '—'} />
                <Row label="Area Outlets" value={String(data.benchmark?.areaOutletCount ?? 0)} />
                <Row label="Total Resto" value={String(data.benchmark?.allRestoOutletCount ?? 0)} />
              </CardContent>
            </Card>

            {/* Historical Timeline */}
            <Card className="shadow-md shadow-black/5 dark:shadow-black/20">
              <CardHeader className="pb-2"><CardTitle className="text-sm">Historical Timeline</CardTitle></CardHeader>
              <CardContent>
                <div className="overflow-x-auto max-h-[300px] overflow-y-auto border rounded-md">
                  {/* STRUCTURAL (S-3, opsi b): same density policy as Bahan
                      Analysis — text-xs, py-1.5 + font-mono kept. */}
                  <Table>
                    <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                      <TableRow>
                        <TableHead className="text-xs h-8">Periode</TableHead>
                        <TableHead className="text-xs h-8 text-right">BOM</TableHead>
                        <TableHead className="text-xs h-8 text-right">Deviasi</TableHead>
                        <TableHead className="text-xs h-8 text-right">Dev/BOM</TableHead>
                        <TableHead className="text-xs h-8 text-right">Nominal</TableHead>
                        <TableHead className="text-xs h-8 text-center">Dir</TableHead>
                        <TableHead className="text-xs h-8 text-right">W</TableHead>
                        <TableHead className="text-xs h-8 text-right">S</TableHead>
                        <TableHead className="text-xs h-8 text-right">T</TableHead>
                        <TableHead className="text-xs h-8 text-right">Resid%</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {/* FIX (BUG-HUNT C8/B2-15): stable key = period identity
                          (monthLabel+weekLabel is unique per row) instead of index. */}
                      {data.timeline?.map((t: ItemHistoryTimelineRow) => (
                        <TableRow key={`${t.monthLabel}-${t.weekLabel}`} className={t.isCurrent ? 'bg-primary/5 font-semibold' : ''}>
                          <TableCell className="text-xs py-1.5 whitespace-nowrap">
                            {t.weekLabel} {t.monthLabel?.split(' ')[0]?.slice(0, 3)}
                            {t.isCurrent && <span className="ml-1 text-xs text-primary">●</span>}
                          </TableCell>
                          <TableCell className="text-xs py-1.5 text-right font-mono">{fmtNum(t.qtyBom)}</TableCell>
                          <TableCell className="text-xs py-1.5 text-right font-mono">{fmtNum(t.qtyDeviasi)}</TableCell>
                          <TableCell className="text-xs py-1.5 text-right font-mono text-red-600">{fmtPct(t.devBom)}</TableCell>
                          <TableCell className="text-xs py-1.5 text-right font-mono">{fmtIDR(t.nominalLossSurplus)}</TableCell>
                          <TableCell className={`text-xs py-1.5 text-center ${directionColor(t.direction)}`}>{t.direction === 'LOSS' ? 'L' : t.direction === 'SURPLUS' ? 'S' : '-'}</TableCell>
                          <TableCell className="text-xs py-1.5 text-right font-mono text-muted-foreground">{t.qtyWaste > 0 ? fmtNum(t.qtyWaste) : '—'}</TableCell>
                          <TableCell className="text-xs py-1.5 text-right font-mono text-muted-foreground">{t.qtySusut > 0 ? fmtNum(t.qtySusut) : '—'}</TableCell>
                          <TableCell className="text-xs py-1.5 text-right font-mono text-muted-foreground">{t.qtyTrial > 0 ? fmtNum(t.qtyTrial) : '—'}</TableCell>
                          <TableCell className="text-xs py-1.5 text-right font-mono">{fmtPct(t.residualRatio)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Historical mean: {fmtPct(data.historical?.mean)} · StdDev: {fmtPct(data.historical?.stdDev)} · zScore: {data.historical?.zScore != null ? fmtDecimal(data.historical.zScore, 2) : '—'} · Sample: {data.historical?.sampleSize || 0} periods
                </p>
              </CardContent>
            </Card>

            {/* Investigation Checklist */}
            <Card className="shadow-md shadow-black/5 dark:shadow-black/20">
              <CardHeader className="pb-2"><CardTitle className="text-sm">Possible Investigation</CardTitle></CardHeader>
              <CardContent>
                <ol className="text-xs space-y-1 list-decimal list-inside text-muted-foreground">
                  <li>Cek actual portion vs SOC</li>
                  <li>Cek timbang bahan (sampling fisik)</li>
                  <li>Cek waste recording (apakah akurat?)</li>
                  <li>Cek susut (apakah wajar?)</li>
                  <li>Cek quality issue (bahan rusak?)</li>
                  <li>Cek receiving (apakah sesuai?)</li>
                  <li>Cek transfer antar outlet</li>
                  <li>Cek UOM conversion</li>
                  <li>Cek administrasi transaksi</li>
                  <li>Cek stock opname timing</li>
                </ol>
                <p className="text-xs text-muted-foreground mt-2 italic">
                  ⚠ "Possible Investigation" bukan "Root Cause" — sistem belum melakukan observasi fisik.
                </p>
              </CardContent>
            </Card>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
