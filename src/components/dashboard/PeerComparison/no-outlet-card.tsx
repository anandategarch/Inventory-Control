'use client';

// ============================================================
//  PeerComparison — "no outlet selected" early-return card
//  (split from PeerComparison.tsx — SPLIT-G; pure code motion)
//
//  Pick-an-outlet state. FIX (BUG-2-a #10): "Peluang Perbaikan
//  (Rp)" is NETWORK-WIDE (area median, no target/peer
//  dependency) — rendered here too so the tab shows the
//  benchmark card + the pick-an-outlet state.
// ============================================================

import { Card, CardContent } from '@/components/ui/card';
import { Users } from 'lucide-react';
import { BenchmarkOpportunityCard } from '@/components/dashboard/peer-comparison/benchmark-opportunity-card';
import type { BenchmarkOpportunityResponse } from '@/components/dashboard/peer-comparison/benchmark-opportunity-card';

export interface NoOutletCardProps {
  opportunityData: BenchmarkOpportunityResponse | undefined;
  opportunityLoading: boolean;
  opportunityError: Error | null;
  onRetryOpportunity: () => void;
}

export function NoOutletCard({
  opportunityData,
  opportunityLoading,
  opportunityError,
  onRetryOpportunity,
}: NoOutletCardProps) {
  return (
    <div className="space-y-4">
      <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
        <CardContent className="py-16 text-center">
          <div className="flex flex-col items-center">
            <div className="relative mb-4">
              <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-amber-200/30 to-emerald-200/30 dark:from-amber-900/20 dark:to-emerald-900/20 blur-xl" aria-hidden />
              <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl border bg-muted/40 text-muted-foreground/50">
                <Users className="h-7 w-7" />
              </div>
            </div>
            <p className="text-sm font-medium text-muted-foreground">Pilih outlet untuk melihat Peer Comparison</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Sistem akan mencari resto dengan sales ±10% sebagai peer group</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Pilih lewat filter Outlet di bilah atas, atau klik baris outlet di tab Resto / Area.</p>
          </div>
        </CardContent>
      </Card>
      {/* FIX (BUG-2-a #10): "Peluang Perbaikan (Rp)" is NETWORK-WIDE (area
          median, no target/peer dependency) — the code's own comment below
          says it "stays useful even when the target has no peers", yet it
          was unreachable until an outlet was selected. Render it here too
          so the tab shows the benchmark card + the pick-an-outlet state. */}
      <BenchmarkOpportunityCard
        data={opportunityData}
        isLoading={opportunityLoading}
        error={opportunityError}
        onRetry={onRetryOpportunity}
      />
    </div>
  );
}
