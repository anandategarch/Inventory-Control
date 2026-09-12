'use client';

// ============================================================
//  AreaTab — "Area" tab (VH-2, D3/D4): AreaComparison (14-area
//  table) + OutletHealthRanking, promoted from the old
//  DashboardTab sections into their own deep-analysis tab.
//  --------------------------------------------------------
//  Default tab of the L6 band (spec §8 derived decision): both
//  components render from the payload /api/analysis the page
//  already fetched — no additional request fires on eager
//  mount, making Area the cheapest first tab.
//  PERF-FE: wrapped in React.memo — page.tsx re-renders on any
//  Zustand state change; without memo this subtree re-renders
//  unnecessarily.
//  Label note: "Ranking Kondisi Outlet" — one term everywhere
//  (closes the old "Ranking Kondisi Resto" vs "Outlet" naming
//  inconsistency, spec D4).
// ============================================================

import { memo } from 'react';
import { BarChart3, MapPin } from 'lucide-react';
import {
  AreaComparison, OutletHealthRanking,
} from '@/components/dashboard/AdvancedAnalysis';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import { SectionHeader } from '@/components/dashboard/shared';
import type { AnalysisData } from '@/hooks/useAnalysis';

export interface AreaTabProps {
  data: AnalysisData;
}

export const AreaTab = memo(function AreaTab({ data }: AreaTabProps) {
  return (
    <div className="space-y-4 min-w-0">
      {/* Section: Area Comparison + Outlet Health Ranking */}
      {/* FIX (UI-15): removed redundant sm:grid-cols-1 (default behavior). */}
      <section className="grid lg:grid-cols-2 gap-4 min-w-0">
        {/* FIX (BUG-HUNT A1): grid items must carry min-w-0 — without it the
            item min-width resolves to the table's min-content (~731px with
            realistic data) and blows the 375px viewport out to ~745px. */}
        <div className="min-w-0">
          <SectionHeader
            icon={<MapPin className="h-4 w-4 text-muted-foreground" />}
            title="Perbandingan Area"
          />
          <ErrorBoundary label="Area Comparison">
            <AreaComparison data={data} />
          </ErrorBoundary>
        </div>
        <div className="min-w-0">
          <SectionHeader
            icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
            title="Ranking Kondisi Outlet"
          />
          <ErrorBoundary label="Outlet Health Ranking">
            <OutletHealthRanking data={data} />
          </ErrorBoundary>
        </div>
      </section>
    </div>
  );
});
