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
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
        return prev;
      }
      setSortDir('desc');
      return key;
    });
  }, []);

  return { sortKey, sortDir, toggleSort };
}
