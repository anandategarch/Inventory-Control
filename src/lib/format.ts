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
