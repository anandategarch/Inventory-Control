// ============================================================
//  Formatting helpers — Indonesian abbreviations
//  M  = Miliar (billion, 1.000.000.000)
//  Jt = Juta   (million, 1.000.000)
//  Rb = Ribu   (thousand, 1.000)
//  Decimal separator: comma (,) — Indonesian style
// ============================================================

/**
 * Safely coerce a value to number or null.
 * Handles: null, undefined, empty string, NaN, Infinity, BigInt.
 * Deduplicated — was previously copied in 4 files (transform.ts, deviation.ts,
 * item-history/route.ts, outlet-items/route.ts).
 */
export function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  // FIX H4 (AUDIT-P2): isNaN('')===false, Number('')===0 — empty string returns 0
  // without the explicit check above. Now returns null (correct for empty Excel cells).
  // FIX H5 (AUDIT-P2): isNaN(Infinity)===false — Infinity poisons aggregations.
  // Now returns null for non-finite values.
  return (isNaN(n) || !isFinite(n)) ? null : n;
}

// Format number with Indonesian decimal separator
function fmtDecimal(n: number, digits: number): string {
  return n.toFixed(digits).replace('.', ',');
}

export function fmtIDR(v: number | null | undefined, compact = true): string {
  // FIX (BUG 3): Guard Infinity — isNaN(Infinity) is false, so it bypassed the guard
  if (v == null || isNaN(v) || !isFinite(v)) return '—';
  if (compact) {
    const abs = Math.abs(v);
    const sign = v < 0 ? '-' : '';
    if (abs >= 1_000_000_000) return `${sign}Rp ${fmtDecimal(abs / 1_000_000_000, 2)}M`;
    if (abs >= 1_000_000) return `${sign}Rp ${fmtDecimal(abs / 1_000_000, 2)}Jt`;
    if (abs >= 1_000) return `${sign}Rp ${fmtDecimal(abs / 1_000, 1)}Rb`;
    return `${sign}Rp ${abs.toFixed(0)}`;
  }
  return `Rp ${v.toLocaleString('id-ID', { maximumFractionDigits: 0 })}`;
}

export function fmtNum(v: number | null | undefined, unit = '', compact = true): string {
  if (v == null || isNaN(v) || !isFinite(v)) return '—';
  if (compact) {
    const abs = Math.abs(v);
    const sign = v < 0 ? '-' : '';
    // FIX MEDIUM (AUDIT-P2): add billions (M) branch — was missing, returned '1000,00Jt'
    if (abs >= 1_000_000_000) return `${sign}${fmtDecimal(abs / 1_000_000_000, 2)}M${unit}`;
    if (abs >= 1_000_000) return `${sign}${fmtDecimal(abs / 1_000_000, 2)}Jt${unit}`;
    if (abs >= 1_000) return `${sign}${fmtDecimal(abs / 1_000, 1)}Rb${unit}`;
    return `${sign}${abs.toFixed(0)}${unit}`;
  }
  return `${v.toLocaleString('id-ID', { maximumFractionDigits: 0 })}${unit}`;
}

export function fmtPct(v: number | null | undefined, withSign = true, digits = 1): string {
  if (v == null || isNaN(v) || !isFinite(v)) return '—';
  const pct = v * 100;
  const sign = withSign && pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(digits).replace('.', ',')}%`;
}

export function fmtPctAbs(v: number | null | undefined, digits = 1): string {
  if (v == null || isNaN(v) || !isFinite(v)) return '—';
  return `${(Math.abs(v) * 100).toFixed(digits).replace('.', ',')}%`;
}

/**
 * Compact formatter for heatmap cells — ultra-short (no "Rp" prefix, 1 decimal).
 * Matches fmtIDR suffix convention: M=Miliar, Jt=Juta, Rb=Ribu.
 * Used in dense grid cells where space is extremely limited.
 */
export function fmtHeatmapCompact(v: number | null | undefined): string {
  if (v == null || isNaN(v) || !isFinite(v) || v === 0) return '';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}${fmtDecimal(abs / 1_000_000_000, 1)}M`;
  if (abs >= 1_000_000) return `${sign}${fmtDecimal(abs / 1_000_000, 1)}Jt`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(0)}Rb`;
  return `${sign}${abs.toFixed(0)}`;
}

export function trendColor(v: number | null | undefined, inverse = false): string {
  if (v == null) return 'text-muted-foreground';
  if (v === 0) return 'text-muted-foreground';
  const positive = v > 0;
  const isGood = inverse ? !positive : positive;
  return isGood ? 'text-emerald-600' : 'text-red-600';
}

export function severityColor(s: string): string {
  switch (s) {
    case 'ABNORMAL': return 'text-red-600 bg-red-50 border-red-200 dark:bg-red-950/40 dark:border-red-900 dark:text-red-400';
    case 'WARNING': return 'text-amber-600 bg-amber-50 border-amber-200 dark:bg-amber-950/40 dark:border-amber-900 dark:text-amber-400';
    case 'ERROR': return 'text-red-700 bg-red-100 border-red-300 dark:bg-red-950/60 dark:border-red-800 dark:text-red-400';
    case 'NORMAL': return 'text-emerald-600 bg-emerald-50 border-emerald-200 dark:bg-emerald-950/40 dark:border-emerald-900 dark:text-emerald-400';
    default: return 'text-muted-foreground bg-muted/50 border-border';
  }
}

export function directionColor(d: string | null | undefined): string {
  switch (d) {
    case 'LOSS': return 'text-red-600 dark:text-red-400';
    case 'SURPLUS': return 'text-emerald-600 dark:text-emerald-400';
    default: return 'text-muted-foreground';
  }
}

// ============================================================
//  numberColor — global: negative = red, positive = green, zero = muted
//  Apply to ANY numeric display (IDR, QTY, percent, etc.)
//  FIX: consolidated from 3 duplicate versions (format.ts, GlobalItemSearchModal,
//  ParetoDashboard). Now includes dark mode + positive=green (was red-only).
// ============================================================
export function numberColor(v: number | null | undefined): string {
  if (v == null || isNaN(v)) return 'text-muted-foreground';
  return v < 0 ? 'text-red-600 dark:text-red-400' : v > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground';
}

export function priorityColor(p: string): string {
  switch (p) {
    case 'P1': return 'text-red-700 bg-red-100 border-red-300 dark:bg-red-950/60 dark:border-red-800 dark:text-red-400';
    case 'P2': return 'text-amber-700 bg-amber-100 border-amber-300 dark:bg-amber-950/60 dark:border-amber-800 dark:text-amber-400';
    case 'P3': return 'text-sky-700 bg-sky-100 border-sky-300 dark:bg-sky-950/60 dark:border-sky-800 dark:text-sky-400';
    default: return 'text-muted-foreground bg-muted/50 border-border';
  }
}

// ============================================================
//  Growth helpers — moved from resto-analysis/helpers.tsx + BomCorrelationCard
//  FIX (BATCH1): consolidated into lib/format.ts so all growth coloring +
//  formatting lives in ONE place (eliminates 2 duplicate definitions).
// ============================================================

/**
 * Format a growth ratio (e.g. 0.123 → "+12,3%" / -0.05 → "-5,0%").
 * Returns '—' for null/undefined. Uses Indonesian decimal comma.
 *
 * FIX (BATCH1): moved from src/components/dashboard/resto-analysis/helpers.tsx
 * (was duplicated visually-equivalent copy in BomCorrelationCard for growth
 * display — now both share this single source).
 */
export function fmtGrowth(v: number | null | undefined): string {
  if (v == null) return '—';
  const pct = (v * 100).toFixed(1);
  return v > 0 ? `+${pct}%` : `${pct}%`;
}

/**
 * Tailwind color class for a growth value.
 * - Positive → emerald (or red if `inverse=true`).
 * - Negative → red (or emerald if `inverse=true`).
 * - Null/undefined/zero → muted-foreground.
 *
 * FIX (BATCH1): moved from src/components/dashboard/resto-analysis/helpers.tsx.
 */
export function growthColor(v: number | null | undefined, inverse = false): string {
  if (v == null) return 'text-muted-foreground';
  if (inverse) return v > 0 ? 'text-red-600 dark:text-red-400' : v < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground';
  return v > 0 ? 'text-emerald-600 dark:text-emerald-400' : v < 0 ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground';
}

/**
 * Inverse growth color class — for metrics where UP is BAD (e.g. deviasi, waste).
 * Differs from `growthColor(v, true)` only by type signature (no undefined) +
 * an explicit `=== 0` early return (functionally equivalent — both return
 * muted for 0/null). Kept as a separate export so BomCorrelationCard can keep
 * its current call sites (`growthColorClass(x)`) without semantic change.
 *
 * FIX (BATCH1): moved from src/components/dashboard/BomCorrelationCard.tsx
 * (was a local duplicate of the inverse-mode coloring pattern).
 */
export function growthColorClass(growth: number | null): string {
  if (growth == null || growth === 0) return 'text-muted-foreground';
  return growth > 0
    ? 'text-red-600 dark:text-red-400'
    : 'text-emerald-600 dark:text-emerald-400';
}

// ============================================================
//  fmtFullSigned — full signed integer with thousand separators
//  FIX (BATCH1): moved from src/components/dashboard/tabs/ItemTrendTab/FlipMatrix.tsx
//  so it can be reused by other QTY-grid components without copy-paste.
//  Returns '0' for zero, otherwise '+N' or '-N' using id-ID locale
//  (Indonesian thousand separators, up to 1 decimal).
// ============================================================
export function fmtFullSigned(n: number): string {
  if (n === 0) return '0';
  const sign = n < 0 ? '-' : '+';
  return `${sign}${Math.abs(n).toLocaleString('id-ID', { maximumFractionDigits: 1 })}`;
}

// ============================================================
//  Format Presets System — inspired by evidence-dev/evidence
//  --------------------------------------------------------
//  Preset codes for consistent formatting across the dashboard.
//  Usage: formatByPreset(value, 'idr1m') → "Rp 1,2M"
//         formatByPreset(value, 'num2')  → "1.234,56"
//         formatByPreset(value, 'pct1')  → "12,3%"
//
//  Categories:
//    numN    — full number with N decimals (Indonesian comma)
//    numNk   — compact: thousand suffix "Rb"
//    numNm   — compact: million suffix "Jt"
//    numNM   — compact: billion suffix "M"
//    idrN    — full IDR with N decimals (Rp prefix)
//    idrNk   — compact IDR: "Rp 500Rb"
//    idrNm   — compact IDR: "Rp 1,2Jt"
//    idrNM   — compact IDR: "Rp 3,4M"
//    pctN    — percent with N decimals
//    qtyN    — signed QTY with N decimals (for deviasi display)
// ============================================================

/**
 * Format preset codes → their handler functions.
 * Each handler receives a number + returns a formatted string.
 * Null/undefined/NaN → '—'.
 */
export const FORMAT_PRESETS: Record<string, (v: number) => string> = {
  // Full numbers (Indonesian thousand separator + comma decimal)
  num0: (v) => Math.round(v).toLocaleString('id-ID'),
  num1: (v) => v.toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
  num2: (v) => v.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  num3: (v) => v.toLocaleString('id-ID', { minimumFractionDigits: 3, maximumFractionDigits: 3 }),

  // Compact numbers (Indonesian suffixes: Rb=ribu, Jt=juta, M=miliar)
  num0k: (v) => fmtCompact(v, 0, 'Rb', 1_000),
  num1k: (v) => fmtCompact(v, 1, 'Rb', 1_000),
  num0m: (v) => fmtCompact(v, 0, 'Jt', 1_000_000),
  num1m: (v) => fmtCompact(v, 1, 'Jt', 1_000_000),
  num2m: (v) => fmtCompact(v, 2, 'Jt', 1_000_000),
  num0M: (v) => fmtCompact(v, 0, 'M', 1_000_000_000),
  num1M: (v) => fmtCompact(v, 1, 'M', 1_000_000_000),
  num2M: (v) => fmtCompact(v, 2, 'M', 1_000_000_000),

  // Full IDR (Rp prefix, Indonesian formatting)
  idr0: (v) => `Rp ${Math.round(v).toLocaleString('id-ID')}`,
  idr1: (v) => `Rp ${v.toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`,
  idr2: (v) => `Rp ${v.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,

  // Compact IDR
  idr0k: (v) => `Rp ${fmtCompact(v, 0, 'Rb', 1_000)}`,
  idr1k: (v) => `Rp ${fmtCompact(v, 1, 'Rb', 1_000)}`,
  idr0m: (v) => `Rp ${fmtCompact(v, 0, 'Jt', 1_000_000)}`,
  idr1m: (v) => `Rp ${fmtCompact(v, 1, 'Jt', 1_000_000)}`,
  idr2m: (v) => `Rp ${fmtCompact(v, 2, 'Jt', 1_000_000)}`,
  idr0M: (v) => `Rp ${fmtCompact(v, 0, 'M', 1_000_000_000)}`,
  idr1M: (v) => `Rp ${fmtCompact(v, 1, 'M', 1_000_000_000)}`,
  idr2M: (v) => `Rp ${fmtCompact(v, 2, 'M', 1_000_000_000)}`,

  // Percent (input is fraction 0-1, displayed as 0-100%)
  pct0: (v) => `${Math.round(v * 100)}%`,
  pct1: (v) => `${(v * 100).toFixed(1).replace('.', ',')}%`,
  pct2: (v) => `${(v * 100).toFixed(2).replace('.', ',')}%`,
  pct3: (v) => `${(v * 100).toFixed(3).replace('.', ',')}%`,

  // Percent absolute (|value|, for Dev/BOM ratio display)
  pct0abs: (v) => `${Math.round(Math.abs(v) * 100)}%`,
  pct1abs: (v) => `${(Math.abs(v) * 100).toFixed(1).replace('.', ',')}%`,
  pct2abs: (v) => `${(Math.abs(v) * 100).toFixed(2).replace('.', ',')}%`,

  // Signed QTY (for deviasi: +1.234 / -567 / 0)
  qty0: (v) => v === 0 ? '0' : `${v < 0 ? '-' : '+'}${Math.abs(v).toLocaleString('id-ID', { maximumFractionDigits: 0 })}`,
  qty1: (v) => v === 0 ? '0' : `${v < 0 ? '-' : '+'}${Math.abs(v).toLocaleString('id-ID', { maximumFractionDigits: 1 })}`,
  qty2: (v) => v === 0 ? '0' : `${v < 0 ? '-' : '+'}${Math.abs(v).toLocaleString('id-ID', { maximumFractionDigits: 2 })}`,
};

/**
 * Compact number formatter helper for presets.
 * Divides by `divisor`, formats with `digits` decimals, appends `suffix`.
 * Handles sign for negative values.
 */
function fmtCompact(v: number, digits: number, suffix: string, divisor: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  return `${sign}${fmtDecimal(abs / divisor, digits)}${suffix}`;
}

/**
 * Format a value using a preset code.
 *
 * @param value  Number to format (null/undefined/NaN → '—')
 * @param preset Preset code from FORMAT_PRESETS (e.g. 'idr1m', 'num2', 'pct1')
 * @returns Formatted string, or '—' for invalid input
 *
 * @example
 * formatByPreset(1234567, 'idr1m')   → "Rp 1,2Jt"
 * formatByPreset(0.125, 'pct1')       → "12,5%"
 * formatByPreset(1234.56, 'num2')     → "1.234,56"
 * formatByPreset(-50, 'qty0')         → "-50"
 * formatByPreset(null, 'num0')        → "—"
 */
export function formatByPreset(value: number | null | undefined, preset: string): string {
  if (value == null || isNaN(value) || !isFinite(value)) return '—';
  const handler = FORMAT_PRESETS[preset];
  if (!handler) {
    // Unknown preset — fall back to num0 (safe default)
    return FORMAT_PRESETS.num0(value);
  }
  return handler(value);
}

/**
 * Check if a preset code is valid (exists in FORMAT_PRESETS).
 * Useful for runtime validation or UI dropdowns.
 */
export function isValidPreset(preset: string): boolean {
  return preset in FORMAT_PRESETS;
}

/**
 * Get all available preset codes, optionally filtered by category prefix.
 * @param prefix Category prefix: 'num', 'idr', 'pct', 'qty'
 * @returns Array of preset codes
 *
 * @example
 * getPresetsByCategory('idr') → ['idr0', 'idr1', 'idr2', 'idr0k', ...]
 */
export function getPresetsByCategory(prefix?: string): string[] {
  const all = Object.keys(FORMAT_PRESETS);
  if (!prefix) return all;
  return all.filter((p) => p.startsWith(prefix));
}

