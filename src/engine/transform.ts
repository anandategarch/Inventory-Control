// ============================================================
//  Transform — raw row → normalized + derived record
//  Handles: type casting, tolerance parsing, direction, residual, abs values
// ============================================================
import type { NormalizedRecord, DerivedRecord, Direction } from '@/types/inventory';
import { CFG_RECON_SETTINGS } from '@/config/settings';
import { parseOutletCode } from '@/lib/outlet';

// ============================================================
//  toNum — robust number parser (Indonesian / accounting / percent formats)
//  Handles: "12.345,67", "(310)", "Rp 269", "5%", "-1.234,56"
//  Exported so validator.ts can reuse (avoid false-positive INVALID_NUMBER)
// ============================================================
export function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isNaN(v) ? null : v;

  let s = String(v).trim();
  if (s === '') return null;

  // ===== Handle Indonesian / accounting number formats =====

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

  // 4. Remove all spaces (e.g., "- 310 " → "-310", "1 345" → "1345")
  s = s.replace(/\s+/g, '');

  // 5. Handle comma + dot separators (Indonesian/European/US formats)
  //    BUG FIX #006: Handle "1.234,56" (dot=thousands, comma=decimal) correctly
  //    Strategy:
  //      a. If BOTH dot and comma present:
  //         - Last separator is decimal, other is thousands
  //         - "1.234,56" → comma=decimal, dot=thousands → "1234.56"
  //         - "1,234.56" → dot=decimal, comma=thousands → "1234.56"
  //      b. If only comma:
  //         - 3 digits after → thousands: "1,345" → "1345"
  //         - 1-2 digits after → decimal: "1,5" → "1.5"
  //      c. If only dot:
  //         - 3 digits after AND number > 9999 → thousands: "1.234" → "1234"
  //         - Otherwise → decimal: "1.5" → "1.5"
  if (s.includes(',') && s.includes('.')) {
    // Both present — determine which is decimal (last one)
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma > lastDot) {
      // Comma is decimal, dot is thousands: "1.234,56" → "1234.56"
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      // Dot is decimal, comma is thousands: "1,234.56" → "1234.56"
      s = s.replace(/,/g, '');
    }
  } else if (s.includes(',')) {
    const lastComma = s.lastIndexOf(',');
    const afterComma = s.slice(lastComma + 1);
    if (afterComma.length === 3 && /^\d+$/.test(afterComma)) {
      // Thousands separator: "1,345" → "1345"
      s = s.replace(/,/g, '');
    } else if (afterComma.length >= 1 && afterComma.length <= 2 && /^\d+$/.test(afterComma)) {
      // Decimal separator: "1,5" → "1.5"
      s = s.replace(/,/g, '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (s.includes('.')) {
    // Bug 1 fix: handle dot-only format (Indonesian thousands with multiple dots)
    // The comment described this case but the code was missing!
    // Strategy:
    //   - Multiple dots → all are thousands separators: "1.234.567" → "1234567"
    //   - Single dot with exactly 3 digits after AND value > 9999 → thousands: "1.234" → "1234"
    //     (but "12.345" where 12 is the integer part → also thousands → "12345")
    //   - Single dot with 1-2 digits after → decimal: "1.5" → "1.5"
    //   - Single dot with 3 digits after but integer part ≤ 3 digits → ambiguous, treat as decimal
    const dots = s.split('.');
    if (dots.length > 2) {
      // Multiple dots = Indonesian thousands: "1.234.567" → "1234567"
      s = s.replace(/\./g, '');
    } else if (dots.length === 2) {
      const afterDot = dots[1];
      const beforeDot = dots[0];
      if (afterDot.length === 3 && /^\d+$/.test(afterDot) && /^\d+$/.test(beforeDot)) {
        // Single dot with 3 digits after — could be thousands or decimal
        // Heuristic: if the integer part is 1-2 digits, treat as thousands
        // "1.234" → 1234 (thousands), "12.345" → 12345 (thousands)
        // "123.456" → 123.456 (decimal, since 123 > 99)
        // This matches Indonesian format where "1.234" = one thousand two hundred thirty-four
        if (beforeDot.length <= 2) {
          s = s.replace(/\./g, '');
        }
        // else: leave as decimal (e.g., "123.456" stays as 123.456)
      }
      // else: leave as decimal (e.g., "1.5", "1.50")
    }
  }

  // 6. Parse the cleaned number
  const n = Number(s);
  if (isNaN(n)) return null;

  // 7. Apply negative sign (from accounting format or existing minus)
  const result = isNegative ? -Math.abs(n) : n;

  // 8. Convert percentage to decimal (5% → 0.05)
  return isPercent ? result / 100 : result;
}

function toStr(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  return String(v).trim();
}

// Parse tolerance: numeric value OR sentinel "BELUM ADA TOLERANSI"
function parseTolerance(raw: unknown): { value: number | null; rawStr: string | null } {
  if (raw === null || raw === undefined || raw === '') return { value: null, rawStr: null };
  if (typeof raw === 'number') return { value: raw, rawStr: String(raw) };
  const s = String(raw).trim();
  if (s.toUpperCase().includes(CFG_RECON_SETTINGS.TOLERANCE_NOT_SET_TEXT.toUpperCase())) {
    return { value: null, rawStr: s };
  }
  // Use robust toNum (handles "5%", "5,5", "5.5", etc.)
  const n = toNum(s);
  return { value: n, rawStr: s };
}

export function normalizeRow(
  row: Record<string, unknown>,
  sourceFile: string,
  rowNumber: number,
  monthLabel: string
): NormalizedRecord {
  const tol = parseTolerance(row.toleranceRaw);
  return {
    akunPenyesuaian: toStr(row.akunPenyesuaian),
    status: toStr(row.status),
    resto: String(row.resto ?? '').trim(),
    namaBahan: String(row.namaBahan ?? '').trim(),
    satuan: toStr(row.satuan),
    qtyBom: toNum(row.qtyBom),
    qtyCom: toNum(row.qtyCom),
    qtyDeviasi: toNum(row.qtyDeviasi),
    qtyWaste: toNum(row.qtyWaste),
    qtySusut: toNum(row.qtySusut),
    qtyTrial: toNum(row.qtyTrial),
    qtyLossSurplus: toNum(row.qtyLossSurplus),
    nominalDeviasi: toNum(row.nominalDeviasi),
    nominalWaste: toNum(row.nominalWaste),
    nominalSusut: toNum(row.nominalSusut),
    nominalTrial: toNum(row.nominalTrial),
    nominalLossSurplus: toNum(row.nominalLossSurplus),
    qtyWasteSusut: toNum(row.qtyWasteSusut),
    pctWasteSusut: toNum(row.pctWasteSusut),
    tolerancePct: tol.value,
    toleranceRaw: tol.rawStr,
    pctQtyDeviasiToBom: toNum(row.pctQtyDeviasiToBom),
    pctQtyWasteToBom: toNum(row.pctQtyWasteToBom),
    pctQtySusutToBom: toNum(row.pctQtySusutToBom),
    pctQtyTrialToBom: toNum(row.pctQtyTrialToBom),
    pctQtyLossToBom: toNum(row.pctQtyLossToBom),
    area: String(row.area ?? '').trim(),
    bulan: String(row.bulan ?? '').trim(),
    bulan2: toStr(row.bulan2),
    nominalSales: toNum(row.nominalSales),
    weekLabel: String(row.weekLabel ?? '').trim().toUpperCase(),
    monthLabel,
    sourceFile,
    rowNumber,
  };
}

// Bug 2 fix: Direction must be based on NET DEVIATION (QTY LOSS/SURPLUS),
// NOT GROSS DEVIATION (QTY DEVIASI).
// Master context section #9:
//   Net Deviation > 0 → LOSS (over-consumption)
//   Net Deviation < 0 → SURPLUS (under-consumption)
// Previously used qtyDeviasi (gross), which is wrong when gross and net
// have different signs (e.g., over-explained items where W+S+T > |gross|).
// Falls back to qtyDeviasi if qtyLossSurplus is null (data quality issue).
export function classifyDirection(netDeviation: number | null, grossDeviation: number | null = null): Direction {
  // Prefer net deviation (qtyLossSurplus) per master context
  if (netDeviation !== null) {
    if (netDeviation > 0) return 'LOSS';    // Net > 0 = over-consumption
    if (netDeviation < 0) return 'SURPLUS';  // Net < 0 = under-consumption
    return 'NEUTRAL';
  }
  // Fallback: use gross deviation if net is null
  if (grossDeviation !== null) {
    if (grossDeviation > 0) return 'LOSS';
    if (grossDeviation < 0) return 'SURPLUS';
  }
  return 'NEUTRAL';
}

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
  // waste+susut+trial are negative (or zero). Their sum is negative (or zero).
  // In convention where deviation is positive = LOSS:
  //   explained = |waste + susut + trial|  (positive magnitude)
  //   residual = |deviasi| - explained
  // We'll keep residualQty in same sign as deviasi for direction consistency.
  const w = rec.qtyWaste ?? 0;
  const s = rec.qtySusut ?? 0;
  const t = rec.qtyTrial ?? 0;
  const explained = Math.abs(w + s + t); // positive
  const absDev = Math.abs(rec.qtyDeviasi);
  // Bug 2 fix: clamp residual to >= 0 to prevent negative residual from
  // inflating dashboard totals via ABS() in SQL aggregates.
  // If explained > absDev (over-explanation/fraud indicator), residual = 0.
  const absResidual = Math.max(0, absDev - explained);
  const sign = rec.qtyDeviasi >= 0 ? 1 : -1;
  const residualQty = sign * absResidual;

  // nominal residual
  const nw = rec.nominalWaste ?? 0;
  const ns = rec.nominalSusut ?? 0;
  const nt = rec.nominalTrial ?? 0;
  const explainedNom = Math.abs(nw + ns + nt);
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
  const direction = classifyDirection(rec.qtyLossSurplus, rec.qtyDeviasi);
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
    const explainedMag = Math.abs(w + s + t);
    const expectedNet = rec.qtyDeviasi - explainedMag * Math.sign(rec.qtyDeviasi);
    // Tolerance: 1 unit or 1% of |expected|, whichever is larger
    const tolerance = Math.max(1, Math.abs(expectedNet) * 0.01);
    if (Math.abs(rec.qtyLossSurplus - expectedNet) > tolerance) {
      netDeviationMismatch = true;
    }
  }

  // week period
  const period = CFG_RECON_SETTINGS.WEEK_PERIODS[rec.weekLabel] || { start: 1, end: 31 };

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
