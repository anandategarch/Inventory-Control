'use client';

import { useQuery, keepPreviousData } from '@tanstack/react-query';

export interface AnalysisData {
  success: boolean;
  period: { monthLabel: string; weekLabel: string; comparisonWeek: string | null; comparisonMonth: string | null };
  filters: { area: string | null; outletCode: string | null; itemName: string | null };
  executiveSummary: any;
  healthStatus: {
    normal: number;
    warning: number;
    abnormal: number;
    breakdown?: {
      byCategory: Record<string, number>;
      byRule: Record<string, number>;
    };
  };
  dqStatus: { ok: number; warnings: number; errors: number; issues: any[] };
  growthComparison: any;
  topItemsByNominal: any[];
  topItemsByDevBom: any[];
  topOutlets: any[];
  deviationBreakdown: { waste: number; susut: number; trial: number; residual: number; total: number };
  lossVsSurplus: { loss: number; surplus: number; lossNominal: number; surplusNominal: number };
  investigationWorklist: any[];
  narrative: string;
  narrativeSource: string;
  recommendation: Array<{ why: string; what: string[]; priority: string }>;
  trend: Array<{ weekLabel: string; devBom: number; sales: number; nominal: number }>;
  priorities: any[];
  durationMs: number;
  cached?: boolean;
  message?: string;
}

async function fetchAnalysis(params: URLSearchParams): Promise<AnalysisData> {
  const res = await fetch(`/api/analysis?${params.toString()}`);
  if (!res.ok) {
    const e = await res.json().catch(() => ({ message: 'Request failed' }));
    throw new Error(e.message || `HTTP ${res.status}`);
  }
  return res.json();
}

export function useAnalysis(params: {
  month: string | null;
  week: string | null;
  compareWeek: string | null;
  compareMonth?: string | null;
  area: string | null;
  outlet: string | null;
  item: string | null;
}) {
  const p = new URLSearchParams();
  if (params.month) p.set('month', params.month);
  if (params.week) p.set('week', params.week);
  // Encode cross-month compare as "WEEK|||Month" so server can resolve month
  if (params.compareWeek) {
    if (params.compareMonth && params.compareMonth !== params.month) {
      p.set('compareWeek', `${params.compareWeek}|||${params.compareMonth}`);
    } else {
      p.set('compareWeek', params.compareWeek);
    }
  }
  if (params.area) p.set('area', params.area);
  if (params.outlet) p.set('outlet', params.outlet);
  if (params.item) p.set('item', params.item);

  return useQuery({
    queryKey: ['analysis', params],
    queryFn: () => fetchAnalysis(p),
    enabled: Boolean(params.month && params.week),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

export interface StatusData {
  success: boolean;
  files: any[];
  months: Array<{ label: string; key: string }>;
  weeksByMonth: Record<string, string[]>;
  outlets: Array<{ code: string; name: string; area: string }>;
  areas: string[];
  stats: { totalFiles: number; totalOutlets: number; totalItems: number; totalRecords: number };
}

export function useStatus() {
  return useQuery({
    queryKey: ['status'],
    queryFn: async () => {
      const res = await fetch('/api/status');
      return res.json() as Promise<StatusData>;
    },
    staleTime: 30_000,
  });
}

export interface DrilldownData {
  success: boolean;
  count: number;
  records: any[];
}

export function useDrilldown(params: { outletCode?: string | null; itemName?: string | null; weekLabel?: string | null; monthLabel?: string | null }) {
  const p = new URLSearchParams();
  if (params.outletCode) p.set('outletCode', params.outletCode);
  if (params.itemName) p.set('itemName', params.itemName);
  if (params.weekLabel) p.set('weekLabel', params.weekLabel);
  if (params.monthLabel) p.set('monthLabel', params.monthLabel);

  return useQuery({
    queryKey: ['drilldown', params],
    queryFn: async () => {
      const res = await fetch(`/api/drilldown?${p.toString()}`);
      return res.json() as Promise<DrilldownData>;
    },
    enabled: Boolean(params.outletCode || params.itemName),
  });
}
