'use client';

// ============================================================
//  WasteMatrixCard — "Matriks Bulanan" (DEEP-WASTE-1)
//  --------------------------------------------------------
//  Outlet × month matrix with a color-scale on the selected
//  metric (waste / susut / trial / residual / waste-sales-%) —
//  the in-app version of the offline report's 5-blok color-scale
//  matrix sheet. Rows: top outlets by total loss (15 default,
//  expandable). Cell color = value relative to the metric's max
//  across the matrix (rose alpha scale — higher = darker).
//  DQ-error months are marked in the column header.
//
//  FIX (WASTE-DRILL): sel berisi data kini klik → DrillDownDrawer
//  presisi BULAN (outlet + monthLabel sel — BUKAN window: nilai sel
//  adalah agregat outlet-bulan itu sendiri). Sel kosong tetap statis.
//  Keyboard parity via clickableRowProps pada <td> (helper rumah
//  bekerja pada elemen non-interaktif apa pun).
// ============================================================

import { memo, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LayoutGrid, ChevronDown, ChevronUp } from 'lucide-react';
import { fmtIDR, fmtPct, fmtHeatmapCompact } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';
import { useDashboard } from '@/hooks/useDashboard';
import type { WasteMonthlyRow, WasteMonthMeta } from './types';

type MatrixMetric = 'waste' | 'susut' | 'trial' | 'residual' | 'wasteToSales';

const METRICS: Array<{ value: MatrixMetric; label: string; isRatio: boolean }> = [
  { value: 'waste', label: 'Waste', isRatio: false },
  { value: 'susut', label: 'Susut', isRatio: false },
  { value: 'trial', label: 'Trial', isRatio: false },
  { value: 'residual', label: 'Residual', isRatio: false },
  { value: 'wasteToSales', label: 'Waste/Sales %', isRatio: true },
];

const INITIAL_ROWS = 15;

/** Cell color: rose alpha scaled by value/max (0.06 → 0.6). Works on light + dark. */
function cellStyle(value: number, max: number): React.CSSProperties {
  if (!Number.isFinite(value) || value <= 0 || max <= 0) return {};
  const t = Math.min(1, value / max);
  const alpha = 0.06 + t * 0.54;
  return { backgroundColor: `rgba(225, 29, 72, ${alpha.toFixed(3)})` };
}

function formatCell(value: number, isRatio: boolean): string {
  return isRatio ? fmtPct(value, false, 1) : fmtHeatmapCompact(value);
}

export const WasteMatrixCard = memo(function WasteMatrixCard({
  monthly,
  months,
}: {
  monthly: WasteMonthlyRow[];
  months: WasteMonthMeta[];
}) {
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const [metric, setMetric] = useState<MatrixMetric>('waste');
  const [expanded, setExpanded] = useState(false);
  // Safe fallback (metric always comes from METRICS) — avoids a non-null
  // assertion warning.
  const metricConf = METRICS.find((m) => m.value === metric) ?? METRICS[0];

  // Rows: outlets ranked by total loss (the loss-heavy first — the matrix
  // answers "di outlet mana, bulan apa, komponen meledak").
  const { rowOutlets, cellMap, max } = useMemo(() => {
    const byOutlet = new Map<string, WasteMonthlyRow[]>();
    let maxLoss = -1;
    let maxLossCode = '';
    for (const r of monthly) {
      const list = byOutlet.get(r.outletCode);
      if (list) list.push(r);
      else byOutlet.set(r.outletCode, [r]);
    }
    const outletsAgg = [...byOutlet.entries()].map(([code, rows]) => {
      const totalLoss = rows.reduce((a, r) => a + r.totalLoss, 0);
      if (totalLoss > maxLoss) { maxLoss = totalLoss; maxLossCode = code; }
      return { code, name: rows[0].outletName, totalLoss };
    }).sort((a, b) => b.totalLoss - a.totalLoss);
    void maxLossCode;
    const map = new Map<string, WasteMonthlyRow>();
    let mx = 0;
    for (const r of monthly) {
      map.set(`${r.outletCode}|${r.monthKey}`, r);
      const v = metric === 'wasteToSales' ? r.wasteToSales : r[metric];
      if (v > mx) mx = v;
    }
    return { rowOutlets: outletsAgg, cellMap: map, max: mx };
  }, [monthly, metric]);

  const visible = expanded ? rowOutlets : rowOutlets.slice(0, INITIAL_ROWS);

  // FIX (WASTE-DRILL): cell → month-precise drill (outlet + THAT month's
  // label — the cell's aggregate IS the outlet-month pair at the current
  // week label, so the drawer's WHERE monthLabel IN [bulan] + weekLabel
  // matches the cell exactly). Empty cells stay non-interactive.
  const handleCellDrill = (outletCode: string, monthLabel: string) => {
    setDrilldown({
      outletCode,
      itemName: null,
      months: [monthLabel],
    });
  };

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <LayoutGrid className="h-3.5 w-3.5" />
          </span>
          Matriks Bulanan Outlet × Bulan
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Baris = outlet terurut total loss (terbesar dulu); kolom = bulan same-week. Warna sel = intensitas nilai
          relatif terhadap maksimum matriks (makin gelap makin tinggi). Bulan dengan DQ error ditandai ⚠ pada kolomnya.
          <span className="font-medium text-foreground/70"> Klik sel berisi data untuk drill-down data sumber outlet-bulan itu.</span>
        </p>
        <div className="flex items-center gap-1.5 pt-2 ml-9 flex-wrap">
          {METRICS.map((m) => (
            <Button
              key={m.value}
              variant={metric === m.value ? 'default' : 'outline'}
              size="sm"
              className="h-6 text-[11px] px-2.5"
              onClick={() => setMetric(m.value)}
              aria-pressed={metric === m.value}
            >
              {m.label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {monthly.length === 0 || months.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Tidak ada data untuk matriks pada scope ini.</div>
        ) : (
          <>
            {/* FIX (BUGHUNT-R2): dropped dead `waste-scroll` class — defined
                in no stylesheet (grep: 0 CSS hits); max-h-96/overflow-auto
                wrapper kept. */}
            <div className="max-h-96 overflow-auto">
              <table className="w-full border-collapse text-xs min-w-[860px]">
                <thead className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm z-10">
                  <tr>
                    <th className="text-left font-semibold uppercase tracking-wider text-[10px] h-8 px-2 sticky left-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm z-20 min-w-[150px]">
                      Outlet
                    </th>
                    {months.map((m) => (
                      <th key={m.monthKey} className="text-center font-semibold text-[10px] h-8 px-1 whitespace-nowrap" title={m.dqError ? `DQ error: ${m.dqErrorCount} isu` : undefined}>
                        {/* FIX (BUGHUNT-R2): strip the trailing year generically —
                            the old replace(' 2026', '') hardcoded the dataset's
                            year and would break crossing into 2027. */}
                        {m.monthLabel.replace(/\s\d{4}$/, '')}{m.dqError ? ' ⚠' : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((o) => (
                    <tr key={o.code} className="border-t">
                      <td className="px-2 py-1.5 font-medium sticky left-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm z-10 whitespace-nowrap">
                        <span className="text-[11px]">{o.code}</span>
                        <span className="text-muted-foreground font-normal text-[10px]"> · {o.name}</span>
                      </td>
                      {months.map((m) => {
                        const cell = cellMap.get(`${o.code}|${m.monthKey}`);
                        const value = cell ? (metric === 'wasteToSales' ? cell.wasteToSales : cell[metric]) : 0;
                        return (
                          <td
                            key={m.monthKey}
                            className={cell
                              ? 'text-center tabular-nums px-1 py-1.5 whitespace-nowrap cursor-pointer hover:outline hover:outline-1 hover:outline-amber-500/70'
                              : 'text-center tabular-nums px-1 py-1.5 whitespace-nowrap'}
                            style={cellStyle(value, max)}
                            {...(cell ? clickableRowProps(() => handleCellDrill(o.code, m.monthLabel)) : {})}
                            title={cell
                              ? `${o.code} · ${m.monthLabel}: ${metric === 'wasteToSales' ? fmtPct(cell.wasteToSales, false, 2) : fmtIDR(cell[metric])}${cell.spike ? ' (lonjakan > 2σ)' : ''} — klik untuk drill-down data sumber`
                              : 'tidak ada data'}
                          >
                            {cell ? formatCell(value, metricConf.isRatio) : ''}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rowOutlets.length > INITIAL_ROWS && (
              <div className="p-2 border-t flex justify-center">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setExpanded((v) => !v)}
                  aria-expanded={expanded}
                >
                  {expanded
                    ? <><ChevronUp className="h-3.5 w-3.5 mr-1" />Tampilkan lebih sedikit</>
                    : <><ChevronDown className="h-3.5 w-3.5 mr-1" />Tampilkan semua {rowOutlets.length} outlet</>}
                </Button>
              </div>
            )}
            <p className="px-4 py-2.5 text-[10px] text-muted-foreground border-t">
              Nilai = ΣABS nominal {metricConf.label} per outlet-bulan ({metricConf.isRatio ? 'rasio waste/sales' : 'Rupiah'})
              {metric === 'wasteToSales' ? '; sel spike (waste/sales &gt; mean+2σ riwayat sendiri) terlihat pada tooltip.' : '.'}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
});
