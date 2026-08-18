'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Users, Loader2 } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { fmtIDR, fmtNum, fmtPctAbs } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';
import { useState } from 'react';

export function PeerComparison() {
  const { focusOutlet, outletCode, monthLabel, currentWeek, setFocusOutlet } = useDashboard();
  const activeOutlet = focusOutlet || outletCode;
  const [mode, setMode] = useState<'week' | 'month'>('week');
  const [peerLimit, setPeerLimit] = useState(10);

  const { data, isLoading, error } = useQuery({
    queryKey: ['peer-comparison', activeOutlet, monthLabel, currentWeek, mode, peerLimit],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('outletCode', activeOutlet!);
      p.set('month', monthLabel!);
      if (mode === 'week' && currentWeek) p.set('week', currentWeek);
      p.set('mode', mode);
      p.set('limit', String(peerLimit));
      const res = await fetch(`/api/peer-comparison?${p.toString()}`);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('Server error');
      return res.json();
    },
    enabled: Boolean(activeOutlet && monthLabel),
  });

  if (!activeOutlet) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          <Users className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p>Pilih outlet untuk melihat Peer Comparison</p>
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-12 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (error || !data?.success) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-red-600">
          <p>Error: {error?.message || data?.error || 'Unknown'}</p>
        </CardContent>
      </Card>
    );
  }

  const peers: any[] = data.peers || [];
  const targetRow = peers.find((p: any) => p.isTarget);
  const otherPeers = peers.filter((p: any) => !p.isTarget);

  // Compute peer averages (excluding target)
  const peerCount = otherPeers.length;
  const avg = (field: string) => peerCount > 0 ? otherPeers.reduce((s: number, p: any) => s + p[field], 0) / peerCount : 0;

  const avgSales = avg('sales');
  const avgNominalDeviasi = avg('nominalDeviasi');
  const avgDevBom = avg('devBom');
  const avgTotalLoss = avg('totalLoss');
  const avgTotalSurplus = avg('totalSurplus');
  const avgQtyWaste = avg('qtyWaste');
  const avgQtySusut = avg('qtySusut');
  const avgQtyTrial = avg('qtyTrial');
  const avgQtyLossSurplus = avg('qtyLossSurplus');
  const avgResidualQty = avg('residualQty');
  const avgItemCount = avg('itemCount');

  // Color: target vs peer average
  // For "bad" metrics (higher = worse): nominalDeviasi, devBom, totalLoss, waste, susut, trial, residual
  // For "good" metrics (higher = better): sales, totalSurplus, itemCount
  const colorCell = (targetVal: number, avgVal: number, higherIsBetter: boolean = false) => {
    if (peerCount === 0) return '';
    const diff = targetVal - avgVal;
    if (Math.abs(diff) < 0.001) return 'text-muted-foreground';
    const isBetter = higherIsBetter ? diff > 0 : diff < 0;
    return isBetter ? 'text-emerald-600 font-semibold' : 'text-red-600 font-semibold';
  };

  const columns = [
    { key: 'sales', label: 'Sales', format: fmtIDR, avg: avgSales, higherBetter: true },
    { key: 'nominalDeviasi', label: 'Nominal Deviasi', format: fmtIDR, avg: avgNominalDeviasi, higherBetter: false },
    { key: 'devBom', label: 'Dev/BOM', format: (v: number) => fmtPctAbs(v), avg: avgDevBom, higherBetter: false },
    { key: 'totalLoss', label: 'Total LOSS', format: fmtIDR, avg: avgTotalLoss, higherBetter: false },
    { key: 'totalSurplus', label: 'Total SURPLUS', format: fmtIDR, avg: avgTotalSurplus, higherBetter: true },
    { key: 'qtyWaste', label: 'QTY Waste', format: fmtNum, avg: avgQtyWaste, higherBetter: false },
    { key: 'qtySusut', label: 'QTY Susut', format: fmtNum, avg: avgQtySusut, higherBetter: false },
    { key: 'qtyTrial', label: 'QTY Trial', format: fmtNum, avg: avgQtyTrial, higherBetter: false },
    { key: 'qtyLossSurplus', label: 'QTY LS', format: fmtNum, avg: avgQtyLossSurplus, higherBetter: false },
    { key: 'residualQty', label: 'Residual', format: fmtNum, avg: avgResidualQty, higherBetter: false },
    { key: 'itemCount', label: 'Item Count', format: (v: number) => String(v), avg: avgItemCount, higherBetter: true },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="h-4 w-4" />
              Peer Comparison
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              {activeOutlet} vs {peerCount} resto dengan sales ±10% ({mode === 'week' ? `WEEK ${currentWeek}` : 'Bulan'})
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as 'week' | 'month')}
              className="h-7 text-xs border rounded px-2 bg-background"
            >
              <option value="week">Per Week</option>
              <option value="month">Per Bulan</option>
            </select>
            <select
              value={String(peerLimit)}
              onChange={(e) => setPeerLimit(parseInt(e.target.value))}
              className="h-7 text-xs border rounded px-2 bg-background"
            >
              <option value="5">Top 5</option>
              <option value="10">Top 10</option>
              <option value="20">Top 20</option>
              <option value="50">Top 50</option>
            </select>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {peers.length === 0 ? (
          <p className="text-center text-muted-foreground text-xs py-6">Tidak ada peer ditemukan</p>
        ) : (
          <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-background z-10">
                <TableRow>
                  <TableHead className="text-[11px] sticky left-0 bg-background">Resto</TableHead>
                  <TableHead className="text-[11px]">Area</TableHead>
                  <TableHead className="text-[11px]">PIC</TableHead>
                  <TableHead className="text-[11px]">Top Item</TableHead>
                  {columns.map(col => (
                    <TableHead key={col.key} className="text-[11px] text-right">{col.label}</TableHead>
                  ))}
                  <TableHead className="text-[11px] text-center">Dir</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* Peer Average Row */}
                {peerCount > 0 && (
                  <TableRow className="border-b-2 border-muted-foreground/20 bg-muted/30">
                    <TableCell className="text-[11px] font-bold sticky left-0 bg-muted/30">📊 Peer Avg</TableCell>
                    <TableCell className="text-[11px] text-muted-foreground">—</TableCell>
                    <TableCell className="text-[11px] text-muted-foreground">—</TableCell>
                    <TableCell className="text-[11px] text-muted-foreground">—</TableCell>
                    {columns.map(col => (
                      <TableCell key={col.key} className="text-[11px] text-right text-muted-foreground font-mono">
                        {col.format(col.avg)}
                      </TableCell>
                    ))}
                    <TableCell className="text-[11px] text-center text-muted-foreground">—</TableCell>
                  </TableRow>
                )}
                {/* Outlet Rows */}
                {peers.map((p: any) => (
                  <TableRow
                    key={p.outletCode}
                    className={`cursor-pointer hover:bg-muted/50 ${p.isTarget ? 'bg-primary/10 border-primary/30' : ''}`}
                    {...clickableRowProps(() => setFocusOutlet(p.outletCode))}
                  >
                    <TableCell className="text-[11px] font-medium sticky left-0 bg-inherit">
                      {p.outletName}
                      {p.isTarget && <Badge variant="default" className="text-[9px] ml-1 h-4">TARGET</Badge>}
                      <div className="text-[10px] text-muted-foreground">{p.outletCode}</div>
                    </TableCell>
                    <TableCell className="text-[11px] text-muted-foreground">{p.area}</TableCell>
                    <TableCell className="text-[11px] text-muted-foreground">{p.pic || '—'}</TableCell>
                    <TableCell className="text-[11px] max-w-[120px] truncate" title={p.topItem || ''}>{p.topItem || '—'}</TableCell>
                    {columns.map(col => {
                      const val = p[col.key];
                      const colorClass = p.isTarget ? colorCell(val, col.avg, col.higherBetter) : '';
                      return (
                        <TableCell key={col.key} className={`text-[11px] text-right font-mono ${colorClass}`}>
                          {col.format(val)}
                        </TableCell>
                      );
                    })}
                    <TableCell className={`text-[11px] text-center font-semibold ${p.direction === 'LOSS' ? 'text-red-600' : p.direction === 'SURPLUS' ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                      {p.direction?.[0] || '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <div className="p-2 text-[10px] text-muted-foreground border-t">
          💡 Klik baris untuk deep dive ke Resto Analysis. Hijau = lebih baik dari peer avg, Merah = lebih buruk.
          Sales range: ±10% dari {targetRow ? fmtIDR(targetRow.sales) : 'target'}.
        </div>
      </CardContent>
    </Card>
  );
}
