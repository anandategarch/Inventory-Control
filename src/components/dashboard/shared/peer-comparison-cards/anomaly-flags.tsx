'use client';

// ============================================================
//  Anomaly Flags — presentational component + helper
//  --------------------------------------------------------
//  The AnomalyFlags component renders a list of pre-computed
//  flag badges (emoji + sr-only text). Pure presentational —
//  caller computes the flags.
//
//  The `computeAnomalyFlags` helper implements the Item Trend
//  Tab's 2-check pattern (|devBom| + |nominalDeviasi|). The
//  Peer Tab checks 4 different metrics (devBom, totalLoss,
//  residualQty, sales) and keeps its own inline compute logic
//  in PeerComparison.tsx (different shape, different semantics).
// ============================================================

import { memo } from 'react';
import type { AnomalyFlag } from './types';

export interface AnomalyFlagsProps {
  /** Pre-computed flags (caller decides which checks to run). */
  flags: AnomalyFlag[];
  /** Font size for the flag text. Peer Tab uses 11px, Item Tab uses 10px. */
  textSize?: '11px' | '10px';
  /** Whether to show the placeholder "—" when flags array is empty. Default true. */
  showPlaceholderWhenEmpty?: boolean;
}

export const AnomalyFlags = memo(function AnomalyFlags({
  flags,
  textSize = '11px',
  showPlaceholderWhenEmpty = true,
}: AnomalyFlagsProps) {
  if (flags.length === 0) {
    if (!showPlaceholderWhenEmpty) return null;
    return <span className="text-muted-foreground text-xs">—</span>;
  }

  const textClass = textSize === '10px' ? 'text-[10px]' : 'text-[11px]';

  return (
    <div className="flex flex-col items-center gap-0.5">
      {flags.map((f, i) => (
        <span
          key={i}
          className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 ${textClass} font-medium ${f.color}`}
          title={f.text}
        >
          <span aria-hidden>{f.emoji}</span>
          <span className="sr-only">{f.text}</span>
        </span>
      ))}
    </div>
  );
});

// ------------------------------------------------------------
//  computeAnomalyFlags — helper for the Item Trend Tab pattern
//  ------------------------------------------------------------
//  Checks:
//    🔴 Dev/BOM tinggi — |devBom| > 1.5× peer avg (|devBom|).
//    🔴 LOSS tinggi    — nominalDeviasi < 0 AND absNominalDeviasi > 1.5× peer avg.
//    🟢 Normal         — no flags AND within ±20% of peer avg on both metrics.
//
//  FIX (BUG-2-05/06): use ABS(peerAvg.devBom) for threshold — devBom is
//  SIGNED (neg=LOSS, pos=SURPLUS). Using signed peerAvg would suppress
//  flags when peers are in LOSS (peerAvg < 0 → checkRatio returns 0).
//
//  Note: this signature matches the ItemPeerComparison use case. The
//  PeerComparison use case (4-metric check) keeps its own inline logic.
// ------------------------------------------------------------

export interface ComputeAnomalyFlagsOpts {
  /** Signed Dev/BOM ratio (negative = LOSS ratio). Null when BOM=0. */
  devBom: number | null;
  /** Peer-avg Dev/BOM (signed). Will be ABS'd internally. */
  peerAvgDevBom: number;
  /** Absolute nominal deviation magnitude. */
  absNominal: number;
  /** Peer-avg absolute nominal deviation magnitude. */
  peerAvgNominal: number;
  /** Direction tag — used to gate the LOSS check (nominal < 0). */
  direction?: string;
  /** Signed nominal deviation — when provided AND < 0, the LOSS check fires. */
  signedNominal?: number;
}

export function computeAnomalyFlags(opts: ComputeAnomalyFlagsOpts): AnomalyFlag[] {
  const flags: AnomalyFlag[] = [];
  const checkRatio = (targetVal: number, avg: number) => (avg > 0 ? targetVal / avg : 0);
  const peerAbsDevBom = Math.abs(opts.peerAvgDevBom);

  // 🔴 Dev/BOM tinggi — abs dev/bom > 1.5× peer avg.
  if (opts.devBom != null && checkRatio(Math.abs(opts.devBom), peerAbsDevBom) > 1.5) {
    flags.push({ emoji: '🔴', text: 'Dev/BOM tinggi', color: 'text-red-600 bg-red-50 dark:bg-red-950/30' });
  }
  // 🔴 LOSS tinggi — nominal < 0 AND abs > 1.5× peer avg.
  const isLoss = opts.signedNominal != null
    ? opts.signedNominal < 0
    : opts.direction === 'LOSS';
  if (isLoss && checkRatio(opts.absNominal, opts.peerAvgNominal) > 1.5) {
    flags.push({ emoji: '🔴', text: 'LOSS tinggi', color: 'text-red-600 bg-red-50 dark:bg-red-950/30' });
  }
  // 🟢 Normal — no flags + within ±20% of peer avg on both metrics.
  if (flags.length === 0) {
    const devBomNear = opts.devBom == null
      || Math.abs(Math.abs(opts.devBom) - peerAbsDevBom) <= peerAbsDevBom * 0.2;
    const nominalNear = Math.abs(opts.absNominal - opts.peerAvgNominal) <= opts.peerAvgNominal * 0.2;
    if (devBomNear && nominalNear) {
      flags.push({ emoji: '🟢', text: 'Normal', color: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30' });
    }
  }

  return flags;
}
