// ============================================================
//  Transform — raw row → normalized + derived record
//  Handles: type casting, tolerance parsing, direction, residual, abs values
// ============================================================
import type { NormalizedRecord, DerivedRecord, Direction } from '@/types/inventory';
import { CFG_RECON_SETTINGS } from '@/config/settings';
import { parseOutletCode } from '@/lib/outlet';

function toNum(v: unknown): number | null {
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
  const n = Number(s.replace(/,/g, '.'));
  return { value: isNaN(n) ? null : n, rawStr: s };
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

export function classifyDirection(qtyDeviasi: number | null): Direction {
  if (qtyDeviasi === null) return 'NEUTRAL';
  if (qtyDeviasi > 0) return 'LOSS';   // actual > SOC
  if (qtyDeviasi < 0) return 'SURPLUS'; // actual < SOC
  return 'NEUTRAL';
}

// Compute residual = qtyDeviasi - (qtyWaste + qtySusut + qtyTrial)
// Note: WASTE/SUSUT/TRIAL are NEGATIVE (consumption), so residual uses sign-aware math.
// Convention: residual is in same sign space as qtyDeviasi.
export function computeResidual(rec: NormalizedRecord): {
  residualQty: number | null;
  residualNominal: number | null;
  residualRatio: number | null;
} {
  if (rec.qtyDeviasi === null) {
    return { residualQty: null, residualNominal: null, residualRatio: null };
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
  const absResidual = absDev - explained;
  const sign = rec.qtyDeviasi >= 0 ? 1 : -1;
  const residualQty = sign * absResidual;

  // nominal residual
  const nw = rec.nominalWaste ?? 0;
  const ns = rec.nominalSusut ?? 0;
  const nt = rec.nominalTrial ?? 0;
  const explainedNom = Math.abs(nw + ns + nt);
  const absDevNom = Math.abs(rec.nominalDeviasi ?? 0);
  const residualNominal = sign * (absDevNom - explainedNom);

  const residualRatio = absDev > 0 ? absResidual / absDev : null;

  return { residualQty, residualNominal, residualRatio };
}

export function deriveRecord(rec: NormalizedRecord): DerivedRecord {
  const direction = classifyDirection(rec.qtyDeviasi);
  const { residualQty, residualNominal, residualRatio } = computeResidual(rec);
  const parsed = parseOutletCode(rec.resto);

  // week period
  const period = CFG_RECON_SETTINGS.WEEK_PERIODS[rec.weekLabel] || { start: 1, end: 31 };

  return {
    ...rec,
    direction,
    residualQty,
    residualNominal,
    residualRatio,
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
