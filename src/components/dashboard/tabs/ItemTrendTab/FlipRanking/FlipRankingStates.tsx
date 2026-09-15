'use client';

// ============================================================
//  FlipRankingStates — non-data states for the flip ranking
//  --------------------------------------------------------
//  SPLIT-B (pure move from FlipRanking.tsx — no behavior change):
//  loading (purple spinner) / error (message + Coba Lagi) /
//  empty (Shuffle EmptyState — "Butuh minimal 2 periode
//  same-week untuk analisis flip.").
// ============================================================

import { Loader2, Shuffle } from 'lucide-react';
// SHADCN-PATTERNS (Pattern 4) — reusable structured EmptyState. Replaces
// the inline `<Shuffle ... /> Tidak ada data flip ...` block.
import { EmptyState } from '@/components/ui/empty-state';

export function FlipRankingLoadingState() {
  return (
    <div className="flex items-center justify-center py-12">
      <Loader2 className="h-5 w-5 animate-spin text-purple-500" />
      <span className="ml-2 text-xs text-muted-foreground">Memuat flip ranking...</span>
    </div>
  );
}

interface FlipRankingErrorStateProps {
  message: string;
  onRetry: () => void;
}

export function FlipRankingErrorState({ message, onRetry }: FlipRankingErrorStateProps) {
  return (
    <div className="text-center text-red-600 dark:text-red-400 text-sm py-8 px-6">
      <p>Gagal memuat flip ranking: {message}</p>
      {/* FIX (BUG-HUNT C20/B2-13): recovery affordance — parity with the
          ParetoDashboard / peer-table error states that offer "Coba Lagi". */}
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md bg-red-600 px-3 text-xs font-medium text-white shadow-sm transition-colors hover:bg-red-700"
      >
        Coba Lagi
      </button>
    </div>
  );
}

export function FlipRankingEmptyState() {
  return (
    // SHADCN-PATTERNS (Pattern 4) — replaced inline `<Shuffle ... />`
    // block with <EmptyState>. Same copy + Shuffle icon as before.
    <EmptyState
      icon={Shuffle}
      title="Tidak ada data flip"
      description="Butuh minimal 2 periode same-week untuk analisis flip."
    />
  );
}
