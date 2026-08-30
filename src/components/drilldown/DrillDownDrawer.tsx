'use client';

import { logger } from '@/lib/logger';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { useDrilldown } from '@/hooks/useAnalysis';
import type { DrilldownRecord } from '@/hooks/useAnalysis';
import { fmtIDR, fmtNum, fmtPctAbs, directionColor, numberColor } from '@/lib/format';
import { ExternalLink, X, Loader2 } from 'lucide-react';
import { useRef, useState, useEffect, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export function DrillDownDrawer() {
  const { drilldown, setDrilldown, monthLabel, currentWeek, setSourceModal, area, kelompok, outletCode: filterOutlet, pic } = useDashboard(useShallow((s) => ({
    drilldown: s.drilldown,
    setDrilldown: s.setDrilldown,
    monthLabel: s.monthLabel,
    currentWeek: s.currentWeek,
    setSourceModal: s.setSourceModal,
    area: s.area,
    kelompok: s.kelompok,
    outletCode: s.outletCode,
    pic: s.pic,
  })));
  const open = Boolean(drilldown.outletCode || drilldown.itemName);

  // FIX M1 (AUDIT-6): Track all loaded records across pages (cursor pagination).
  const [allRecords, setAllRecords] = useState<DrilldownRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // First page fetch — pass dashboard filters so drill-down respects active filter
  const drill = useDrilldown({
    outletCode: drilldown.outletCode,
    itemName: drilldown.itemName,
    weekLabel: currentWeek,
    monthLabel,
    limit: 50,
    area: area && area !== 'all' ? area : undefined,
    kelompok: kelompok && kelompok !== 'all' ? kelompok : undefined,
    pic: pic && pic !== 'all' ? pic : undefined,
  });

  // FIX M1: When first page loads, populate allRecords + nextCursor.
  useEffect(() => {
    if (drill.data) {
      setAllRecords(drill.data.records);
      setNextCursor(drill.data.nextCursor);
    }
  }, [drill.data]);

  // Reset when drawer closes or filter changes
  useEffect(() => {
    if (!open) {
      setAllRecords([]);
      setNextCursor(null);
    }
  }, [open]);

  // FIX M1: Load More — fetch next page using cursor, append to allRecords.
  const handleLoadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams();
      if (drilldown.outletCode) params.set('outletCode', drilldown.outletCode);
      if (drilldown.itemName) params.set('itemName', drilldown.itemName);
      if (currentWeek) params.set('weekLabel', currentWeek);
      if (monthLabel) params.set('monthLabel', monthLabel);
      params.set('limit', '50');
      params.set('cursor', String(nextCursor));
      // Pass dashboard filters so pagination respects active filter
      if (area && area !== 'all') params.set('area', area);
      if (kelompok && kelompok !== 'all') params.set('kelompok', kelompok);
      if (pic && pic !== 'all') params.set('pic', pic);

      const res = await fetch(`/api/drilldown?${params.toString()}`);
      const data = await res.json();
      if (data.success) {
        setAllRecords(prev => [...prev, ...data.records]);
        setNextCursor(data.nextCursor);
      }
    } catch (e) {
      logger.error("[drilldown] Load More failed:", { error: e });
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, drilldown, currentWeek, monthLabel, area, kelompok, pic]);

  function handleClose(open: boolean) {
    if (!open) setDrilldown({ outletCode: null, itemName: null });
  }

  return (
    <Sheet open={open} onOpenChange={handleClose}>
      <SheetContent side="right" className="w-full sm:max-w-2xl p-0 flex flex-col">
        <SheetHeader className="p-4 border-b shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <SheetTitle className="text-base">Drill-down: Data Sumber</SheetTitle>
              <SheetDescription className="text-xs">
                {drilldown.outletCode && `Outlet: ${drilldown.outletCode}`}
                {drilldown.outletCode && drilldown.itemName && ' · '}
                {drilldown.itemName && `Item: ${drilldown.itemName}`}
                {currentWeek && ` · ${currentWeek} ${monthLabel || ''}`}
              </SheetDescription>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setDrilldown({ outletCode: null, itemName: null })}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </SheetHeader>

        {/* FIX AUDIT-6 #5: removed nested ScrollArea — the virtualized table
            has its own scroll container. No more double-scroll confusion. */}
        <div className="flex-1 overflow-hidden p-4 space-y-3">
          {drill.isLoading && <p className="text-sm text-muted-foreground">Memuat data sumber...</p>}
          {drill.error && (
            <div className="flex items-center gap-3 p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900">
              <p className="text-sm text-red-600 flex-1">Error: {drill.error.message}</p>
              <Button variant="outline" size="sm" className="h-7 text-xs shrink-0" onClick={() => drill.refetch()}>
                Coba Lagi
              </Button>
            </div>
          )}
          {drill.data && (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className="text-xs">{allRecords.length} record</Badge>
                {nextCursor && (
                  <Badge variant="secondary" className="text-[10px]">
                    {allRecords.length} dimuat · masih ada lagi
                  </Badge>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setSourceModal(true)}
                >
                  <ExternalLink className="h-3 w-3 mr-1" /> Sumber Lengkap
                </Button>
              </div>

              {/* FIX M2 (AUDIT-6): Use raw <table> instead of shadcn <Table> wrapper.
                  The wrapper's overflow-x-auto div breaks position:sticky on thead.
                  FIX M8 (AUDIT-6): Enable measureElement for dynamic row heights. */}
              <VirtualizedDrawerTable records={allRecords} />

              {/* FIX M1 (AUDIT-6): Load More button — consumes cursor pagination. */}
              {nextCursor && (
                <div className="flex justify-center pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleLoadMore}
                    disabled={loadingMore}
                  >
                    {loadingMore ? (
                      <>
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                        Memuat...
                      </>
                    ) : (
                      'Muat Lebih Banyak'
                    )}
                  </Button>
                </div>
              )}

              {allRecords.length > 0 && (
                <div className="rounded-lg border p-3 space-y-2">
                  <p className="text-xs font-semibold text-muted-foreground uppercase">Metrik Turunan (record teratas)</p>
                  {(() => {
                    const r = allRecords[0];
                    return (
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div><span className="text-muted-foreground">Direction:</span> <span className={`font-semibold ${directionColor(r.derived?.direction ?? null)}`}>{r.derived?.direction ?? '—'}</span></div>
                        <div><span className="text-muted-foreground">Residual Qty:</span> <span className="font-medium">{fmtNum(r.derived?.residualQty ?? null)}</span></div>
                        <div><span className="text-muted-foreground">Residual Ratio:</span> <span className="font-medium">{fmtPctAbs(r.derived?.residualRatio ?? null)}</span></div>
                        <div><span className="text-muted-foreground">Avg Price:</span> <span className="font-medium">{fmtIDR(r.derived?.avgPrice ?? null)}</span></div>
                        <div><span className="text-muted-foreground">Tolerance:</span> <span className="font-medium">{r.derived?.tolerancePct != null ? fmtPctAbs(r.derived.tolerancePct) : 'Not set'}</span></div>
                        <div><span className="text-muted-foreground">Abs Nominal:</span> <span className="font-medium">{fmtIDR(r.derived?.absNominalDeviasi ?? null)}</span></div>
                        <div className="col-span-2"><span className="text-muted-foreground">Source File:</span> <span className="font-medium">{r.source?.fileName ?? '—'}</span></div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ============================================================
//  VirtualizedDrawerTable — virtualized table with sticky header.
//  FIX M2: Uses raw <table> element (bypasses shadcn <Table> wrapper
//          which breaks position:sticky via overflow-x-auto div).
//  FIX M8: Enables measureElement for dynamic row heights (handles
//          2-line outlet name+code cells correctly).
// ============================================================
function VirtualizedDrawerTable({ records }: { records: DrilldownRecord[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: records.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    overscan: 8,
    // FIX M8: measure actual row height on scroll — handles multi-line cells.
    measureElement: (element) => element.getBoundingClientRect().height,
  });

  const items = rowVirtualizer.getVirtualItems();
  const totalHeight = rowVirtualizer.getTotalSize();

  return (
    <div ref={parentRef} className="overflow-auto border rounded-md" style={{ maxHeight: '400px' }}>
      {/* FIX M2: Raw <table> — no wrapper div that breaks sticky header. */}
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-background z-10 shadow-sm">
          <tr className="border-b">
            <th className="text-left p-2 font-medium">Outlet</th>
            <th className="text-left p-2 font-medium">Item</th>
            <th className="text-right p-2 font-medium">QTY BOM</th>
            <th className="text-right p-2 font-medium">QTY Dev</th>
            <th className="text-right p-2 font-medium">Nom Dev</th>
            <th className="text-right p-2 font-medium">Dev/BOM</th>
            <th className="text-center p-2 font-medium">Dir</th>
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
                </td>
                <td className="p-2 font-medium">{r.item?.name ?? '—'}</td>
                <td className={`p-2 text-right ${numberColor(r.qty?.bom ?? null)}`}>{fmtNum(r.qty?.bom ?? null)}</td>
                <td className={`p-2 text-right ${numberColor(r.qty?.deviasi ?? null)}`}>{fmtNum(r.qty?.deviasi ?? null)}</td>
                <td className={`p-2 text-right font-semibold ${numberColor(r.nominal?.deviasi ?? null)}`}>{fmtIDR(r.nominal?.deviasi ?? null)}</td>
                <td className="p-2 text-right">{fmtPctAbs(r.derived?.pctQtyDeviasiToBom ?? null)}</td>
                <td className={`p-2 text-center font-semibold ${directionColor(r.derived?.direction ?? null)}`}>{r.derived?.direction?.[0] ?? '—'}</td>
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
