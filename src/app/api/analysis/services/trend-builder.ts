// ============================================================
//  Trend Builder — builds trend, multiPeriodComparison, netCostTrend
//  from queryTrendAgg rows. Extracted from analysis/route.ts (Phase 3).
// ============================================================
import { computeNominalDeviationGrowth } from '@/lib/metrics';
import type { TrendAggRow } from '@/lib/queries/dashboard';

export interface TrendPoint {
  weekLabel: string;
  devBom: number;
  sales: number;
  nominal: number;
}

export interface MultiPeriodPoint {
  period: string;
  sales: number;
  bom: number | null;
  deviation: number;
  absDeviation: number;
  devBomRatio: number;
  growthPct: number | null;
}

export interface NetCostTrendPoint {
  weekLabel: string;
  netCostRatio: number;
  lossNominal: number;
  surplusNominal: number;
  sales: number;
}

function sortKeyForRow(r: TrendAggRow, monthKeyByLabel: Map<string, string>): string {
  const mk = monthKeyByLabel.get(r.monthLabel) || '0000-00';
  return `${mk}|${String(parseInt(r.weekLabel.replace(/\D/g, '')) || 0).padStart(2, '0')}`;
}

export function buildTrend(
  trendAggRows: TrendAggRow[],
  monthKeyByLabel: Map<string, string>,
): TrendPoint[] {
  return trendAggRows
    .map((r) => ({
      weekLabel: `${r.weekLabel} ${r.monthLabel.split(' ')[0].slice(0, 3)}`,
      sortKey: sortKeyForRow(r, monthKeyByLabel),
      devBom: r.devBom,
      sales: r.sales,
      nominal: r.nominal,
    }))
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .map(({ sortKey: _sk, ...rest }) => rest);
}

export function buildMultiPeriodComparison(
  trendAggRows: TrendAggRow[],
  monthKeyByLabel: Map<string, string>,
): MultiPeriodPoint[] {
  return trendAggRows
    .map((r) => ({
      period: `${r.weekLabel} ${r.monthLabel.split(' ')[0].slice(0, 3)}`,
      sortKey: sortKeyForRow(r, monthKeyByLabel),
      sales: r.sales,
      bom: r.qtyBom ?? null,
      deviation: r.nominal,
      absDeviation: Math.abs(r.nominal),
      devBomRatio: r.devBom,
      growthPct: null as number | null,
    }))
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .map((row, i, arr) => {
      if (i > 0) {
        row.growthPct = computeNominalDeviationGrowth(row.deviation, arr[i - 1].deviation);
      }
      const { sortKey: _sk, ...rest } = row;
      return rest;
    });
}

export function buildNetCostTrend(
  trendAggRows: TrendAggRow[],
  monthKeyByLabel: Map<string, string>,
): NetCostTrendPoint[] {
  return trendAggRows
    .map((r) => ({
      weekLabel: `${r.weekLabel} ${r.monthLabel.split(' ')[0].slice(0, 3)}`,
      sortKey: sortKeyForRow(r, monthKeyByLabel),
      netCostRatio: r.sales > 0 ? (r.lossNominal - r.surplusNominal) / r.sales : 0,
      lossNominal: r.lossNominal,
      surplusNominal: r.surplusNominal,
      sales: r.sales,
    }))
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .map(({ sortKey: _sk, ...rest }) => rest);
}
