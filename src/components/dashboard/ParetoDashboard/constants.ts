// ============================================================
//  ParetoDashboard — Constants & Helpers
//  --------------------------------------------------------
//  Pure data + pure functions only. No React, no hooks.
// ============================================================

import type { ConcentrationLevel, ConcentrationStats, ParetoDimension, ParetoResult } from './types';

export const DIM_LABELS: Record<ParetoDimension, string> = {
  item: 'Item',
  outlet: 'Outlet',
  area: 'Area',
  kelompok: 'Kelompok',
  pic: 'PIC',
};

// FIX #28: countSuffix helper — picks the short label for the dimension
// shown under each row in a QuadrantCard (e.g. "3 out", "5 klp", "2 pic").
export function countSuffix(title: string): string {
  const t = title.toLowerCase();
  if (t.includes('kelompok')) return 'klp';
  if (t.includes('pic')) return 'pic';
  if (t.includes('outlet')) return 'resto';
  if (t.includes('area')) return 'area';
  return ''; // items have no count suffix
}

// FIX #23: per-quadrant tooltip text describing what each card shows.
export const QUADRANT_TOOLTIPS: Record<string, string> = {
  'Top Items (80% Deviation)': 'Top item yang menyumbang 80% total |nominalDeviasi|. Sisa item hanya 20%.',
  'Top Outlets (80% Deviation)': 'Top outlet yang menyumbang 80% total |nominalDeviasi|. Fokus ke sini untuk impact maksimal.',
  'Top Kelompok (80% Deviation)': 'Top kelompok (segment) yang menyumbang 80% total |nominalDeviasi|. Bisa signalkan masalah sistemik di kelompok tersebut.',
  'Top Areas (80% Deviation)': 'Top area geografis yang menyumbang 80% total |nominalDeviasi|.',
  'Top PIC (80% Deviation)': 'Top PIC (Person In Charge) yang menyumbang 80% total |nominalDeviasi|.',
};

// ============================================================
//  ANA-1-C: Concentration Ratio (Contribution Analysis ringkas)
//  --------------------------------------------------------
//  Semantic chip classes for the TINGGI/SEDANG/RENDAH level —
//  identical to the priority-level badge styling in
//  PrioritySummaryCard.tsx (red / amber / emerald, light + dark).
// ============================================================
export const CONCENTRATION_LEVEL_STYLE: Record<ConcentrationLevel, string> = {
  TINGGI: 'text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900',
  SEDANG: 'text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900',
  RENDAH: 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900',
};

// ANA-1-C: pure FRONTEND derivation from an existing ParetoResult —
// drivers arrive pre-sorted (desc |totalAbsNominal|) with sharePct/cumPct,
// so no recount of the 80% cut is needed:
//   CR3 = cumPct of driver #3 (Top 3 share)
//   CR5 = cumPct of driver #5 (Top 5 share; falls back to the last
//        available driver when fewer than 5 exist)
//   N80 = drivers.length — the backend loop (computePareto8020) already
//        stops at cumPct ≥ 80%, so drivers.length IS the N-for-80%.
//        null = the 20-driver cap truncated the list before 80% was
//        reached (true N80 unknown client-side → render as "20+").
// Level: TINGGI bila CR5 ≥ 70% · SEDANG ≥ 50% · RENDAH di bawahnya.
// Returns null when there are no drivers (nothing to concentrate).
export function deriveConcentration(result: ParetoResult): ConcentrationStats | null {
  const drivers = result.drivers;
  if (drivers.length === 0) return null;
  const cr3Count = Math.min(3, drivers.length);
  const cr5Count = Math.min(5, drivers.length);
  const cr3 = drivers[cr3Count - 1].cumPct;
  const cr5 = drivers[cr5Count - 1].cumPct;
  // The loop consumes every row before capping, and all rows always sum to
  // 100% — so a last cumPct < 80 can only mean the maxDrivers (20) cap hit.
  const n80 = drivers[drivers.length - 1].cumPct >= 80 ? drivers.length : null;
  const level: ConcentrationLevel = cr5 >= 70 ? 'TINGGI' : cr5 >= 50 ? 'SEDANG' : 'RENDAH';
  return { cr3, cr5, cr3Count, cr5Count, n80, level };
}
