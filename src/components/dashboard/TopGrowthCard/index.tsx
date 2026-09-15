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
//
//  SPLIT-G: this folder holds the split modules — format.ts
//  (constants + formatting helpers), empty-states.tsx, period-
//  legend.tsx, contributor.tsx (drill-down lines), growth-row.tsx
//  (accordion row). This file is the thin orchestrator (state,
//  navigation bridge, render). Import path
//  '@/components/dashboard/TopGrowthCard' resolves here (folder +
//  index.tsx) — caller imports unchanged.
// ============================================================

import { memo, useCallback, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TrendingUp } from 'lucide-react';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import type { AnalysisData } from '@/hooks/useAnalysis';
import type { TopGrowthContributor, TopGrowthRow } from '@/lib/queries/growth-drivers';
import { CONTRIBUTOR_LIMIT_FALLBACK, DISPLAY_LIMIT, type Grain } from './format';
import { GrowthEmptyState, StalePayloadEmptyState } from './empty-states';
import { PeriodLegend } from './period-legend';
import { GrowthRow } from './growth-row';

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
              {rows.map((r, i) => (
                <GrowthRow
                  key={r.name}
                  r={r}
                  index={i}
                  isOpen={expanded === r.name}
                  grain={grain}
                  grainNoun={grainNoun}
                  childNoun={childNoun}
                  contributorLimit={contributorLimit}
                  onToggle={handleRowToggle}
                  onContributorClick={handleContributorClick}
                  onRowLink={handleRowLink}
                />
              ))}
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
