'use client';

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useDashboard } from '@/hooks/useDashboard';
import { useDrilldown } from '@/hooks/useAnalysis';
import type { DrilldownRecord } from '@/hooks/useAnalysis';
import { fmtIDR, fmtNum, fmtPctAbs, directionColor, numberColor } from '@/lib/format';
import { ExternalLink, X } from 'lucide-react';
import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export function DrillDownDrawer() {
  const { drilldown, setDrilldown, monthLabel, currentWeek, sourceModalOpen, setSourceModal } = useDashboard();
  const open = Boolean(drilldown.outletCode || drilldown.itemName);

  const drill = useDrilldown({
    outletCode: drilldown.outletCode,
    itemName: drilldown.itemName,
    weekLabel: currentWeek,
    monthLabel,
  });

  function handleClose(open: boolean) {
    if (!open) setDrilldown({ outletCode: null, itemName: null });
  }

  return (
    <Sheet open={open} onOpenChange={handleClose}>
      <SheetContent side="right" className="w-full sm:max-w-2xl p-0 flex flex-col">
        <SheetHeader className="p-4 border-b">
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

        <ScrollArea className="flex-1">
          <div className="p-4 space-y-4">
            {drill.isLoading && <p className="text-sm text-muted-foreground">Memuat data sumber...</p>}
            {drill.error && <p className="text-sm text-red-600">Error: {drill.error.message}</p>}
            {drill.data && (
              <>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs">{drill.data.count} record</Badge>
                  {drill.data.hasMore && (
                    <Badge variant="secondary" className="text-[10px]">Halaman 1 — gunakan API cursor untuk load more</Badge>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setSourceModal(true)}
                  >
                    <ExternalLink className="h-3 w-3 mr-1" /> Lihat Sumber Lengkap
                  </Button>
                </div>

                {/* FIX Medium #3: virtualized table — renders only visible rows.
                    Was capped at 100 (M-N fix), now renders all 500 smoothly. */}
                <VirtualizedDrawerTable records={drill.data.records} />

                {drill.data.records.length > 0 && (
                  <div className="rounded-lg border p-3 space-y-2">
                    <p className="text-xs font-semibold text-muted-foreground uppercase">Metrik Turunan (record teratas)</p>
                    {(() => {
                      const r = drill.data.records[0];
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
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

// ============================================================
//  VirtualizedDrawerTable — virtualized table for drawer.
//  FIX Medium #3: renders only visible rows via @tanstack/react-virtual.
//  Handles 500 records smoothly (was janky at 100+).
// ============================================================
function VirtualizedDrawerTable({ records }: { records: DrilldownRecord[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: records.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40, // row height (single-line cells)
    overscan: 8,
  });

  const items = rowVirtualizer.getVirtualItems();
  const totalHeight = rowVirtualizer.getTotalSize();

  return (
    <div ref={parentRef} className="overflow-auto border rounded-md" style={{ maxHeight: '400px' }}>
      <Table>
        <TableHeader className="sticky top-0 bg-background z-10">
          <TableRow>
            <TableHead className="text-xs">Outlet</TableHead>
            <TableHead className="text-xs">Item</TableHead>
            <TableHead className="text-xs text-right">QTY BOM</TableHead>
            <TableHead className="text-xs text-right">QTY Dev</TableHead>
            <TableHead className="text-xs text-right">Nom Dev</TableHead>
            <TableHead className="text-xs text-right">Dev/BOM</TableHead>
            <TableHead className="text-xs text-center">Dir</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.length > 0 && (
            <tr style={{ height: `${items[0].start}px` }} />
          )}
          {items.map((virtualRow) => {
            const r = records[virtualRow.index];
            return (
              <TableRow key={r.id} style={{ height: `${virtualRow.size}px` }}>
                <TableCell className="text-xs">
                  <div className="font-medium">{r.outlet?.name ?? '—'}</div>
                  <div className="text-[11px] text-muted-foreground">{r.outlet?.code ?? '—'}</div>
                </TableCell>
                <TableCell className="text-xs font-medium">{r.item?.name ?? '—'}</TableCell>
                <TableCell className={`text-xs text-right ${numberColor(r.qty?.bom ?? null)}`}>{fmtNum(r.qty?.bom ?? null)}</TableCell>
                <TableCell className={`text-xs text-right ${numberColor(r.qty?.deviasi ?? null)}`}>{fmtNum(r.qty?.deviasi ?? null)}</TableCell>
                <TableCell className={`text-xs text-right font-semibold ${numberColor(r.nominal?.deviasi ?? null)}`}>{fmtIDR(r.nominal?.deviasi ?? null)}</TableCell>
                <TableCell className="text-xs text-right">{fmtPctAbs(r.derived?.pctQtyDeviasiToBom ?? null)}</TableCell>
                <TableCell className={`text-xs text-center font-semibold ${directionColor(r.derived?.direction ?? null)}`}>{r.derived?.direction?.[0] ?? '—'}</TableCell>
              </TableRow>
            );
          })}
          {items.length > 0 && (
            <tr style={{ height: `${totalHeight - items[items.length - 1].end}px` }} />
          )}
        </TableBody>
      </Table>
    </div>
  );
}
