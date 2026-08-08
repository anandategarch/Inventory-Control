'use client';

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useDashboard } from '@/hooks/useDashboard';
import { useDrilldown } from '@/hooks/useAnalysis';
import { fmtIDR, fmtNum, fmtPctAbs, directionColor } from '@/lib/format';
import { Database, Download, X } from 'lucide-react';
import { useMemo } from 'react';

export function SourceDataModal() {
  const { sourceModalOpen, setSourceModal, drilldown, monthLabel, currentWeek } = useDashboard();

  const drill = useDrilldown({
    outletCode: drilldown.outletCode,
    itemName: drilldown.itemName,
    weekLabel: currentWeek,
    monthLabel,
  });

  const records = drill.data?.records || [];

  // Build CSV for export
  const csvContent = useMemo(() => {
    if (records.length === 0) return '';
    const headers = [
      'Outlet Code', 'Outlet Name', 'Area', 'Item', 'Satuan',
      'Month', 'Week', 'Source File',
      'QTY BOM', 'QTY COM', 'QTY Deviasi', 'QTY Waste', 'QTY Susut', 'QTY Trial', 'QTY Loss/Surplus',
      'Nominal Deviasi', 'Nominal Waste', 'Nominal Susut', 'Nominal Trial', 'Nominal Loss/Surplus', 'Nominal Sales',
      'Direction', 'Dev/BOM %', 'Tolerance %', 'Residual Qty', 'Residual Ratio', 'Avg Price',
      'Bulan', 'Bulan 2',
    ];
    const rows = records.map((r) => [
      r.outlet.code, r.outlet.name, r.outlet.area, r.item.name, r.item.satuan || '',
      r.period.monthLabel, r.period.weekLabel, r.source.fileName,
      r.qty.bom ?? '', r.qty.com ?? '', r.qty.deviasi ?? '',
      r.qty.waste ?? '', r.qty.susut ?? '', r.qty.trial ?? '', r.qty.lossSurplus ?? '',
      r.nominal.deviasi ?? '', r.nominal.waste ?? '', r.nominal.susut ?? '',
      r.nominal.trial ?? '', r.nominal.lossSurplus ?? '', r.nominal.sales ?? '',
      r.derived.direction ?? '', r.derived.pctQtyDeviasiToBom ?? '', r.derived.tolerancePct ?? '',
      r.derived.residualQty ?? '', r.derived.residualRatio ?? '', r.derived.avgPrice ?? '',
      r.bulan ?? '', r.bulan2 ?? '',
    ]);
    return [headers, ...rows]
      .map((row) => row.map((cell) => {
        const s = String(cell ?? '');
        // Escape CSV: wrap in quotes if contains comma, quote, or newline
        if (s.includes(',') || s.includes('"') || s.includes('\n')) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      }).join(','))
      .join('\n');
  }, [records]);

  function handleExportCSV() {
    if (!csvContent) return;
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const safeName = (drilldown.outletCode || 'all').replace(/[^a-zA-Z0-9]/g, '_');
    const safeItem = (drilldown.itemName || 'all').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);
    link.href = url;
    link.download = `source_${safeName}_${safeItem}_${currentWeek || ''}_${monthLabel || ''}.csv`.replace(/\s+/g, '_');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  return (
    <Dialog open={sourceModalOpen} onOpenChange={setSourceModal}>
      <DialogContent className="sm:max-w-[1100px] max-h-[90vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="flex items-center gap-2 text-base">
                <Database className="h-4 w-4" />
                Full Source Data
              </DialogTitle>
              <DialogDescription className="text-xs mt-1">
                {drilldown.outletCode && `Outlet: ${drilldown.outletCode}`}
                {drilldown.outletCode && drilldown.itemName && ' · '}
                {drilldown.itemName && `Item: ${drilldown.itemName}`}
                {currentWeek && ` · ${currentWeek}`}
                {monthLabel && ` ${monthLabel}`}
                {records.length > 0 && ` · ${records.length} records`}
              </DialogDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={handleExportCSV}
                disabled={records.length === 0}
              >
                <Download className="h-3.5 w-3.5 mr-1" />
                Export CSV
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                onClick={() => setSourceModal(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </DialogHeader>

        <ScrollArea className="flex-1 border rounded-md">
          {drill.isLoading && (
            <div className="flex items-center justify-center py-12">
              <p className="text-sm text-muted-foreground">Loading source records...</p>
            </div>
          )}
          {drill.error && (
            <div className="p-4 text-sm text-red-600">
              Error: {drill.error.message}
            </div>
          )}
          {drill.data && records.length === 0 && (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No source records found for this filter.
            </div>
          )}
          {drill.data && records.length > 0 && (
            <Table>
              <TableHeader className="sticky top-0 bg-background z-10">
                <TableRow>
                  <TableHead className="text-xs">Outlet</TableHead>
                  <TableHead className="text-xs">Item</TableHead>
                  <TableHead className="text-xs">Period</TableHead>
                  <TableHead className="text-xs text-right">QTY BOM</TableHead>
                  <TableHead className="text-xs text-right">QTY COM</TableHead>
                  <TableHead className="text-xs text-right">QTY Dev</TableHead>
                  <TableHead className="text-xs text-right">QTY Waste</TableHead>
                  <TableHead className="text-xs text-right">QTY Susut</TableHead>
                  <TableHead className="text-xs text-right">QTY Trial</TableHead>
                  <TableHead className="text-xs text-right">QTY LS</TableHead>
                  <TableHead className="text-xs text-right">Nom Dev</TableHead>
                  <TableHead className="text-xs text-right">Nom Sales</TableHead>
                  <TableHead className="text-xs text-right">Dev/BOM</TableHead>
                  <TableHead className="text-xs text-right">Tol</TableHead>
                  <TableHead className="text-xs text-right">Resid Ratio</TableHead>
                  <TableHead className="text-xs text-center">Dir</TableHead>
                  <TableHead className="text-xs">Source File</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-xs">
                      <div className="font-medium">{r.outlet.name}</div>
                      <div className="text-[10px] text-muted-foreground">{r.outlet.code}</div>
                      <div className="text-[10px] text-muted-foreground">{r.outlet.area}</div>
                    </TableCell>
                    <TableCell className="text-xs font-medium">
                      {r.item.name}
                      {r.item.satuan && <div className="text-[10px] text-muted-foreground">{r.item.satuan}</div>}
                    </TableCell>
                    <TableCell className="text-xs">
                      <div>{r.period.weekLabel}</div>
                      <div className="text-[10px] text-muted-foreground">{r.period.monthLabel}</div>
                    </TableCell>
                    <TableCell className="text-xs text-right">{fmtNum(r.qty.bom)}</TableCell>
                    <TableCell className="text-xs text-right">{fmtNum(r.qty.com)}</TableCell>
                    <TableCell className="text-xs text-right font-semibold">{fmtNum(r.qty.deviasi)}</TableCell>
                    <TableCell className="text-xs text-right">{fmtNum(r.qty.waste)}</TableCell>
                    <TableCell className="text-xs text-right">{fmtNum(r.qty.susut)}</TableCell>
                    <TableCell className="text-xs text-right">{fmtNum(r.qty.trial)}</TableCell>
                    <TableCell className="text-xs text-right">{fmtNum(r.qty.lossSurplus)}</TableCell>
                    <TableCell className="text-xs text-right font-semibold">{fmtIDR(r.nominal.deviasi)}</TableCell>
                    <TableCell className="text-xs text-right">{fmtIDR(r.nominal.sales)}</TableCell>
                    <TableCell className="text-xs text-right">{fmtPctAbs(r.derived.pctQtyDeviasiToBom)}</TableCell>
                    <TableCell className="text-xs text-right">
                      {r.derived.tolerancePct != null ? fmtPctAbs(r.derived.tolerancePct) : '—'}
                    </TableCell>
                    <TableCell className="text-xs text-right">{fmtPctAbs(r.derived.residualRatio)}</TableCell>
                    <TableCell className={`text-xs text-center font-semibold ${directionColor(r.derived.direction)}`}>
                      {r.derived.direction?.[0]}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.source.fileName}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </ScrollArea>

        {drill.data && records.length > 0 && (
          <div className="flex items-center justify-between pt-2 text-xs text-muted-foreground">
            <span>
              Showing {records.length} record{records.length !== 1 ? 's' : ''}
              {records.length === 50 && ' (capped at 50 — use Export CSV for full data)'}
            </span>
            <Badge variant="outline" className="text-[10px]">
              Traceable to source Excel
            </Badge>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
