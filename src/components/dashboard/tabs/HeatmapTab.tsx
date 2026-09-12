'use client';

// ============================================================
//  HeatmapTab — "Heatmap" tab (VH-2, D4): AreaItemHeatmap,
//  promoted from the old DashboardTab's last section into its
//  own deep-analysis tab.
//  --------------------------------------------------------
//  Self-contained fetch (/api/area-item-heatmap) — no `data`
//  prop needed. The heatmap component stays next/dynamic +
//  ssr:false with a LoadingChart fallback (pattern carried over
//  from the old DashboardTab).
//  PERF-FE: wrapped in React.memo — page.tsx re-renders on any
//  Zustand state change; without memo this subtree re-renders
//  unnecessarily.
// ============================================================

import { memo } from 'react';
import dynamic from 'next/dynamic';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import { LoadingChart } from '@/components/dashboard/shared';

// Phase 4: Lazy-load heavy components (ssr: false — client-only)
const AreaItemHeatmap = dynamic(() => import('@/components/dashboard/AreaItemHeatmap').then(m => m.AreaItemHeatmap), { ssr: false, loading: () => <LoadingChart /> });

export const HeatmapTab = memo(function HeatmapTab() {
  return (
    <div className="space-y-4 min-w-0">
      {/* Section: Heatmap Area × Item (standalone fetch, not dependent on analysis data) */}
      <ErrorBoundary label="Heatmap Area × Item">
        <AreaItemHeatmap />
      </ErrorBoundary>
    </div>
  );
});
