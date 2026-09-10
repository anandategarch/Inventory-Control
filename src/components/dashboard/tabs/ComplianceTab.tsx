'use client';

// ============================================================
//  ComplianceTab — "Kepatuhan" tab content. Same wrapper
//  pattern as PeerTab: memo + lazy Compliance component
//  (single fetch — no recharts here, so the LoadingChart
//  fallback is mostly for chunk download).
// ============================================================

import { memo } from 'react';
import dynamic from 'next/dynamic';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import { LoadingChart } from '@/components/dashboard/shared';

const Compliance = dynamic(() => import('@/components/dashboard/Compliance').then(m => m.Compliance), { ssr: false, loading: () => <LoadingChart /> });

export const ComplianceTab = memo(function ComplianceTab() {
  return (
    <ErrorBoundary label="Kepatuhan">
      <Compliance />
    </ErrorBoundary>
  );
});
