'use client';

// ============================================================
//  TopGrowthCard — "Top Growth (Resto & Barang)"
//  --------------------------------------------------------
//  Task H-2c (CHANGE 6): Top movers of nominal SALES vs the compare
//  period, toggleable between two grains:
//    - Per Resto  → data.topGrowth.byOutlet (group o.name)
//    - Per Barang → data.topGrowth.byItem   (group i.name)
//
//  Task H-5 (v2 — period clarity + drill-down):
//    - PERIOD LEGEND: an explicit "Periode ini vs Pembanding" block in the
//      header — concrete week + month + day range (weeks are cumulative:
//      WEEK 2 = tgl 1–14) + how the compare period was chosen (otomatis =
//      same week in the previous month, or dipilih). Answers "growth dari
//      periode apa aja?" at a glance instead of a cryptic one-liner.
//    - DRILL-DOWN: every row is expandable (accordion). Per Resto rows
//      expand into the top BARANG driving that resto's Δ; Per Barang rows
//      expand into the top RESTO driving that barang's Δ. Contributors
//      arrive IN the /api/analysis payload (topGrowth[].contributors —
//      computed by queryTopGrowth from the same (outlet × item) sales
//      matrix), so expansion is pure client state: no fetch, no spinner.
//
//  Data comes from the /api/analysis payload (`topGrowth`, computed
//  by queryTopGrowth) — same compare-period semantics as
//  GrowthComparison: auto = same weekLabel in the previous month, or
//  the user's explicit compare period. No separate fetch, no separate
//  cache — it rides the 30-min cache / SWR / background-recompute
//  envelope of the analysis payload.
//
//  TASK H-6 (correctness rework — fixes "drill down menampilkan data
//  yang salah"): each grain now runs on a REAL per-grain source, and
//  the Δ column's METRIC changes with the tab:
//    - Per Resto  → ΔSALES in Rp (OutletPeriodSales.salesMode — the
//      canonical per-outlet Sales; nominalSales is outlet-level and
//      denormalized, so the old SUM-over-rows was Sales × rowCount).
//      Drill-down: top barang by Δ pemakaian BOM inside the resto —
//      the demand-side decomposition (there is no per-barang Sales).
//    - Per Barang → Δ PEMAKAIAN BOM in the item's satuan (qtyBom is
//      genuine per-row item data; consistent with Growth Comparison's
//      BOM metric). Drill-down: top resto driving that item's BOM move.
//  Qty numbers ALWAYS carry their satuan so they can never be misread
//  as rupiah.
//
//  Sign convention (sacred): delta = curr − prev. Sales UP = good →
//  emerald (growthColor with inverse=false — NOT growthColorClass,
//  which is the up-is-bad variant used for deviation metrics).
//
//  Loading note: page.tsx gates the whole tab tree on `analysis.data`
//  (LoadingState), so this card only ever renders with a resolved
//  payload. `data.topGrowth` being undefined (payload cached before
//  the field existed) renders a tidy empty state instead of crashing.
// ============================================================

import { memo, useCallback, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ChevronDown, ChevronRight, RefreshCw, TrendingUp } from 'lucide-react';
import { fmtGrowth, growthColor } from '@/lib/format';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';
import type { AnalysisData } from '@/hooks/useAnalysis';
import type { TopGrowthContributor, TopGrowthRow } from '@/lib/queries/growth-drivers';

/** Server caps each list at 15 rows (queryTopGrowth); the card shows the top 10. */
const DISPLAY_LIMIT = 10;
/** Server-side contributor cap (topGrowth.contributorLimit) — fallback for old payloads. */
const CONTRIBUTOR_LIMIT_FALLBACK = 5;

type Grain = 'outlet' | 'item';

// ------------------------------------------------------------
//  Formatting — compact signed nominal delta, mirrored verbatim
//  from GrowthComparison.tsx formatDelta so the two growth sections
//  (same tab, adjacent sections) read identically.
// ------------------------------------------------------------
function formatDelta(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}M`;
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}Jt`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(0)}Rb`;
  return v.toFixed(0);
}

function formatDeltaSigned(v: number): string {
  // Negative sign is already emitted by formatDelta; only append "+".
  return v > 0 ? `+${formatDelta(v)}` : formatDelta(v);
}

// ------------------------------------------------------------
//  TASK H-6 — QTY delta formatting (Per Barang grain + all drill-down
//  contributors): "−12,5 kg". id-ID locale, max 2 decimals under 10K
//  (BOM qtys are small), 0 decimals above. The satuan suffix makes a
//  qty impossible to misread as rupiah.
// ------------------------------------------------------------
function formatQty(v: number, unit?: string | null): string {
  const abs = Math.abs(v);
  const num = abs >= 10_000
    ? abs.toLocaleString('id-ID', { maximumFractionDigits: 0 })
    : abs.toLocaleString('id-ID', { maximumFractionDigits: 2 });
  return unit ? `${num} ${unit}` : num;
}

function formatQtySigned(v: number, unit?: string | null): string {
  // Negative sign is already emitted by toLocaleString; only append "+".
  return v > 0 ? `+${formatQty(v, unit)}` : formatQty(v, unit);
}

/** "WEEK 2 · Mei 2026 · tgl 1–14" — week label + month + cumulative day range. */
function formatPeriodLabel(
  week: string,
  month: string | null | undefined,
  range: { start: number; end: number } | null | undefined,
): string {
  const base = month ? `${week} · ${month}` : week;
  return range ? `${base} · tgl ${range.start}–${range.end}` : base;
}

/** Shared empty-state block (icon + copy) — pattern from GrowthComparison. */
function GrowthEmptyState({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center">
      <TrendingUp className="h-8 w-8 text-muted-foreground/40 mb-2" />
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

// ------------------------------------------------------------
//  FIX (TASK H-3): old-cache empty state is now ACTIONABLE. The passive
//  "tunggu recompute background" copy was useless — pre-H-3, a pre-deploy
//  cache row was served as a FRESH hit (no recompute ever triggered), and
//  refreshing only re-hit the same server row. With the H-3 server fix
//  (payload-schema versioning in the cache key) this branch is effectively
//  unreachable, but the button guarantees recovery even if it somehow
//  appears: it triggers the full refresh flow (server cache clear +
//  client refetch) instead of asking the user to wait.
// ------------------------------------------------------------
function StalePayloadEmptyState({ onRefresh }: { onRefresh?: () => void }) {
  const [requested, setRequested] = useState(false);

  const handleClick = useCallback(() => {
    if (requested) return;
    setRequested(true);
    onRefresh?.();
    // Re-arm after 2 minutes in case the recompute failed. The success path
    // never lands here: the refreshed payload contains topGrowth, so this
    // whole branch unmounts. (setState-after-unmount is a no-op in React 18+.)
    window.setTimeout(() => setRequested(false), 120_000);
  }, [onRefresh, requested]);

  return (
    <div className="flex flex-col items-center justify-center py-8 text-center gap-3">
      <TrendingUp className="h-8 w-8 text-muted-foreground/40 mb-2" />
      <p className="text-sm text-muted-foreground">
        Data Top Growth belum ada di payload lama (cache sebelum pembaruan).
        {onRefresh ? ' Hitung ulang data analisis untuk memuatnya.' : ' Muat ulang halaman setelah beberapa saat.'}
      </p>
      {onRefresh ? (
        <Button
          variant="outline"
          size="sm"
          onClick={handleClick}
          disabled={requested}
          className="h-8 gap-1.5 text-xs"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${requested ? 'animate-spin' : ''}`} />
          {requested ? 'Menghitung ulang…' : 'Hitung Ulang Data Analisis'}
        </Button>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------
//  TASK H-5 — Period legend: the two compared periods, spelled out.
//  Small definition-list rows: label (Kini/Pembanding) → value with the
//  concrete week + month + day range and, for the compare row, HOW it
//  was chosen (otomatis vs dipilih). Replaces the old cryptic one-line
//  subtitle ("Sales WEEK 2 Mei vs WEEK 2 April — ranking |Δ|") that
//  never made the compared periods obvious.
// ------------------------------------------------------------
function PeriodLegend({ data }: { data: AnalysisData }) {
  const { monthLabel, weekLabel, comparisonWeek, comparisonMonth, comparisonAuto, weekRange, comparisonWeekRange } =
    data.period;

  const currText = formatPeriodLabel(weekLabel, monthLabel, weekRange);
  const hasCompare = !!comparisonWeek;
  const compareText = hasCompare
    ? formatPeriodLabel(
        comparisonWeek,
        comparisonMonth && comparisonMonth !== monthLabel ? comparisonMonth : monthLabel,
        comparisonWeekRange,
      )
    : null;

  return (
    <div className="ml-9 mt-1 grid grid-cols-[auto_1fr] items-baseline gap-x-2.5 gap-y-0.5 text-[11px] tabular-nums">
      <span className="font-medium text-muted-foreground/80">Periode ini</span>
      <span className="font-medium text-foreground/85 truncate" title={currText}>{currText}</span>

      <span className="font-medium text-muted-foreground/80">Pembanding</span>
      {compareText ? (
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="text-amber-700 dark:text-amber-400 font-medium truncate" title={compareText}>
            {compareText}
          </span>
          <Badge
            variant="outline"
            className="h-4 shrink-0 px-1 text-[9px] font-medium leading-none border-border/60 text-muted-foreground"
            title={
              comparisonAuto
                ? 'Periode pembanding otomatis: minggu yang sama di bulan sebelumnya'
                : 'Periode pembanding dipilih pada filter'
            }
          >
            {comparisonAuto ? 'otomatis' : 'dipilih'}
          </Badge>
        </span>
      ) : (
        <span className="text-muted-foreground/60 italic">belum ada — upload minggu di bulan sebelumnya</span>
      )}
    </div>
  );
}

// ------------------------------------------------------------
//  TASK H-5 — one contributor line inside an expanded row. Mirrors the
//  parent row's columns (name / signed Δ / % or "Baru") so the eye can
//  line them up, indented one level under the row it explains.
//  TASK H-6: contributors are ALWAYS Δ pemakaian BOM (qty) — both drill
//  directions rank BOM movement — so the Δ column is qty + satuan.
// ------------------------------------------------------------
const ContributorLine = memo(function ContributorLine({ c }: { c: TopGrowthContributor }) {
  return (
    <div className="flex items-center gap-2 py-1 text-[11px] tabular-nums">
      <span className="w-1.5 shrink-0 self-stretch rounded-full bg-border/70" aria-hidden="true" />
      <span className="flex-1 min-w-0 truncate text-muted-foreground" title={c.name}>{c.name}</span>
      <span className={`w-20 shrink-0 text-right font-semibold ${growthColor(c.delta)}`}>
        {formatQtySigned(c.delta, c.unit)}
      </span>
      <span className="w-16 shrink-0 text-right">
        {c.isNew ? (
          <Badge
            variant="outline"
            className="h-4 px-1 text-[9px] font-medium border-sky-300 text-sky-700 bg-sky-50/60 dark:border-sky-800 dark:text-sky-400 dark:bg-sky-950/30"
            title="Tidak ada pemakaian BOM di periode pembanding (base nol) — % tidak dapat dihitung"
          >
            Baru
          </Badge>
        ) : (
          <span className={growthColor(c.pct ?? 0)}>{fmtGrowth(c.pct ?? 0)}</span>
        )}
      </span>
    </div>
  );
});

export const TopGrowthCard = memo(function TopGrowthCard({
  data,
  onRefresh,
}: {
  data: AnalysisData;
  /** TASK H-3: full refresh flow (server cache clear + client refetch) — used by the stale-payload recovery button. */
  onRefresh?: () => void;
}) {
  const [grain, setGrain] = useState<Grain>('outlet');
  // TASK H-5: single-open accordion — the name of the expanded row. One at a
  // time keeps the list scannable; switching grain resets it (row names from
  // the other grain must never inherit the open state).
  const [expanded, setExpanded] = useState<string | null>(null);

  // Pin field identities first (P3-HYG-7a lesson) so the useMemo below
  // isn't defeated by fresh fallback arrays on every render.
  const topGrowth = data.topGrowth;
  const byOutlet = topGrowth?.byOutlet;
  const byItem = topGrowth?.byItem;

  // Derived display list — MUST be memoized (audit D-b lesson: never
  // recompute inline per render). Deps are stable references under
  // TanStack Query structural sharing.
  const rows = useMemo<TopGrowthRow[]>(() => {
    const list = grain === 'outlet' ? byOutlet : byItem;
    return list ? list.slice(0, DISPLAY_LIMIT) : [];
  }, [grain, byOutlet, byItem]);

  const handleGrainChange = useCallback((v: string) => {
    setGrain(v === 'item' ? 'item' : 'outlet');
    setExpanded(null);
  }, []);

  const handleRowToggle = useCallback((name: string) => {
    // Toggle this row; clicking another row closes the previous one.
    setExpanded((prev) => (prev === name ? null : name));
  }, []);

  const grainNoun = grain === 'outlet' ? 'resto' : 'barang';
  // Contributor vocabulary flips with the grain: an outlet row's
  // contributors are barang; an item row's contributors are resto.
  const childNoun = grain === 'outlet' ? 'barang' : 'resto';
  const contributorLimit = topGrowth?.contributorLimit ?? CONTRIBUTOR_LIMIT_FALLBACK;
  // TASK H-6: the Δ column's metric follows the grain — Per Resto ranks
  // ΔSales in Rp (salesMode); Per Barang ranks Δ pemakaian BOM in the
  // item's satuan. Copy + thresholds below branch on this.
  const isSalesGrain = grain === 'outlet';
  const metricCaption = isSalesGrain ? 'ΔSales per resto (Rp)' : 'Δ pemakaian BOM per barang (satuan barang)';
  const thresholdLabel = isSalesGrain ? '|ΔSales| ≥ Rp1.000' : '|ΔBOM| ≥ 0,01 satuan';

  // TASK H-6: formula + reading copy per grain. The two grains rank
  // DIFFERENT metrics (Sales is outlet-level only; BOM usage is the
  // per-barang demand signal) — spelling this out is what keeps the
  // mixed-metric card unambiguous.
  const formulaText = isSalesGrain
    ? 'ΔSales = Sales resto (periode ini) − Sales resto (pembanding)'
    : 'ΔBOM = Σ pemakaian BOM barang (periode ini) − Σ pemakaian BOM (pembanding)';
  const descriptionText = isSalesGrain
    ? 'UNTUK APA: melihat resto dengan pergerakan Sales (nominal, Rp) terbesar vs periode pembanding — minggu yang sama di bulan sebelumnya (otomatis), atau pembanding yang dipilih. Sales per resto = MODE kolom Penjualan (OutletPeriodSales) — angka yang sama dengan Ringkasan Eksekutif / Top Outlets.\n' +
      'CARA BACA: Δ = Sales sekarang − Sales pembanding (bertanda; naik = emerald, turun = merah). % = Δ / |Sales pembanding| — tidak bisa dihitung saat base pembanding nol, ditampilkan sebagai badge "Baru". Ranking berdasar |Δ|; perubahan < Rp1.000 disaring sebagai noise. Server meranking 15, kartu menampilkan 10 teratas.\n' +
      `DRILL-DOWN: klik baris untuk membuka barang dengan Δ pemakaian BOM terbesar di resto itu (top ${contributorLimit}). Sales adalah angka level-outlet — tidak ada Sales per barang — sehingga pemakaian BOM adalah indikator demand per barang yang terdekat.\n` +
      'CONTOH: Sales 5,3Jt → 7,4Jt: Δ = +2,1Jt, % = +39,6%.'
    : 'UNTUK APA: melihat barang dengan pergerakan pemakaian BOM (qty, satuan barang) terbesar vs periode pembanding — konsisten dengan metric BOM di Growth Comparison. Sales tidak bisa dipecah per barang (angka level-outlet), sehingga pemakaian BOM dipakai sebagai sinyal demand per barang.\n' +
      'CARA BACA: Δ = pemakaian BOM sekarang − pembanding (bertanda, dalam satuan barang; naik = emerald). % = Δ / |pembanding| — "Baru" saat base pembanding nol. Ranking berdasar |Δ|; perubahan < 0,01 satuan disaring sebagai noise.\n' +
      `DRILL-DOWN: klik baris untuk membuka resto penyumbang Δ pemakaian BOM terbesar untuk barang itu (top ${contributorLimit}).\n` +
      'CONTOH: BOM 320 kg → 400 kg: Δ = +80 kg, % = +25%.';
  const tooltipText = isSalesGrain
    ? `Naik = baik (Sales bertambah). Sales per resto = MODE kolom Penjualan — konsisten dengan kartu lain. Badge "Baru" = tidak ada Sales di periode pembanding (base nol). Klik baris untuk drill-down: barang dengan Δ pemakaian BOM terbesar. Rentang tanggal mengikuti minggu kumulatif (W2 = tgl 1–14).`
    : `Δ pemakaian BOM per barang, dalam satuan barang (naik = pemakaian bertambah — indikator demand). Klik baris untuk drill-down: resto penyumbang Δ terbesar. Rentang tanggal mengikuti minggu kumulatif (W2 = tgl 1–14).`;

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground shrink-0">
            <TrendingUp className="h-3.5 w-3.5" />
          </span>
          Top Growth
          <FormulaInfo
            formula={formulaText}
            description={descriptionText}
            side="bottom"
          />
          <InfoTooltip content={tooltipText} />
        </CardTitle>
        {/* TASK H-5: explicit compared-periods legend — "growth dari periode
            apa aja" answered visually, including HOW the compare period was
            chosen (otomatis/dipilih badge) instead of a cryptic subtitle. */}
        <PeriodLegend data={data} />
      </CardHeader>
      <CardContent>
        {/* Grain toggle — pattern from RestoAnalysis.tsx (TabsList grid-cols-2/3),
            state kept local: switching grain must not re-render sibling sections. */}
        <Tabs value={grain} onValueChange={handleGrainChange}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="outlet" className="text-xs">Per Resto</TabsTrigger>
            <TabsTrigger value="item" className="text-xs">Per Barang</TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Payload predates the field (old cache entry) — ACTIONABLE recovery
            since TASK H-3: the button clears the server cache + refetches, so
            the next payload contains topGrowth and this branch unmounts. */}
        {!topGrowth ? (
          <StalePayloadEmptyState onRefresh={onRefresh} />
        ) : !data.period.comparisonWeek ? (
          // Mirrors GrowthComparison's no-compare-period branch — without a
          // compare period every group would be "Baru" (base nol), which is
          // top-sales, not growth.
          <GrowthEmptyState text="Tidak ada data periode pembanding. Upload beberapa minggu untuk mengaktifkan analisis growth." />
        ) : rows.length === 0 ? (
          <GrowthEmptyState
            text={isSalesGrain
              ? 'Tidak ada resto dengan perubahan Sales signifikan (|Δ| ≥ Rp1.000) vs periode pembanding.'
              : 'Tidak ada barang dengan perubahan pemakaian BOM signifikan (|Δ| ≥ 0,01 satuan) vs periode pembanding.'}
          />
        ) : (
          <>
            {/* TASK H-6: metric caption — the Δ column's metric follows the
                tab (ΔSales Rp vs Δ pemakaian BOM qty). One glance tells the
                user what the numbers are BEFORE reading any row. */}
            <p className="mt-2.5 text-[11px] font-medium text-muted-foreground">
              {metricCaption}
            </p>
            <div className="mt-1.5 max-h-[420px] overflow-y-auto pr-1">
            <ul className="space-y-0.5">
              {rows.map((r, i) => {
                const isOpen = expanded === r.name;
                const panelId = `topgrowth-contrib-${i}`;
                return (
                  <li key={r.name} className="border-b border-border/40 last:border-0 last:pb-0">
                    {/* TASK H-5: the row itself is a button — keyboard-focusable,
                        aria-expanded, single-open accordion. 44px-ish touch
                        target via py-2 on the button. */}
                    <button
                      type="button"
                      onClick={() => handleRowToggle(r.name)}
                      aria-expanded={isOpen}
                      aria-controls={panelId}
                      className="flex w-full items-center gap-2 rounded-md py-2 text-xs text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/60"
                    >
                      <span className="w-5 shrink-0 text-right text-muted-foreground tabular-nums">{i + 1}</span>
                      {/* Chevron — right when closed, rotates down when open. */}
                      {isOpen ? (
                        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
                      )}
                      <span className="flex-1 min-w-0 truncate font-medium" title={r.name}>{r.name}</span>
                      {/* Signed delta — colored via growthColor (inverse=false):
                          naik = baik → emerald. TASK H-6: the metric follows
                          the grain — ΔSales (Rp compact) for Per Resto, Δ
                          pemakaian BOM (qty + satuan) for Per Barang. */}
                      <span className={`w-20 shrink-0 text-right tabular-nums font-semibold ${growthColor(r.delta)}`}>
                        {isSalesGrain ? formatDeltaSigned(r.delta) : formatQtySigned(r.delta, r.unit)}
                      </span>
                      {/* Signed pct — or "Baru" badge when there is no prev base. */}
                      <span className="w-16 shrink-0 text-right">
                        {r.isNew ? (
                          <Badge
                            variant="outline"
                            className="h-5 px-1.5 text-[10px] font-medium border-sky-300 text-sky-700 bg-sky-50/60 dark:border-sky-800 dark:text-sky-400 dark:bg-sky-950/30"
                            title={isSalesGrain
                              ? 'Tidak ada Sales di periode pembanding (base nol) — % tidak dapat dihitung'
                              : 'Tidak ada pemakaian BOM di periode pembanding (base nol) — % tidak dapat dihitung'}
                          >
                            Baru
                          </Badge>
                        ) : (
                          <span className={`tabular-nums ${growthColor(r.pct)}`}>{fmtGrowth(r.pct)}</span>
                        )}
                      </span>
                    </button>

                    {/* TASK H-5: drill-down panel — top sub-grain movers driving
                        this row's Δ. Data rides the payload (no fetch); the
                        panel only mounts when open (cheap + keeps DOM small).
                        TASK H-6: contributors are ALWAYS Δ pemakaian BOM —
                        Sales is outlet-level, so BOM movement is the closest
                        item-level demand signal (stated in the panel). */}
                    {isOpen ? (
                      <div id={panelId} className="mb-1 ml-9 border-l-2 border-border/60 pl-2">
                        <p className="py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                          {childNoun === 'barang' ? 'Barang' : 'Resto'} — Δ pemakaian BOM terbesar (top {contributorLimit})
                        </p>
                        {r.contributors.length > 0 ? (
                          r.contributors.map((c) => <ContributorLine key={c.name} c={c} />)
                        ) : (
                          <p className="py-1 text-[11px] italic text-muted-foreground/60">
                            Tidak ada {childNoun} dengan pergerakan pemakaian BOM di {grainNoun} ini.
                          </p>
                        )}
                        <p className="pb-1 text-[10px] italic text-muted-foreground/55">
                          Sales adalah angka level-outlet — pemakaian BOM per {childNoun} adalah indikator demand terdekat.
                        </p>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-[11px] text-muted-foreground/60">
              Top {rows.length} dari maksimal 15 mover terbesar per {grainNoun} · {thresholdLabel} · klik baris untuk detail {childNoun} penyumbang
            </p>
          </div>
          </>
        )}
      </CardContent>
    </Card>
  );
});
