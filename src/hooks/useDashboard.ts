'use client';

import { create } from 'zustand';

interface DashboardStore {
  monthLabel: string | null;
  currentWeek: string | null;
  comparisonWeek: string | null;
  comparisonMonth: string | null;
  area: string | null;
  kelompok: string | null;
  outletCode: string | null;
  itemName: string | null;
  pic: string | null;
  comparisonMode: 'previous_week' | 'historical_average';
  setMonth: (v: string | null) => void;
  setWeek: (v: string | null) => void;
  setCompareWeek: (v: string | null, m: string | null) => void;
  // FIX (PERF-1 / AUDIT-FE): atomic period setter — sets monthLabel, currentWeek,
  // comparisonWeek AND comparisonMonth in ONE store update. The old flow called
  // setMonth/setWeek (which reset comparisonWeek → useAnalysis fetched with
  // compareWeek: null) and THEN setCompareWeek → queryKey changed → the heavy
  // /api/analysis payload was fetched TWICE on every period change. Callers that
  // can compute the full (month, week, compare) triple up front (useDashboardEffects
  // combined auto-select, FilterBar month/week handlers) must use this instead of
  // the field-resetting setters. setMonth/setWeek/setCompareWeek stay untouched for
  // single-field callers.
  setPeriod: (month: string | null, week: string | null, compareWeek: string | null, compareMonth: string | null) => void;
  setArea: (v: string | null) => void;
  setKelompok: (v: string | null) => void;
  setOutlet: (v: string | null) => void;
  setItem: (v: string | null) => void;
  setPic: (v: string | null) => void;
  reset: () => void;
  drilldown: { outletCode: string | null; itemName: string | null };
  setDrilldown: (d: { outletCode: string | null; itemName: string | null }) => void;
  sourceModalOpen: boolean;
  setSourceModal: (b: boolean) => void;
  deepDiveItem: { itemName: string | null; outletCode: string | null };
  setDeepDiveItem: (d: { itemName: string | null; outletCode: string | null }) => void;
  scorecardOutlet: string | null;
  setScorecardOutlet: (code: string | null) => void;
  focusOutlet: string | null;
  setFocusOutlet: (code: string | null) => void;
  activeTab: string;
  // PERF (H-8 QUICK WIN 3 — visited-tab gating): tabs the user has ACTIVELY
  // opened at least once. The dashboard page renders a tab's content (and
  // therefore fires its queries — /api/pareto, /api/flip-ranking, …) only
  // after its first visit, while keep-alive (forceMount) preserves state
  // afterwards. This kills the eager initial-load fetches that hidden
  // force-mounted tabs used to fire for tabs the user never opens.
  // Tracked INSIDE setActiveTab / setFocusOutlet so every navigation path
  // (Tabs onValueChange, keyboard shortcuts 1-5, RankingNasionalCard
  // cross-tab link, focus-outlet flows) is covered.
  visitedTabs: string[];
  setActiveTab: (tab: string) => void;
  // Phase 1 — Navigation Bridge: external components (e.g. RankingNasionalCard)
  // can pre-select an item in the Trend Item Tab by setting this. The Trend
  // Item Tab reads it as its `selectedItem` (replaces local useState) so the
  // selection survives tab switches + persists across page renders.
  trendSelectedItem: string | null;
  setTrendSelectedItem: (item: string | null) => void;
}

export const useDashboard = create<DashboardStore>((set) => ({
  monthLabel: null,
  currentWeek: null,
  comparisonWeek: null,
  comparisonMonth: null,
  area: null,
  kelompok: null,
  outletCode: null,
  itemName: null,
  pic: null,
  comparisonMode: 'previous_week',
  setMonth: (v) => set({ monthLabel: v, currentWeek: null, comparisonWeek: null, comparisonMonth: null }),
  setWeek: (v) => set({ currentWeek: v, comparisonWeek: null, comparisonMonth: null }),
  setCompareWeek: (v, m) => set({ comparisonWeek: v, comparisonMonth: m }),
  setPeriod: (month, week, compareWeek, compareMonth) => set({ monthLabel: month, currentWeek: week, comparisonWeek: compareWeek, comparisonMonth: compareMonth }),
  setArea: (v) => set({ area: v, outletCode: null, focusOutlet: null, scorecardOutlet: null }),
  setKelompok: (v) => set({ kelompok: v, outletCode: null, focusOutlet: null, scorecardOutlet: null }),
  setOutlet: (v) => set({ outletCode: v, focusOutlet: null }),
  setItem: (v) => set({ itemName: v }),
  setPic: (v) => set({ pic: v, outletCode: null, focusOutlet: null, scorecardOutlet: null }),
  reset: () => set({ area: null, kelompok: null, outletCode: null, itemName: null, pic: null, focusOutlet: null, scorecardOutlet: null }),
  drilldown: { outletCode: null, itemName: null },
  setDrilldown: (d) => set({ drilldown: d }),
  sourceModalOpen: false,
  setSourceModal: (b) => set({ sourceModalOpen: b }),
  deepDiveItem: { itemName: null, outletCode: null },
  setDeepDiveItem: (d) => set({ deepDiveItem: d }),
  scorecardOutlet: null,
  setScorecardOutlet: (code) => set({ scorecardOutlet: code }),
  focusOutlet: null,
  setFocusOutlet: (code) => set((state) => code
    ? {
        focusOutlet: code,
        activeTab: 'resto',
        // H-8 QW3: focus-outlet switches to the resto tab — mark it visited.
        visitedTabs: state.visitedTabs.includes('resto') ? state.visitedTabs : [...state.visitedTabs, 'resto'],
      }
    : { focusOutlet: null }
  ),
  activeTab: 'dashboard',
  // H-8 QW3: 'dashboard' is the default tab — its content renders eagerly.
  visitedTabs: ['dashboard'],
  setActiveTab: (tab) => set((state) => ({
    activeTab: tab,
    // H-8 QW3: first visit mounts the tab's subtree (queries fire);
    // subsequent visits are no-ops (keep-alive already has it mounted).
    visitedTabs: state.visitedTabs.includes(tab) ? state.visitedTabs : [...state.visitedTabs, tab],
  })),
  trendSelectedItem: null,
  setTrendSelectedItem: (item) => set({ trendSelectedItem: item }),
}));
