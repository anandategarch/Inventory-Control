'use client';

import { memo, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableCaption,
} from '@/components/ui/table';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import type { AnalysisData, BomCorrelationFinding, BomCorrelationCounts } from '@/hooks/useAnalysis';
import { fmtNum, fmtPct, growthColorClass } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { GitCompare, AlertTriangle, CheckCircle2 } from 'lucide-react';

// ============================================================
//  BomCorrelationCard — 3 sections
//  --------------------------------------------------------
//  FIX-BOM-UI (CONFIG-02): the card previously read ONLY aggregate
//  growth from `executiveSummary` and computed alignment inline with
//  hardcoded thresholds. It now reads `bomCorrelationFindings`
//  (per-record rule fires from the SQL rule engine) as the PRIMARY
//  section, and keeps the aggregate alignment table + narrative as
//  secondary sections with all P3 bugs fixed.
//
//  Section 1 — Per-Record Findings (top 50 by priority)
//  Section 2 — Aggregate Alignment (Deviasi/Waste/Susut/Trial vs BOM)
//  Section 3 — Findings Narrative (textual summary)
// ============================================================

interface MetricRow {
  name: string;
  current: number | null;
  growth: number | null;
  previous: number | null;
  aligned: boolean | null; // null = unknown alignment OR baseline
  isBaseline: boolean;     // FIX BUG-BOM-UI-02: distinguishes BOM row from null-aligned others
}

// Display labels for each BOM rule code (used in the per-record table).
const RULE_LABELS: Record<string, string> = {
  BOM_DEVIATION_MISMATCH: 'Deviasi > 2× BOM',
  BOM_DOWN_DEV_UP: 'BOM turun, deviasi naik',
  WASTE_BOM_MISMATCH: 'Waste vs BOM',
  SUSUT_BOM_MISMATCH: 'Susut vs BOM',
  TRIAL_BOM_MISMATCH: 'Trial vs BOM',
  BOM_DEVIATION_DISPROPORTIONATE: 'Deviasi disproportional',
};

// Rule display order — most severe first (ABNORMAL rules above WARNING rules).
const RULE_ORDER: Array<{ code: keyof BomCorrelationCounts; label: string }> = [
  { code: 'BOM_DEVIATION_MISMATCH', label: 'Deviasi > 2× BOM' },
  { code: 'BOM_DOWN_DEV_UP', label: 'BOM turun, deviasi naik' },
  { code: 'BOM_DEVIATION_DISPROPORTIONATE', label: 'Deviasi disproportional (1,5–2×)' },
  { code: 'WASTE_BOM_MISMATCH', label: 'Waste vs BOM' },
  { code: 'SUSUT_BOM_MISMATCH', label: 'Susut vs BOM' },
  { code: 'TRIAL_BOM_MISMATCH', label: 'Trial vs BOM' },
];

// FIX BUG-BOM-UI-06: format ratio with Indonesian comma decimal separator.
// Returns "—" for null/NaN/Infinity. Suffix defaults to "×".
function fmtRatio(v: number | null | undefined, suffix = '×'): string {
  if (v == null || isNaN(v) || !isFinite(v)) return '—';
  return `${v.toFixed(1).replace('.', ',')}${suffix}`;
}

function severityBadgeClass(severity: string): string {
  if (severity === 'ABNORMAL') {
    return 'border-red-300 text-red-700 bg-red-50 dark:border-red-800 dark:text-red-400 dark:bg-red-950/30';
  }
  return 'border-amber-300 text-amber-700 bg-amber-50 dark:border-amber-800 dark:text-amber-400 dark:bg-amber-950/30';
}

// FIX (BATCH1): growthColorClass moved to @/lib/format — imported above.
// Removed local duplicate definition (~6 lines).

function BomCorrelationCardInner({ data }: { data: AnalysisData }) {
  const s = data.executiveSummary;
  const findings: BomCorrelationFinding[] = data.bomCorrelationFindings ?? [];
  const counts = data.bomCorrelationCounts;
  // NAVLINK-1 (B1): finding row click opens the raw-records drawer for the
  // exact (outlet × item) pair behind the rule fire. Guarded — payloads cached
  // before the outletCode field existed render plain (non-clickable) rows.
  const setDrilldown = useDashboard(useShallow((st) => st.setDrilldown));

  // FIX BUG-BOM-UI-09: guard qtyBom (optional chaining on each summary field).
  const bomGrowth = s?.qtyBom?.growth ?? null;
  const bomUp = (bomGrowth ?? 0) > 0;
  const bomDown = (bomGrowth ?? 0) < 0;

  // ============================================================
  //  Section 2 rows — aggregate alignment
  //  FIX BUG-BOM-UI-02: isBaseline distinguishes BOM row (aligned=null
  //    because it IS the baseline) from other rows where aligned=null
  //    means "no comparison data" or "stable growth".
  //  FIX BUG-BOM-UI-03: metric growth === 0 returns null (stable = neutral,
  //    not "not aligned"). Previously a 0% growth on Deviasi vs 0% BOM
  //    would have shown "⚠ Tidak" because both metricUp and metricDown
  //    were false → returned false.
  //  PERF-FE: wrapped in useMemo — these rows depend only on `s` (executive
  //    summary) and `bomGrowth`. Without memo, the IIFE recomputed on every
  //    parent re-render (e.g., when `isFetching` toggles or sibling state
  //    changes) and produced a new array reference, busting React.memo on
  //    any future consumer.
  // ============================================================
  const rows: MetricRow[] = useMemo(() => {
    if (!s) return [];
    const checkAligned = (growth: number | null): boolean | null => {
      if (growth == null || bomGrowth == null) return null;
      if (growth === 0) return null; // stable = neutral, not "not aligned"
      if (bomGrowth === 0) return null;
      const metricUp = growth > 0;
      const metricDown = growth < 0;
      return (bomUp && metricUp) || (bomDown && metricDown);
    };

    return [
      { name: 'QTY BOM', current: s.qtyBom?.current ?? null, growth: bomGrowth, previous: s.qtyBom?.previous ?? null, aligned: null, isBaseline: true },
      { name: 'QTY Deviasi', current: s.qtyDeviasi?.current ?? null, growth: s.qtyDeviasi?.growth ?? null, previous: s.qtyDeviasi?.previous ?? null, aligned: checkAligned(s.qtyDeviasi?.growth ?? null), isBaseline: false },
      { name: 'QTY Waste', current: s.qtyWaste?.current ?? null, growth: s.qtyWaste?.growth ?? null, previous: s.qtyWaste?.previous ?? null, aligned: checkAligned(s.qtyWaste?.growth ?? null), isBaseline: false },
      { name: 'QTY Susut', current: s.qtySusut?.current ?? null, growth: s.qtySusut?.growth ?? null, previous: s.qtySusut?.previous ?? null, aligned: checkAligned(s.qtySusut?.growth ?? null), isBaseline: false },
      { name: 'QTY Trial', current: s.qtyTrial?.current ?? null, growth: s.qtyTrial?.growth ?? null, previous: s.qtyTrial?.previous ?? null, aligned: checkAligned(s.qtyTrial?.growth ?? null), isBaseline: false },
    ];
  }, [s, bomGrowth, bomUp, bomDown]);

  // ============================================================
  //  Section 3 — Findings Narrative (textual summary)
  //  FIX BUG-BOM-UI-01: if bomGrowth is null, show "Tidak ada data
  //    perbandingan" instead of falling through to "Semua metrik sejalan".
  //  FIX BUG-BOM-UI-05: use fmtPct(growth, false) — suppress redundant "+"
  //    when "naik"/"turun" is already in the text (the + adds no info).
  //  FIX BUG-BOM-UI-06: ratios formatted via fmtRatio (comma decimal).
  //  FIX BUG-BOM-UI-07: stable React keys (string slugs, not array index).
  //  PERF-FE: wrapped in useMemo — narrative depends only on `s` +
  //    bomGrowth/bomUp/bomDown. Avoids recompute on every parent re-render.
  // ============================================================
  const findingsNarrative: Array<{ text: string; type: 'warning' | 'ok'; key: string }> = useMemo(() => {
    if (!s) return [{ text: 'Data tidak tersedia', type: 'warning', key: 'no-data' }];
    if (bomGrowth == null) {
      return [{
        text: 'Tidak ada data perbandingan — pilih week pembanding untuk mengevaluasi korelasi BOM',
        type: 'warning',
        key: 'no-compare',
      }];
    }
    const result: Array<{ text: string; type: 'warning' | 'ok'; key: string }> = [];
    const devGrowth = s.qtyDeviasi?.growth ?? null;
    const wasteGrowth = s.qtyWaste?.growth ?? null;
    const susutGrowth = s.qtySusut?.growth ?? null;
    const trialGrowth = s.qtyTrial?.growth ?? null;

    // Deviasi vs BOM proporsionalitas
    if (bomUp && devGrowth != null && devGrowth > 0) {
      const ratio = devGrowth / (bomGrowth ?? 1);
      if (ratio > 2) {
        result.push({ text: `Deviasi naik ${fmtPct(devGrowth, false)} jauh melebihi BOM naik ${fmtPct(bomGrowth, false)} (rasio ${fmtRatio(ratio)})`, type: 'warning', key: 'dev-far-exceed' });
      } else if (ratio > 1.5) {
        result.push({ text: `Deviasi naik ${fmtPct(devGrowth, false)} tidak proporsional dengan BOM naik ${fmtPct(bomGrowth, false)} (rasio ${fmtRatio(ratio)})`, type: 'warning', key: 'dev-disproportionate' });
      } else {
        result.push({ text: `Deviasi naik proporsional dengan BOM (rasio ${fmtRatio(ratio)})`, type: 'ok', key: 'dev-proportional' });
      }
    }
    if (bomDown && devGrowth != null && devGrowth > 0) {
      result.push({ text: `BOM turun ${fmtPct(bomGrowth, false)} tapi deviasi naik ${fmtPct(devGrowth, false)} — tidak sejalan`, type: 'warning', key: 'bom-down-dev-up' });
    }

    if (bomUp && wasteGrowth != null && wasteGrowth < 0) result.push({ text: `Waste turun ${fmtPct(wasteGrowth, false)} saat BOM naik ${fmtPct(bomGrowth, false)} — harusnya ikut naik`, type: 'warning', key: 'waste-mismatch-up' });
    if (bomDown && wasteGrowth != null && wasteGrowth > 0) result.push({ text: `Waste naik ${fmtPct(wasteGrowth, false)} saat BOM turun ${fmtPct(bomGrowth, false)} — harusnya ikut turun`, type: 'warning', key: 'waste-mismatch-down' });

    if (bomUp && susutGrowth != null && susutGrowth < 0) result.push({ text: `Susut turun ${fmtPct(susutGrowth, false)} saat BOM naik ${fmtPct(bomGrowth, false)} — harusnya ikut naik`, type: 'warning', key: 'susut-mismatch-up' });
    if (bomDown && susutGrowth != null && susutGrowth > 0) result.push({ text: `Susut naik ${fmtPct(susutGrowth, false)} saat BOM turun ${fmtPct(bomGrowth, false)} — harusnya ikut turun`, type: 'warning', key: 'susut-mismatch-down' });

    if (bomUp && trialGrowth != null && trialGrowth < 0) result.push({ text: `Trial turun ${fmtPct(trialGrowth, false)} saat BOM naik ${fmtPct(bomGrowth, false)} — harusnya ikut naik`, type: 'warning', key: 'trial-mismatch-up' });
    if (bomDown && trialGrowth != null && trialGrowth > 0) result.push({ text: `Trial naik ${fmtPct(trialGrowth, false)} saat BOM turun ${fmtPct(bomGrowth, false)} — harusnya ikut turun`, type: 'warning', key: 'trial-mismatch-down' });

    if (result.length === 0) result.push({ text: 'Semua metrik sejalan dengan BOM', type: 'ok', key: 'all-aligned' });
    return result;
  }, [s, bomGrowth, bomUp, bomDown]);

  const hasFindings = findings.length > 0;
  // PERF-FE: memoize totalBomFlags — depends only on `counts` (object on
  // `data`). Avoids recompute + produces a stable primitive.
  const totalBomFlags = useMemo(
    () => (counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0),
    [counts],
  );

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
            description="QTY Deviasi, Waste, Susut, dan Trial seharusnya naik/turun bersama BOM. Jika berlawanan arah → indikasi anomali. Rasio deviasi/BOM > 1,5× = tidak proporsional (ambang batas dapat dikonfigurasi di Settings)."
            example="BOM naik 10%, Waste turun 5% → ⚠ tidak sejalan"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Anomali per-record + alignment aggregate Deviasi/Waste/Susut/Trial vs BOM
        </p>
      </CardHeader>

      <CardContent className="p-0">
        {/* ============================================================
            SECTION 1 — Per-Record Findings (PRIMARY)
            Top 50 BOM rule fires, sorted by priority DESC (most severe first).
            Count badges show per-rule totals (from the FULL flag set, not
            the sliced top-50).
            ============================================================ */}
        <div className="border-b">
          <div className="px-3 pt-3 pb-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Anomali per Record
              {totalBomFlags > 0 && (
                <span className="ml-1.5 text-amber-600 dark:text-amber-400">({totalBomFlags} record)</span>
              )}
            </h4>
            {counts && totalBomFlags > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {RULE_ORDER.map(({ code, label }) => {
                  const c = counts[code] ?? 0;
                  if (c === 0) return null;
                  return (
                    <Badge
                      key={code}
                      variant="outline"
                      className="text-[10px] h-5 px-1.5 bg-amber-50/60 dark:bg-amber-950/20 border-amber-200/70 dark:border-amber-900/60 text-amber-700 dark:text-amber-400"
                    >
                      {label}
                      <span className="font-semibold ml-1 tabular-nums">{c}</span>
                    </Badge>
                  );
                })}
              </div>
            )}
          </div>

          {!hasFindings ? (
            <div className="px-3 pb-4 pt-1">
              <div className="flex items-center gap-2 py-3 px-3 rounded-lg border border-emerald-200/70 dark:border-emerald-900/60 bg-emerald-50/40 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span className="text-xs">
                  Tidak ada anomali korelasi BOM terdeteksi untuk periode ini
                </span>
              </div>
            </div>
          ) : (
            // BUG-BOM-UI-08: scroll container around the table — the sticky
            // TableHeader below now actually sticks to the top of THIS container.
            <div className="max-h-96 overflow-y-auto overflow-x-auto">
              <Table>
                {/* BUG-BOM-UI-13: sr-only TableCaption for screen readers. */}
                <TableCaption className="sr-only">
                  Daftar record yang memicu aturan korelasi BOM — diurutkan berdasarkan prioritas (paling parah di atas)
                </TableCaption>
                <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                  <TableRow className="border-b hover:bg-transparent">
                    <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3">Outlet</TableHead>
                    <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3">Item</TableHead>
                    <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3">Rule</TableHead>
                    <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right">BOM Growth</TableHead>
                    <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right">Metric Growth</TableHead>
                    <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right">Ratio</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {/* BUG-BOM-UI-07: stable React keys (composite id, not array index). */}
                  {findings.map((f) => (
                    <TableRow
                      key={`${f.outletId}-${f.itemId}-${f.ruleCode}-${f.akunPenyesuaian ?? ''}`}
                      {...(f.outletCode
                        ? clickableRowProps(() => setDrilldown({ outletCode: f.outletCode ?? null, itemName: f.itemName }))
                        : {})}
                      className={`${f.outletCode ? 'cursor-pointer ' : ''}hover:bg-muted/40 transition-colors border-b`}
                      title={f.outletCode ? 'Klik untuk lihat record mentah resto × item ini' : undefined}
                    >
                      <TableCell className="text-[11px] px-3 py-2 font-medium whitespace-normal" title={f.outletName}>
                        <div className="truncate">{f.outletName}</div>
                        <div className="text-[10px] text-muted-foreground">ID: {f.outletId}</div>
                      </TableCell>
                      <TableCell className="text-[11px] px-3 py-2 whitespace-normal" title={f.itemName}>
                        {f.itemName}
                      </TableCell>
                      <TableCell className="text-[11px] px-3 py-2">
                        <Badge variant="outline" className={`text-[10px] h-5 px-1.5 ${severityBadgeClass(f.severity)}`}>
                          {RULE_LABELS[f.ruleCode] ?? f.ruleCode}
                        </Badge>
                      </TableCell>
                      <TableCell className={`text-[11px] px-3 py-2 text-right tabular-nums ${growthColorClass(f.bomGrowth)}`}>
                        {f.bomGrowth != null ? fmtPct(f.bomGrowth, true) : '—'}
                      </TableCell>
                      <TableCell className={`text-[11px] px-3 py-2 text-right tabular-nums ${growthColorClass(f.metricGrowth)}`}>
                        {f.metricGrowth != null ? fmtPct(f.metricGrowth, true) : '—'}
                      </TableCell>
                      <TableCell className="text-[11px] px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {fmtRatio(f.deviationBomRatio)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        {/* ============================================================
            SECTION 2 — Aggregate Alignment Table
            Shows the AGGREGATE growth direction alignment per metric
            (Deviasi/Waste/Susut/Trial vs BOM). Useful as a summary
            view alongside the per-record findings above.
            ============================================================ */}
        <div className="border-b">
          <div className="px-3 pt-3 pb-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Agregasi Alignment
            </h4>
            <p className="text-[10px] text-muted-foreground/70 mt-0.5">
              Arah growth vs week pembanding
            </p>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableCaption className="sr-only">
                Tabel alignment aggregate — apakah growth Deviasi/Waste/Susut/Trial sejalan dengan arah BOM
              </TableCaption>
              {/* NOTE: no sticky header here — the table is short (5 rows) and
                  there is no scroll container, so sticky would be dead code. */}
              <TableHeader>
                <TableRow className="border-b hover:bg-transparent">
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3">Metrik</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right">Current</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right">Growth</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-right">Previous</TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-10 px-3 text-center">Sejalan?</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* BUG-BOM-UI-14: in-table empty message when rows is empty. */}
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-xs text-muted-foreground py-6">
                      Data executive summary tidak tersedia
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.name} className="hover:bg-muted/40 transition-colors border-b">
                      <TableCell className="text-[11px] px-3 py-2 font-medium">{row.name}</TableCell>
                      <TableCell className="text-[11px] px-3 py-2 text-right tabular-nums">{fmtNum(row.current)}</TableCell>
                      {/* BUG-BOM-UI-04: BOM row (isBaseline) uses neutral color,
                          not red for positive growth. BOM is the reference, not a
                          deviation indicator. */}
                      <TableCell className={`text-[11px] px-3 py-2 text-right tabular-nums ${
                        row.isBaseline
                          ? 'text-muted-foreground'
                          : growthColorClass(row.growth)
                      }`}>
                        {row.growth != null ? fmtPct(row.growth, true) : '—'}
                      </TableCell>
                      <TableCell className="text-[11px] px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {fmtNum(row.previous)}
                      </TableCell>
                      <TableCell className="text-[11px] px-3 py-2 text-center">
                        {/* BUG-BOM-UI-02: distinguish baseline (BOM row, italic
                            "baseline" label) from unknown alignment (other rows
                            with null aligned show plain "—"). */}
                        {row.isBaseline ? (
                          <span className="text-muted-foreground text-[10px] italic">baseline</span>
                        ) : row.aligned === null ? (
                          <span className="text-muted-foreground text-[10px]">—</span>
                        ) : row.aligned ? (
                          <Badge variant="outline" className="text-[10px] h-4 px-1 border-emerald-300 text-emerald-700 bg-emerald-50 dark:border-emerald-800 dark:text-emerald-400 dark:bg-emerald-950/30">
                            ✓ Ya
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] h-4 px-1 border-red-300 text-red-700 bg-red-50 dark:border-red-800 dark:text-red-400 dark:bg-red-950/30">
                            ⚠ Tidak
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>

        {/* ============================================================
            SECTION 3 — Findings Narrative
            Textual summary of the aggregate alignment. Uses stable
            React keys (BUG-BOM-UI-07) and Indonesian decimal commas
            for ratios (BUG-BOM-UI-06).
            ============================================================ */}
        <div className="p-3 space-y-1.5">
          {findingsNarrative.map((f) => (
            <div
              key={f.key}
              className={`text-[11px] flex items-start gap-1.5 ${
                f.type === 'warning'
                  ? 'text-amber-700 dark:text-amber-400'
                  : 'text-emerald-700 dark:text-emerald-400'
              }`}
            >
              <span className="shrink-0 mt-0.5">
                {f.type === 'warning'
                  ? <AlertTriangle className="h-3 w-3" />
                  : <CheckCircle2 className="h-3 w-3" />}
              </span>
              <span className="leading-relaxed">{f.text}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export const BomCorrelationCard = memo(BomCorrelationCardInner);
