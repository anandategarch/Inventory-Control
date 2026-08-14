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

  // Week period definition — CUMULATIVE (user confirmed)
  // WEEK 1 = day 1-7, WEEK 2 = day 1-14, WEEK 3 = day 1-21, WEEK 4 = day 1-25
  // Each week INCLUDES all previous weeks (cumulative, not discrete).
  // Comparison must be same-week across months (W4 Juli vs W4 Juni, NOT W4 vs W2).
  WEEK_PERIODS: {
    'WEEK 1': { start: 1, end: 7 },
    'WEEK 2': { start: 1, end: 14 },
    'WEEK 3': { start: 1, end: 21 },
    'WEEK 4': { start: 1, end: 25 },
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
