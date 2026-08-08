'use client';

import { create } from 'zustand';
import type { FilterState } from '@/types/inventory';

interface DashboardStore extends FilterState {
  comparisonMonth: string | null;
  setMonth: (v: string | null) => void;
  setWeek: (v: string | null) => void;
  setCompareWeek: (v: string | null, m: string | null) => void;
  setArea: (v: string | null) => void;
  setOutlet: (v: string | null) => void;
  setItem: (v: string | null) => void;
  reset: () => void;
  drilldown: { outletCode: string | null; itemName: string | null };
  setDrilldown: (d: { outletCode: string | null; itemName: string | null }) => void;
  sourceModalOpen: boolean;
  setSourceModal: (b: boolean) => void;
  cardDrillDown: string | null;
  setCardDrillDown: (card: string | null) => void;
}

export const useDashboard = create<DashboardStore>((set) => ({
  monthLabel: null,
  currentWeek: null,
  comparisonWeek: null,
  comparisonMonth: null,
  area: null,
  outletCode: null,
  itemName: null,
  comparisonMode: 'previous_week',
  setMonth: (v) => set({ monthLabel: v }),
  setWeek: (v) => set({ currentWeek: v, comparisonWeek: null, comparisonMonth: null }),
  setCompareWeek: (v, m) => set({ comparisonWeek: v, comparisonMonth: m }),
  setArea: (v) => set({ area: v, outletCode: null }),
  setOutlet: (v) => set({ outletCode: v }),
  setItem: (v) => set({ itemName: v }),
  reset: () => set({ area: null, outletCode: null, itemName: null }),
  drilldown: { outletCode: null, itemName: null },
  setDrilldown: (d) => set({ drilldown: d }),
  sourceModalOpen: false,
  setSourceModal: (b) => set({ sourceModalOpen: b }),
  cardDrillDown: null,
  setCardDrillDown: (card) => set({ cardDrillDown: card }),
}));
