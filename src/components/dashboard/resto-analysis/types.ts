// ============================================================
//  RestoAnalysis — shared types
//  (split from RestoAnalysis.tsx — Phase 3)
// ============================================================

import type { OutletItem } from '@/components/dashboard/PrioritySummaryCard';
import type { Recommendation } from '@/components/dashboard/PrioritySummaryCard';
import type { DeviasiRankItem } from '@/hooks/useAnalysis';

/** Server-side resto profile (perf + behavior + historical + benchmark + top risk + investigation). */
export interface RestoProfile {
  performance: {
    sales: number; qtyBom: number; qtyDeviasi: number; nominalDeviasi: number;
    nominalLossSurplus: number; devBom: number | null; lossToSales: number | null;
    qtyBomGrowth: number | null; qtyDeviasiGrowth: number | null; nominalDeviasiGrowth: number | null;
  };
  behavior: {
    lossNominal: number; surplusNominal: number; lossPct: number | null; surplusPct: number | null;
    qtyWaste: number; qtySusut: number; qtyTrial: number; qtyLossSurplus: number;
    residualQty: number; residualPct: number | null; explainedPct: number | null;
  };
  historical: {
    bomGrowth: number | null; deviasiGrowth: number | null; nominalGrowth: number | null;
    trend: string;
  };
  benchmark: {
    areaAvgDevBom: number; allRestoAvgDevBom: number; outletDevBom: number; areaMultiplier: number | null;
  };
  topRisk: {
    byNominal: Array<{ itemName: string; value: number; direction: string }>;
    byDevBom: Array<{ itemName: string; value: number }>;
    byResidual: Array<{ itemName: string; value: number }>;
  };
  investigation: {
    normal: number; warning: number; abnormal: number; total: number; healthScore: number;
  };
}

/** Row in the Bahan Analysis ranking tables (financial / operational / unexplained). */
export interface ItemRow {
  rank: number; itemName: string; satuan: string | null;
  qtyBom: number; qtyDeviasi: number | null;
  devBom: number | null; nominalLossSurplus: number | null; absNominalLossSurplus: number;
  direction: string; residualRatio: number | null;
  qtyWaste: number; qtySusut: number; qtyTrial: number;
  historicalTrend: '↑' | '↓' | '→' | '?';
  areaMultiplier: number | null;
  priority: 'P1' | 'P2' | 'P3';
  [key: string]: unknown;
}

/** /api/outlet-items response payload. */
export interface OutletItemsResponse {
  success: boolean;
  outlet: { code: string; name: string; area: string; pic: string | null };
  period: { month: string; week: string; prevWeek: string | null; prevMonth: string | null };
  restoProfile: RestoProfile;
  rankings: { financial: ItemRow[]; operational: ItemRow[]; unexplained: ItemRow[] };
  allItems: OutletItem[];
  /** Top 30 deviasi items for THIS outlet (with national rank + peer benchmark).
   *  Powers RankingNasionalCard when a resto is selected for analysis. */
  topDeviasiRank?: DeviasiRankItem[];
  itemCount?: number;
  durationMs?: number;
  error?: string;
}

/** /api/item-history response payload (timeline rows). */
export interface ItemHistoryTimelineRow {
  monthLabel: string;
  weekLabel: string;
  qtyBom: number;
  qtyCom: number | null;
  qtyDeviasi: number | null;
  qtyWaste: number;
  qtySusut: number;
  qtyTrial: number;
  qtyLossSurplus: number | null;
  nominalDeviasi: number | null;
  nominalLossSurplus: number | null;
  absNominalLossSurplus: number;
  devBom: number | null;
  direction: string;
  residualQty: number | null;
  residualRatio: number | null;
  tolerancePct: number | null;
  isCurrent: boolean;
}

export interface ItemHistoryResponse {
  success: boolean;
  outlet?: { code: string; name: string; area: string };
  itemName?: string;
  timeline?: ItemHistoryTimelineRow[];
  benchmark?: {
    outletDevBom: number | null;
    areaAvgDevBom: number | null;
    allRestoAvgDevBom: number | null;
    bestDevBom: number | null;
    areaMultiplier: number | null;
    allRestoMultiplier: number | null;
    areaOutletCount: number;
    allRestoOutletCount: number;
  };
  historical?: {
    mean: number | null;
    stdDev: number | null;
    zScore: number | null;
    sampleSize: number;
    earliestDevBom: number | null;
    currentDevBom: number | null;
    deterioration: number | null;
    trend: string;
    warningLevel: string | null;
    benchmarkFlag: string | null;
  };
  current?: ItemHistoryTimelineRow;
  priority?: string;
  error?: string;
}

/** /api/recommendations response payload. */
export interface RecommendationResponse {
  success: boolean;
  recommendations: Recommendation[];
  error?: string;
}

// Re-export shared types from PrioritySummaryCard so callers can import from
// a single convenient location if desired.
export type { OutletItem, Recommendation };
