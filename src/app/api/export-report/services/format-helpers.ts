// ============================================================
//  Format helpers — shared between data-fetcher + docx-builder
//  --------------------------------------------------------
//  Extracted from the original 1120-line route.ts (Task 4-c refactor).
//
//  These 3 helpers are used by BOTH the data-fetcher (no — actually only
//  the docx-builder calls them today) and the docx-builder. They are
//  pure-function formatters with no side effects, no I/O, no DB access.
//  Splitting them out keeps docx-builder.ts focused on document assembly.
//
//  All 3 functions preserve the EXACT formatting logic from the original
//  route.ts:131-151. Any change here would alter the rendered .docx text
//  for ALL exported reports — DO NOT change without verifying byte-for-byte
//  parity against the pre-split output.
// ============================================================

// ============================================================
//  Currency / number / percent formatters (Indonesian locale)
//  --------------------------------------------------------
//  - fmtIDR: compact IDR (Rp 1.23 Jt / Rp 4.56 M / Rp 7 Rb)
//  - fmtNum: grouped integer with id-ID locale, max 2 fractional digits
//  - fmtPct: percentage with optional leading + sign (for growth column)
//
//  All three return '—' (em dash) for null / NaN / non-finite input —
//  this is the "missing value" sentinel used throughout the Word export
//  so empty cells don't render as "0" or "NaN" or "undefined".
// ============================================================

/**
 * Format an IDR currency value into a compact human-readable string.
 *
 *   - null / NaN / Infinity → '—'
 *   - abs >= 1B  → 'Rp 1.23 M'  (miliar / billion)
 *   - abs >= 1M  → 'Rp 4.56 Jt' (juta / million)
 *   - abs >= 1K  → 'Rp 7 Rb'    (ribu / thousand)
 *   - else       → 'Rp 89'
 *
 *  Negative values get a leading '-' (e.g. '-Rp 1.23 Jt').
 *
 *  Relocated VERBATIM from route.ts:131-139. Used by docx-builder for the
 *  Executive Summary table, Top Items tables, Variance table, Trend table.
 */
export function fmtIDR(v: number | null | undefined): string {
  if (v == null || isNaN(v) || !isFinite(v)) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}Rp ${(abs / 1_000_000_000).toFixed(2)} M`;
  if (abs >= 1_000_000) return `${sign}Rp ${(abs / 1_000_000).toFixed(2)} Jt`;
  if (abs >= 1_000) return `${sign}Rp ${(abs / 1_000).toFixed(0)} Rb`;
  return `${sign}Rp ${abs.toFixed(0)}`;
}

/**
 * Format a quantity / count value with id-ID grouping (1.234.567) and
 * max 2 fractional digits.
 *
 *  Relocated VERBATIM from route.ts:141-144. Used by docx-builder for the
 *  QTY columns in the Executive Summary, Top Items, Breakdown tables.
 */
export function fmtNum(v: number | null | undefined): string {
  if (v == null || isNaN(v) || !isFinite(v)) return '—';
  return v.toLocaleString('id-ID', { maximumFractionDigits: 2 });
}

/**
 * Format a fraction (0..1) as a percentage string with 2 fractional digits.
 *
 *  - null / NaN / Infinity → '—'
 *  - withSign = true       → leading '+' for positive values (growth column)
 *  - withSign = false      → no sign (ratios / proportions column)
 *
 *  Relocated VERBATIM from route.ts:146-151. Used by docx-builder for the
 *  Growth columns (% Deviasi, % BOM, % Loss-to-Sales, % Surplus, etc.) and
 *  the Breakdown composition table.
 */
export function fmtPct(v: number | null | undefined, withSign = false): string {
  if (v == null || isNaN(v) || !isFinite(v)) return '—';
  const pct = v * 100;
  const sign = withSign && pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}
