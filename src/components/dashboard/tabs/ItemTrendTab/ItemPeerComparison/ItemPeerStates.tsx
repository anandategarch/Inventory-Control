'use client';

// ============================================================
//  ItemPeerStates — non-data states for the drill-down panel
//  --------------------------------------------------------
//  SPLIT-B (pure move from ItemPeerComparison.tsx — no behavior
//  change): loading / error / no-data cards rendered before the
//  4 analysis cards + peer table.
// ============================================================

import { AlertCircle, Info, Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

export function ItemPeerLoadingState() {
  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardContent className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
        <span className="ml-2 text-xs text-muted-foreground">Memuat peer comparison...</span>
      </CardContent>
    </Card>
  );
}

interface ItemPeerErrorStateProps {
  message: string;
  onRetry: () => void;
}

export function ItemPeerErrorState({ message, onRetry }: ItemPeerErrorStateProps) {
  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardContent className="flex flex-col items-center justify-center py-12 text-center">
        <AlertCircle className="h-6 w-6 text-red-500 mb-2" />
        <p className="text-sm text-red-600 dark:text-red-400">Gagal memuat peer comparison</p>
        <p className="text-xs text-muted-foreground mt-1">{message}</p>
        {/* FIX (BUG-HUNT C20/B2-13): retry affordance — parity with the peer
            table / ParetoDashboard error states. */}
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md bg-red-600 px-3 text-xs font-medium text-white shadow-sm transition-colors hover:bg-red-700"
        >
          Coba Lagi
        </button>
      </CardContent>
    </Card>
  );
}

interface ItemPeerNoDataStateProps {
  itemName: string;
  month: string;
  week: string;
  /** True when the response had no target at all (item not found in the
   *  period) — drives the extra "Kemungkinan:" hint line. */
  noTarget: boolean;
}

export function ItemPeerNoDataState({ itemName, month, week, noTarget }: ItemPeerNoDataStateProps) {
  // FIX (BUG-2-07): also check for 0 peers (target exists but no other
  // outlets in BOM ±50% range). Without this, cards render degenerate
  // values (EfficiencyScore=100, GapAnalysis vs 0, empty ScatterPlot,
  // #1/1 ranking).
  // FIX (BUG-2-10): improved empty state message — covers all "no data"
  // cases (item not found, no peers, kelompok/PIC mismatch), not just
  // the "no peer (BOM ±50%)" case.
  const reason = noTarget
    ? `Item "${itemName}" tidak ditemukan di periode ${month} · ${week}.`
    : `Tidak ada peer outlet dengan QTY BOM ±50% di periode ${month} · ${week}.`;
  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardContent className="flex flex-col items-center justify-center py-12 text-center">
        <Info className="h-6 w-6 text-muted-foreground mb-2" />
        <p className="text-sm text-muted-foreground">Tidak ada data peer comparison</p>
        <p className="text-xs text-muted-foreground/70 mt-1">{reason}</p>
        {noTarget && (
          <p className="text-[11px] text-muted-foreground/60 mt-1">
            Kemungkinan: item tidak memiliki deviasi di periode ini, atau filter area/kelompok/PIC tidak cocok.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
