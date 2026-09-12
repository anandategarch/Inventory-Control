// ============================================================
//  ParetoDashboard — Constants & Helpers
//  --------------------------------------------------------
//  Pure data + pure functions only. No React, no hooks.
// ============================================================

import type { ParetoDimension } from './types';

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
