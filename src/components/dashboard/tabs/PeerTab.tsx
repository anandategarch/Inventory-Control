'use client';

// ============================================================
//  PeerTab — "Peer Comparison" tab content. Extracted from
//  page.tsx lines 659-668.
//  --------------------------------------------------------
//  PeerComparison is lazy-loaded (recharts heavy) — the
//  LoadingChart fallback reserves layout space.
// ============================================================

import dynamic from 'next/dynamic';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import { FetchAware, LoadingChart } from '@/components/dashboard/shared';

const PeerComparison = dynamic(() => import('@/components/dashboard/PeerComparison').then(m => m.PeerComparison), { ssr: false, loading: () => <LoadingChart /> });

export interface PeerTabProps {
  isFetching: boolean;
}

export function PeerTab({ isFetching }: PeerTabProps) {
  return (
    <>
      {/* FIX #32: FetchAware wraps PeerComparison — it has its own
          internal isFetching indicator too, but this keeps the
          dashboard-wide refetch indicator visible. */}
      <FetchAware isFetching={isFetching}>
        <ErrorBoundary label="Peer Comparison">
          <PeerComparison />
        </ErrorBoundary>
      </FetchAware>
    </>
  );
}
