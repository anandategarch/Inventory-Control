'use client';

// ItemConsistencyAnalysis — "Analisis Pola Item" card. Moved verbatim
// from AdvancedAnalysis.tsx (REFACTOR-1-c pure split — zero behavior
// change).

import { memo, useState, useMemo, Fragment } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
// SHADCN-PATTERNS (Pattern 4) — reusable structured EmptyState. Used
// inside ItemConsistencyAnalysis's empty-row fallback. Kept inside a
// `<TableRow><TableCell colSpan={8}>` wrapper to preserve valid table
// HTML (a bare <div> in <tbody> would be invalid).
import { EmptyState } from '@/components/ui/empty-state';
import { Link2, ChevronRight, ChevronDown } from 'lucide-react';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { fmtIDR, fmtPctAbs } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { consistencyLabel, consistencyBadge } from './health-badges';
import { AnomaliOutletExpansion } from './AnomaliOutletExpansion';

export const ItemConsistencyAnalysis = memo(function ItemConsistencyAnalysis({ data }: { data: AnalysisData }) {
  // FIX (ANOMALI-OUTLETS): inline row expansion replaces DrillDownDrawer popup.
  // Pull month/week/filters + setFocusOutlet from the dashboard store so the
  // expansion panel can fetch the per-outlet anomali list + navigate to the
  // Resto Analysis tab on click.
  const {
    monthLabel,
    currentWeek,
    area,
    kelompok,
    outletCode,
    pic,
    setFocusOutlet,
  } = useDashboard(
    useShallow((s) => ({
      monthLabel: s.monthLabel,
      currentWeek: s.currentWeek,
      area: s.area,
      kelompok: s.kelompok,
      outletCode: s.outletCode,
      pic: s.pic,
      setFocusOutlet: s.setFocusOutlet,
    })),
  );

  // Expand/collapse state. Only ONE row expanded at a time — clicking
  // another closes the previous. `expandedDirection` is the MINORITY
  // direction of the currently-expanded row (passed to the API).
  const [expandedItem, setExpandedItem] = useState<string | null>(null);
  const [expandedDirection, setExpandedDirection] = useState<'LOSS' | 'SURPLUS' | null>(null);

  // Use unified items list from backend (outlet-count-based classification)
  // Fallback to mapping from systemic/episodic for backward compat
  const ca = data.itemConsistencyAnalysis || { systemic: [], episodic: [], items: [] };
  const rows: Array<{
    itemName: string;
    outletCount: number;
    lossOutlets: number;
    surplusOutlets: number;
    absNominal: number;
    avgDevBom: number;
    type: 'SYSTEMIC' | 'WIDESPREAD' | 'ISOLATED';
  }> = useMemo(() => {
    const r: Array<{
      itemName: string;
      outletCount: number;
      lossOutlets: number;
      surplusOutlets: number;
      absNominal: number;
      avgDevBom: number;
      type: 'SYSTEMIC' | 'WIDESPREAD' | 'ISOLATED';
    }> = (ca.items && ca.items.length > 0)
      ? ca.items.map((i) => ({
          itemName: i.itemName,
          outletCount: i.outletCount,
          lossOutlets: i.lossOutlets,
          surplusOutlets: i.surplusOutlets,
          absNominal: i.totalAbsNominal,
          avgDevBom: i.avgDevBom,
          type: i.consistency,
        }))
      : [
          ...(ca.systemic || []).map((s) => ({
            itemName: s.itemName,
            outletCount: s.occurrences,
            lossOutlets: 0,
            surplusOutlets: 0,
            absNominal: s.absNominal,
            avgDevBom: s.avgDevBom,
            type: (s.occurrences >= 10 ? 'SYSTEMIC' : 'WIDESPREAD') as 'SYSTEMIC' | 'WIDESPREAD',
          })),
          ...(ca.episodic || []).map((s) => ({
            itemName: s.itemName,
            outletCount: 1,
            lossOutlets: 0,
            surplusOutlets: 0,
            absNominal: s.absNominal,
            avgDevBom: s.devBom,
            type: 'ISOLATED' as 'ISOLATED',
          })),
        ].sort((a, b) => b.absNominal - a.absNominal);
    return r;
  }, [ca.items, ca.systemic, ca.episodic]);

  const systemicCount = rows.filter((r) => r.type === 'SYSTEMIC').length;
  const widespreadCount = rows.filter((r) => r.type === 'WIDESPREAD').length;
  const isolatedCount = rows.filter((r) => r.type === 'ISOLATED').length;

  // Toggle expansion for a row. When anomaliCount === 0 (item is 100% one
  // direction), there are no anomali outlets to show — don't expand.
  const onRowClick = (row: typeof rows[number]) => {
    const minorityDirection: 'LOSS' | 'SURPLUS' = row.lossOutlets > row.surplusOutlets ? 'SURPLUS' : 'LOSS';
    const anomaliCount = Math.min(row.lossOutlets, row.surplusOutlets);
    if (anomaliCount === 0) return;
    if (expandedItem === row.itemName) {
      setExpandedItem(null);
      setExpandedDirection(null);
    } else {
      setExpandedItem(row.itemName);
      setExpandedDirection(minorityDirection);
    }
  };

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
            <Link2 className="h-3.5 w-3.5" />
          </span>
          Analisis Pola Item
          <FormulaInfo
            formula="Outlets = COUNT(DISTINCT outlet) per item dengan deviasi"
            description={'UNTUK APA: Mengidentifikasi item yang menyimpang di multiple outlet (pola penyimpangan).\nCARA BACA: Massal (≥10 outlet) = masalah produk/QTY BOM. Regional (5-9 outlet) = pola area tertentu. Lokal (2-4 outlet) = anomali outlet spesifik.\nCONTOH: UDANG KEJU FROZEN deviasi di 15 outlet = Massal → cek QTY BOM atau harga beli.\nACTION: Massal → revisi master data QTY BOM. Regional → evaluasi pelatihan area. Lokal → investigasi outlet spesifik.'}
            example="UDANG KEJU FROZEN deviasi di 15 outlet = Massal"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          <span className="font-medium text-red-600 dark:text-red-400 tabular-nums">{systemicCount} massal</span> · <span className="font-medium text-amber-600 dark:text-amber-400 tabular-nums">{widespreadCount} regional</span> · <span className="font-medium tabular-nums">{isolatedCount} lokal</span>
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-80">
          <Table>
            <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
              <TableRow className="border-b hover:bg-transparent">
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3">NAMA BAHAN</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3">Type</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3 text-right">Outlets</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3 text-right">LOSS</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3 text-right">SURPLUS</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3 text-center">⚠️ Anomali</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3 text-right">|NOMINAL DEVIASI|</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3 text-right">Rata-rata % DEV TO BOM</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                // SHADCN-PATTERNS (Pattern 4) — replaced inline "Tidak ada
                // data" TableCell text with <EmptyState>. Wrapped in a
                // TableRow/TableCell so it stays valid table HTML.
                <TableRow>
                  <TableCell colSpan={8} className="p-0">
                    <EmptyState icon={Link2} title="Tidak ada data" />
                  </TableCell>
                </TableRow>
              ) : rows.map((row, i) => {
                // Minority direction = the LESS-FREQUENT direction of the item.
                // Anomali count = number of outlets in the minority direction.
                // When 0, the row is not expandable (no anomali to show).
                const minorityDirection: 'LOSS' | 'SURPLUS' = row.lossOutlets > row.surplusOutlets ? 'SURPLUS' : 'LOSS';
                const anomaliCount = Math.min(row.lossOutlets, row.surplusOutlets);
                const isExpanded = expandedItem === row.itemName && expandedDirection !== null;
                return (
                  <Fragment key={`${row.itemName}-${i}`}>
                    <TableRow
                      className={`cursor-pointer hover:bg-muted/40 transition-colors ${i % 2 === 1 ? 'bg-muted/20' : ''} ${isExpanded ? 'bg-amber-50/40 dark:bg-amber-950/10' : ''}`}
                      {...clickableRowProps(() => onRowClick(row))}
                    >
                      <TableCell className="text-xs px-3 py-2 font-medium whitespace-normal" title={row.itemName}>{row.itemName}</TableCell>
                      <TableCell className="px-3 py-2">
                        <Badge variant="outline" className={`text-[11px] px-1.5 py-0 font-medium ${consistencyBadge(row.type)}`}>{consistencyLabel(row.type)}</Badge>
                      </TableCell>
                      <TableCell className="text-xs px-3 py-2 text-right font-semibold tabular-nums">{row.outletCount}</TableCell>
                      <TableCell className="text-xs px-3 py-2 text-right text-red-600 dark:text-red-400 font-medium tabular-nums">{row.lossOutlets}</TableCell>
                      <TableCell className="text-xs px-3 py-2 text-right text-emerald-600 dark:text-emerald-400 font-medium tabular-nums">{row.surplusOutlets}</TableCell>
                      <TableCell className="text-xs px-3 py-2 text-center">
                        {anomaliCount > 0 ? (
                          <Badge variant="outline" className="text-[10px] h-5 px-1.5 gap-0.5 cursor-pointer text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30">
                            {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                            {anomaliCount} {minorityDirection === 'LOSS' ? 'L' : 'S'}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs px-3 py-2 text-right font-semibold tabular-nums">{fmtIDR(row.absNominal)}</TableCell>
                      <TableCell className="text-xs px-3 py-2 text-right tabular-nums">{fmtPctAbs(row.avgDevBom)}</TableCell>
                    </TableRow>
                    {isExpanded && expandedDirection && (
                      <AnomaliOutletExpansion
                        itemName={row.itemName}
                        direction={expandedDirection}
                        monthLabel={monthLabel}
                        currentWeek={currentWeek}
                        area={area}
                        kelompok={kelompok}
                        outletCode={outletCode}
                        pic={pic}
                        setFocusOutlet={setFocusOutlet}
                      />
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
});
