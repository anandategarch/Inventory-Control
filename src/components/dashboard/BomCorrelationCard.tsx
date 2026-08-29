'use client';

import { memo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { fmtNum, fmtPct } from '@/lib/format';
import { GitCompare } from 'lucide-react';

interface MetricRow {
  name: string;
  current: number | null;
  growth: number | null;
  previous: number | null;
  aligned: boolean | null; // null = baseline (BOM)
}

function BomCorrelationCardInner({ data }: { data: AnalysisData }) {
  const s = data.executiveSummary;

  const bomGrowth = s?.qtyBom.growth ?? null;
  const bomUp = (bomGrowth ?? 0) > 0;
  const bomDown = (bomGrowth ?? 0) < 0;

  const rows: MetricRow[] = (() => {
    if (!s) return [];
    const checkAligned = (growth: number | null): boolean | null => {
      if (growth == null || bomGrowth == null) return null;
      if (bomGrowth === 0) return null;
      const metricUp = growth > 0;
      const metricDown = growth < 0;
      return (bomUp && metricUp) || (bomDown && metricDown);
    };

    return [
      { name: 'QTY BOM', current: s.qtyBom.current, growth: bomGrowth, previous: s.qtyBom.previous, aligned: null },
      { name: 'QTY Deviasi', current: s.qtyDeviasi.current, growth: s.qtyDeviasi.growth, previous: s.qtyDeviasi.previous, aligned: checkAligned(s.qtyDeviasi.growth) },
      { name: 'QTY Waste', current: s.qtyWaste.current, growth: s.qtyWaste.growth, previous: s.qtyWaste.previous, aligned: checkAligned(s.qtyWaste.growth) },
      { name: 'QTY Susut', current: s.qtySusut.current, growth: s.qtySusut.growth, previous: s.qtySusut.previous, aligned: checkAligned(s.qtySusut.growth) },
      { name: 'QTY Trial', current: s.qtyTrial.current, growth: s.qtyTrial.growth, previous: s.qtyTrial.previous, aligned: checkAligned(s.qtyTrial.growth) },
    ];
  })();

  const findings = (() => {
    if (!s) return [{ text: 'Data tidak tersedia', type: 'warning' as const }];
    const result: { text: string; type: 'warning' | 'ok' }[] = [];
    const devGrowth = s.qtyDeviasi.growth;
    const wasteGrowth = s.qtyWaste.growth;
    const susutGrowth = s.qtySusut.growth;
    const trialGrowth = s.qtyTrial.growth;

    // Deviasi vs BOM proporsionalitas
    if (bomUp && devGrowth != null && devGrowth > 0) {
      const ratio = devGrowth / (bomGrowth ?? 1);
      if (ratio > 2) result.push({ text: `Deviasi naik ${fmtPct(devGrowth, true)} jauh melebihi BOM naik ${fmtPct(bomGrowth, true)} (rasio ${ratio.toFixed(1)}×)`, type: 'warning' });
      else if (ratio > 1.5) result.push({ text: `Deviasi naik ${fmtPct(devGrowth, true)} tidak proporsional dengan BOM naik ${fmtPct(bomGrowth, true)} (rasio ${ratio.toFixed(1)}×)`, type: 'warning' });
      else result.push({ text: `Deviasi naik proporsional dengan BOM (rasio ${ratio.toFixed(1)}×)`, type: 'ok' });
    }
    if (bomDown && devGrowth != null && devGrowth > 0) result.push({ text: `BOM turun ${fmtPct(bomGrowth, true)} tapi deviasi naik ${fmtPct(devGrowth, true)} — tidak sejalan`, type: 'warning' });

    // Waste vs BOM
    if (bomUp && wasteGrowth != null && wasteGrowth < 0) result.push({ text: `Waste turun ${fmtPct(wasteGrowth, true)} saat BOM naik ${fmtPct(bomGrowth, true)} — harusnya ikut naik`, type: 'warning' });
    if (bomDown && wasteGrowth != null && wasteGrowth > 0) result.push({ text: `Waste naik ${fmtPct(wasteGrowth, true)} saat BOM turun ${fmtPct(bomGrowth, true)} — harusnya ikut turun`, type: 'warning' });

    // Susut vs BOM
    if (bomUp && susutGrowth != null && susutGrowth < 0) result.push({ text: `Susut turun ${fmtPct(susutGrowth, true)} saat BOM naik ${fmtPct(bomGrowth, true)} — harusnya ikut naik`, type: 'warning' });
    if (bomDown && susutGrowth != null && susutGrowth > 0) result.push({ text: `Susut naik ${fmtPct(susutGrowth, true)} saat BOM turun ${fmtPct(bomGrowth, true)} — harusnya ikut turun`, type: 'warning' });

    // Trial vs BOM
    if (bomUp && trialGrowth != null && trialGrowth < 0) result.push({ text: `Trial turun ${fmtPct(trialGrowth, true)} saat BOM naik ${fmtPct(bomGrowth, true)} — harusnya ikut naik`, type: 'warning' });
    if (bomDown && trialGrowth != null && trialGrowth > 0) result.push({ text: `Trial naik ${fmtPct(trialGrowth, true)} saat BOM turun ${fmtPct(bomGrowth, true)} — harusnya ikut turun`, type: 'warning' });

    if (result.length === 0) result.push({ text: 'Semua metrik sejalan dengan BOM', type: 'ok' });
    return result;
  })();

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-cyan-50 dark:bg-cyan-950/40 text-cyan-600 dark:text-cyan-400 shrink-0">
            <GitCompare className="h-3.5 w-3.5" />
          </span>
          Analisis Korelasi BOM
          <FormulaInfo
            formula="Metrik harus sejalan dengan BOM"
            description="QTY Deviasi, Waste, Susut, dan Trial seharusnya naik/turun bersama BOM. Jika berlawanan arah → indikasi anomali. Rasio deviasi/BOM > 1.5× = tidak proporsional."
            example="BOM naik 10%, Waste turun 5% → ⚠ tidak sejalan"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Cek apakah Deviasi/Waste/Susut/Trial sejalan dengan arah BOM
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
              <TableRow className="border-b hover:bg-transparent">
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3">Metrik</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right">Current</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right">Growth</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right">Previous</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-center">Sejalan?</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.name} className="hover:bg-muted/40 transition-colors border-b">
                  <TableCell className="text-[11px] px-3 py-2 font-medium">{row.name}</TableCell>
                  <TableCell className="text-[11px] px-3 py-2 text-right tabular-nums">{fmtNum(row.current)}</TableCell>
                  <TableCell className={`text-[11px] px-3 py-2 text-right tabular-nums ${(row.growth ?? 0) > 0 ? 'text-red-600 dark:text-red-400' : (row.growth ?? 0) < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
                    {row.growth != null ? fmtPct(row.growth, true) : '—'}
                  </TableCell>
                  <TableCell className="text-[11px] px-3 py-2 text-right tabular-nums text-muted-foreground">{fmtNum(row.previous)}</TableCell>
                  <TableCell className="text-[11px] px-3 py-2 text-center">
                    {row.aligned === null ? (
                      <span className="text-muted-foreground text-[10px]">— (baseline)</span>
                    ) : row.aligned ? (
                      <Badge variant="outline" className="text-[10px] h-4 px-1 border-emerald-300 text-emerald-700 bg-emerald-50 dark:border-emerald-800 dark:text-emerald-400 dark:bg-emerald-950/30">✓ Ya</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] h-4 px-1 border-red-300 text-red-700 bg-red-50 dark:border-red-800 dark:text-red-400 dark:bg-red-950/30">⚠ Tidak</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* Findings */}
        <div className="p-3 space-y-1.5 border-t">
          {findings.map((f, i) => (
            <div key={i} className={`text-[11px] flex items-start gap-1.5 ${f.type === 'warning' ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'}`}>
              <span className="shrink-0">{f.type === 'warning' ? '⚠' : '✓'}</span>
              <span>{f.text}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export const BomCorrelationCard = memo(BomCorrelationCardInner);
