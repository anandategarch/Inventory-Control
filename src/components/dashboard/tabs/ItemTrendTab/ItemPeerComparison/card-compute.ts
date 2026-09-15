// ============================================================
//  ItemPeerComparison — card pre-compute (pure functions)
//  --------------------------------------------------------
//  SPLIT-B (pure move from ItemPeerComparison.tsx — no behavior
//  change). Pre-computed values for the 4 analysis cards (each
//  caller computes its own — Item Tab vs Peer Tab have different
//  metrics + formulas):
//    - buildPeerCardData → gapRows (Gap Analysis card),
//      scatterPoints (Scatter Plot card), rankItems (Ranking
//      Summary card) + `total`
//  No 'use client', no React — fully tree-shakeable + testable.
// ============================================================

import { fmtIDR, fmtNum, fmtPctAbs } from '@/lib/format';
import type { GapRow, RankItem, ScatterPoint } from '@/components/dashboard/shared/peer-comparison-cards';
import { rankColor } from '../item-peer-compute';
import type { ItemPeerRow, ItemPeerAverages } from './types';

export interface PeerCardData {
  gapRows: GapRow[];
  scatterPoints: ScatterPoint[];
  rankItems: RankItem[];
  /** Total peers (incl. target — server includes it in peers[]). */
  total: number;
}

export function buildPeerCardData(
  target: ItemPeerRow,
  peers: ItemPeerRow[],
  peerAvg: ItemPeerAverages,
): PeerCardData {
  // --- Gap Analysis rows ---
  // Peer BEST = lowest absolute nominal deviation (closest to zero = best).
  // FIX (BUG-2-04): exclude target from peer BEST search — target is now
  // included in peers[] (server-side change), but "peer best" should be
  // the best NON-target outlet.
  const nonTargetPeers = peers.filter(p => !p.isTarget);
  const absValues = nonTargetPeers.map(p => p.absNominalDeviasi);
  const bestAbsNominal = absValues.length > 0 ? Math.min(...absValues) : 0;
  const bestPeer = nonTargetPeers.find(p => p.absNominalDeviasi === bestAbsNominal);

  const gapRows: GapRow[] = [
    {
      label: 'Nominal Deviasi',
      targetVal: target.absNominalDeviasi,
      bestVal: bestAbsNominal,
      avgVal: peerAvg.absNominalDeviasi,
      format: fmtIDR,
      higherBetter: false,
    },
    {
      label: 'QTY Deviasi',
      targetVal: Math.abs(target.qtyDeviasi),
      bestVal: bestPeer ? Math.abs(bestPeer.qtyDeviasi) : 0,
      avgVal: peerAvg.absQtyDeviasi,
      format: fmtNum,
      higherBetter: false,
    },
    {
      label: 'Dev/BOM',
      targetVal: target.devBom != null ? Math.abs(target.devBom) : 0,
      bestVal: bestPeer && bestPeer.devBom != null ? Math.abs(bestPeer.devBom) : 0,
      // FIX (BUG-2-04): use ABS peer avg — devBom is signed, but we compare
      // magnitudes (all targetVal/bestVal are already ABS).
      avgVal: Math.abs(peerAvg.devBom),
      format: fmtPctAbs,
      higherBetter: false,
    },
  ];

  // --- Scatter Plot points ---
  // FIX (PATTERN-2): add "vs peer avg" comparison to tooltip using TargetComparison.
  // Shows how each outlet's |Nominal| compares to peer average — context for
  // interpreting the scatter plot (above/below avg).
  const scatterPoints: ScatterPoint[] = peers.map(p => ({
    x: p.qtyBom,
    y: p.absNominalDeviasi,
    label: p.outletName,
    direction: p.direction,
    isTarget: p.outletCode === target.outletCode,
    tooltipLines: [
      { label: 'QTY BOM', value: fmtNum(p.qtyBom) },
      { label: '|Nominal|', value: fmtIDR(p.absNominalDeviasi) },
      // FIX (PATTERN-2): add vs peer avg comparison line.
      // downIsGood=true (higher |Nominal| = worse → up = bad).
      {
        label: 'vs peer avg',
        value: peerAvg.absNominalDeviasi > 0
          ? `${p.absNominalDeviasi > peerAvg.absNominalDeviasi ? '+' : ''}${((p.absNominalDeviasi - peerAvg.absNominalDeviasi) / peerAvg.absNominalDeviasi * 100).toFixed(1).replace('.', ',')}%`
          : '—',
      },
    ],
  }));

  // --- Ranking Summary items ---
  const total = peers.length;
  // Rank by |nominalDeviasi| ascending (lowest = best = rank 1).
  const sorted = [...peers].sort((a, b) => a.absNominalDeviasi - b.absNominalDeviasi);
  const rank = sorted.findIndex(p => p.outletCode === target.outletCode) + 1;
  const worst = rank === total && total > 1;
  const best = rank === 1;
  const percentile = total > 0 ? (rank / total) * 100 : 100;

  const rankItems: RankItem[] = [
    {
      label: 'Rank |Nominal|',
      badgeContent: `#${rank}/${total}`,
      badgeClass: rankColor(rank, total),
      // FIX (UI-18): standardized to 'outline' for cleaner look.
      variant: 'outline',
      star: best,
      warn: worst,
    },
    {
      label: 'Percentile',
      badgeContent: `p${percentile.toFixed(0)}`,
      variant: 'outline',
    },
    {
      label: 'LOSS outlets',
      badgeContent: String(peers.filter(p => p.direction === 'LOSS').length),
      badgeClass: 'text-red-700 dark:text-red-400',
      variant: 'outline',
    },
    {
      label: 'SURPLUS outlets',
      badgeContent: String(peers.filter(p => p.direction === 'SURPLUS').length),
      badgeClass: 'text-emerald-700 dark:text-emerald-400',
      variant: 'outline',
    },
  ];

  return { gapRows, scatterPoints, rankItems, total };
}
