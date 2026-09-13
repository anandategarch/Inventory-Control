'use client';

// ============================================================
//  TopGrowthCard — "Top Growth (Resto & Barang)"
//  --------------------------------------------------------
//  Task H-2c (CHANGE 6): Top movers vs the compare period,
//  toggleable between two grains:
//    - Per Resto  → data.topGrowth.byOutlet (group o.name)
//    - Per Barang → data.topGrowth.byItem   (group i.name)
//
//  Task H-5 (v2 — period clarity + drill-down):
//    - PERIOD LEGEND: an explicit "Periode ini vs Pembanding" block in the
//      header — concrete week + month + day range (weeks are cumulative:
//      WEEK 2 = tgl 1–14) + how the compare period was chosen (otomatis =
//      same week in the previous month, or dipilih).
//    - DRILL-DOWN: every row is expandable (accordion). Per Resto rows
//      expand into the top BARANG driving that resto's Δ; Per Barang rows
//      expand into the top RESTO driving that barang's Δ. Contributors
//      arrive IN the /api/analysis payload (topGrowth[].contributors —
//      computed by queryTopGrowth from the same (outlet × item) deviation
//      matrix), so expansion is pure client state: no fetch, no spinner.
//
//  Data comes from the /api/analysis payload (`topGrowth`, computed
//  by queryTopGrowth) — same compare-period semantics as
//  GrowthComparison: auto = same weekLabel in the previous month, or
//  the user's explicit compare period. No separate fetch, no separate
//  cache — it rides the 30-min cache / SWR / background-recompute
//  envelope of the analysis payload.
//
//  TASK H-7 (metric switch — user request: "Top Growth (Resto &
//  Barang) pakai nominal deviasi sum kemudian absolute dan signed
//  nilai asli dan drill down nya pakai kuantiti deviasi dan ada
//  nominal juga"): BOTH tabs rank the SAME metric —
//    - ROWS (Per Resto & Per Barang): Δ SUM(nominalDeviasi) in Rp —
//      the SIGNED NET nominal deviation (negative = LOSS / over-
//      consumption, positive = SURPLUS / under-consumption — the same
//      number as the Ringkasan Eksekutif "Nominal Deviasi" KPI).
//      Ranking by |Δ| (absolute), display of the SIGNED real value.
//    - DRILL-DOWN contributors: ranked by Δ kuantiti deviasi (qty,
//      signed, satuan) AND each line also shows Δ nominal (Rp) —
//      volume and value side by side ("ada nominal juga").
//
//  Sign convention (sacred): delta = curr − prev. Δ > 0 = deviasi
//  bergerak ke arah SURPLUS (atau LOSS berkurang) → emerald; Δ < 0 =
//  bergerak ke arah LOSS (over-consumption meningkat) → merah
//  (growthColor with inverse=false — the app-wide LOSS=red framing).
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
import { fmtNum, fmtPct, growthColor } from '@/lib/format';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { clickableRowProps } from '@/lib/a11y';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import type { AnalysisData } from '@/hooks/useAnalysis';
import type { TopGrowthContributor, TopGrowthRow } from '@/lib/queries/growth-drivers';

/** Server caps each list at 15 rows (queryTopGrowth); the card shows the top 10. */
const DISPLAY_LIMIT = 10;
/** Server-side contributor cap (topGrowth.contributorLimit) — fallback for old payloads. */
const CONTRIBUTOR_LIMIT_FALLBACK = 5;

type Grain = 'outlet' | 'item';

// ------------------------------------------------------------
//  Formatting — compact signed nominal delta.
//  VH-3: delegates to lib/format fmtNum (Indonesian suffixes +
//  comma decimals — normalizes the old dot-decimal local copy,
//  closing the H-14-a mixed-decimal finding in this file).
// ------------------------------------------------------------
function formatDelta(v: number): string {
  return fmtNum(v);
}

function formatDeltaSigned(v: number): string {
  // Negative sign is already emitted by formatDelta; only append "+".
  return v > 0 ? `+${formatDelta(v)}` : formatDelta(v);
}

// ------------------------------------------------------------
//  TASK H-7 — QTY delta formatting (drill-down contributor lines):
//  "−12,5 kg". id-ID locale, max 2 decimals under 10K, 0 above. The
//  satuan suffix makes a qty impossible to misread as rupiah.
// ------------------------------------------------------------
function formatQty(v: number, unit?: string | null): string {
  const abs = Math.abs(v);
  const num = abs >= 10_000
    ? abs.toLocaleString('id-ID', { maximumFractionDigits: 0 })
    : abs.toLocaleString('id-ID', { maximumFractionDigits: 2 });
  return unit ? `${num} ${unit}` : num;
}

function formatQtySigned(v: number, unit?: string | null): string {
  // FIX (BUG-HUNT B6/BUG-3-02): formatQty() strips the sign via Math.abs and
  // toLocaleString never re-emits it, so negative Δ qty rendered as a bare
  // "12,5 kg" (direction readable only from color) while the adjacent Δ
  // nominal column IS signed. Restore the explicit minus; keep 0 unsigned.
  return v > 0 ? `+${formatQty(v, unit)}` : v < 0 ? `-${formatQty(v, unit)}` : formatQty(v, unit);
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
//  was chosen (otomatis vs dipilih). Answers "growth dari periode apa
//  aja?" at a glance.
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
//  TASK H-7 — one contributor line inside an expanded row. TWO delta
//  columns side by side (volume AND value — "kuantiti deviasi dan ada
//  nominal juga"):
//    - Δ kuantiti deviasi (signed, satuan barang) — the drill-down's
//      RANKING metric, bold.
//    - Δ nominal deviasi (signed, Rp) — the value movement.
//  "Baru" rides inline after the name when the contributor has no
//  deviation base of either kind in the compare period. A mini header
//  row (ContributorHeader) labels the two columns.
// ------------------------------------------------------------
const CONTRIBUTOR_QTY_COL = 'w-24';
const CONTRIBUTOR_RP_COL = 'w-20';

function ContributorHeader() {
  return (
    <div className="flex items-center gap-2 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground/60">
      <span className="w-1.5 shrink-0" aria-hidden="true" />
      <span className="flex-1 min-w-0" />
      <span className={`${CONTRIBUTOR_QTY_COL} shrink-0 text-right`}>Δ kuantiti</span>
      <span className={`${CONTRIBUTOR_RP_COL} shrink-0 text-right`}>Δ nominal</span>
    </div>
  );
}

const ContributorLine = memo(function ContributorLine({
  c,
  onClick,
}: {
  c: TopGrowthContributor;
  /** NAVLINK-1 (B1): when set, the line is a keyboard-accessible link-out
   *  (barang → Trend Item tab, resto → Resto tab via focusOutlet). */
  onClick?: () => void;
}) {
  return (
    <div
      {...(onClick ? clickableRowProps(onClick) : {})}
      className={`flex items-center gap-2 rounded-md py-1 text-[11px] tabular-nums outline-none transition-colors ${
        onClick ? 'cursor-pointer hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/60' : ''
      }`}
      title={onClick ? 'Klik untuk membuka analisa lengkap' : undefined}
    >
      <span className="w-1.5 shrink-0 self-stretch rounded-full bg-border/70" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="min-w-0 truncate text-muted-foreground" title={c.name}>{c.name}</span>
        {c.isNew ? (
          <Badge
            variant="outline"
            className="h-4 shrink-0 px-1 text-[9px] font-medium leading-none border-sky-300 text-sky-700 bg-sky-50/60 dark:border-sky-800 dark:text-sky-400 dark:bg-sky-950/30"
            title="Tidak ada deviasi (kuantiti & nominal) di periode pembanding — base nol"
          >
            Baru
          </Badge>
        ) : null}
      </span>
      <span className={`${CONTRIBUTOR_QTY_COL} shrink-0 text-right font-semibold ${growthColor(c.qtyDelta)}`}>
        {formatQtySigned(c.qtyDelta, c.unit)}
      </span>
      <span className={`${CONTRIBUTOR_RP_COL} shrink-0 text-right font-medium ${growthColor(c.nominalDelta)}`}>
        {formatDeltaSigned(c.nominalDelta)}
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

  // NAVLINK-1 (B1): cross-feature navigation — same store actions the other
  // cards use (pattern: RankingNasionalCard's Navigation Bridge). Barang
  // names link to the Item tab's trend view (item name IS the identity);
  // resto rows/contributors link to the Resto tab via focusOutlet(code).
  const { setFocusOutlet, setTrendSelectedItem, setActiveTab } = useDashboard(useShallow((s) => ({
    setFocusOutlet: s.setFocusOutlet,
    setTrendSelectedItem: s.setTrendSelectedItem,
    setActiveTab: s.setActiveTab,
  })));

  const handleContributorClick = useCallback(
    (c: TopGrowthContributor) => {
      if (grain === 'outlet') {
        // Contributor is a barang → Trend Item view (exact item-name identity).
        setTrendSelectedItem(c.name);
        setActiveTab('item');
      } else if (c.code) {
        // Contributor is a resto with its outlet code → Resto deep dive.
        setFocusOutlet(c.code);
      }
    },
    [grain, setFocusOutlet, setTrendSelectedItem, setActiveTab],
  );

  const handleRowLink = useCallback(
    (r: TopGrowthRow) => {
      if (grain === 'item') {
        setTrendSelectedItem(r.name);
        setActiveTab('item');
      } else if (r.code) {
        setFocusOutlet(r.code);
      }
    },
    [grain, setFocusOutlet, setTrendSelectedItem, setActiveTab],
  );

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
  // TASK H-7: BOTH grains rank the SAME metric — Δ nominal deviasi (Rp,
  // signed). Only the drill-down vocabulary (barang vs resto) flips.
  const metricCaption = `Δ nominal deviasi per ${grainNoun} (Rp)`;
  const thresholdLabel = '|Δnominal| ≥ Rp1.000';

  // TASK H-7: formula + reading copy. Both tabs rank the signed net
  // NOMINAL deviation; the drill-down decomposes it into kuantiti
  // (volume) + nominal (value) per sub-grain.
  // UX-TOOLTIP-1 (user request 2025-12): ONE tooltip (was FormulaInfo +
  // InfoTooltip side by side) in simple "ini buat apa" language.
  const formulaText = 'ΔNominal Deviasi = Σ nominal deviasi (periode ini) − Σ nominal deviasi (pembanding)';
  const descriptionText =
    'UNTUK APA: melihat resto / barang dengan pergerakan NOMINAL DEVIASI (Rp) terbesar vs periode pembanding — negatif = LOSS (pemakaian melebihi BOM), positif = SURPLUS.\n' +
    'CARA BACA: ranking berdasar |Δ|; Δ negatif = LOSS memburuk (merah), Δ positif = bergerak ke arah SURPLUS (hijau). Perubahan < Rp1.000 disaring sebagai noise.\n' +
    `DRILL-DOWN: klik baris untuk membuka ${childNoun} penyumbang terbesar di ${grainNoun} itu.\n` +
    'CONTOH: Σ nominal deviasi −500rb → −900rb: Δ = −400rb (LOSS memburuk, merah).';

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
        </CardTitle>
        {/* SPEC-1 (§21): question-first subtitle (anti-pattern #12). */}
        <p className="text-xs text-muted-foreground ml-9"><span className="font-medium text-foreground/70">Siapa yang berubah paling besar?</span> — per resto dan per barang vs periode pembanding</p>
        {/* TASK H-5: explicit compared-periods legend — "growth dari periode
            apa aja" answered visually, including HOW the compare period was
            chosen (otomatis/dipilih badge). */}
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
          // top-mover, not growth.
          <GrowthEmptyState text="Tidak ada data periode pembanding. Upload beberapa minggu untuk mengaktifkan analisis growth." />
        ) : rows.length === 0 ? (
          <GrowthEmptyState
            text={`Tidak ada ${grainNoun} dengan perubahan nominal deviasi signifikan (|Δ| ≥ Rp1.000) vs periode pembanding.`}
          />
        ) : (
          <>
            {/* TASK H-7: metric caption — both tabs rank the SAME metric
                (Δ nominal deviasi, Rp). One glance tells the user what the
                numbers are BEFORE reading any row. */}
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
                      {/* Signed nominal delta (Rp compact) — colored via
                          growthColor (inverse=false): Δ>0 = toward SURPLUS /
                          less loss → emerald; Δ<0 = toward LOSS → red. TASK
                          H-7: the metric is the SAME for both grains. */}
                      <span className={`w-20 shrink-0 text-right tabular-nums font-semibold ${growthColor(r.delta)}`}>
                        {formatDeltaSigned(r.delta)}
                      </span>
                      {/* Signed pct — or "Baru" badge when there is no prev base. */}
                      <span className="w-16 shrink-0 text-right">
                        {r.isNew ? (
                          <Badge
                            variant="outline"
                            className="h-5 px-1.5 text-[10px] font-medium border-sky-300 text-sky-700 bg-sky-50/60 dark:border-sky-800 dark:text-sky-400 dark:bg-sky-950/30"
                            title="Tidak ada nominal deviasi di periode pembanding (base nol) — % tidak dapat dihitung"
                          >
                            Baru
                          </Badge>
                        ) : (
                          <span className={`tabular-nums ${growthColor(r.pct)}`}>{fmtPct(r.pct, true, 1)}</span>
                        )}
                      </span>
                    </button>

                    {/* TASK H-5: drill-down panel — top sub-grain movers driving
                        this row's Δ. Data rides the payload (no fetch); the
                        panel only mounts when open (cheap + keeps DOM small).
                        TASK H-7: contributors are ranked by |Δ kuantiti
                        deviasi| and ALSO show Δ nominal (Rp) — volume and
                        value side by side, labeled by the column header. */}
                    {isOpen ? (
                      <div id={panelId} className="mb-1 ml-9 border-l-2 border-border/60 pl-2">
                        <p className="py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                          {childNoun === 'barang' ? 'Barang' : 'Resto'} — Δ kuantiti deviasi terbesar (top {contributorLimit})
                        </p>
                        {r.contributors.length > 0 ? (
                          <>
                            <ContributorHeader />
                            {r.contributors.map((c) => (
                              <ContributorLine
                                key={c.name}
                                c={c}
                                onClick={
                                  // NAVLINK-1 (B1): barang always links (item-name
                                  // identity); resto links only when its code rode
                                  // the payload (old caches → undefined → no link).
                                  grain === 'outlet' || c.code
                                    ? () => handleContributorClick(c)
                                    : undefined
                                }
                              />
                            ))}
                          </>
                        ) : (
                          <p className="py-1 text-[11px] italic text-muted-foreground/60">
                            Tidak ada {childNoun} dengan pergerakan deviasi di {grainNoun} ini.
                          </p>
                        )}
                        {/* NAVLINK-1 (B1): row-level link-out — the expanded row's
                            OWN entity, not just its contributors. Item row →
                            Trend Item; outlet row → Resto deep dive (needs code). */}
                        {grain === 'item' || r.code ? (
                          <button
                            type="button"
                            onClick={() => handleRowLink(r)}
                            className="mt-1 inline-flex items-center gap-1 rounded-sm text-[10px] font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                          >
                            {grain === 'item' ? 'Trend item ini →' : 'Buka resto ini →'}
                          </button>
                        ) : null}
                        <p className="pb-1 text-[10px] italic text-muted-foreground/55">
                          Δ kuantiti = pergerakan volume (satuan); Δ nominal = pergerakan nilai (Rp). Kuantiti tetap
                          dengan nominal bergerak = efek harga.
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
