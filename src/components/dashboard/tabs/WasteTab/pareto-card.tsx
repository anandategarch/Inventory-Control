'use client';

// ============================================================
//  WasteParetoCard — "Top Item Waste" (DEEP-WASTE-1) + W11 Paritas
//  --------------------------------------------------------
//  Pareto of items by ΣABS nominalWaste over the multi-month
//  same-week window + kumulatif share (the 80/20 reading) +
//  SISTEMIK columns (#outlet aktif / #bulan aktif) + trend
//  (last vs prev month) + expandable per-outlet breakdown (the
//  Item×Outlet matrix of the offline report).
//  Self-fetching (/api/waste-top-items) — independent of the
//  waste-series request, same query conventions (5-min
//  staleTime, keepPreviousData).
//
//  W11 (Paritas Susut & Trial):
//    - Metric selector in the header (Waste | Susut | Trial — the
//      matrix-card toggle pattern): switches the self-fetch `metric`
//      param (queryKey gains it → a re-fetch per selector change).
//      The table's LEADING nominal + ordering follow the metric; the
//      waste-SPECIFIC columns (SISTEMATIK badge + #Outlet/#Bulan +
//      trend) only render under 'waste' — those counts stay
//      waste>0-semantic under every metric (documented server-side).
//    - Fingerprint column (ALL metrics): compact "W/S/T" share display
//      of the explained loss + class badge (W-/S-/T-DOMINANT;
//      T-DOMINANT carries the INDIKASI tone — trial account semantics
//      are unverified).
//    - "Screen Trial" collapsible sub-table (the card's expand
//      pattern): items where trial looks abusive (3 documented
//      signals, all INDIKASI). FIX (AUDIT-B M2): signal-1 is
//      TWO-TIER — the absolute BLATAN bar (rasio ≥ 5%) OR a robust
//      OUTLIER tier (median + 3×1.4826×MAD atas populasi item
//      ber-BOM pada slice) — each screened row carries a
//      ratioSignal/ratioThreshold badge pair. The substitution signal
//      (trial↑ while deviasi↓) is NOT derivable from the current
//      aggregates — noted in the footer.
//    - NOTE on the shared queryKey: the Quadrant card fetches the same
//      route WITHOUT the metric slot — under metric='waste' (default)
//      both cards dedup into ONE request (keys equal); under
//      susut/trial the quadrant card keeps its own waste-ordered
//      request (it is waste-semantic by design).
// ============================================================

import { memo, Fragment, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ChevronRight, TrendingUp, TrendingDown, Minus, FlaskConical } from 'lucide-react';
import { fmtIDR, fmtPct, fmtNum } from '@/lib/format';
import type {
  WasteFingerprintClass,
  WasteMetric,
  WasteTopItemRow,
  WasteTopItemsResponse,
  WasteTrialScreenItem,
} from './types';

// ------------------------------------------------------------
// Metric configuration (the matrix-card METRICS pattern, restricted
// to the three parity metrics the route accepts)
// ------------------------------------------------------------

const METRICS: ReadonlyArray<{
  value: WasteMetric;
  label: string;
  /** Table head of the leading nominal column. */
  nominalHead: string;
  /** Leading nominal cell tone (waste keeps the historical amber). */
  nominalClass: string;
}> = [
  { value: 'waste', label: 'Waste', nominalHead: 'Waste', nominalClass: 'text-amber-600 dark:text-amber-400' },
  { value: 'susut', label: 'Susut', nominalHead: 'Susut', nominalClass: 'text-sky-600 dark:text-sky-400' },
  { value: 'trial', label: 'Trial', nominalClass: 'text-violet-600 dark:text-violet-400', nominalHead: 'Trial' },
];

/** Per-item accessor bundle for the ACTIVE metric (guards pre-W11 caches). */
function metricFields(it: WasteTopItemRow, metric: WasteMetric) {
  switch (metric) {
    case 'susut':
      return {
        nominal: it.susutNominal ?? 0,
        qty: it.susutQty ?? 0,
        share: it.susutShare ?? 0,
        cumulative: it.susutCumulativeShare ?? 0,
      };
    case 'trial':
      return {
        nominal: it.trialNominal ?? 0,
        qty: it.trialQty ?? 0,
        share: it.trialShare ?? 0,
        cumulative: it.trialCumulativeShare ?? 0,
      };
    default:
      return { nominal: it.totalWaste, qty: it.wasteQty, share: it.share, cumulative: it.cumulativeShare };
  }
}

/** Metric population total (Σ scope — the parity context badge). */
function metricPopulation(data: WasteTopItemsResponse | undefined, metric: WasteMetric): number {
  switch (metric) {
    case 'susut': return data?.susutPopulationTotal ?? 0;
    case 'trial': return data?.trialPopulationTotal ?? 0;
    default: return data?.populationTotal ?? 0;
  }
}

/** Trend glyph: last vs prev month waste (waste-semantic — hidden under susut/trial). */
function TrendGlyph({ last, prev }: { last: number; prev: number }) {
  if (last <= 0 && prev <= 0) return <Minus className="h-3 w-3 text-muted-foreground inline" aria-label="datar" />;
  if (prev <= 0 && last > 0) return <TrendingUp className="h-3 w-3 text-red-600 dark:text-red-400 inline" aria-label="naik" />;
  const growth = last / prev - 1;
  if (Math.abs(growth) < 0.1) return <Minus className="h-3 w-3 text-muted-foreground inline" aria-label="datar" />;
  return growth > 0
    ? <TrendingUp className="h-3 w-3 text-red-600 dark:text-red-400 inline" aria-label="naik" />
    : <TrendingDown className="h-3 w-3 text-emerald-600 dark:text-emerald-400 inline" aria-label="turun" />;
}

// ------------------------------------------------------------
// Fingerprint display helpers (W11)
// ------------------------------------------------------------

/** Compact "W/S/T" shares of the explained loss, e.g. "62/31/7". */
function fingerprintText(fp: { shareW: number; shareS: number; shareT: number }): string {
  return `${Math.round(fp.shareW * 100)}/${Math.round(fp.shareS * 100)}/${Math.round(fp.shareT * 100)}`;
}

const FINGERPRINT_BADGE_CLASS: Record<WasteFingerprintClass, string> = {
  // W = amber (the waste color), S = sky (cold-chain/penyimpanan), T = violet
  // (trial) — T carries the INDIKASI caveat in its tooltip.
  'W-DOMINANT': 'text-amber-700 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30',
  'S-DOMINANT': 'text-sky-700 dark:text-sky-400 border-sky-300/70 dark:border-sky-800/70 bg-sky-50/60 dark:bg-sky-950/30',
  'T-DOMINANT': 'text-violet-700 dark:text-violet-400 border-violet-300/70 dark:border-violet-800/70 bg-violet-50/60 dark:bg-violet-950/30',
};

function fingerprintTooltip(fp: { shareW: number; shareS: number; shareT: number; explainedNominal: number }, cls: WasteFingerprintClass | null): string {
  const parts = [
    'Fingerprint W/S/T = porsi waste/susut/trial dari loss yang TERJELASKAN (W+S+T, ΣABS nominal).',
    `Eksak: W ${fmtPct(fp.shareW, false, 1)} · S ${fmtPct(fp.shareS, false, 1)} · T ${fmtPct(fp.shareT, false, 1)} · explained ${fmtIDR(fp.explainedNominal)}.`,
    'Klasifikasi max-share (tie-break W>S>T) — INDIKASI pola, bukan root-cause.',
  ];
  if (cls === 'T-DOMINANT') parts.push('T-DOMINANT (INDIKASI): semantik akun TRIAL belum terverifikasi — bisa R&D wajar atau keran pembuangan; lihat Screen Trial.');
  if (cls === 'S-DOMINANT') parts.push('S-DOMINANT: didominasi susut — kandidat investigasi penyimpanan/cold-chain.');
  if (cls === 'W-DOMINANT') parts.push('W-DOMINANT: didominasi waste — kandidat investigasi prep/handling.');
  return parts.join(' ');
}

/** Fingerprint cell: compact shares + class badge (null → TANPA EXPLAINED). */
function FingerprintCell({ fp }: { fp: WasteTopItemRow['fingerprint'] }) {
  if (!fp) return <span className="text-[10px] text-muted-foreground">—</span>;
  if (fp.fingerprintClass == null) {
    return (
      <Badge
        variant="outline"
        title="TANPA EXPLAINED — W+S+T = 0: tidak ada dekomposisi loss W/S/T pada item ini (loss-nya, jika ada, seluruhnya residual)."
        className="text-[9px] font-normal text-zinc-600 dark:text-zinc-300 border-zinc-300/70 dark:border-zinc-700 bg-zinc-50/60 dark:bg-zinc-900/30 h-4 px-1.5 cursor-help"
      >
        TANPA EXPL
      </Badge>
    );
  }
  const cls = fp.fingerprintClass;
  return (
    <div className="flex items-center justify-center gap-1.5 whitespace-nowrap">
      <span
        className="text-[10px] tabular-nums text-muted-foreground cursor-help"
        title={fingerprintTooltip(fp, cls)}
      >
        {fingerprintText(fp)}
      </span>
      <Badge
        variant="outline"
        title={fingerprintTooltip(fp, cls)}
        className={`text-[9px] font-semibold h-4 px-1.5 cursor-help ${FINGERPRINT_BADGE_CLASS[cls]}`}
      >
        {cls === 'T-DOMINANT' ? 'T-DOM·INDIKASI' : cls}
      </Badge>
    </div>
  );
}

// ------------------------------------------------------------
// Trial-abuse screen sub-table (W11) — collapsible
// ------------------------------------------------------------

/** FIX (AUDIT-B M2): signal-1 tier badge classes — BLATAN (red, the
 *  absolute bar) vs OUTLIER (amber, unusual vs the slice's item
 *  population). House badge style (same palette language as the
 *  fingerprint/class badges). */
const RATIO_SIGNAL_BADGE_CLASS: Record<'BLATAN' | 'OUTLIER', string> = {
  BLATAN: 'text-red-700 dark:text-red-400 border-red-300/70 dark:border-red-800/70 bg-red-50/60 dark:bg-red-950/30',
  OUTLIER: 'text-amber-700 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30',
};

/** FIX (AUDIT-B M2): tooltip per tier — the threshold + what it means. */
function ratioSignalTooltip(signal: 'BLATAN' | 'OUTLIER', threshold: number | null): string {
  if (signal === 'BLATAN') {
    return `BLATAN: rasio trial/BOM ≥ 5% (bar absolut — ${threshold != null ? `ambang ${fmtPct(threshold, false, 1)}, ` : ''}≥ 5% pemakaian teoretis dibukukan trial; jauh di atas sampling R&D).`;
  }
  return `OUTLIER: rasio trial/BOM ≥ median + 3 × 1,4826 × MAD populasi item ber-BOM pada slice ini${threshold != null ? ` (ambang ${fmtPct(threshold, false, 2)})` : ''} — tidak biasa dibanding populasi item meski jauh di bawah bar absolut.`;
}

function TrialScreenTable({ rows }: { rows: WasteTrialScreenItem[] }) {
  return (
    <div className="max-h-64 overflow-auto">
      <Table className="min-w-[720px]">
        <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
          <TableRow className="border-b hover:bg-transparent">
            <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">Item</TableHead>
            <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Trial</TableHead>
            <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">QTY Trial</TableHead>
            <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Trial/BOM</TableHead>
            <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">#Bulan Trial</TableHead>
            <TableHead className="text-center text-xs font-semibold uppercase tracking-wider h-8">Fingerprint</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.itemId} className="h-9">
              <TableCell className="text-xs font-medium">
                {r.itemName}
                {/* FIX (AUDIT-B M2): the signal-1 tier badge (BLATAN red /
                    OUTLIER amber) — absent on stale pre-fix caches. */}
                {r.ratioSignal && (
                  <Badge
                    variant="outline"
                    title={ratioSignalTooltip(r.ratioSignal, r.ratioThreshold ?? null)}
                    className={`ml-2 text-[9px] font-normal h-4 px-1.5 cursor-help ${RATIO_SIGNAL_BADGE_CLASS[r.ratioSignal]}`}
                  >
                    {r.ratioSignal}
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-right text-xs tabular-nums text-violet-600 dark:text-violet-400">{fmtIDR(r.trialNominal)}</TableCell>
              <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{fmtNum(r.trialQty, r.satuan || '')}</TableCell>
              <TableCell
                className={`text-right text-xs tabular-nums ${r.trialToBom != null && r.trialToBom >= 0.1 ? 'font-semibold text-red-600 dark:text-red-400' : ''}`}
                title={r.trialToBom != null
                  ? `Σ|qtyTrial| ÷ Σ|qtyBom| (unitless — satuan sama)${r.ratioSignal ? ` · lolos sinyal rasio via ${r.ratioSignal}${r.ratioThreshold != null ? ` (ambang ${fmtPct(r.ratioThreshold, false, 2)})` : ''}` : ''}`
                  : 'Tanpa basis BOM — tidak dinormalisasi'}
              >
                {r.trialToBom != null ? fmtPct(r.trialToBom, false, 1) : '—'}
              </TableCell>
              <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{r.trialMonthsActive}</TableCell>
              <TableCell className="text-center">
                {r.fingerprintClass ? (
                  <Badge variant="outline" className={`text-[9px] font-semibold h-4 px-1.5 ${FINGERPRINT_BADGE_CLASS[r.fingerprintClass]}`}>
                    {r.fingerprintClass}
                  </Badge>
                ) : (
                  <span className="text-[10px] text-muted-foreground">—</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ------------------------------------------------------------
// The card
// ------------------------------------------------------------

export const WasteParetoCard = memo(function WasteParetoCard({
  monthLabel,
  currentWeek,
  area,
  kelompok,
  pic,
}: {
  monthLabel: string;
  currentWeek: string;
  area: string | null;
  kelompok: string | null;
  pic: string | null;
}) {
  const [expandedItem, setExpandedItem] = useState<number | null>(null);
  // W11: the parity metric selector (default waste = pre-W11 behavior).
  const [metric, setMetric] = useState<WasteMetric>('waste');
  // W11: the collapsible trial-abuse screen (the card's expand pattern).
  const [showTrialScreen, setShowTrialScreen] = useState(false);

  const { data, isLoading, error } = useQuery<WasteTopItemsResponse>({
    // W11: the metric rides in the queryKey — switching the selector
    // re-fetches with the new ordering (top-N BY the metric). The slot
    // is OMITTED under the default 'waste' so this card's key stays
    // IDENTICAL to the Quadrant card's (same route, same filters) —
    // react-query keeps deduping the default view into ONE request;
    // only the susut/trial views get their own entries.
    queryKey: ['waste-top-items', monthLabel, currentWeek, area, kelompok, pic, ...(metric === 'waste' ? [] : [metric])],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('month', monthLabel);
      p.set('week', currentWeek);
      if (area) p.set('area', area);
      if (kelompok) p.set('kelompok', kelompok);
      if (pic) p.set('pic', pic);
      // 'waste' is the route default — sent anyway for clarity; it maps
      // to the same server cache slot as omitting the param.
      p.set('metric', metric);
      const res = await fetch(`/api/waste-top-items?${p.toString()}`);
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        throw new Error(`Server error (HTTP ${res.status}). ${text.slice(0, 200)}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<WasteTopItemsResponse>;
    },
    enabled: Boolean(monthLabel && currentWeek),
    // PERF-FE (PAKET A) convention: only changes on ingest / manual refresh.
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });

  const items = data?.items || [];
  const metricConf = METRICS.find((m) => m.value === metric) ?? METRICS[0];
  const population = metricPopulation(data, metric);
  // BUGHUNT-R1 FIX 2: derive the sistematik month threshold from the
  // ACTUAL window size the server used (ceil(windowMonths/2)) instead of
  // the hardcoded "6 bulan" (the 12-month cap's half — wrong on the live
  // 8-9 month window). Sane fallback when the field is absent.
  const windowMonths = data?.windowMonths;
  const sistematikMonthsText = windowMonths != null && windowMonths > 0
    ? `≥ ${Math.ceil(windowMonths / 2)} bulan`
    : '≥ separuh bulan window';

  // W11: parity context — the susut/waste (and trial/waste) ratios of the
  // scope, shown under every selector so "susut 1,8× waste" is readable
  // without leaving the card.
  const wasteTotal = data?.populationTotal ?? 0;
  const susutTotal = data?.susutPopulationTotal ?? 0;
  const trialTotal = data?.trialPopulationTotal ?? 0;
  const parityText = wasteTotal > 0 && metric !== 'waste'
    ? (metric === 'susut' ? `${(susutTotal / wasteTotal).toFixed(1)}× waste` : `${(trialTotal / wasteTotal).toFixed(2)}× waste`)
    : wasteTotal > 0 && metric === 'waste' && susutTotal > 0
      ? `susut ${(susutTotal / wasteTotal).toFixed(1)}× waste`
      : null;

  const trialScreen = data?.trialScreen ?? [];
  const fingerprintSummary = data?.fingerprint;
  const isWaste = metric === 'waste';
  // Column count for the expanded breakdown row's colSpan (trend +
  // #outlet/#bulan render waste-only).
  const colSpan = isWaste ? 10 : 7;

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <ChevronRight className="h-3.5 w-3.5" />
          </span>
          Pareto Item {metricConf.label} — 80/20 + Fingerprint W/S/T
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Item teratas by ΣABS nominal{metricConf.label} pada window same-week (maks. 12 bulan). Share & kumulatif = porsi dari
          total {metricConf.label.toLowerCase()} scope.{' '}
          {isWaste ? (
            <>
              <span className="font-medium text-foreground/70">SISTEMATIK</span> = aktif{' '}
              {sistematikMonthsText} dan ≥ 2 outlet (masalah resep/proses, bukan kejadian sekali).{' '}
            </>
          ) : null}
          Fingerprint = porsi W/S/T dari loss yang terjelaskan (kolom terpisah, semua metrik).
          Klik baris untuk breakdown per outlet.
        </p>
        {/* W11: metric selector — the matrix-card toggle pattern. */}
        <div className="flex items-center gap-1.5 pt-2 ml-9 flex-wrap" role="group" aria-label="Pilih metrik Pareto">
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
        {population != null && population > 0 && (
          <div className="flex items-center gap-2 pt-2 flex-wrap ml-9">
            <Badge variant="secondary" className="text-xs tabular-nums font-medium">Σ {metricConf.label} scope {fmtIDR(population)}</Badge>
            {parityText && (
              <Badge
                variant="outline"
                title="Paritas scope window — Σ|nominal| ketiga metrik selalu tersedia pada respons yang sama."
                className="text-[10px] font-normal text-muted-foreground h-5 cursor-help"
              >
                {parityText}
              </Badge>
            )}
            {isWaste && items.filter((i) => i.sistematik).length > 0 && (
              <Badge variant="outline" className="text-[10px] font-normal text-amber-700 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30 h-5">
                {items.filter((i) => i.sistematik).length} item sistematik
              </Badge>
            )}
            {fingerprintSummary && (fingerprintSummary.classCounts.sDominant > 0 || fingerprintSummary.classCounts.tDominant > 0) && (
              <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground h-5">
                {fingerprintSummary.classCounts.wDominant}W · {fingerprintSummary.classCounts.sDominant}S · {fingerprintSummary.classCounts.tDominant}T dominan
              </Badge>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Memuat Pareto {metricConf.label.toLowerCase()}…</div>
        ) : error ? (
          <div className="p-6 text-center text-sm text-red-600 dark:text-red-400">{error.message}</div>
        ) : items.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Tidak ada item {metricConf.label.toLowerCase()} pada scope ini.</div>
        ) : (
          <div className="max-h-96 overflow-auto">
            <Table className="min-w-[980px]">
              <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                <TableRow className="border-b hover:bg-transparent">
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-8 w-8" />
                  <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">Item</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">{metricConf.nominalHead}</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">QTY</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Share</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Kumulatif</TableHead>
                  <TableHead className="text-center text-xs font-semibold uppercase tracking-wider h-8" title="Fingerprint: porsi W/S/T dari loss terjelaskan (W+S+T)">Fingerprint</TableHead>
                  {isWaste && (
                    <>
                      <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8" title="Jumlah distinct outlet dengan WASTE > 0 (waste-semantic)">#Outlet</TableHead>
                      <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8" title="Jumlah distinct bulan dengan WASTE > 0 (waste-semantic)">#Bulan</TableHead>
                      <TableHead className="text-center text-xs font-semibold uppercase tracking-wider h-8">Trend</TableHead>
                    </>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((it: WasteTopItemRow) => {
                  const f = metricFields(it, metric);
                  return (
                    <Fragment key={it.itemId}>
                      <TableRow
                        className="h-9 cursor-pointer hover:bg-muted/50 dark:hover:bg-zinc-800/40"
                        onClick={() => setExpandedItem(expandedItem === it.itemId ? null : it.itemId)}
                        aria-expanded={expandedItem === it.itemId}
                      >
                        <TableCell className="w-8 p-0">
                          <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${expandedItem === it.itemId ? 'rotate-90' : ''}`} />
                        </TableCell>
                        <TableCell className="text-xs font-medium">
                          {it.itemName}
                          {isWaste && it.sistematik && (
                            <Badge variant="outline" className="ml-2 text-[9px] font-normal text-amber-700 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30 h-4 px-1.5">
                              SISTEMATIK
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className={`text-right text-xs tabular-nums ${metricConf.nominalClass}`}>{fmtIDR(f.nominal)}</TableCell>
                        <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{fmtNum(f.qty, it.satuan || '')}</TableCell>
                        <TableCell className="text-right text-xs tabular-nums">{fmtPct(f.share, false, 1)}</TableCell>
                        <TableCell className={`text-right text-xs tabular-nums ${f.cumulative >= 0.8 ? 'font-semibold text-red-600 dark:text-red-400' : ''}`}>
                          {fmtPct(f.cumulative, false, 1)}
                        </TableCell>
                        <TableCell className="text-center">
                          <FingerprintCell fp={it.fingerprint} />
                        </TableCell>
                        {isWaste && (
                          <>
                            <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{it.outletsActive}</TableCell>
                            <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{it.monthsActive}</TableCell>
                            <TableCell className="text-center">
                              <TrendGlyph last={it.lastMonthWaste} prev={it.prevMonthWaste} />
                            </TableCell>
                          </>
                        )}
                      </TableRow>
                      {expandedItem === it.itemId && (
                        <TableRow className="bg-muted/30 dark:bg-zinc-900/40 hover:bg-muted/30 dark:hover:bg-zinc-900/40">
                          <TableCell colSpan={colSpan} className="py-2.5 px-6">
                            <p className="text-[11px] text-muted-foreground mb-1.5">
                              Breakdown per outlet — {it.itemName} (maks. 8 outlet teratas by {metricConf.label.toLowerCase()}):
                            </p>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                              {it.byOutlet.length === 0 && <span className="text-[11px] text-muted-foreground">—</span>}
                              {it.byOutlet.map((b) => {
                                // W11: the breakdown line follows the ACTIVE
                                // metric (the server sorts/caps the slice on
                                // it); share-of-item is computed locally from
                                // the same fields.
                                const value = metric === 'susut' ? (b.susut ?? 0) : metric === 'trial' ? (b.trial ?? 0) : b.waste;
                                const itemTotal = f.nominal;
                                const shareOfMetric = itemTotal > 0 ? value / itemTotal : 0;
                                return (
                                  <div key={b.outletCode} className="flex items-center justify-between gap-2 rounded border bg-background/60 dark:bg-zinc-900/60 px-2 py-1">
                                    <span className="text-[11px] font-medium truncate" title={`${b.outletCode} · ${b.outletName} · ${b.area}`}>
                                      {b.outletCode} <span className="text-muted-foreground font-normal">· {b.outletName}</span>
                                    </span>
                                    <span className="text-[11px] tabular-nums whitespace-nowrap">
                                      <span className={metricConf.nominalClass}>{fmtIDR(value)}</span>
                                      <span className="text-muted-foreground"> ({fmtPct(shareOfMetric, false, 0)}, {b.monthsActive} bln)</span>
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {/* W11: the trial-abuse screen — collapsible section following the
            card's expand pattern (ghost button + aria-expanded). Rendered
            whenever the response carries the field (even empty: the honest
            "no abusive trial found" reading), hidden on stale pre-W11
            caches where the field is absent. */}
        {data?.trialScreen != null && (
          <div className="border-t">
            <div className="p-2 flex justify-center">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setShowTrialScreen((v) => !v)}
                aria-expanded={showTrialScreen}
              >
                <FlaskConical className="h-3.5 w-3.5 mr-1" />
                {showTrialScreen
                  ? 'Sembunyikan Screen Trial'
                  : `Screen Trial${trialScreen.length > 0 ? ` (${trialScreen.length} item)` : ' (0 item)'}`}
              </Button>
            </div>
            {showTrialScreen && (
              <div className="px-4 pb-3">
                {trialScreen.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2 text-center">
                    Tidak ada item yang lolos 3 sinyal screen trial pada slice ini (baik bar absolut 5% maupun outlier robust tidak terpicu) —
                    indikasi pemakaian akun trial masih wajar (R&amp;D).
                  </p>
                ) : (
                  <>
                    <p className="text-[11px] text-muted-foreground mb-1.5">
                      Item dengan akun TRIAL yang tampak menyalahgunaan — ketiga sinyal terpenuhi (SEMUA, konservatif):
                      rasio trial/BOM lolos dua-tier{' '}
                      (<span className="font-medium text-red-700 dark:text-red-400">BLATAN</span>: bar absolut ≥ 5%{' '}
                      ATAU <span className="font-medium text-amber-700 dark:text-amber-400">OUTLIER</span>: ≥ median + 3×1,4826×MAD
                      populasi item ber-BOM pada slice ini — guard &lt; 5 item / MAD = 0 → hanya bar absolut; item tanpa trial ikut baseline
                      rasio 0) · ≥ 3 bulan persisten · nilai ≥ Rp 100 rb.{' '}
                      <span className="font-medium text-violet-700 dark:text-violet-400">INDIKASI</span> — bukan bukti;
                      verifikasi semantik akun trial sebelum menyimpulkan.
                    </p>
                    <TrialScreenTable rows={trialScreen} />
                  </>
                )}
              </div>
            )}
          </div>
        )}

        <p className="px-4 py-2.5 text-[10px] text-muted-foreground border-t">
          {isWaste ? (
            <>
              Trend = waste bulan terakhir vs bulan sebelumnya pada window (naik = memburuk). #Outlet/#Bulan = jumlah distinct
              outlet/bulan dengan waste &gt; 0 (semantik WASTE — tetap ditampilkan apa adanya di bawah metrik lain).
              SISTEMATIK = {sistematikMonthsText} dan ≥ 2 outlet.
            </>
          ) : (
            <>
              Kolom #Outlet/#Bulan/SISTEMATIK/Trend disembunyikan pada tampilan {metricConf.label} — semantiknya waste-semantic
              (dihitung atas waste &gt; 0) sehingga menyesatkan bila dibaca sebagai “outlet/bulan {metricConf.label.toLowerCase()} aktif”.
              Share/kumulatif mengikuti metrik aktif; ganti selector ke Waste untuk kolom lengkap.
            </>
          )}{' '}
          Fingerprint = porsi W/S/T dari loss TERJELASKAN (W+S+T) — klasifikasi max-share (tie-break W&gt;S&gt;T), INDIKASI pola
          bukan root-cause; T-DOMINANT khususnya berlabel INDIKASI karena semantik akun trial belum terverifikasi.
          Screen Trial dihitung atas item yang ditampilkan (top-N metrik aktif) — pindah selector ke Trial untuk cakupan
          trial terlengkap; sinyal substitusi (trial naik saat deviasi turun) belum dapat diturunkan dari agregat yang ada.
        </p>
      </CardContent>
    </Card>
  );
});
