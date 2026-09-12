'use client';

// ============================================================
//  DashboardNarrative — the L2-L5 narrative layers of the
//  Visual Hierarchy restructure (VH-1).
//  --------------------------------------------------------
//  MASTER-CONTEXT-VISUAL-HIERARCHY.md §3 (prinsip struktural
//  #1): these layers live OUTSIDE the <Tabs> in page.tsx, so
//  switching a deep-analysis tab never remounts/unmounts the
//  narrative and its scroll position survives.
//
//  Layer story (Minto pyramid — answer first, evidence later):
//    01 CONTROL STATUS        — WHAT / HOW MUCH (4 KPI + cascade)
//    02 PRIORITY ACTIONS      — WHERE (priority resto + items)
//    03 KEY FINDINGS          — WHY, certainty-aware (auto insights)
//    04 DIAGNOSTIC EVIDENCE   — WHY, measured (deviation /
//                               price effect / growth / top growth /
//                               loss vs surplus)
//
//  SPEC-1 (upload spec §23/§30): layer renames — EXECUTIVE STATUS →
//  CONTROL STATUS, WHAT NEEDS ATTENTION → PRIORITY ACTIONS, WHY IT
//  HAPPENED → KEY FINDINGS, DIAGNOSIS → DIAGNOSTIC EVIDENCE. Epistemic
//  honesty: "findings/evidence" never claim confirmed root cause.
//
//  VH-3: the presentation layers are now reskinned per the spec
//  tokens (ExecutiveStatus 4-KPI, compact L3 panels, callout
//  insights, collapsible L5). Kept from VH-1: ErrorBoundary per
//  module, lazy chart imports with LoadingChart fallbacks, the
//  layer grouping + LayerHeader eyebrows + the space-y-8
//  md:space-y-10 inter-layer rhythm (spec §5.3: layer gap ≥ 2×
//  the 16px card gap).
//
//  PERF-FE: wrapped in React.memo for the same reason as the
//  old DashboardTab — the parent (page.tsx) re-renders on any
//  Zustand state change (e.g. opening a modal); without memo
//  the 12+ sections re-render on each of those even though
//  the `data` prop hasn't changed.
// ============================================================

import { memo } from 'react';
import dynamic from 'next/dynamic';
import { ExecutiveStatus } from '@/components/dashboard/narrative/ExecutiveStatus';
import { ItemPriorityPanel } from '@/components/dashboard/narrative/ItemPriorityPanel';
import { InsightsPanel } from '@/components/dashboard/InsightsPanel';
import { RestoRecommendationCard } from '@/components/dashboard/RestoRecommendationCard';
import { PriceEffectCard } from '@/components/dashboard/PriceEffectCard';
import { TopGrowthCard } from '@/components/dashboard/TopGrowthCard';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import { LoadingChart, LayerHeader } from '@/components/dashboard/shared';
import type { AnalysisData } from '@/hooks/useAnalysis';

// Phase 4: Lazy-load heavy chart components (Recharts = 5.4MB)
// ssr: false — charts are client-only (use ResponsiveContainer which needs window)
const GrowthComparison = dynamic(() => import('@/components/dashboard/Charts').then(m => m.GrowthComparison), { ssr: false, loading: () => <LoadingChart /> });
const DeviationBreakdownChart = dynamic(() => import('@/components/dashboard/Charts').then(m => m.DeviationBreakdownChart), { ssr: false, loading: () => <LoadingChart /> });
const LossVsSurplusChart = dynamic(() => import('@/components/dashboard/Charts').then(m => m.LossVsSurplusChart), { ssr: false, loading: () => <LoadingChart /> });

export interface DashboardNarrativeProps {
  data: AnalysisData;
  /** TASK H-3: full refresh flow (server cache clear + client refetch) —
   *  threaded to TopGrowthCard's stale-payload recovery button. */
  onRefresh?: () => void;
}

export const DashboardNarrative = memo(function DashboardNarrative({ data, onRefresh }: DashboardNarrativeProps) {
  return (
    <div className="space-y-8 md:space-y-10 min-w-0">
      {/* ====== L2 — CONTROL STATUS (what / how much) ====== */}
      <section id="l2-status" aria-labelledby="l2-header" className="space-y-4 scroll-mt-40">
        {/* VH-6 (Superset "Name with Purpose"): question-oriented story
            captions — WHAT → WHERE → WHY → HOW MUCH → EXPLORE (Minto). */}
        <LayerHeader number="01" title="CONTROL STATUS" id="l2-header" description="Apa kondisinya sekarang? Empat angka utama beserta kaskade penyusun deviasi." />
        {/* VH-3 (D1-c): the old ExecutiveSummary + HealthAlert pair is
            absorbed into ExecutiveStatus — 4 KPI (Deviasi hero + Residual
            + Dev/BOM + Health) + the GROSS→W/S/T→NET cascade strip. */}
        <ErrorBoundary label="Control Status">
          <ExecutiveStatus data={data} />
        </ErrorBoundary>
      </section>

      {/* ====== L3 — PRIORITY ACTIONS (where) ====== */}
      <section id="l3-attention" aria-labelledby="l3-header" className="space-y-4 scroll-mt-40">
        <LayerHeader number="02" title="PRIORITY ACTIONS" id="l3-header" description="Di mana harus bertindak lebih dulu? Resto dan item prioritas berdasarkan dampak." />
        <div className="grid lg:grid-cols-2 gap-4 min-w-0">
          {/* Section: Resto Recommendation Engine (self-fetch, no change to the
              hook/query; the analysis payload rides along for the D6 adaptive
              rule + footer coverage stats). */}
          <ErrorBoundary label="Resto Prioritas Analisa">
            <RestoRecommendationCard data={data} />
          </ErrorBoundary>
          {/* Section: Top Items — VH-3 compact panel (D5-b toggle Nominal |
              Dev/BOM, top-3 + expand, click → drill-down). The FULL TopItems
              cards live in the Item tab (tabs/ItemTab.tsx, untouched).
              H-11 (#4a — UI dedup): the Dashboard's Top Outlets card was
              REMOVED — it duplicated the Pareto tab's "Top Outlets (80%
              Deviation)" QuadrantCard; outlet prioritization here is covered
              by Resto Prioritas Analisa (left column) + Ranking Kondisi
              Outlet (Area tab). */}
          <ErrorBoundary label="Item Prioritas">
            <ItemPriorityPanel data={data} />
          </ErrorBoundary>
        </div>
      </section>

      {/* ====== L4 — KEY FINDINGS (certainty-aware why) ====== */}
      <section id="l4-why" aria-labelledby="l4-header" className="space-y-4 scroll-mt-40">
        <LayerHeader number="03" title="KEY FINDINGS" id="l4-header" description="Temuan apa yang paling penting? Diurut berdasarkan kepastian — TERUKUR (kalkulasi terverifikasi) dan INDIKASI (pola kuat, perlu validasi)." />
        <ErrorBoundary label="Insights Panel">
          <InsightsPanel data={data} />
        </ErrorBoundary>
      </section>

      {/* ====== L5 — DIAGNOSTIC EVIDENCE (measured why) ====== */}
      <section id="l5-diagnosis" aria-labelledby="l5-header" className="space-y-4 scroll-mt-40">
        <LayerHeader number="04" title="DIAGNOSTIC EVIDENCE" id="l5-header" description="Bukti terukur apa yang menjelaskan kondisi ini? Dekomposisi deviasi + efek harga (bukti primer); konteks pertumbuhan (pendukung)." />
        {/* SPEC-1 (§7.3): PRIMARY EVIDENCE — the two lenses that decompose
            the deviation itself get the 2-col top row and the strongest
            visual weight. Growth context moves DOWN to supporting. */}
        <div className="grid lg:grid-cols-2 gap-4 min-w-0">
          <ErrorBoundary label="Deviation Breakdown">
            <DeviationBreakdownChart data={data} />
          </ErrorBoundary>
          {/* AVG Price Effect (Harga vs Kuantitas)
              Task W: implements Master Context (business doc) §22/§55 —
              separates the Δ|Nominal Deviasi| vs the compare period into a
              price effect and a quantity effect (Bennet, exact).
              Self-contained fetch (/api/price-effect) — no `data` prop. */}
          <ErrorBoundary label="AVG Price Effect">
            <PriceEffectCard />
          </ErrorBoundary>
        </div>
        {/* SPEC-1 (§7.3): SUPPORTING EVIDENCE — growth context (how fast,
            who moved, direction vs SOC) demoted to a labeled sub-row with
                less visual weight (eyebrow label + 3-col grid). */}
        <div className="space-y-3 min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">
            Supporting Evidence
          </p>
          <div className="grid lg:grid-cols-3 gap-4 min-w-0">
            <ErrorBoundary label="Growth Comparison">
              <GrowthComparison data={data} />
            </ErrorBoundary>
            {/* Top Growth (per resto & barang)
                Task H-2c (CHANGE 6): biggest SALES movers vs the compare period,
                toggleable Per Resto / Per Barang — display-only v1. */}
            <ErrorBoundary label="Top Growth">
              <TopGrowthCard data={data} onRefresh={onRefresh} />
            </ErrorBoundary>
            {/* Loss/Surplus (TrendChart removed per user request) */}
            <ErrorBoundary label="Loss vs Surplus">
              <LossVsSurplusChart data={data} />
            </ErrorBoundary>
          </div>
        </div>
      </section>
    </div>
  );
});
