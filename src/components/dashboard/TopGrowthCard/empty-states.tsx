'use client';

// ============================================================
//  TopGrowthCard — empty states
//  (split from TopGrowthCard.tsx — SPLIT-G; pure code motion)
//
//  Two branches:
//    - GrowthEmptyState: shared icon + copy block (pattern from
//      GrowthComparison — no compare period / no movers).
//    - StalePayloadEmptyState: actionable recovery for payloads
//      cached before `topGrowth` existed (TASK H-3).
// ============================================================

import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { RefreshCw, TrendingUp } from 'lucide-react';

/** Shared empty-state block (icon + copy) — pattern from GrowthComparison. */
export function GrowthEmptyState({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center">
      <TrendingUp className="h-8 w-8 text-muted-foreground/40 mb-2" />
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

// ------------------------------------------------------------
//  FIX (TASK H-3): old-cache empty state is now ACTIONABLE. The passive
//  "tunggu recompute background" copy was useless — pre-H-3, a pre-deploy
//  cache row was served as a FRESH hit (no recompute ever triggered), and
//  refreshing only re-hit the same server row. With the H-3 server fix
//  (payload-schema versioning in the cache key) this branch is effectively
//  unreachable, but the button guarantees recovery even if it somehow
//  appears: it triggers the full refresh flow (server cache clear +
//  client refetch) instead of asking the user to wait.
// ------------------------------------------------------------
export function StalePayloadEmptyState({ onRefresh }: { onRefresh?: () => void }) {
  const [requested, setRequested] = useState(false);

  const handleClick = useCallback(() => {
    if (requested) return;
    setRequested(true);
    onRefresh?.();
    // Re-arm after 2 minutes in case the recompute failed. The success path
    // never lands here: the refreshed payload contains topGrowth, so this
    // whole branch unmounts. (setState-after-unmount is a no-op in React 18+.)
    window.setTimeout(() => setRequested(false), 120_000);
  }, [onRefresh, requested]);

  return (
    <div className="flex flex-col items-center justify-center py-8 text-center gap-3">
      <TrendingUp className="h-8 w-8 text-muted-foreground/40 mb-2" />
      <p className="text-sm text-muted-foreground">
        Data Top Growth belum ada di payload lama (cache sebelum pembaruan).
        {onRefresh ? ' Hitung ulang data analisis untuk memuatnya.' : ' Muat ulang halaman setelah beberapa saat.'}
      </p>
      {onRefresh ? (
        <Button
          variant="outline"
          size="sm"
          onClick={handleClick}
          disabled={requested}
          className="h-8 gap-1.5 text-xs"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${requested ? 'animate-spin' : ''}`} />
          {requested ? 'Menghitung ulang…' : 'Hitung Ulang Data Analisis'}
        </Button>
      ) : null}
    </div>
  );
}
