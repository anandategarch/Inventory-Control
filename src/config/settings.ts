// ============================================================
//  CFG_STATUS_RECON — Status label configuration
//  (Mirrors concept from Power Query design; kept for compatibility)
// ============================================================
export const CFG_STATUS_LABELS = {
  // Direction labels
  LOSS: 'LOSS',
  SURPLUS: 'SURPLUS',
  NEUTRAL: 'NEUTRAL',

  // Severity labels
  NORMAL: 'NORMAL',
  WARNING: 'WARNING',
  ABNORMAL: 'ABNORMAL',

  // Status fallbacks
  NO_RULE_STATUS: 'RULE TIDAK DITEMUKAN',
  INSUFFICIENT_EVIDENCE: 'Insufficient evidence — further investigation required',

  // Health labels
  HEALTHY: 'HEALTHY',
  NEEDS_ATTENTION: 'NEEDS ATTENTION',
  CRITICAL: 'CRITICAL',
} as const;

// ============================================================
//  CFG_RECON_SETTINGS — behavioral config
// ============================================================
export const CFG_RECON_SETTINGS = {
  // NULL vs 0 handling
  TREAT_NULL_AS: 'KOSONG' as const,
  TREAT_ZERO_AS: 'ADA' as const, // 0 dianggap ADA input (configurable)

  // Week period definition (user confirmed ranges)
  // WEEK 1 = day 1-7, WEEK 2 = day 8-14, WEEK 3/4 = day 15-30/31
  // Note: data may use WEEK 3 or WEEK 4 for the third period — support both
  WEEK_PERIODS: {
    'WEEK 1': { start: 1, end: 7 },
    'WEEK 2': { start: 8, end: 14 },
    'WEEK 3': { start: 15, end: 31 },
    'WEEK 4': { start: 15, end: 31 },
    'WEEK 5': { start: 29, end: 31 }, // FIX (BUG 9): was missing — WEEK 5+ got whole month fallback
  } as Record<string, { start: number; end: number }>,

  // Outlet code patterns
  OUTLET_CODE_PATTERNS: [
    /^(\d{4})\.([A-Z]+)$/,        // 1030.BDGSET
    /^B\.(\d{4})\.([A-Z]+)$/,     // B.1001.MLGPAR
  ] as RegExp[],

  // Tolerance sentinel text
  TOLERANCE_NOT_SET_TEXT: 'BELUM ADA TOLERANSI',
  FALLBACK_TOLERANCE_PCT: 0.05,

  // Historical window
  HISTORICAL_WEEKS: 8,
} as const;
