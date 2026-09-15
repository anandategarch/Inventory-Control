// ============================================================
//  OutletPriorityPanel — lens model (types + tiny classifiers)
//  (split from OutletPriorityPanel.tsx — SPLIT-G; pure code motion)
//
//  The four lenses ("prioritas" | "kondisi" | "peluang" |
//  "perubahan"), the compact-panel display constants, and the
//  lens-agnostic CompactRow normalization shape that keeps the
//  three payload list types out of the render path.
// ============================================================

import type { RestoRecommendation } from '@/hooks/useRecommendations';
import type { RecommendationHistory } from '@/components/dashboard/priority-summary/types';
import type { ChangeOutletStat } from '@/components/dashboard/narrative/ChangeItemTable';

export type Lens = 'prioritas' | 'kondisi' | 'peluang' | 'perubahan';

/** Compact panel shows 3 by default, at most 8 when expanded
 *  (progressive disclosure — same rule as ItemPriorityPanel). */
export const COMPACT_MAX = 8;

export const TOOLTIP_TEXT =
  'Satu panel, empat lensa untuk "resto mana yang perlu perhatian dulu?": Prioritas = skor 14 sinyal (loss, deviasi, anomali, dsb); Kondisi = health score dari campuran normal/warning/abnormal; Peluang Rp = loss yang bisa ditekan jika turun ke median areanya; Perubahan = seberapa jauh gerakan deviasi periode ini menyimpang dari kebiasaan gerak resto itu sendiri (rasio = perubahan sekarang ÷ rata-rata perubahan antar periode, same-week). Klik resto untuk detail; versi penuh tiap lensa ada di tab Resto / Area / Peer.';

/** Normalized display row (lens-agnostic) — keeps the three payload
 *  list types out of the render path and the mini-bar scale simple. */
export interface CompactRow {
  key: string;
  outletCode: string;
  outletName: string;
  area: string;
  magnitude: number;
  valueLabel: string;
  valueCls: string;
  barCls: string;
  subLabel: string;
  /** ANA-1-D chips (Prioritas lens only) — carried over 1:1 from the old
   *  RestoRecommendationCard rows so the compact panel loses no signal. */
  history?: RecommendationHistory;
  trendDeteriorating?: boolean;
  /** Perubahan lens only (CHANGE-1) — status + LOSS↔SURPLUS flip marker. */
  status?: ChangeOutletStat['status'];
  isFlip?: boolean;
}

/** Tooltip for the recurrence chip (verbatim from the old card — ANA-1-D). */
export function recurrenceTitle(h: RecommendationHistory): string {
  let t = `Bermasalah di ${h.abnormalCount} dari ${h.periodCount} bulan sebelumnya (Dev/BOM di atas toleransi atau loss di atas threshold)`;
  if (h.periodCount < 4) t += ' · data historis masih terbatas';
  return t;
}

export function levelValueCls(level: RestoRecommendation['priorityLevel']): string {
  if (level === 'TINGGI') return 'text-red-600 dark:text-red-400';
  if (level === 'SEDANG') return 'text-amber-600 dark:text-amber-400';
  return 'text-zinc-500 dark:text-zinc-400';
}

export function levelBarCls(level: RestoRecommendation['priorityLevel']): string {
  if (level === 'TINGGI') return 'bg-red-500';
  if (level === 'SEDANG') return 'bg-amber-500';
  return 'bg-zinc-400';
}
