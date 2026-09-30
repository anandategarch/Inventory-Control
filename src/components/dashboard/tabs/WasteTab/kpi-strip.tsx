'use client';

// ============================================================
//  WasteKpiStrip — Ringkasan waste jaringan (DEEP-WASTE-1)
//  --------------------------------------------------------
//  The in-app version of the offline report's "Ringkasan" sheet:
//  window KPIs (Σ sales / waste / susut / trial / residual,
//  waste/sales) + severity chips for the 4 network detectors.
//  Props-driven (the parent WasteTab owns the /api/waste-series
//  query — one request feeds every series card).
// ============================================================

import { memo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Gauge } from 'lucide-react';
import { fmtIDR, fmtPct } from '@/lib/format';
import type { WasteKpis } from './types';

function KpiCell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 dark:bg-zinc-800/30 px-3 py-2 min-w-0">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground truncate">{label}</p>
      <p className={`text-sm font-semibold tabular-nums mt-0.5 truncate ${tone ?? ''}`}>{value}</p>
    </div>
  );
}

export const WasteKpiStrip = memo(function WasteKpiStrip({
  kpis,
  week,
  monthsCount,
}: {
  kpis: WasteKpis;
  week: string;
  monthsCount: number;
}) {
  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <Gauge className="h-3.5 w-3.5" />
          </span>
          Ringkasan Waste — Same-Week ({week})
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Agregat {kpis.outlets} outlet selama {monthsCount} bulan (maks. 12 bulan terakhir, same-week —
          minggu bersifat kumulatif sehingga perbandingan antar bulan HANYA valid pada minggu yang sama).
          Waste/Susut/Trial/Residual = ΣABS nominal per bulan.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          <KpiCell label="Σ Sales" value={fmtIDR(kpis.sales)} />
          <KpiCell label="Σ Waste" value={fmtIDR(kpis.waste)} tone="text-amber-600 dark:text-amber-400" />
          <KpiCell label="Σ Susut" value={fmtIDR(kpis.susut)} />
          <KpiCell label="Σ Trial" value={fmtIDR(kpis.trial)} />
          <KpiCell label="Σ Residual" value={fmtIDR(kpis.residual)} tone="text-zinc-600 dark:text-zinc-300" />
          <KpiCell label="Waste / Sales" value={fmtPct(kpis.wasteToSales, false, 2)} tone="text-amber-600 dark:text-amber-400 font-bold" />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground h-5">
            Loss bersih {fmtIDR(kpis.totalLoss - kpis.totalSurplus)}
          </Badge>
          {kpis.zeroWasteBigLossOutlets > 0 && (
            <Badge variant="outline" className="text-[10px] font-normal text-red-600 dark:text-red-400 border-red-300/70 dark:border-red-800/70 bg-red-50/60 dark:bg-red-950/30 h-5">
              {kpis.zeroWasteBigLossOutlets} outlet waste≈0 rugi besar
            </Badge>
          )}
          {kpis.spikeCells > 0 && (
            <Badge variant="outline" className="text-[10px] font-normal text-amber-700 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30 h-5">
              {kpis.spikeCells} sel bulanan lonjakan waste &gt; 2σ
            </Badge>
          )}
          {kpis.underRecordingOutlets > 0 && (
            <Badge variant="outline" className="text-[10px] font-normal text-yellow-700 dark:text-yellow-400 border-yellow-300/70 dark:border-yellow-800/70 bg-yellow-50/60 dark:bg-yellow-950/30 h-5">
              {kpis.underRecordingOutlets} outlet waste/sales &lt; 0,1%
            </Badge>
          )}
          {kpis.residualDominantOutlets > 0 && (
            <Badge variant="outline" className="text-[10px] font-normal text-zinc-600 dark:text-zinc-300 border-zinc-300/70 dark:border-zinc-700 bg-zinc-50/60 dark:bg-zinc-900/30 h-5">
              {kpis.residualDominantOutlets} outlet residual dominan
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
});
