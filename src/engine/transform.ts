// ============================================================
//  Transform — raw row → normalized + derived record
//  Handles: type casting, tolerance parsing, direction, residual, abs values
// ============================================================
import type { NormalizedRecord, DerivedRecord, Direction } from '@/types/inventory';
import { CFG_RECON_SETTINGS } from '@/config/settings';
import { parseOutletCode } from '@/lib/outlet';
import { computeDirection } from '@/lib/metrics';

// ============================================================
//  Number locale hint for parsing string values from CSV/text.
//  - 'id': Indonesian format — dot=thousands, comma=decimal ("1.234,56")
//  - 'us': US format — comma=thousands, dot=decimal ("1,234.56")
//  - 'auto' (default): heuristic — tries to guess based on separator positions
// ============================================================
export type NumberLocale = 'auto' | 'id' | 'us';

// ============================================================
//  toNum — robust number parser (Indonesian / US / accounting / percent)
//  Handles: "12.345,67", "12,345.67", "(310)", "Rp 269", "5%", "-1.234,56"
//  Exported so validator.ts can reuse (avoid false-positive INVALID_NUMBER)
//
//  locale param:
//    'id'  → strict Indonesian: dot=thousands, comma=decimal
//    'us'  → strict US: comma=thousands, dot=decimal
//    'auto' (default) → heuristic (best-effort, may misinterpret "1.234")
// ============================================================
export function toNum(v: unknown, locale: NumberLocale = 'auto'): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isNaN(v) ? null : v;

  let s = String(v).trim();
  if (s === '') return null;

  // ===== Common preprocessing (applies to all locales) =====

  // 1. Remove "Rp" / "IDR" anywhere (Indonesian Rupiah): "Rp269", "-Rp269", "Rp 269"
  s = s.replace(/Rp/i, '').replace(/IDR/i, '').trim();

  // 2. Handle accounting format: "(310)" = -310, "(1,345)" = -1345
  let isNegative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    isNegative = true;
    s = s.slice(1, -1).trim();
  }

  // 3. Handle percentage suffix: "5%", "-1%", "0.00%"
  let isPercent = false;
  if (s.endsWith('%')) {
    isPercent = true;
    s = s.slice(0, -1).trim();
  }

  // 4. Remove all spaces
  s = s.replace(/\s+/g, '');

  // ===== Locale-specific separator handling =====
  s = normalizeSeparators(s, locale);

  // 6. Parse the cleaned number
  const n = Number(s);
  if (isNaN(n)) return null;

  // 7. Apply negative sign (from accounting format or existing minus)
  const result = isNegative ? -Math.abs(n) : n;

  // 8. Convert percentage to decimal (5% → 0.05)
  return isPercent ? result / 100 : result;
}

// ============================================================
//  normalizeSeparators — convert locale-specific number format to JS-parseable string
//  Returns a string with only digits, at most one '.', and optional leading '-'.
// ============================================================
function normalizeSeparators(s: string, locale: NumberLocale): string {
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');

  if (locale === 'id') {
    // Indonesian: dot=thousands, comma=decimal
    // "1.234.567,89" → "1234567.89", "1.234" → "1234", "1,5" → "1.5"
    if (hasComma && hasDot) {
      return s.replace(/\./g, '').replace(',', '.');
    }
    if (hasComma) {
      return s.replace(/,/g, '.');
    }
    if (hasDot) {
      // All dots are thousands separators
      return s.replace(/\./g, '');
    }
    return s;
  }

  if (locale === 'us') {
    // US: comma=thousands, dot=decimal
    // "1,234,567.89" → "1234567.89", "1,234" → "1234", "1.5" → "1.5"
    if (hasComma) {
      // Remove all commas (thousands); keep dot as decimal
      return s.replace(/,/g, '');
    }
    // Dot is decimal — leave as-is
    return s;
  }

  // ===== 'auto' — heuristic (best-effort) =====
  // This is the legacy behavior. May misinterpret "1.234" (could be 1.234 or 1234).
  // Users should prefer explicit locale ('id' or 'us') for CSV imports.
  if (hasComma && hasDot) {
    // Both present — last separator is decimal
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma > lastDot) {
      // Comma is decimal, dot is thousands: "1.234,56" → "1234.56"
      return s.replace(/\./g, '').replace(',', '.');
    } else {
      // Dot is decimal, comma is thousands: "1,234.56" → "1234.56"
      return s.replace(/,/g, '');
    }
  }
  if (hasComma) {
    const lastComma = s.lastIndexOf(',');
    const afterComma = s.slice(lastComma + 1);
    if (afterComma.length === 3 && /^\d+$/.test(afterComma)) {
      // Thousands separator: "1,345" → "1345"
      return s.replace(/,/g, '');
    }
    if (afterComma.length >= 1 && afterComma.length <= 2 && /^\d+$/.test(afterComma)) {
      // Decimal separator: "1,5" → "1.5"
      return s.replace(/,/g, '.');
    }
    return s.replace(/,/g, '');
  }
  if (hasDot) {
    const dots = s.split('.');
    if (dots.length > 2) {
      // Multiple dots = thousands: "1.234.567" → "1234567"
      return s.replace(/\./g, '');
    }
    if (dots.length === 2) {
      const afterDot = dots[1];
      const beforeDot = dots[0];
      if (afterDot.length === 3 && /^\d+$/.test(afterDot) && /^\d+$/.test(beforeDot)) {
        // Single dot with 3 digits after — ambiguous
        // Heuristic: integer part 1-2 digits → thousands ("1.234" → 1234)
        //            integer part 3+ digits → decimal ("123.456" → 123.456)
        if (beforeDot.length <= 2) {
          return s.replace(/\./g, '');
        }
      }
    }
  }
  return s;
}

function toStr(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  return String(v).trim();
}

// Parse tolerance: numeric value OR sentinel "BELUM ADA TOLERANSI"
function parseTolerance(raw: unknown, locale: NumberLocale = 'auto'): { value: number | null; rawStr: string | null } {
  if (raw === null || raw === undefined || raw === '') return { value: null, rawStr: null };
  if (typeof raw === 'number') return { value: raw, rawStr: String(raw) };
  const s = String(raw).trim();
  // Bug 7 fix: use exact match (===) not includes() to avoid false positives
  // "5% BELUM ADA TOLERANSI" should parse 5% as tolerance, not return null
  // Only treat as "not set" if the ENTIRE string is the sentinel text
  if (s.toUpperCase() === CFG_RECON_SETTINGS.TOLERANCE_NOT_SET_TEXT.toUpperCase()) {
    return { value: null, rawStr: s };
  }
  // Use robust toNum (handles "5%", "5,5", "5.5", etc.)
  let n = toNum(s, locale);
  // FIX (BUG 4): If toNum failed (mixed string like "5% BELUM ADA TOLERANSI"),
  // try extracting the leading numeric token before falling back to null.
  if (n === null) {
    const leadMatch = s.match(/^\s*([0-9.,%()RpIDR\s-]+)/i);
    if (leadMatch) {
      n = toNum(leadMatch[1], locale);
    }
  }
  return { value: n, rawStr: s };
}

export function normalizeRow(
  row: Record<string, unknown>,
  sourceFile: string,
  rowNumber: number,
  monthLabel: string,
  locale: NumberLocale = 'auto',
): NormalizedRecord {
  const tol = parseTolerance(row.toleranceRaw, locale);
  return {
    akunPenyesuaian: toStr(row.akunPenyesuaian),
    status: toStr(row.status),
    resto: String(row.resto ?? '').trim(),
    namaBahan: String(row.namaBahan ?? '').trim(),
    satuan: toStr(row.satuan),
    qtyBom: toNum(row.qtyBom, locale),
    qtyCom: toNum(row.qtyCom, locale),
    qtyDeviasi: toNum(row.qtyDeviasi, locale),
    qtyWaste: toNum(row.qtyWaste, locale),
    qtySusut: toNum(row.qtySusut, locale),
    qtyTrial: toNum(row.qtyTrial, locale),
    qtyLossSurplus: toNum(row.qtyLossSurplus, locale),
    nominalDeviasi: toNum(row.nominalDeviasi, locale),
    nominalWaste: toNum(row.nominalWaste, locale),
    nominalSusut: toNum(row.nominalSusut, locale),
    nominalTrial: toNum(row.nominalTrial, locale),
    nominalLossSurplus: toNum(row.nominalLossSurplus, locale),
    qtyWasteSusut: toNum(row.qtyWasteSusut, locale),
    pctWasteSusut: toNum(row.pctWasteSusut, locale),
    tolerancePct: tol.value,
    toleranceRaw: tol.rawStr,
    pctQtyDeviasiToBom: toNum(row.pctQtyDeviasiToBom, locale),
    pctQtyWasteToBom: toNum(row.pctQtyWasteToBom, locale),
    pctQtySusutToBom: toNum(row.pctQtySusutToBom, locale),
    pctQtyTrialToBom: toNum(row.pctQtyTrialToBom, locale),
    pctQtyLossToBom: toNum(row.pctQtyLossToBom, locale),
    area: String(row.area ?? '').trim(),
    bulan: String(row.bulan ?? '').trim(),
    bulan2: toStr(row.bulan2),
    nominalSales: toNum(row.nominalSales, locale),
    weekLabel: String(row.weekLabel ?? '').trim().toUpperCase(),
    monthLabel,
    sourceFile,
    rowNumber,
  };
}

// FIX (audit issue #6): classifyDirection wrapper REMOVED.
// All consumers now use computeDirection() directly from @/lib/metrics.
// Direction logic: NET deviation (qtyLossSurplus) < 0 → LOSS, > 0 → SURPLUS (Excel convention).
// Falls back to GROSS (qtyDeviasi) if NET is null.

// Compute residual = qtyDeviasi - (qtyWaste + qtySusut + qtyTrial)
// Note: WASTE/SUSUT/TRIAL are NEGATIVE (consumption), so residual uses sign-aware math.
// Convention: residual is in same sign space as qtyDeviasi.
export function computeResidual(rec: NormalizedRecord): {
  residualQty: number | null;
  residualNominal: number | null;
  residualRatio: number | null;
  isOverExplained: boolean;
} {
  if (rec.qtyDeviasi === null) {
    return { residualQty: null, residualNominal: null, residualRatio: null, isOverExplained: false };
  }
  // waste+susut+trial are negative (or zero) in well-formed data, but may
  // have mixed signs in malformed inputs (e.g. positive trial qty). Use
  // abs-each-then-sum so the explained magnitude is correct for mixed signs.
  // FIX (BUG-2-9): was `Math.abs(w + s + t)` which undercounts explained
  // deviation when waste/susut/trial have mixed signs, inflating residual
  // and triggering false RESIDUAL_LOSS flags.
  //   e.g. w=+5, s=-3, t=-2 → wrong = |0| = 0, correct = 5+3+2 = 10.
  const w = rec.qtyWaste ?? 0;
  const s = rec.qtySusut ?? 0;
  const t = rec.qtyTrial ?? 0;
  const explained = Math.abs(w) + Math.abs(s) + Math.abs(t); // positive
  const absDev = Math.abs(rec.qtyDeviasi);
  // Bug 2 fix: clamp residual to >= 0 to prevent negative residual from
  // inflating dashboard totals via ABS() in SQL aggregates.
  // If explained > absDev (over-explanation/fraud indicator), residual = 0.
  const absResidual = Math.max(0, absDev - explained);
  const sign = rec.qtyDeviasi >= 0 ? 1 : -1;
  const residualQty = sign * absResidual;

  // nominal residual — same abs-each-then-sum fix (BUG-2-9).
  const nw = rec.nominalWaste ?? 0;
  const ns = rec.nominalSusut ?? 0;
  const nt = rec.nominalTrial ?? 0;
  const explainedNom = Math.abs(nw) + Math.abs(ns) + Math.abs(nt);
  const absDevNom = Math.abs(rec.nominalDeviasi ?? 0);
  // Bug 2 fix: clamp nominal residual to >= 0 as well
  const residualNominal = sign * Math.max(0, absDevNom - explainedNom);

  const residualRatio = absDev > 0 ? absResidual / absDev : null;

  // Bug 8 fix: flag over-explanation (explained > absDev) as red flag for
  // fraud detection. Previously, clamping absResidual to 0 hid this signal.
  const isOverExplained = explained > absDev && absDev > 0;

  return { residualQty, residualNominal, residualRatio, isOverExplained };
}

export function deriveRecord(rec: NormalizedRecord): DerivedRecord {
  // Bug 2 fix: direction based on NET deviation (qtyLossSurplus), not gross (qtyDeviasi)
  const direction = computeDirection(rec.qtyLossSurplus, rec.qtyDeviasi);
  const { residualQty, residualNominal, residualRatio, isOverExplained } = computeResidual(rec);
  const parsed = parseOutletCode(rec.resto);

  // Bug 1 fix: validate Net Deviation formula
  // Master context: Net = Gross - |Waste| - |Susut| - |Trial|
  // If Excel's qtyLossSurplus ≠ computed net, flag as DQ issue
  let netDeviationMismatch = false;
  if (rec.qtyDeviasi !== null && rec.qtyLossSurplus !== null) {
    const w = rec.qtyWaste ?? 0;
    const s = rec.qtySusut ?? 0;
    const t = rec.qtyTrial ?? 0;
    // FIX (FIX-DEEP-3C / DEEP-AUDIT-ENGINE-2): use abs-each-then-sum so the
    // explained magnitude is correct for mixed-sign inputs (mirrors
    // computeResidual above). Was `Math.abs(w + s + t)` which undercounts the
    // explained magnitude when waste/susut/trial have mixed signs (e.g.
    // w=+5, s=-3, t=-2 → wrong = |0| = 0, correct = 5+3+2 = 10), inflating
    // expectedNet and triggering false NET_DEVIATION_MISMATCH flags.
    const explainedMag = Math.abs(w) + Math.abs(s) + Math.abs(t);
    const expectedNet = rec.qtyDeviasi - explainedMag * Math.sign(rec.qtyDeviasi);
    // Tolerance: 1 unit or 1% of |expected|, whichever is larger
    const tolerance = Math.max(1, Math.abs(expectedNet) * 0.01);
    if (Math.abs(rec.qtyLossSurplus - expectedNet) > tolerance) {
      netDeviationMismatch = true;
    }
  }

  // week period
  // FIX: CUMULATIVE week periods from config (W1=1-7, W2=1-14, W3=1-21, W4=1-25)
  // Previously: discrete ranges (W2=8-14) which was wrong — weeks are cumulative.
  let period = CFG_RECON_SETTINGS.WEEK_PERIODS[rec.weekLabel];
  if (!period) {
    // Derive for WEEK 5+ (rare): cumulative up to min(N*7, 31)
    const weekNum = parseInt(rec.weekLabel.replace(/\D/g, '')) || 1;
    period = { start: 1, end: Math.min(weekNum * 7, 31) };
  }

  return {
    ...rec,
    direction,
    residualQty,
    residualNominal,
    residualRatio,
    isOverExplained,
    netDeviationMismatch,
    absQtyDeviasi: rec.qtyDeviasi !== null ? Math.abs(rec.qtyDeviasi) : null,
    absNominalDeviasi: rec.nominalDeviasi !== null ? Math.abs(rec.nominalDeviasi) : null,
    absQtyLossSurplus: rec.qtyLossSurplus !== null ? Math.abs(rec.qtyLossSurplus) : null,
    absNominalLossSurplus: rec.nominalLossSurplus !== null ? Math.abs(rec.nominalLossSurplus) : null,
    outletCode: parsed?.fullCode ?? rec.resto,
    outletName: parsed?.name ?? rec.resto,
    outletNumericCode: parsed?.numericCode ?? '',
    monthKey: '', // filled by caller
    weekKey: '',  // filled by caller
    periodStart: period.start,
    periodEnd: period.end,
  };
}
