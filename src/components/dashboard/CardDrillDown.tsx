'use client';

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { useDashboard } from '@/hooks/useDashboard';
import { fmtIDR, fmtNum, fmtPctAbs, directionColor } from '@/lib/format';
import { X } from 'lucide-react';
import type { AnalysisData, TopOutlet } from '@/hooks/useAnalysis';

interface CardDrillDownProps {
  data: AnalysisData | undefined;
}

// Union of all possible row shapes returned by `getData` across the card configs.
// All rows share `outletCode` + `area` (outlet rows) or `itemName` + `outletCode` (item rows).
// Additional columns are accessed via `col.format(val, row)` with permissive `unknown` typing.
type DrillRow = Record<string, unknown>;

interface ColumnDef {
  key: string;
  label: string;
  align?: string;
  format?: (v: unknown, row: DrillRow) => string;
  color?: (v: unknown, row: DrillRow) => string;
}

interface CardConfig {
  title: string;
  description: string;
  columns: ColumnDef[];
  getData: (data: AnalysisData) => DrillRow[];
}

const CARD_CONFIG: Record<string, CardConfig> = {
  sales: {
    title: 'Top 10 Outlets by Sales',
    description: 'Outlet dengan Sales tertinggi (nilai unique per outlet, bukan sum)',
    columns: [
      { key: 'outletCode', label: 'Outlet' },
      { key: 'area', label: 'Area' },
      { key: 'sales', label: 'Sales', align: 'right', format: (v) => fmtIDR(v as number) },
      { key: 'nominalDeviasi', label: 'Nominal Deviasi', align: 'right', format: (v) => fmtIDR(v as number), color: (v) => v == null ? '' : (v as number) < 0 ? 'text-red-600' : 'text-emerald-600' },
      { key: 'devToSalesRatio', label: 'Dev/Sales', align: 'right', format: (v) => v != null ? fmtPctAbs(v as number) : '—' },
    ],
    getData: (data) => (data.topOutletsBySales || []) as unknown as DrillRow[],
  },
  nominalDeviasi: {
    title: 'Top 10 Items by Nominal Deviasi',
    description: 'Item dengan financial impact tertinggi (absolute nominal deviation)',
    columns: [
      { key: 'itemName', label: 'Item' },
      { key: 'outletCode', label: 'Outlet' },
      { key: 'nominalDeviasi', label: 'Nominal Deviasi', align: 'right', format: (v) => fmtIDR(v as number), color: (v) => v == null ? '' : (v as number) < 0 ? 'text-red-600' : 'text-emerald-600' },
      { key: 'direction', label: 'Dir', align: 'center', format: (v) => (v as string)?.[0] || '-', color: (v) => directionColor(v as string) },
    ],
    getData: (data) => (data.topItemsByNominal || []) as unknown as DrillRow[],
  },
  qtyBom: {
    title: 'Top 10 Items (by Nominal Deviasi)',
    description: 'Item dengan financial impact tertinggi — proxy untuk QTY BOM',
    columns: [
      { key: 'itemName', label: 'Item' },
      { key: 'outletCode', label: 'Outlet' },
      { key: 'nominalDeviasi', label: 'Nominal Deviasi', align: 'right', format: (v) => fmtIDR(v as number), color: (v) => v == null ? '' : (v as number) < 0 ? 'text-red-600' : 'text-emerald-600' },
      { key: 'direction', label: 'Dir', align: 'center', format: (v) => (v as string)?.[0] || '-', color: (v) => directionColor(v as string) },
    ],
    getData: (data) => (data.topItemsByNominal || []) as unknown as DrillRow[],
  },
  qtyDeviasi: {
    title: 'Top 10 Items by Deviation/BOM',
    description: 'Item dengan operational abnormality tertinggi (normalized)',
    columns: [
      { key: 'itemName', label: 'Item' },
      { key: 'outletCode', label: 'Outlet' },
      { key: 'devBom', label: 'Dev/BOM', align: 'right', format: (v) => fmtPctAbs(v as number) },
      { key: 'tolerance', label: 'Tolerance', align: 'right', format: (v) => v != null ? fmtPctAbs(v as number) : '—' },
    ],
    getData: (data) => (data.topItemsByDevBom || []) as unknown as DrillRow[],
  },
  waste: {
    title: 'Top 10 Items by Waste',
    description: 'Item dengan waste tertinggi (QTY & nominal)',
    columns: [
      { key: 'itemName', label: 'Item' },
      { key: 'outletCode', label: 'Outlet' },
      { key: 'qtyWaste', label: 'QTY Waste', align: 'right', format: (v) => fmtNum(v as number) },
      { key: 'nominalWaste', label: 'Nominal Waste', align: 'right', format: (v) => fmtIDR(v as number) },
    ],
    getData: (data) => (data.topItemsByWaste || []) as unknown as DrillRow[],
  },
  susut: {
    title: 'Top 10 Items by Susut',
    description: 'Item dengan susut (shrinkage) tertinggi',
    columns: [
      { key: 'itemName', label: 'Item' },
      { key: 'outletCode', label: 'Outlet' },
      { key: 'qtySusut', label: 'QTY Susut', align: 'right', format: (v) => fmtNum(v as number) },
      { key: 'nominalSusut', label: 'Nominal Susut', align: 'right', format: (v) => fmtIDR(v as number) },
    ],
    getData: (data) => (data.topItemsBySusut || []) as unknown as DrillRow[],
  },
  trial: {
    title: 'Top 10 Items by Trial',
    description: 'Item dengan trial tertinggi',
    columns: [
      { key: 'itemName', label: 'Item' },
      { key: 'outletCode', label: 'Outlet' },
      { key: 'qtyTrial', label: 'QTY Trial', align: 'right', format: (v) => fmtNum(v as number) },
      { key: 'nominalTrial', label: 'Nominal Trial', align: 'right', format: (v) => fmtIDR(v as number) },
    ],
    getData: (data) => (data.topItemsByTrial || []) as unknown as DrillRow[],
  },
  lossSurplus: {
    title: 'Top 10 Items by Loss/Surplus',
    description: 'Item dengan residual loss/surplus tertinggi',
    columns: [
      { key: 'itemName', label: 'Item' },
      { key: 'outletCode', label: 'Outlet' },
      { key: 'qtyLossSurplus', label: 'QTY LS', align: 'right', format: (v) => fmtNum(v as number) },
      { key: 'nominalLossSurplus', label: 'Nominal LS', align: 'right', format: (v) => fmtIDR(v as number) },
      { key: 'direction', label: 'Dir', align: 'center', format: (v) => (v as string)?.[0] || '-', color: (v) => directionColor(v as string) },
    ],
    getData: (data) => (data.topItemsByLossSurplus || []) as unknown as DrillRow[],
  },
  loss: {
    title: 'Top 10 Outlets by Loss',
    description: 'Outlet dengan total LOSS tertinggi (actual > SOC, nominalDeviasi < 0 = rugi)',
    columns: [
      { key: 'outletCode', label: 'Outlet' },
      { key: 'area', label: 'Area' },
      { key: 'lossAmount', label: 'Loss Amount', align: 'right', format: (v) => fmtIDR(v as number) },
      { key: 'sales', label: 'Sales', align: 'right', format: (v) => fmtIDR(v as number) },
    ],
    // BUG FIX #003: Filter by LOSS direction, not just absNominal
    getData: (data) => (data.topOutlets || [])
      .filter((o: TopOutlet) => o && o.direction === 'LOSS')
      .sort((a, b) => b.absNominal - a.absNominal) as unknown as DrillRow[],
  },
  surplus: {
    title: 'Top 10 Outlets by Surplus',
    description: 'Outlet dengan total SURPLUS tertinggi (actual < SOC, nominalDeviasi > 0 = untung)',
    columns: [
      { key: 'outletCode', label: 'Outlet' },
      { key: 'area', label: 'Area' },
      { key: 'surplusAmount', label: 'Surplus Amount', align: 'right', format: (v) => fmtIDR(v as number) },
      { key: 'sales', label: 'Sales', align: 'right', format: (v) => fmtIDR(v as number) },
    ],
    // BUG FIX #003: Filter by SURPLUS direction, not just absNominal
    getData: (data) => (data.topOutlets || [])
      .filter((o: TopOutlet) => o && o.direction === 'SURPLUS')
      .sort((a, b) => b.absNominal - a.absNominal) as unknown as DrillRow[],
  },
};

export function CardDrillDown({ data }: CardDrillDownProps) {
  const { cardDrillDown, setCardDrillDown } = useDashboard();
  const open = Boolean(cardDrillDown);
  const config = cardDrillDown ? CARD_CONFIG[cardDrillDown] : null;

  const rows = config && data ? config.getData(data) : [];

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) setCardDrillDown(null); }}>
      <DialogContent className="sm:max-w-[800px] max-h-[80vh] flex flex-col overflow-hidden" showCloseButton={false}>
        <DialogHeader className="shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="text-base">{config?.title || 'Drill-down'}</DialogTitle>
              <DialogDescription className="text-xs mt-1">{config?.description}</DialogDescription>
            </div>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setCardDrillDown(null)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto border rounded-md">
          {rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Tidak ada data</div>
          ) : (
            <Table>
              <TableHeader className="sticky top-0 bg-background z-10">
                <TableRow>
                  <TableHead className="text-xs w-8">#</TableHead>
                  {config?.columns.map((col) => (
                    <TableHead key={col.key} className={`text-xs ${col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : ''}`}>
                      {col.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row: DrillRow, i: number) => (
                  <TableRow key={i}>
                    <TableCell className="text-xs text-muted-foreground">{i + 1}</TableCell>
                    {config?.columns.map((col) => {
                      const val = row[col.key];
                      const formatted = col.format ? col.format(val, row) : String(val ?? '—');
                      const colorClass = col.color ? col.color(val, row) : '';
                      return (
                        <TableCell key={col.key} className={`text-xs ${col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : ''} ${colorClass}`}>
                          {formatted}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        {rows.length > 0 && (
          <div className="flex items-center justify-between pt-2 text-xs text-muted-foreground">
            <span>Menampilkan {rows.length} item teratas</span>
            <Badge variant="outline" className="text-[11px]">
              {data?.period.weekLabel} {data?.period.monthLabel}
            </Badge>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
