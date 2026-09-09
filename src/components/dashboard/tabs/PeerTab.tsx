'use client';

// ============================================================
//  PeerTab — "Peer Comparison" tab content. Extracted from
//  page.tsx lines 659-668.
//  --------------------------------------------------------
//  PeerComparison is lazy-loaded (recharts heavy) — the
//  LoadingChart fallback reserves layout space.
//  PERF-FE: wrapped in React.memo — skips re-render when parent
//  re-renders for unrelated Zustand state (modal/drawer toggles).
//  PERF-FE (PAKET A): `isFetching` prop + FetchAware wrapper removed
//  — the prop toggled on every background refetch (defeating memo)
//  and FetchAware froze clicks while stale data was still usable.
//  PeerComparison keeps its own internal, local fetch indicators
//  (e.g. the refetch button spinner), which is where that signal
//  belongs.
// ============================================================

import { memo } from 'react';
import dynamic from 'next/dynamic';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import { LoadingChart } from '@/components/dashboard/shared';

const PeerComparison = dynamic(() => import('@/components/dashboard/PeerComparison').then(m => m.PeerComparison), { ssr: false, loading: () => <LoadingChart /> });

export const PeerTab = memo(function PeerTab() {
  return (
    <ErrorBoundary label="Peer Comparison">
      <PeerComparison />
    </ErrorBoundary>
  );
});
