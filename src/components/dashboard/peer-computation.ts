// ============================================================
//  peer-computation — pure card-value computation helpers for the
//  Peer Tab. Moved verbatim from PeerComparison.tsx (REFACTOR-1-c
//  pure split — zero behavior change). Each caller (Peer Tab +
//  Item Trend Tab) computes its own values from its own row type,
//  then passes them to the shared presentational cards (see
//  shared/peer-comparison-cards).
// ============================================================

import { fmtIDR, fmtNum, fmtPctAbs } from '@/lib/format';
import type { PeerRow, PeerAverages } from './peer-comparison/types';
import type { GapRow, RankItem, ScatterPoint, AnomalyFlag } from '@/components/dashboard/shared/peer-comparison-cards';

/** Peer Tab efficiency score — composite 0-100 based on target vs peer avg.
 *  Penalty: devBom (50pts) + totalLoss (25pts) + residualQty (15pts) + sales (10pts). */
export function computePeerEfficiencyScore(target: PeerRow, peerAvg: PeerAverages): number {
  const safeDiv = (a: number, b: number) => (b > 0 ? a / b : 0);
  const avg = (k: string) => peerAvg[k] as number;
  const devBomPenalty = Math.min(50, safeDiv(target.devBom - avg('devBom'), avg('devBom')) * 25);
  const lossPenalty = Math.min(25, safeDiv(target.totalLoss - avg('totalLoss'), avg('totalLoss')) * 12.5);
  const residualPenalty = Math.min(15, safeDiv(target.residualQty - avg('residualQty'), avg('residualQty')) * 7.5);
  const salesPenalty = Math.min(10, Math.max(0, safeDiv(avg('sales') - target.sales, avg('sales')) * 10));
  const raw = 100 - (devBomPenalty + lossPenalty + residualPenalty + salesPenalty);
  return Math.max(0, Math.min(100, raw));
}

/** Peer Tab gap rows — Dev/BOM, Total LOSS, Residual, Sales.
 *  Best = min for bad metrics, max for Sales. */
export function computePeerGapRows(target: PeerRow, peers: PeerRow[]): GapRow[] {
  const gapMetrics: Array<{ key: keyof PeerRow; label: string; format: (v: number) => string; higherBetter: boolean }> = [
    // FIX (BUG-INT-01): use direct ref fmtPctAbs (not wrapper) so GapAnalysisCard
    // can match it via identity check (r.format === fmtPctAbsRef) for preset mapping.
    { key: 'devBom',      label: 'Dev/BOM',     format: fmtPctAbs,           higherBetter: false },
    { key: 'totalLoss',   label: 'Total LOSS',  format: fmtIDR,              higherBetter: false },
    { key: 'residualQty', label: 'Residual',    format: fmtNum,              higherBetter: false },
    { key: 'sales',       label: 'Sales',       format: fmtIDR,              higherBetter: true  },
  ];
  return gapMetrics.map(m => {
    const targetVal = target[m.key] as number;
    const values = peers.map(p => p[m.key] as number);
    const bestVal = m.higherBetter ? Math.max(...values) : Math.min(...values);
    const gap = targetVal - bestVal;
    const pctAboveBest = bestVal !== 0 ? (gap / Math.abs(bestVal)) * 100 : 0;
    return {
      label: m.label,
      targetVal,
      bestVal,
      pctAboveBest,
      format: m.format,
      higherBetter: m.higherBetter,
    };
  });
}

/** Peer Tab scatter points — X=sales, Y=devBom*100.
 *  FIX (PATTERN-2): add "vs peer avg" Dev/BOM comparison to tooltip. */
export function computePeerScatterPoints(peers: PeerRow[], targetCode: string | undefined, peerAvg: PeerAverages): ScatterPoint[] {
  return peers.map(p => ({
    x: p.sales,
    y: p.devBom * 100, // convert ratio → %
    label: p.outletName,
    isTarget: p.outletCode === targetCode,
    tooltipLines: [
      { label: 'Sales', value: fmtIDR(p.sales) },
      { label: 'Dev/BOM', value: `${(p.devBom * 100).toFixed(1).replace('.', ',')}%` },
      // FIX (PATTERN-2): add vs peer avg comparison (downIsGood for Dev/BOM).
      // FIX (BUG-INT-02): use Indonesian comma (was dot decimal).
      {
        label: 'vs peer avg',
        value: peerAvg.devBom !== 0
          ? `${p.devBom > peerAvg.devBom ? '+' : ''}${((p.devBom - peerAvg.devBom) / Math.abs(peerAvg.devBom) * 100).toFixed(1).replace('.', ',')}%`
          : '—',
      },
    ],
  }));
}

/** Peer Tab ranking items — ranks for sales, devBom, totalLoss, residualQty,
 *  nominalDeviasi, qtyWaste. Rank 1 = best, N = worst. */
export function computePeerRankItems(target: PeerRow, peers: PeerRow[]): { items: RankItem[]; total: number } {
  const total = peers.length;
  const keyMetrics: Array<{ key: keyof PeerRow; label: string; higherBetter: boolean }> = [
    { key: 'sales',          label: 'Sales',          higherBetter: true  },
    { key: 'devBom',         label: 'Dev/BOM',        higherBetter: false },
    { key: 'totalLoss',      label: 'Total LOSS',     higherBetter: false },
    { key: 'residualQty',    label: 'Residual',       higherBetter: false },
    { key: 'nominalDeviasi', label: 'Nominal Deviasi', higherBetter: false },
    { key: 'qtyWaste',       label: 'QTY Waste',      higherBetter: false },
  ];
  const rankColor = (rank: number, t: number) => {
    if (rank === 1) return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400';
    if (rank === t) return 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400';
    if (rank <= t / 2) return 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400';
    return 'bg-muted text-muted-foreground';
  };
  const items: RankItem[] = keyMetrics.map(m => {
    const sorted = [...peers].sort((a, b) => {
      const av = a[m.key] as number;
      const bv = b[m.key] as number;
      // For higherBetter: highest = best = rank 1 → sort descending.
      // For bad metrics (lower better): lowest = best = rank 1 → sort ascending.
      return m.higherBetter ? bv - av : av - bv;
    });
    const rank = sorted.findIndex(p => p.outletCode === target.outletCode) + 1;
    const best = rank === 1;
    const worst = rank === total;
    return {
      label: m.label,
      badgeContent: `#${rank}/${total}`,
      badgeClass: rankColor(rank, total),
      variant: 'secondary',
      star: best,
      warn: worst,
    };
  });
  return { items, total };
}

/** Peer Tab anomaly flags per row — checks devBom, totalLoss, residualQty, sales.
 *  Returns the pre-computed AnomalyFlag[] for the shared AnomalyFlags component. */
export function computePeerAnomalyFlags(row: PeerRow, peerAvg: PeerAverages): AnomalyFlag[] {
  const flags: AnomalyFlag[] = [];
  const avgVal = (k: keyof PeerRow) => peerAvg[k as string] as number;
  const checkRatio = (targetVal: number, avg: number) => (avg > 0 ? targetVal / avg : 0);

  if (checkRatio(row.devBom, avgVal('devBom')) > 1.5) {
    flags.push({ emoji: '🔴', text: 'Dev/BOM tinggi', color: 'text-red-600 bg-red-50 dark:bg-red-950/30' });
  }
  if (checkRatio(row.totalLoss, avgVal('totalLoss')) > 1.5) {
    flags.push({ emoji: '🔴', text: 'LOSS tinggi', color: 'text-red-600 bg-red-50 dark:bg-red-950/30' });
  }
  if (checkRatio(row.residualQty, avgVal('residualQty')) > 1.5) {
    flags.push({ emoji: '🔴', text: 'Residual tinggi', color: 'text-red-600 bg-red-50 dark:bg-red-950/30' });
  }
  if (checkRatio(row.sales, avgVal('sales')) < 0.8 && avgVal('sales') > 0) {
    flags.push({ emoji: '🟡', text: 'Sales rendah', color: 'text-amber-600 bg-amber-50 dark:bg-amber-950/30' });
  }

  const allNormal =
    flags.length === 0 &&
    Math.abs(row.devBom - avgVal('devBom')) <= avgVal('devBom') * 0.2 &&
    Math.abs(row.totalLoss - avgVal('totalLoss')) <= avgVal('totalLoss') * 0.2 &&
    Math.abs(row.residualQty - avgVal('residualQty')) <= avgVal('residualQty') * 0.2 &&
    Math.abs(row.sales - avgVal('sales')) <= avgVal('sales') * 0.2;

  if (allNormal) {
    flags.push({ emoji: '🟢', text: 'Normal', color: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30' });
  }

  return flags;
}
