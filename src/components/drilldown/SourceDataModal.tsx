'use client';

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { useDrilldown } from '@/hooks/useAnalysis';
import type { DrilldownRecord } from '@/hooks/useAnalysis';
import { fmtIDR, fmtNum, fmtPctAbs, directionColor, numberColor } from '@/lib/format';
import { Database, Download, X } from 'lucide-react';
import { useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export function SourceDataModal() {
  const { sourceModalOpen, setSourceModal, drilldown, monthLabel, currentWeek, area, kelompok, pic } = useDashboard(useShallow((s) => ({
    sourceModalOpen: s.sourceModalOpen,
    setSourceModal: s.setSourceModal,
    drilldown: s.drilldown,
    monthLabel: s.monthLabel,
    currentWeek: s.currentWeek,
    area: s.area,
    kelompok: s.kelompok,
    pic: s.pic,
  })));

  // FIX (H-12 / drilldown queryKey mismatch): this used to omit limit +
  // area/kelompok/pic, so "Sumber Lengkap" opened with a DIFFERENT queryKey
  // than the drawer's (limit undefined vs 50, no filters vs filters) →
  // TanStack treated it as a new query and re-fetched the SAME 50 rows the
  // drawer already had (duplicate /api/drilldown round-trip), AND the modal
  // showed UNFILTERED rows whenever a dashboard filter was active (drawer
  // showed filtered rows — the two views could disagree).
  // Now the params match DrillDownDrawer field-for-field → one cache entry,
  // instant open, filter-consistent rows.
  const drill = useDrilldown({
    outletCode: drilldown.outletCode,
    itemName: drilldown.itemName,
    weekLabel: currentWeek,
    monthLabel,
    limit: 50,
    area: area && area !== 'all' ? area : undefined,
    kelompok: kelompok && kelompok !== 'all' ? kelompok : undefined,
    pic: pic && pic !== 'all' ? pic : undefined,
    // UI-03 FIX: Only fetch when modal is actually open — avoids redundant
    // fetch every time the drawer opens (the drawer has its own 50-row query;
    // with identical keys the modal now reuses the drawer's cached rows).
    enabled: sourceModalOpen,
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
      r.outlet?.code ?? '', r.outlet?.name ?? '', r.outlet?.area ?? '', r.item?.name ?? '', r.item?.satuan || '',
      r.period?.monthLabel ?? '', r.period?.weekLabel ?? '', r.source?.fileName ?? '',
      r.qty?.bom ?? '', r.qty?.com ?? '', r.qty?.deviasi ?? '',
      r.qty?.waste ?? '', r.qty?.susut ?? '', r.qty?.trial ?? '', r.qty?.lossSurplus ?? '',
      r.nominal?.deviasi ?? '', r.nominal?.waste ?? '', r.nominal?.susut ?? '',
      r.nominal?.trial ?? '', r.nominal?.lossSurplus ?? '', r.nominal?.sales ?? '',
      r.derived?.direction ?? '', r.derived?.pctQtyDeviasiToBom ?? '', r.derived?.tolerancePct ?? '',
      r.derived?.residualQty ?? '', r.derived?.residualRatio ?? '', r.derived?.avgPrice ?? '',
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
      <DialogContent className="sm:max-w-[1100px] max-h-[85vh] flex flex-col overflow-hidden" showCloseButton={false}>
        <DialogHeader className="shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="flex items-center gap-2 text-base">
                <Database className="h-4 w-4" />
                Data Sumber Lengkap
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

        <div className="flex-1 overflow-y-auto border rounded-md">
          {drill.isLoading && (
            <div className="flex items-center justify-center py-12">
              <p className="text-sm text-muted-foreground">Memuat data sumber...</p>
            </div>
          )}
          {drill.error && (
            <div className="flex items-center gap-3 p-4 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900">
              <p className="text-sm text-red-600 flex-1">Error: {drill.error.message}</p>
              <Button variant="outline" size="sm" className="h-7 text-xs shrink-0" onClick={() => drill.refetch()}>
                Coba Lagi
              </Button>
            </div>
          )}
          {drill.data && records.length === 0 && (
            <div className="p-8 text-center text-sm text-muted-foreground">
              Tidak ada data sumber untuk filter ini.
            </div>
          )}
          {drill.data && records.length > 0 && (
            <VirtualizedRecordsTable records={records} />
          )}
        </div>

        {drill.data && records.length > 0 && (
          <div className="flex items-center justify-between pt-2 text-xs text-muted-foreground shrink-0">
            <span>
              Menampilkan {records.length} record{records.length !== 1 ? 's' : ''}
              {/* H-12: the modal shares the drawer's limit-50 queryKey (see the
                  useDrilldown call above) — the old "maks 500" hint could never
                  fire. Full data remains traceable via the source Excel. */}
              {records.length === 50 && ' (50 record pertama — data lengkap ada di Excel sumber)'}
            </span>
            <Badge variant="outline" className="text-[11px]">
              Dapat ditelusuri ke Excel sumber
            </Badge>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
//  VirtualizedRecordsTable — virtualized table for 100+ records.
//  FIX Medium #3: uses @tanstack/react-virtual to render only visible rows.
//  Renders 500 records smoothly (was janky at 100+ with native table).
//  Keeps sticky header + horizontal scroll for 17 columns.
// ============================================================
function VirtualizedRecordsTable({ records }: { records: DrilldownRecord[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: records.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 52,
    overscan: 10,
    // FIX M8 (AUDIT-6): measure actual row height — handles 3-line cells
    // (outlet name + code + area) correctly.
    measureElement: (element) => element.getBoundingClientRect().height,
  });

  const items = rowVirtualizer.getVirtualItems();
  const totalHeight = rowVirtualizer.getTotalSize();

  return (
    <div ref={parentRef} className="overflow-auto" style={{ maxHeight: '60vh' }}>
      {/* FIX M2 (AUDIT-6): Raw <table> — bypasses shadcn <Table> wrapper
          which breaks position:sticky via overflow-x-auto div. */}
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-background z-10 shadow-sm">
          <tr className="border-b">
            <th className="text-left p-2 font-medium">Outlet</th>
            <th className="text-left p-2 font-medium">Item</th>
            <th className="text-left p-2 font-medium">Period</th>
            <th className="text-right p-2 font-medium">QTY BOM</th>
            <th className="text-right p-2 font-medium">QTY COM</th>
            <th className="text-right p-2 font-medium">QTY Dev</th>
            <th className="text-right p-2 font-medium">QTY Waste</th>
            <th className="text-right p-2 font-medium">QTY Susut</th>
            <th className="text-right p-2 font-medium">QTY Trial</th>
            <th className="text-right p-2 font-medium">QTY LS</th>
            <th className="text-right p-2 font-medium">Nom Dev</th>
            <th className="text-right p-2 font-medium">Nom Sales</th>
            <th className="text-right p-2 font-medium">Dev/BOM</th>
            <th className="text-right p-2 font-medium">Tol</th>
            <th className="text-right p-2 font-medium">Resid Ratio</th>
            <th className="text-center p-2 font-medium">Dir</th>
            <th className="text-left p-2 font-medium">Source File</th>
          </tr>
        </thead>
        <tbody>
          {items.length > 0 && (
            <tr style={{ height: `${items[0].start}px` }} />
          )}
          {items.map((virtualRow) => {
            const r = records[virtualRow.index];
            return (
              <tr key={r.id} ref={rowVirtualizer.measureElement} data-index={virtualRow.index}
                  className="border-b hover:bg-muted/40">
                <td className="p-2">
                  <div className="font-medium">{r.outlet?.name ?? '—'}</div>
                  <div className="text-[11px] text-muted-foreground">{r.outlet?.code ?? '—'}</div>
                  <div className="text-[11px] text-muted-foreground">{r.outlet?.area ?? '—'}</div>
                </td>
                <td className="p-2 font-medium">
                  {r.item?.name ?? '—'}
                  {r.item?.satuan && <div className="text-[11px] text-muted-foreground">{r.item.satuan}</div>}
                </td>
                <td className="p-2">
                  <div>{r.period?.weekLabel ?? '—'}</div>
                  <div className="text-[11px] text-muted-foreground">{r.period?.monthLabel ?? '—'}</div>
                </td>
                <td className={`p-2 text-right ${numberColor(r.qty?.bom ?? null)}`}>{fmtNum(r.qty?.bom ?? null)}</td>
                <td className={`p-2 text-right ${numberColor(r.qty?.com ?? null)}`}>{fmtNum(r.qty?.com ?? null)}</td>
                <td className={`p-2 text-right font-semibold ${numberColor(r.qty?.deviasi ?? null)}`}>{fmtNum(r.qty?.deviasi ?? null)}</td>
                <td className={`p-2 text-right ${numberColor(r.qty?.waste ?? null)}`}>{fmtNum(r.qty?.waste ?? null)}</td>
                <td className={`p-2 text-right ${numberColor(r.qty?.susut ?? null)}`}>{fmtNum(r.qty?.susut ?? null)}</td>
                <td className={`p-2 text-right ${numberColor(r.qty?.trial ?? null)}`}>{fmtNum(r.qty?.trial ?? null)}</td>
                <td className={`p-2 text-right ${numberColor(r.qty?.lossSurplus ?? null)}`}>{fmtNum(r.qty?.lossSurplus ?? null)}</td>
                <td className={`p-2 text-right font-semibold ${numberColor(r.nominal?.deviasi ?? null)}`}>{fmtIDR(r.nominal?.deviasi ?? null)}</td>
                <td className="p-2 text-right">{fmtIDR(r.nominal?.sales ?? null)}</td>
                <td className="p-2 text-right">{fmtPctAbs(r.derived?.pctQtyDeviasiToBom ?? null)}</td>
                <td className="p-2 text-right">
                  {r.derived?.tolerancePct != null ? fmtPctAbs(r.derived.tolerancePct) : '—'}
                </td>
                <td className="p-2 text-right">{fmtPctAbs(r.derived?.residualRatio ?? null)}</td>
                <td className={`p-2 text-center font-semibold ${directionColor(r.derived?.direction ?? null)}`}>
                  {r.derived?.direction?.[0] ?? '—'}
                </td>
                <td className="p-2 text-muted-foreground">{r.source?.fileName ?? '—'}</td>
              </tr>
            );
          })}
          {items.length > 0 && (
            <tr style={{ height: `${totalHeight - items[items.length - 1].end}px` }} />
          )}
        </tbody>
      </table>
    </div>
  );
}
