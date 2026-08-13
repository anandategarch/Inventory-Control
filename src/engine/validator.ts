// ============================================================
//  Data Quality Validator — validates raw rows before analysis
//  Produces DQIssue list. ERROR severity blocks analysis.
// ============================================================
import type { DQIssueSummary } from '@/types/inventory';
import type { DQIssue } from '@prisma/client';
import { CFG_RECON_SETTINGS } from '@/config/settings';
import { toNum } from '@/engine/transform';

export interface DQResult {
  issues: DQIssueRow[];
  severityCounts: { ERROR: number; WARNING: number; INFO: number };
  status: 'OK' | 'WARNING' | 'ERROR';
}

export interface DQIssueRow {
  severity: 'ERROR' | 'WARNING' | 'INFO';
  code: string;
  message: string;
  rawValue?: string;
  rowNumber?: number;
  outletCode?: string;
  itemName?: string;
  weekLabel?: string;
  sheetName?: string; // P1-9 fix: track which sheet the issue came from
}

export function validateRow(
  row: Record<string, unknown>,
  rowNumber: number,
  seenKeys: Set<string>,
  sheetName?: string // P1-9 fix: pass sheet name for multi-sheet audit
): DQIssueRow[] {
  const issues: DQIssueRow[] = [];
  const resto = String(row.resto ?? '').trim();
  const namaBahan = String(row.namaBahan ?? '').trim();
  const weekLabel = String(row.weekLabel ?? '').trim();
  const akun = String(row.akunPenyesuaian ?? '').trim();
  const area = String(row.area ?? '').trim();

  // ERROR: missing required fields
  if (!resto) {
    issues.push({ severity: 'ERROR', code: 'MISSING_OUTLET', message: `Row ${rowNumber}: RESTO kosong`, rowNumber });
  }
  if (!namaBahan) {
    issues.push({ severity: 'ERROR', code: 'MISSING_ITEM', message: `Row ${rowNumber}: NAMA BAHAN kosong`, rowNumber });
  }
  if (!weekLabel) {
    issues.push({ severity: 'WARNING', code: 'MISSING_WEEK', message: `Row ${rowNumber}: STATUS BULAN (week) kosong`, rowNumber });
  }

  // Bug 8 fix: DQ checks for mapping issues (master context #45)
  // OUTLET_NOT_MAPPED: outlet code doesn't match expected format (XXXX.NNNN or B.XXXX.NNNN)
  if (resto) {
    // Valid outlet code formats: "1030.BDGSET" or "B.1001.MLGPAR"
    const outletCodePattern = /^(B\.)?\d{3,5}\.[A-Z]{4,8}$/i;
    if (!outletCodePattern.test(resto)) {
      issues.push({
        severity: 'WARNING',
        code: 'OUTLET_NOT_MAPPED',
        message: `Row ${rowNumber}: RESTO "${resto}" tidak sesuai format outlet code (XXXX.NAMA). Periksa mapping outlet.`,
        rawValue: resto,
        rowNumber, outletCode: resto, itemName: namaBahan, weekLabel,
      });
    }
  }

  // AREA_NOT_MAPPED: area field empty or suspicious
  if (!area) {
    issues.push({
      severity: 'WARNING',
      code: 'AREA_NOT_MAPPED',
      message: `Row ${rowNumber}: AREA kosong untuk ${namaBahan} @ ${resto}`,
      rowNumber, outletCode: resto, itemName: namaBahan, weekLabel,
    });
  }

  // PERIOD_NOT_MAPPED: weekLabel not in expected format (WEEK 1/2/3/4)
  if (weekLabel && !/^WEEK\s*[1-4]$/i.test(weekLabel)) {
    issues.push({
      severity: 'WARNING',
      code: 'PERIOD_NOT_MAPPED',
      message: `Row ${rowNumber}: STATUS BULAN "${weekLabel}" tidak sesuai format (WEEK 1/2/3/4)`,
      rawValue: weekLabel,
      rowNumber, outletCode: resto, itemName: namaBahan,
    });
  }

  // ERROR: invalid number on critical numeric columns
  const criticalNums = ['qtyBom', 'qtyDeviasi', 'nominalDeviasi'];
  for (const col of criticalNums) {
    const raw = row[col];
    if (raw !== null && raw !== undefined && raw !== '') {
      const n = toNum(raw);
      if (n === null) {
        issues.push({
          severity: 'ERROR',
          code: 'INVALID_NUMBER',
          message: `Row ${rowNumber}: ${col} bukan angka valid: ${String(raw)}`,
          rawValue: String(raw),
          rowNumber,
        });
      }
    }
  }

  // WARNING: missing BOM (cannot compute dev/bom ratio)
  const qtyBom = toNum(row.qtyBom);
  const qtyDeviasi = toNum(row.qtyDeviasi);
  if (qtyBom === null || qtyBom === 0) {
    issues.push({
      severity: 'WARNING',
      code: 'MISSING_BOM',
      message: `Row ${rowNumber}: QTY BOM kosong/0 untuk ${namaBahan} @ ${resto}`,
      rowNumber, outletCode: resto, itemName: namaBahan, weekLabel,
    });
  }

  // WARNING: tolerance not set (sentinel text)
  const tolRaw = row.toleranceRaw;
  if (tolRaw !== null && tolRaw !== undefined && typeof tolRaw === 'string' &&
      tolRaw.toUpperCase().includes(CFG_RECON_SETTINGS.TOLERANCE_NOT_SET_TEXT.toUpperCase())) {
    issues.push({
      severity: 'INFO',
      code: 'TOLERANCE_NOT_SET',
      message: `Row ${rowNumber}: tolerance belum diset untuk ${namaBahan}`,
      rawValue: String(tolRaw),
      rowNumber, outletCode: resto, itemName: namaBahan, weekLabel,
    });
  }

  // ERROR: duplicate natural key
  const key = `${resto}|${namaBahan}|${weekLabel}|${akun}`;
  if (seenKeys.has(key)) {
    issues.push({
      severity: 'ERROR',
      code: 'DUPLICATE',
      message: `Row ${rowNumber}: duplikat key ${key}`,
      rawValue: key,
      rowNumber, outletCode: resto, itemName: namaBahan, weekLabel,
    });
  } else {
    seenKeys.add(key);
  }

  // WARNING: unexpected sign (BOM should be negative in this convention)
  if (qtyBom !== null && qtyBom > 0) {
    issues.push({
      severity: 'WARNING',
      code: 'BOM_POSITIVE',
      message: `Row ${rowNumber}: QTY BOM positif (${qtyBom}) — konvensi normalnya negatif (konsumsi)`,
      rawValue: String(qtyBom),
      rowNumber, outletCode: resto, itemName: namaBahan,
    });
  }

  // INFO: deviation direction
  if (qtyDeviasi !== null && qtyDeviasi === 0) {
    issues.push({
      severity: 'INFO',
      code: 'ZERO_DEVIATION',
      message: `Row ${rowNumber}: QTY DEVIASI = 0 (NEUTRAL)`,
      rowNumber, outletCode: resto, itemName: namaBahan,
    });
  }

  // WARNING: OVER_EXPLAINED — WASTE+SUSUT+TRIAL > |DEVIASI| (fraud indicator)
  // If the explained components exceed the total deviation, this is suspicious:
  // either fraud, wrong SPV input, or double-counting of waste.
  const qtyWaste = toNum(row.qtyWaste);
  const qtySusut = toNum(row.qtySusut);
  const qtyTrial = toNum(row.qtyTrial);
  if (qtyDeviasi !== null && qtyWaste !== null && qtySusut !== null && qtyTrial !== null) {
    const explainedAbs = Math.abs(qtyWaste + qtySusut + qtyTrial);
    const deviasiAbs = Math.abs(qtyDeviasi);
    if (deviasiAbs > 0 && explainedAbs > deviasiAbs) {
      const overPct = ((explainedAbs - deviasiAbs) / deviasiAbs) * 100;
      issues.push({
        severity: 'WARNING',
        code: 'OVER_EXPLAINED',
        message: `Row ${rowNumber}: WASTE+SUSUT+TRIAL (${explainedAbs.toFixed(0)}) > |DEVIASI| (${deviasiAbs.toFixed(0)}) — over-explained by ${overPct.toFixed(1)}%. Indikasi salah input atau fraud.`,
        rawValue: `explained=${explainedAbs}, deviasi=${deviasiAbs}`,
        rowNumber, outletCode: resto, itemName: namaBahan, weekLabel,
      });
    }
  }

  // Bug 1 fix: Validate Net Deviation formula
  // Master context #8: Gross Deviation - Waste - Susut - Trial = Net Deviation (QTY LOSS/SURPLUS)
  // If Excel's qtyLossSurplus ≠ computed net, flag as DQ issue
  const qtyLossSurplus = toNum(row.qtyLossSurplus);
  if (qtyDeviasi !== null && qtyLossSurplus !== null && qtyWaste !== null && qtySusut !== null && qtyTrial !== null) {
    const explainedMag = Math.abs((qtyWaste ?? 0) + (qtySusut ?? 0) + (qtyTrial ?? 0));
    const expectedNet = qtyDeviasi - explainedMag * Math.sign(qtyDeviasi);
    const tolerance = Math.max(1, Math.abs(expectedNet) * 0.01);
    if (Math.abs(qtyLossSurplus - expectedNet) > tolerance) {
      issues.push({
        severity: 'WARNING',
        code: 'NET_DEVIATION_MISMATCH',
        message: `Row ${rowNumber}: QTY LOSS/SURPLUS (${qtyLossSurplus}) ≠ Gross - |W+S+T| (${expectedNet.toFixed(1)}). Formula mismatch — periksa perhitungan Excel.`,
        rawValue: `excel=${qtyLossSurplus}, expected=${expectedNet.toFixed(1)}`,
        rowNumber, outletCode: resto, itemName: namaBahan, weekLabel,
      });
    }
  }

  // P1-9 fix: tag all issues with sheetName for multi-sheet audit
  if (sheetName) {
    for (const issue of issues) {
      issue.sheetName = sheetName;
    }
  }

  return issues;
}

export function summarizeDQ(issues: DQIssueRow[]): {
  summary: DQIssueSummary[];
  severityCounts: { ERROR: number; WARNING: number; INFO: number };
  status: 'OK' | 'WARNING' | 'ERROR';
} {
  const counts = { ERROR: 0, WARNING: 0, INFO: 0 };
  const byCode = new Map<string, { severity: DQIssueRow['severity']; code: string; message: string; count: number }>();
  for (const i of issues) {
    counts[i.severity]++;
    const k = i.code;
    const existing = byCode.get(k);
    if (existing) existing.count++;
    else byCode.set(k, { severity: i.severity, code: i.code, message: i.message, count: 1 });
  }
  const summary: DQIssueSummary[] = [...byCode.values()].map((v) => ({
    code: v.code,
    severity: v.severity as 'ERROR' | 'WARNING' | 'INFO',
    message: v.message.replace(/Row \d+:\s*/, ''),
    count: v.count,
  })).sort((a, b) => {
    const sevOrder = { ERROR: 0, WARNING: 1, INFO: 2 };
    return sevOrder[a.severity] - sevOrder[b.severity] || b.count - a.count;
  });
  const status: 'OK' | 'WARNING' | 'ERROR' =
    counts.ERROR > 0 ? 'ERROR' : counts.WARNING > 0 ? 'WARNING' : 'OK';
  return { summary, severityCounts: counts, status };
}
