'use client';

// ============================================================
//  useDrillPeriodSync — Phase 2 drill-period state
//  --------------------------------------------------------
//  SPLIT-B (pure move from ItemTrendTab/index.tsx — no behavior
//  change). Tracks which period the user clicked (via row click
//  or chart dot click) for the ItemPeerComparison drill-down.
//  Defaults to the current dashboard month/week when both are
//  set; auto-syncs when the user changes the dashboard period.
//
//  Implementation: "adjust state during render" pattern (per React docs:
//  https://react.dev/reference/react/useState#storing-information-from-previous-renders).
//  This avoids the `react-hooks/set-state-in-effect` lint error + avoids
//  the extra render cycle that `useEffect + setState` would cause. The
//  `prevPeriodKey` state stores the previous month+week combo so we can
//  detect changes; when it differs from the current combo, we update both
//  `prevPeriodKey` (so the next render doesn't loop) and `drillPeriod`
//  (the actual drill target).
// ============================================================

import { useState } from 'react';

export interface DrillPeriod {
  month: string;
  week: string;
}

export function useDrillPeriodSync(
  monthLabel: string | null,
  currentWeek: string | null,
): { drillPeriod: DrillPeriod | null; setDrillPeriod: (p: DrillPeriod | null) => void } {
  const [drillPeriod, setDrillPeriod] = useState<DrillPeriod | null>(null);
  const [prevPeriodKey, setPrevPeriodKey] = useState<string | null>(null);
  const currentPeriodKey = monthLabel && currentWeek ? `${monthLabel}|${currentWeek}` : null;
  if (currentPeriodKey !== prevPeriodKey) {
    setPrevPeriodKey(currentPeriodKey);
    setDrillPeriod(monthLabel && currentWeek ? { month: monthLabel, week: currentWeek } : null);
  }
  return { drillPeriod, setDrillPeriod };
}
