'use client';

// ============================================================
//  ItemTab — "Item" tab (VH-2, D3/D4): the full item workflow
//  merged into ONE tab:
//    1. Item Prioritas (full version — ByNominal + ByDevBom;
//       the L3 narrative layer keeps its own copy above)
//    2. Trend Item (the entire old 'trend' tab — search bar,
//       per-period line chart, rank chart, table, flip matrix,
//       flip ranking, peer drill-down)
//    3. Pola Item (Massal / Regional / Lokal)
//  --------------------------------------------------------
//  Lazy-loaded at page level (React.lazy + Suspense + TabSkeleton)
//  — the old 'trend' tab chunk plus TopItems/AdvancedAnalysis
//  stay out of the first paint.
//  PERF-FE: wrapped in React.memo — page.tsx re-renders on any
//  Zustand state change; without memo this subtree re-renders
//  unnecessarily.
// ============================================================

import { memo } from 'react';
import { BarChart3 } from 'lucide-react';
import { TopItemsByNominal, TopItemsByDevBom } from '@/components/dashboard/TopItems';
import { ItemConsistencyAnalysis } from '@/components/dashboard/AdvancedAnalysis';
import { ItemTrendTab } from '@/components/dashboard/tabs/ItemTrendTab';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import { SectionHeader } from '@/components/dashboard/shared';
import type { AnalysisData } from '@/hooks/useAnalysis';

export interface ItemTabProps {
  data: AnalysisData;
}

export const ItemTab = memo(function ItemTab({ data }: ItemTabProps) {
  return (
    <div className="space-y-4 min-w-0">
      {/* Section: Top Items
          H-11 (#4a — UI dedup): the Dashboard's Top Outlets card was REMOVED —
          it duplicated the Pareto tab's "Top Outlets (80% Deviation)"
          QuadrantCard (same ABS(SUM(nominalDeviasi)) ranking, two backend
          scans). The Pareto tab keeps the quadrant card (it is one of the 5
          Pareto dimensions); outlet prioritization is covered by Resto
          Prioritas Analisa (L3) + Ranking Kondisi Outlet (Area tab).
          STRUCTURAL (S-1, adapted): this is the FULL version — the compact
          copy lives in the L3 narrative layer (WHAT NEEDS ATTENTION). */}
      <section>
        <SectionHeader
          icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
          title="Item Prioritas"
        />
        {/* FIX (UI-05): min-w-0 on grid wrapper prevents overflow.
            H-11 (#4a): 3→2 columns after the TopOutlets card removal. */}
        <div className="grid lg:grid-cols-2 gap-4 min-w-0">
          <ErrorBoundary label="Top Items">
            <TopItemsByNominal data={data} />
            <TopItemsByDevBom data={data} />
          </ErrorBoundary>
        </div>
      </section>

      {/* ====== TREND ITEM (per-item QTY timeline + Z-Score) ====== */}
      {/* Phase 1 — pass analysisData so the tab can render the Rank Badge
          row (item's national rank in topDeviasiRank). */}
      <ErrorBoundary label="Trend Item">
        <ItemTrendTab analysisData={data} />
      </ErrorBoundary>

      {/* Section: Item Consistency */}
      <section>
        <SectionHeader
          icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
          title="Pola Item (Massal / Regional / Lokal)"
        />
        <ErrorBoundary label="Item Consistency Analysis">
          <ItemConsistencyAnalysis data={data} />
        </ErrorBoundary>
      </section>
    </div>
  );
});
