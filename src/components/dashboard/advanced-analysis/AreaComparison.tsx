'use client';

// AreaComparison — "Perbandingan Area" card. Moved verbatim from
// AdvancedAnalysis.tsx (REFACTOR-1-c pure split — zero behavior change).

import { memo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { MapPin } from 'lucide-react';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { QuickSettings } from '@/components/dashboard/QuickSettings';
import { useDashboard } from '@/hooks/useDashboard';
import { fmtIDR, fmtPct, fmtPctAbs } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { lossToSalesColor } from './health-badges';

// ============================================================
//  1.4 AreaComparison
//  Perbandingan antar area
// ============================================================
export const AreaComparison = memo(function AreaComparison({ data }: { data: AnalysisData }) {
  const setArea = useDashboard((s) => s.setArea);
  const areas = (data.areaAnalysis || [])
    .slice()
    .sort((a, b) => b.totalAbsNominal - a.totalAbsNominal);

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
            <MapPin className="h-3.5 w-3.5" />
          </span>
          Perbandingan Area
          <FormulaInfo
            formula="LOSS/PENJUALAN = Total LOSS / Total PENJUALAN per area"
            description={'UNTUK APA: Membandingkan performa deviasi antar area untuk intervensi tertarget.\nCARA BACA: Area dengan LOSS/PENJUALAN tinggi = paling boros. Klik baris untuk filter dashboard by area.\nCONTOH: JAWA BARAT 1: LOSS Rp 2M / PENJUALAN Rp 20M = 10% (buruk).\nACTION: Area terburuk → evaluasi proses area & bandingkan dengan area terbaik.'}
            example="JAKBAR: LOSS 8M / Sales 80M = 10% (kritis)"
            side="bottom"
          />
          <QuickSettings
            settings={[
              { key: 'BENCHMARK_AREA_FACTOR', label: 'Faktor Benchmark Area', dataType: 'number', min: 1, max: 5, step: 0.5 },
            ]}
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          <span className="font-medium tabular-nums">{areas.length}</span> area · diurutkan dari NOMINAL DEVIASI terbesar
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-80">
          <Table>
            <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
              <TableRow className="border-b hover:bg-transparent">
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3">Area</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3 text-right">Outlets</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3 text-right">PENJUALAN</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3 text-right">|NOMINAL DEVIASI|</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3 text-right">LOSS/PENJUALAN</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3 text-right">% DEV TO BOM</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {areas.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center text-xs text-muted-foreground py-8">Tidak ada data</TableCell></TableRow>
              ) : areas.map((a, i) => {
                const isWorst = i === 0;
                const isBest = i === areas.length - 1;
                return (
                  <TableRow
                    key={a.area}
                    className={`cursor-pointer hover:bg-muted/40 transition-colors ${i % 2 === 1 ? 'bg-muted/20' : ''}`}
                    {...clickableRowProps(() => setArea(a.area))}
                  >
                    <TableCell className="text-xs px-3 py-2 font-medium">
                      <div className="flex items-center gap-1.5">
                        {isWorst && <span className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" title="Terburuk" />}
                        {isBest && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" title="Terbaik" />}
                        <span className="break-words leading-tight" title={a.area}>{a.area}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs px-3 py-2 text-right text-muted-foreground tabular-nums">{a.outletCount}</TableCell>
                    <TableCell className="text-xs px-3 py-2 text-right tabular-nums">{fmtIDR(a.totalSales)}</TableCell>
                    <TableCell className="text-xs px-3 py-2 text-right font-semibold tabular-nums">{fmtIDR(a.totalAbsNominal)}</TableCell>
                    <TableCell className={`text-xs px-3 py-2 text-right font-semibold tabular-nums ${lossToSalesColor(a.lossToSales)}`}>{fmtPct(a.lossToSales, false)}</TableCell>
                    <TableCell className="text-xs px-3 py-2 text-right tabular-nums">{fmtPctAbs(a.avgDevBom)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
});
