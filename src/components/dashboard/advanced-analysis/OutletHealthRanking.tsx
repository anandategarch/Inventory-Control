'use client';

// OutletHealthRanking — "Ranking Kondisi Outlet" card. Moved verbatim
// from AdvancedAnalysis.tsx (REFACTOR-1-c pure split — zero behavior
// change).

import { memo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Progress } from '@/components/ui/progress';
import { Heart } from 'lucide-react';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { QuickSettings } from '@/components/dashboard/QuickSettings';
import { useDashboard } from '@/hooks/useDashboard';
import { fmtIDR, fmtPctAbs } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { healthScoreBg, healthScoreColor } from './health-badges';

// ============================================================
//  1.2 OutletHealthRanking
//  Ranking kondisi outlet dengan skor gabungan
// ============================================================
export const OutletHealthRanking = memo(function OutletHealthRanking({ data }: { data: AnalysisData }) {
  const setFocusOutlet = useDashboard((s) => s.setFocusOutlet);
  const ranking = (data.outletHealthRanking || []).slice().sort((a, b) => a.healthScore - b.healthScore);
  const worstCount = ranking.filter((o) => o.healthScore < 50).length;
  const criticalCount = ranking.filter((o) => o.healthScore < 30).length;

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 shrink-0">
            <Heart className="h-3.5 w-3.5" />
          </span>
          Ranking Kondisi Outlet
          <FormulaInfo
            formula="Skor = 30% % DEV TO BOM + 25% RESIDUAL + 25% LOSS/PENJUALAN + 20% Jumlah Masalah"
            description={'UNTUK APA: Memberikan skor kondisi outlet 0-100 (100 = sempurna, 0 = kritis) berdasarkan komposit 4 metric.\nCARA BACA: Skor = 30% Dev/BOM + 25% Residual + 25% Loss/Sales + 20% Abnormal Count. Diurutkan dari terburuk.\nCONTOH: Dev/BOM 49% → skor 2, Residual 96% → skor 4, Loss/Sales 7% → skor 65, Abnormal 50 → skor 0. Weighted: 18.\nACTION: Outlet skor < 30 = kritis, butuh intervensi segera.'}
            example="Outlet A: devBom 18% + residual 60% + loss/sales 8% + 12 masalah → skor 35 (kritis)"
            side="bottom"
          />
          <QuickSettings
            settings={[
              { key: 'HEALTH_WEIGHT_DEV_BOM', label: 'Bobot Dev/BOM (Health)', dataType: 'number', min: 0, max: 100, step: 5 },
              { key: 'HEALTH_WEIGHT_RESIDUAL', label: 'Bobot Residual (Health)', dataType: 'number', min: 0, max: 100, step: 5 },
              { key: 'HEALTH_WEIGHT_LOSS_TO_SALES', label: 'Bobot Loss/Sales (Health)', dataType: 'number', min: 0, max: 100, step: 5 },
              { key: 'HEALTH_WEIGHT_ABNORMAL', label: 'Bobot Abnormal (Health)', dataType: 'number', min: 0, max: 100, step: 5 },
            ]}
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          <span className="font-medium tabular-nums">{worstCount}</span> outlet terburuk · <span className="text-red-600 dark:text-red-400 font-medium tabular-nums">{criticalCount} kritis</span>
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-80">
          <Table>
            <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
              <TableRow className="border-b hover:bg-transparent">
                <TableHead className="text-xs font-semibold uppercase tracking-wider w-8 h-8 px-3">#</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3">Outlet</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3">Skor</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3 text-right">% DEV TO BOM</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3 text-right">Masalah</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 px-3 text-right">NOMINAL DEVIASI</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ranking.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center text-xs text-muted-foreground py-8">Tidak ada data</TableCell></TableRow>
              ) : ranking.map((o, i) => (
                <TableRow
                  key={o.outletCode}
                  className={`cursor-pointer hover:bg-muted/40 transition-colors ${i % 2 === 1 ? 'bg-muted/20' : ''} ${o.healthScore < 30 ? 'bg-red-50/30 dark:bg-red-950/10' : ''}`}
                  {...clickableRowProps(() => setFocusOutlet(o.outletCode))}
                >
                  <TableCell className="text-xs text-muted-foreground px-3 py-2 tabular-nums">{i + 1}</TableCell>
                  <TableCell className="px-3 py-2">
                    <div className="text-xs font-medium leading-tight whitespace-normal" title={o.outletName}>{o.outletName}</div>
                    <div className="text-xs text-muted-foreground">{o.outletCode} · {o.area}</div>
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <div className="flex items-center gap-1.5 min-w-[80px]">
                      <Progress value={o.healthScore} className="h-1.5" indicatorClassName={healthScoreBg(o.healthScore)} />
                      <span className={`text-xs font-semibold tabular-nums ${healthScoreColor(o.healthScore)}`}>{o.healthScore}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs px-3 py-2 text-right tabular-nums">{fmtPctAbs(o.devBom)}</TableCell>
                  <TableCell className="text-xs px-3 py-2 text-right text-red-600 dark:text-red-400 font-medium tabular-nums">{o.abnormal}</TableCell>
                  <TableCell className="text-xs px-3 py-2 text-right font-semibold tabular-nums">
                    {/* FIX: display SIGNED nominalDeviasi (negative=LOSS=red, positive=SURPLUS=green) */}
                    {/* FIX (AUDIT-CALC-FRONTEND P1-3): was fallback to o.absNominal (always ≥0) when
                        nominalDeviasi is null → worst-ranking outlets colored green. Now show '—' if null. */}
                    <span className={o.nominalDeviasi != null
                      ? (o.nominalDeviasi < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')
                      : 'text-muted-foreground'}>
                      {o.nominalDeviasi != null ? fmtIDR(o.nominalDeviasi) : '—'}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
});
