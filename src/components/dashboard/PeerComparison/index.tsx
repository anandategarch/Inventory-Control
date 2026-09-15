'use client';

// ============================================================
//  PeerComparison — main component (thin wrapper)
//
//  Adds 8 analysis features above/below the existing peer table:
//   #1 Ranking Summary, #2 Gap Analysis, #3 Item-Level Comparison,
//   #4 Scatter Plot, #5 Anomaly Flags, #6 Trend Chart,
//   #7 Efficiency Score, #9 Correlation Insight
//
//  Sub-components live in ./peer-comparison/*.
//  Pure compute helpers live in ./peer-computation (REFACTOR-1-c
//  split — moved verbatim, zero behavior change).
//
//  SPLIT-G: this file is now the folder entry (index.tsx) —
//  queries + derived memos live in ./use-peer-queries, the
//  pick-an-outlet early return in ./no-outlet-card, the peer
//  table in ./peer-table-card. Import path
//  '@/components/dashboard/PeerComparison' resolves here
//  (folder + index.tsx) — caller imports unchanged.
// ============================================================

import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Users, Scale } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { fmtIDR } from '@/lib/format';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';
import { SectionHeader } from '@/components/dashboard/shared';

import {
  EfficiencyScoreCard,
  GapAnalysisCard,
  ScatterPlotCard,
  RankingSummaryCard,
} from '@/components/dashboard/shared/peer-comparison-cards';
import { BenchmarkOpportunityCard } from '@/components/dashboard/peer-comparison/benchmark-opportunity-card';
import { ItemLevelComparison } from '@/components/dashboard/peer-comparison/items-table';
import { TopItemsAcrossPeers } from '@/components/dashboard/peer-comparison/top-items-card';
import { TrendChartCard } from '@/components/dashboard/peer-comparison/trend-chart';
import { CorrelationInsightCard } from '@/components/dashboard/peer-comparison/correlation-insight-card';
import { usePeerQueries } from './use-peer-queries';
import { NoOutletCard } from './no-outlet-card';
import { PeerTableCard } from './peer-table-card';

// Re-export shared types so callers importing from this file still work.
export type {
  PeerRow, MetricDef, ItemComparisonResponse, TrendResponse, PeerAverages, PeerTopItemsResponse,
} from '@/components/dashboard/peer-comparison/types';

export function PeerComparison() {
  const { focusOutlet, outletCode, monthLabel, currentWeek, setFocusOutlet, kelompok } = useDashboard(useShallow((s) => ({
    focusOutlet: s.focusOutlet,
    outletCode: s.outletCode,
    monthLabel: s.monthLabel,
    currentWeek: s.currentWeek,
    setFocusOutlet: s.setFocusOutlet,
    kelompok: s.kelompok,
  })));
  const activeOutlet = focusOutlet || outletCode;

  // ============================================================
  //  P1 PARALLEL QUERIES + derived state — see ./use-peer-queries
  //  (all hooks called unconditionally, BEFORE the early return,
  //  exactly like the pre-split component).
  // ============================================================
  const {
    mainData, mainLoading, mainFetching, mainError, refetchMain,
    peers, targetRow, otherPeers,
    itemsData, itemsLoading, itemsError,
    trendData, trendLoading, trendError,
    topItemsData, topItemsLoading, topItemsError,
    opportunityData, opportunityLoading, opportunityError, refetchOpportunity,
    peerAverages, efficiencyScore, gapRows, scatterPoints, rankData,
  } = usePeerQueries({ activeOutlet, monthLabel, currentWeek, kelompok });

  if (!activeOutlet) {
    return (
      <NoOutletCard
        opportunityData={opportunityData}
        opportunityLoading={opportunityLoading}
        opportunityError={opportunityError}
        onRetryOpportunity={refetchOpportunity}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* ============ 1. HEADER + EXISTING TABLE ============ */}
      <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-start gap-2.5">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5">
                <Users className="h-3.5 w-3.5" />
              </span>
              <div>
                <CardTitle className="text-sm flex items-center gap-2">
                  Peer Comparison
                  <InfoTooltip content="Target outlet dibandingkan dengan peer set (top 50 by sales proximity, ±10% sales). Metrics: Sales, Dev/BOM, Nominal, QTY, Gross/Net Loss/Surplus. Klik baris untuk ganti target." />
                </CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">
                  <span className="font-medium text-foreground">{activeOutlet}</span> vs <span className="font-medium tabular-nums">{otherPeers.length}</span> resto dengan sales ±10%{currentWeek ? ` (WEEK ${currentWeek})` : ''}
                </p>
              </div>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* ============ 2-5. ANALYSIS CARDS (grid 2 cols on desktop) ============ */}
      {/* VH-7: section header — "Enrich with Context" (Superset/Metabase):
          the analysis grid opens with the question it answers. */}
      <SectionHeader
        icon={<Scale className="h-4 w-4 text-muted-foreground" />}
        title="Ringkasan Target vs Peer"
        description="Seberapa baik outlet terpilih dibanding peer group (resto dengan sales ±10%)?"
      />
      <div className="grid grid-cols-2 gap-4">
        {targetRow && otherPeers.length > 0 && (
          <EfficiencyScoreCard
            score={efficiencyScore}
            footnote="Komposit dari Dev/BOM (50%), LOSS (25%), Residual (15%), Sales (10%). Higher = better."
          />
        )}
        {targetRow && otherPeers.length > 0 && (
          <GapAnalysisCard
            rows={gapRows}
            footerText='Untuk metrik "buruk" (Dev/BOM, LOSS, Residual), peer best = nilai terendah. Untuk Sales, peer best = nilai tertinggi.'
            gridCols={2}
          />
        )}
        {targetRow && otherPeers.length > 0 && rankData && (
          <RankingSummaryCard
            items={rankData.items}
            subtitle={
              <>
                <span className="font-medium text-foreground">{targetRow.outletName}</span> berperingkat di antara{' '}
                <span className="font-medium tabular-nums">{rankData.total}</span> resto (1 = terbaik,{' '}
                <span className="tabular-nums">{rankData.total}</span> = terburuk).
              </>
            }
            gridCols={3}
            itemLayout="horizontal"
          />
        )}
        {otherPeers.length > 0 && (
          <ScatterPlotCard
            points={scatterPoints}
            title="Sales vs Dev/BOM"
            subtitle="Setiap titik = 1 resto. Target ditandai merah. Posisi kanan-bawah = sales tinggi & deviasi rendah (ideal)."
            height={280}
            xLabel="Sales"
            yLabel="Dev/BOM"
            yUnit="%"
            formatX={fmtIDR}
            formatY={(v: number) => String(v)}
            colorMode="target-only"
            legend={[
              { label: 'Target', color: 'bg-red-600' },
              { label: 'Peer', color: 'bg-zinc-500' },
            ]}
          />
        )}
        {/* ANA-1-E (Benchmark Opportunity): measured Rp gap vs area median.
            Always rendered (self-managed loading/error/empty) — the metric
            is network-wide, so it stays useful even when the target has no
            peers and the four cards above are hidden. Also rendered in the
            !activeOutlet early-return above (FIX BUG-2-a #10). */}
        <BenchmarkOpportunityCard
          data={opportunityData}
          isLoading={opportunityLoading}
          error={opportunityError}
          onRetry={refetchOpportunity}
        />
      </div>

      {/* ============ 6. PEER TABLE + ANOMALY FLAGS (Feature 5) ============ */}
      {/* PEERTOP-2: also carries the expandable per-outlet top-item rows
          (topItemsData drives the ▸/▾ expansion under each resto row). */}
      <PeerTableCard
        mainData={mainData}
        mainLoading={mainLoading}
        mainFetching={mainFetching}
        mainError={mainError}
        peers={peers}
        otherPeers={otherPeers}
        peerAverages={peerAverages}
        targetRow={targetRow}
        onSelectOutlet={setFocusOutlet}
        onRetryMain={refetchMain}
        topItemsData={topItemsData}
        topItemsLoading={topItemsLoading}
      />

      {/* ============ 6b. TOP ITEMS ACROSS PEERS (PEERTOP-2) ============ */}
      {/* Peer-centric block grouped together (right after the Peer Table):
          cross-peer union of every peer's own top-N items — shared vs
          local problems + blind spots. Always mounted (P1) — fires its
          query in parallel with the main query. Own loading/error states. */}
      <TopItemsAcrossPeers
        data={topItemsData}
        isLoading={topItemsLoading}
        error={topItemsError}
        totalPeers={otherPeers.length}
        topN={5}
      />

      {/* ============ 7. ITEM-LEVEL COMPARISON (Feature 3) ============ */}
      {/* Always mounted (P1) — fires its query in parallel with the
          main query. Own loading/error states inside. */}
      <ItemLevelComparison
        data={itemsData}
        isLoading={itemsLoading}
        error={itemsError}
      />

      {/* ============ 8. TREND CHART (Feature 6) ============ */}
      {/* Always mounted (P1) — fires once peerCodes from main are
          available (stable peer set across weeks). Own loading/error. */}
      <TrendChartCard
        data={trendData}
        isLoading={trendLoading}
        error={trendError}
      />

      {/* ============ 9. CORRELATION INSIGHT (Feature 9) ============ */}
      {targetRow && otherPeers.length > 0 && (
        <CorrelationInsightCard target={targetRow} peers={otherPeers} peerAvg={peerAverages} />
      )}
    </div>
  );
}
