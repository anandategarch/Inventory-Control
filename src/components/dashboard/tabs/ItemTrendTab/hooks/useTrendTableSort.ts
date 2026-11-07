'use client';

// ============================================================
//  useTrendTableSort — table sort state
//  --------------------------------------------------------
//  SPLIT-B (pure move from ItemTrendTab/index.tsx — no behavior
//  change). Owns the ItemTrendTable sort state (default period
//  asc — chronological, matches chart) + the toggle callback.
// ============================================================

import { useCallback, useState } from 'react';
import type { SortKey, SortDir } from '../types';

export function useTrendTableSort() {
  // Sort state for the table — default period asc (chronological, matches chart).
  const [sortKey, setSortKey] = useState<SortKey>('period');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const toggleSort = useCallback((key: SortKey) => {
    // FIX (BUG-HUNT-3-c-4): the previous implementation called setSortDir
    // INSIDE the setSortKey updater — an impure updater (side effect inside
    // a state updater). React double-invokes updaters in StrictMode (dev),
    // so the setSortDir toggle was enqueued TWICE and the two toggles
    // cancelled out → sort direction did NOT change when clicking the
    // already-active column in dev. Read sortKey from the closure instead
    // and dispatch the two updates as separate pure calls.
    if (sortKey === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }, [sortKey]);

  return { sortKey, sortDir, toggleSort };
}
