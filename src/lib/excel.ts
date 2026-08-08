// ============================================================
//  Excel parser — multi-sheet aware (Mode A: flat sheet with WEEK column)
//  Reads .xlsx via exceljs, normalizes headers, returns raw rows.
// ============================================================
import ExcelJS from 'exceljs';
import path from 'path';
import { createHash } from 'crypto';

// Header normalization map: raw → canonical
export const HEADER_ALIASES: Record<string, string> = {
  'akun penyesuaian persediaan': 'akunPenyesuaian',
  'status': 'status',
  'resto': 'resto',
  'nama bahan': 'namaBahan',
  'satuan': 'satuan',
  'qty bom': 'qtyBom',
  'qty com': 'qtyCom',
  'qty deviasi': 'qtyDeviasi',
  'qty waste': 'qtyWaste',
  'qty susut': 'qtySusut',
  'qty trial': 'qtyTrial',
  'qty loss surplus': 'qtyLossSurplus',
  'nominal deviasi': 'nominalDeviasi',
  'nominal waste': 'nominalWaste',
  'nominal susut': 'nominalSusut',
  'nominal trial': 'nominalTrial',
  'nominal loss/surplus': 'nominalLossSurplus',
  'qty waste + susut': 'qtyWasteSusut',
  '% waste + susut': 'pctWasteSusut',
  '%toleransi': 'toleranceRaw',
  '% qty deviasi to bom': 'pctQtyDeviasiToBom',
  'qty waste to bom': 'pctQtyWasteToBom',
  'qty susut to bom': 'pctQtySusutToBom',
  'qty trial to bom': 'pctQtyTrialToBom',
  'qty loss/ surplus to bom': 'pctQtyLossToBom',
  'area': 'area',
  'bulan': 'bulan',
  'penjualan': 'nominalSales',
  'status bulan': 'weekLabel',
  'bulan 2': 'bulan2',
};

export interface ParsedSheet {
  sheetName: string;
  headers: { raw: string; canonical: string; index: number }[];
  rows: Record<string, unknown>[];
}

export interface ParsedWorkbook {
  fileName: string;
  filePath: string;
  fileHash: string;
  sheets: ParsedSheet[];
}

export async function hashFile(filePath: string): Promise<string> {
  const fs = await import('fs/promises');
  const buf = await fs.readFile(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

export function normalizeHeader(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  return HEADER_ALIASES[cleaned] || HEADER_ALIASES[cleaned.replace(/\s*\/\s*/g, '/')] || cleaned;
}

function cellToValue(cell: ExcelJS.Cell): unknown {
  let v: unknown = cell.value;
  if (v && typeof v === 'object') {
    if ('richText' in v && Array.isArray(v.richText)) {
      v = v.richText.map((t) => t.text).join('');
    } else if ('text' in v && typeof v.text === 'string') {
      v = v.text;
    } else if ('result' in v && v.result !== undefined) {
      v = v.result;
    } else if ('formula' in v) {
      v = cell.result ?? null;
    } else {
      v = JSON.stringify(v);
    }
  }
  return v;
}

export async function parseExcelFile(filePath: string): Promise<ParsedWorkbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const fileHash = await hashFile(filePath);
  const fileName = path.basename(filePath);
  const sheets: ParsedSheet[] = [];

  for (const ws of wb.worksheets) {
    if (ws.state !== 'visible') continue;
    const headerRow = ws.getRow(1);
    const headers: { raw: string; canonical: string; index: number }[] = [];
    for (let c = 1; c <= ws.columnCount; c++) {
      const cell = headerRow.getCell(c);
      const raw = String(cellToValue(cell) ?? '').trim();
      if (!raw) continue;
      headers.push({ raw, canonical: normalizeHeader(raw), index: c });
    }
    if (headers.length === 0) continue;

    const rows: Record<string, unknown>[] = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const obj: Record<string, unknown> = {};
      let hasValue = false;
      for (const h of headers) {
        const v = cellToValue(row.getCell(h.index));
        obj[h.canonical] = v;
        if (v !== null && v !== undefined && v !== '') hasValue = true;
      }
      if (hasValue) rows.push(obj);
    }
    sheets.push({ sheetName: ws.name, headers, rows });
  }

  return { fileName, filePath, fileHash, sheets };
}

// ============================================================
//  Parse month label from filename.
//  Supports patterns:
//    "Januari 2026.xlsx"        → monthLabel="Januari 2026", monthKey="2026-01"
//    "JULI 2026.xlsx"           → monthLabel="Juli 2026",    monthKey="2026-07"
//    "13.JANUARI 2026.xlsx"     → monthLabel="Januari 2026", monthKey="2026-01", prefix="13"
//    "14. FEBRUARI 2026.xlsx"   → monthLabel="Februari 2026",monthKey="2026-02", prefix="14"
//    "191.JULI 26.xlsx"         → monthLabel="Juli 2026",    monthKey="2026-07", prefix="191" (2-digit year)
// ============================================================
const MONTH_MAP: Record<string, { name: string; num: string }> = {
  januari: { name: 'Januari', num: '01' },
  februari: { name: 'Februari', num: '02' },
  pebruari: { name: 'Februari', num: '02' }, // common typo variant
  maret: { name: 'Maret', num: '03' },
  april: { name: 'April', num: '04' },
  mei: { name: 'Mei', num: '05' },
  juni: { name: 'Juni', num: '06' },
  juli: { name: 'Juli', num: '07' },
  agustus: { name: 'Agustus', num: '08' },
  september: { name: 'September', num: '09' },
  okteber: { name: 'Oktober', num: '10' },
  oktober: { name: 'Oktober', num: '10' },
  nopember: { name: 'November', num: '11' },
  november: { name: 'November', num: '11' },
  desember: { name: 'Desember', num: '12' },
};

export interface ParsedMonth {
  monthLabel: string;
  monthKey: string;
  prefix?: string; // file sequence code like "13", "14", "191" (kept for traceability)
}

export function parseMonthFromFilename(fileName: string): ParsedMonth | null {
  const base = fileName.replace(/\.xlsx$/i, '').trim();
  // Match optional prefix (digits + dot + optional space), then month name, then year (4 or 2 digits)
  const m = base.match(/^(?:(\d+)\.\s*)?([A-Za-z]+)\s+(\d{2,4})$/);
  if (!m) return null;
  const prefix = m[1];
  const monthLower = m[2].toLowerCase();
  const found = MONTH_MAP[monthLower];
  if (!found) return null;

  // Normalize year to 4 digits
  let year = m[3];
  if (year.length === 2) year = `20${year}`;

  return {
    monthLabel: `${found.name} ${year}`,
    monthKey: `${year}-${found.num}`,
    prefix: prefix || undefined,
  };
}
