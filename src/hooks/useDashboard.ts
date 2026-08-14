'use client';

import { create } from 'zustand';

interface DashboardStore {
  monthLabel: string | null;
  currentWeek: string | null;
  comparisonWeek: string | null;
  comparisonMonth: string | null;
  area: string | null;
  outletCode: string | null;
  itemName: string | null;
  pic: string | null;
  comparisonMode: 'previous_week' | 'historical_average';
  setMonth: (v: string | null) => void;
  setWeek: (v: string | null) => void;
  setCompareWeek: (v: string | null, m: string | null) => void;
  setArea: (v: string | null) => void;
  setOutlet: (v: string | null) => void;
  setItem: (v: string | null) => void;
  setPic: (v: string | null) => void;
  reset: () => void;
  drilldown: { outletCode: string | null; itemName: string | null };
  setDrilldown: (d: { outletCode: string | null; itemName: string | null }) => void;
  sourceModalOpen: boolean;
  setSourceModal: (b: boolean) => void;
  cardDrillDown: string | null;
  setCardDrillDown: (card: string | null) => void;
  deepDiveItem: { itemName: string | null; outletCode: string | null };
  setDeepDiveItem: (d: { itemName: string | null; outletCode: string | null }) => void;
  scorecardOutlet: string | null;
  setScorecardOutlet: (code: string | null) => void;
  focusOutlet: string | null;
  setFocusOutlet: (code: string | null) => void;
  activeTab: string;
  setActiveTab: (tab: string) => void;
}

export const useDashboard = create<DashboardStore>((set) => ({
  monthLabel: null,
  currentWeek: null,
  comparisonWeek: null,
  comparisonMonth: null,
  area: null,
  outletCode: null,
  itemName: null,
  pic: null,
  comparisonMode: 'previous_week',
  setMonth: (v) => set({ monthLabel: v, currentWeek: null, comparisonWeek: null, comparisonMonth: null }),
  setWeek: (v) => set({ currentWeek: v, comparisonWeek: null, comparisonMonth: null }), // reset compare saat ganti week, auto-set akan jalan via useEffect
  setCompareWeek: (v, m) => set({ comparisonWeek: v, comparisonMonth: m }),
  setArea: (v) => set({ area: v, outletCode: null, focusOutlet: null, scorecardOutlet: null }),
  setOutlet: (v) => set({ outletCode: v }),
  setItem: (v) => set({ itemName: v }),
  setPic: (v) => set({ pic: v, outletCode: null, focusOutlet: null, scorecardOutlet: null }),
  reset: () => set({ area: null, outletCode: null, itemName: null, pic: null }),
  drilldown: { outletCode: null, itemName: null },
  setDrilldown: (d) => set({ drilldown: d }),
  sourceModalOpen: false,
  setSourceModal: (b) => set({ sourceModalOpen: b }),
  cardDrillDown: null,
  setCardDrillDown: (card) => set({ cardDrillDown: card }),
  deepDiveItem: { itemName: null, outletCode: null },
  setDeepDiveItem: (d) => set({ deepDiveItem: d }),
  scorecardOutlet: null,
  setScorecardOutlet: (code) => set({ scorecardOutlet: code }),
  focusOutlet: null,
  setFocusOutlet: (code) => set((state) => code
    ? { focusOutlet: code, activeTab: 'focus' }
    : { focusOutlet: null }
  ),
  activeTab: 'dashboard',
  setActiveTab: (tab) => set({ activeTab: tab }),
}));
