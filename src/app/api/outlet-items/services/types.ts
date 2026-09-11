// ============================================================
//  Types & shared utilities for /api/outlet-items service modules
//  --------------------------------------------------------
//  Extracted from the original 673-line route.ts (Phase 4 refactor).
//
//  Contains:
//    - SQL row shapes (CurrentRecRow, PrevRecRow, BenchRow)
//    - Shared service-level types (OutletLookup, ResolvedPeriod,
//      FetchedRecords, ItemBreakdownRow, PrevByItemIdEntry)
//
//  H-12: the EarlyHttpResponse class moved to the shared module
//  src/lib/early-http-response.ts (was defined verbatim 3×) — import it
//  from there.
// ============================================================
import type { OutletPIC } from '@prisma/client';
import type { RuntimeThresholds } from '@/lib/settings';
import type { queryTopItemsByDeviasiRankForOutlet } from '@/lib/queries/items/top-items';

// PERF-API-01 (Task PERF-API): EarlyHttpResponse pattern (same as export-report)
// — lets the cache-wrapped computeFn signal "abort compute + return this response"
// for early-return paths (404 outlet not found). Throwing propagates through
// withCacheAndDedup's rejectComputation so concurrent in-flight awaiters also
// see the 404 (cache is NOT populated for 404s). H-12: import from the shared
// src/lib/early-http-response.ts (was defined verbatim in this file).

// Shape returned by db.outlet.findFirst({select: {id, code, name, area}})
export interface OutletLookup {
  id: number;
  code: string;
  name: string;
  area: string;
}

// SQL row shape — currentRecs (withStatementTimeout $queryRaw)
export interface CurrentRecRow {
  itemId: number; itemName: string; satuan: string | null;
  akunPenyesuaian: string | null;
  qtyBom: number | null; qtyCom: number | null; qtyDeviasi: number | null;
  qtyWaste: number | null; qtySusut: number | null; qtyTrial: number | null;
  qtyLossSurplus: number | null;
  nominalDeviasi: number | null; nominalWaste: number | null; nominalSusut: number | null;
  nominalTrial: number | null; nominalLossSurplus: number | null; nominalSales: number | null;
  avgPrice: number | null; tolerancePct: number | null;
  pctQtyDeviasiToBom: number | null;
  direction: string | null;
  residualQty: number | null; residualNominal: number | null; residualRatio: number | null;
  absQtyDeviasi: number | null; absNominalDeviation: number | null;
  absQtyLossSurplus: number | null; absNominalLossSurplus: number | null;
}

// SQL row shape — prevRecs
export interface PrevRecRow {
  itemId: number; akunPenyesuaian: string | null;
  qtyDeviasi: number | null; nominalDeviasi: number | null;
  qtyBom: number | null; pctQtyDeviasiToBom: number | null;
  nominalSales: number | null;
}

// SQL row shape — areaBench / networkBench
export interface BenchRow {
  avgDevBom: number;
  lossToSales?: number | null;
}

// Entry in the prevByItemId Map — keyed by `${itemId}|${akunPenyesuaian ?? ''}`
export interface PrevByItemIdEntry {
  qtyDeviasi: number;
  nominalDeviasi: number;
  qtyBom: number;
  pctDevBom: number | null;
}

// Result of resolveOutletAndPeriod — month label re-resolved to actual DB case
export interface ResolvedPeriod {
  month: string;
  compareMonth: string | null;
  thresholds: RuntimeThresholds;
  outlet: OutletLookup;
  prevWeek: string | null;
  prevMonth: string | null;
}

// Promise returned by queryTopItemsByDeviasiRankForOutlet — fired in parallel
// with the main Promise.all batch and awaited later (after restoProfile +
// itemBreakdown assembly completes).
export type TopDeviasiRankPromise = ReturnType<typeof queryTopItemsByDeviasiRankForOutlet>;

// Result of fetchRecords — 5 parallel SQL queries + 1 topDeviasiRank promise
export interface FetchedRecords {
  currentRecs: CurrentRecRow[];
  prevRecs: PrevRecRow[];
  areaBench: BenchRow[];
  networkBench: BenchRow[];
  outletPIC: OutletPIC | null;
  topDeviasiRankPromise: TopDeviasiRankPromise;
}

// Per-item breakdown row — produced by buildItemBreakdown, consumed by
// buildRankings + the final response payload (allItems field).
export interface ItemBreakdownRow {
  itemId: number;
  itemName: string;
  satuan: string | null;
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
  avgPrice: number | null;
  tolerancePct: number | null;
  devBom: number | null;
  direction: string;
  residualQty: number | null;
  residualRatio: number | null;
  isOverExplained: boolean;
  // Historical
  prevQtyDeviasi: number | null;
  prevPctDevBom: number | null;
  devBomGrowth: number | null;
  historicalTrend: '↑' | '↓' | '→' | '?';
  // Benchmark — renamed network → allResto for clarity (both returned for compat)
  areaAvgDevBom: number;
  networkAvgDevBom: number; // backward compat
  allRestoAvgDevBom: number; // FIX: clearer name
  areaMultiplier: number | null;
  // Priority (Metric Engine: 'P1' | 'P2' | 'P3')
  priority: 'P1' | 'P2' | 'P3';
}

// Per-item row in the 3 rankings (itemBreakdown row + sequential rank)
export interface RankedItemRow extends ItemBreakdownRow {
  rank: number;
}

// Shape of the rankings object — 3 sorted slices of itemBreakdown
export interface Rankings {
  financial: RankedItemRow[];
  operational: RankedItemRow[];
  unexplained: RankedItemRow[];
}
