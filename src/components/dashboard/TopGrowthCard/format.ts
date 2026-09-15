// ============================================================
//  TopGrowthCard — formatting helpers & constants
//  (split from TopGrowthCard.tsx — SPLIT-G; pure code motion)
// ============================================================

import { fmtNum } from '@/lib/format';

/** Server caps each list at 15 rows (queryTopGrowth); the card shows the top 10. */
export const DISPLAY_LIMIT = 10;
/** Server-side contributor cap (topGrowth.contributorLimit) — fallback for old payloads. */
export const CONTRIBUTOR_LIMIT_FALLBACK = 5;

export type Grain = 'outlet' | 'item';

// ------------------------------------------------------------
//  Formatting — compact signed nominal delta.
//  VH-3: delegates to lib/format fmtNum (Indonesian suffixes +
//  comma decimals — normalizes the old dot-decimal local copy,
//  closing the H-14-a mixed-decimal finding in this file).
// ------------------------------------------------------------
export function formatDelta(v: number): string {
  return fmtNum(v);
}

export function formatDeltaSigned(v: number): string {
  // Negative sign is already emitted by formatDelta; only append "+".
  return v > 0 ? `+${formatDelta(v)}` : formatDelta(v);
}

// ------------------------------------------------------------
//  TASK H-7 — QTY delta formatting (drill-down contributor lines):
//  "−12,5 kg". id-ID locale, max 2 decimals under 10K, 0 above. The
//  satuan suffix makes a qty impossible to misread as rupiah.
// ------------------------------------------------------------
export function formatQty(v: number, unit?: string | null): string {
  const abs = Math.abs(v);
  const num = abs >= 10_000
    ? abs.toLocaleString('id-ID', { maximumFractionDigits: 0 })
    : abs.toLocaleString('id-ID', { maximumFractionDigits: 2 });
  return unit ? `${num} ${unit}` : num;
}

export function formatQtySigned(v: number, unit?: string | null): string {
  // FIX (BUG-HUNT B6/BUG-3-02): formatQty() strips the sign via Math.abs and
  // toLocaleString never re-emits it, so negative Δ qty rendered as a bare
  // "12,5 kg" (direction readable only from color) while the adjacent Δ
  // nominal column IS signed. Restore the explicit minus; keep 0 unsigned.
  return v > 0 ? `+${formatQty(v, unit)}` : v < 0 ? `-${formatQty(v, unit)}` : formatQty(v, unit);
}

/** "WEEK 2 · Mei 2026 · tgl 1–14" — week label + month + cumulative day range. */
export function formatPeriodLabel(
  week: string,
  month: string | null | undefined,
  range: { start: number; end: number } | null | undefined,
): string {
  const base = month ? `${week} · ${month}` : week;
  return range ? `${base} · tgl ${range.start}–${range.end}` : base;
}
