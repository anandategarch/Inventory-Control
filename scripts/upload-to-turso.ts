#!/usr/bin/env bun
// ============================================================
//  upload-to-turso.ts — Upload Excel data directly to Turso
//  ----------------------------------------------------------
//  Usage:
//    DATABASE_URL=libsql://your-db.turso.io \
//    DATABASE_AUTH_TOKEN=your-token \
//    bun run scripts/upload-to-turso.ts
// ============================================================

import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { createClient } from '@libsql/client';
import ExcelJS from 'exceljs';
import { stringify } from 'csv-stringify/sync';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { parse } from 'csv-parse';
import { createReadStream } from 'fs';

// ============================================================
//  Config — from environment variables
// ============================================================
const DB_URL = process.env.DATABASE_URL;
const DB_TOKEN = process.env.DATABASE_AUTH_TOKEN;
const DATA_DIR = process.argv[2] || './data/inventory';

if (!DB_URL || !DB_TOKEN) {
  console.error('❌ Missing DATABASE_URL or DATABASE_AUTH_TOKEN');
  console.error('');
  console.error('Usage:');
  console.error('  DATABASE_URL=libsql://xxx.turso.io \\');
  console.error('  DATABASE_AUTH_TOKEN=eyJxxx \\');
  console.error('  bun run scripts/upload-to-turso.ts [data_dir]');
  console.error('');
  console.error('Or set them in .env file first.');
  process.exit(1);
}

console.log('═══════════════════════════════════════════════');
console.log('  Upload Data ke Turso');
console.log('═══════════════════════════════════════════════');
console.log(`  Database: ${DB_URL}`);
console.log(`  Data dir: ${DATA_DIR}`);
console.log('');

// ============================================================
//  Connect to Turso
// ============================================================
const libsql = createClient({ url: DB_URL, authToken: DB_TOKEN });
const adapter = new PrismaLibSql(libsql);
const db = new PrismaClient({ adapter, log: ['error'] });

// ============================================================
//  Header normalization (same as app)
// ============================================================
const HEADER_ALIASES: Record<string, string> = {
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

function normalizeHeader(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  return HEADER_ALIASES[cleaned] || HEADER_ALIASES[cleaned.replace(/\s*\/\s*/g, '/')] || cleaned;
}

// ============================================================
//  Number parser (handles Indonesian formats)
// ============================================================
function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isNaN(v) ? null : v;
  let s = String(v).trim();
  if (s === '') return null;
  s = s.replace(/Rp/i, '').replace(/IDR/i, '').trim();
  let isNegative = false;
  if (s.startsWith('(') && s.endsWith(')')) { isNegative = true; s = s.slice(1, -1).trim(); }
  let isPercent = false;
  if (s.endsWith('%')) { isPercent = true; s = s.slice(0, -1).trim(); }
  s = s.replace(/\s+/g, '');
  if (s.includes(',') && s.includes('.')) {
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma > lastDot) { s = s.replace(/\./g, '').replace(',', '.'); }
    else { s = s.replace(/,/g, ''); }
  } else if (s.includes(',')) {
    const lastComma = s.lastIndexOf(',');
    const afterComma = s.slice(lastComma + 1);
    if (afterComma.length === 3 && /^\d+$/.test(afterComma)) { s = s.replace(/,/g, ''); }
    else if (afterComma.length >= 1 && afterComma.length <= 2 && /^\d+$/.test(afterComma)) { s = s.replace(/,/g, '.'); }
    else { s = s.replace(/,/g, ''); }
  }
  const n = Number(s);
  if (isNaN(n)) return null;
  const result = isNegative ? -Math.abs(n) : n;
  return isPercent ? result / 100 : result;
}

// ============================================================
//  Parse tolerance
// ============================================================
function parseTolerance(raw: unknown): { value: number | null; rawStr: string | null } {
  if (raw === null || raw === undefined || raw === '') return { value: null, rawStr: null };
  if (typeof raw === 'number') return { value: raw, rawStr: String(raw) };
  const s = String(raw).trim();
  if (s.toUpperCase().includes('BELUM ADA TOLERANSI')) return { value: null, rawStr: s };
  const n = Number(s.replace(/,/g, '.'));
  return { value: isNaN(n) ? null : n, rawStr: s };
}

// ============================================================
//  Parse outlet code
// ============================================================
function parseOutletCode(raw: string) {
  const code = (raw ?? '').trim().toUpperCase();
  if (!code) return null;
  let m = code.match(/^(\d{4})\.([A-Z]+)/);
  if (m) return { fullCode: code, numericCode: m[1], name: m[2] };
  m = code.match(/^B\.(\d{4})\.([A-Z]+)/);
  if (m) return { fullCode: code, numericCode: m[1], name: m[2] };
  const parts = code.split('.');
  return { fullCode: code, numericCode: parts[0] || code, name: parts[parts.length - 1] || code };
}

// ============================================================
//  Month parser
// ============================================================
const MONTH_MAP: Record<string, { name: string; num: string }> = {
  januari: { name: 'Januari', num: '01' }, februari: { name: 'Februari', num: '02' },
  maret: { name: 'Maret', num: '03' }, april: { name: 'April', num: '04' },
  mei: { name: 'Mei', num: '05' }, juni: { name: 'Juni', num: '06' },
  juli: { name: 'Juli', num: '07' }, agustus: { name: 'Agustus', num: '08' },
  september: { name: 'September', num: '09' }, oktober: { name: 'Oktober', num: '10' },
  november: { name: 'November', num: '11' }, desember: { name: 'Desember', num: '12' },
};

function parseMonthFromFilename(fileName: string) {
  let base = fileName.replace(/\.(xlsx|csv)$/i, '').trim();
  base = base.replace(/\s*-\s*Google\s+(Sheets|試算表|Spreadsheet|Drive).*$/i, '').trim();
  base = base.replace(/\.xlsx$/i, '').trim();
  let m = base.match(/^(?:(\d+)\.\s*)?([A-Za-z]+)\s+(\d{2,4})$/);
  if (m) {
    const found = MONTH_MAP[m[2].toLowerCase()];
    if (found) {
      let year = m[3]; if (year.length === 2) year = `20${year}`;
      return { monthLabel: `${found.name} ${year}`, monthKey: `${year}-${found.num}` };
    }
  }
  m = base.match(/(?:(\d+)\.\s*)?([A-Za-z]{3,9})\s+(\d{2,4})/);
  if (m) {
    const found = MONTH_MAP[m[2].toLowerCase()];
    if (found) {
      let year = m[3]; if (year.length === 2) year = `20${year}`;
      return { monthLabel: `${found.name} ${year}`, monthKey: `${year}-${found.num}` };
    }
  }
  return null;
}

// ============================================================
//  Cell value extractor
// ============================================================
function cellToValue(cell: ExcelJS.Cell): unknown {
  let v: unknown = cell.value;
  if (v && typeof v === 'object') {
    if ('richText' in v && Array.isArray(v.richText)) v = v.richText.map((t) => t.text).join('');
    else if ('text' in v && typeof v.text === 'string') v = v.text;
    else if ('result' in v && v.result !== undefined) v = v.result;
    else if ('formula' in v) v = cell.result ?? null;
    else v = JSON.stringify(v);
  }
  return v;
}

// ============================================================
//  Hash file
// ============================================================
async function hashFile(filePath: string): Promise<string> {
  const crypto = await import('crypto');
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ============================================================
//  Convert Excel to CSV (in-process)
// ============================================================
async function convertExcelToCsv(excelPath: string, csvPath: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(excelPath);
  const ws = wb.worksheets.find((s) => s.state === 'visible') || wb.worksheets[0];
  if (!ws) throw new Error('No worksheets found');

  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  for (let c = 1; c <= ws.columnCount; c++) {
    headers.push(String(cellToValue(headerRow.getCell(c)) ?? '').trim());
  }
  fs.writeFileSync(csvPath, stringify([headers]));

  const CHUNK = 2000;
  let chunk: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return;
    const values: string[] = [];
    for (let c = 1; c <= ws.columnCount; c++) {
      const v = cellToValue(row.getCell(c));
      values.push(v === null || v === undefined ? '' : String(v));
    }
    chunk.push(values);
    if (chunk.length >= CHUNK) { fs.appendFileSync(csvPath, stringify(chunk)); chunk = []; }
  });
  if (chunk.length > 0) fs.appendFileSync(csvPath, stringify(chunk));
}

// ============================================================
//  Parse CSV stream
// ============================================================
async function* parseCsvStream(csvPath: string) {
  const parser = parse({
    columns: (headers: string[]) => headers.map((h: string) => {
      const cleaned = h.toLowerCase().replace(/\s+/g, ' ').trim();
      return HEADER_ALIASES[cleaned] || HEADER_ALIASES[cleaned.replace(/\s*\/\s*/g, '/')] || cleaned;
    }),
    skip_empty_lines: true, trim: true, bom: true,
    relax_quotes: true, relax_column_count: true,
  });
  const stream = createReadStream(csvPath, 'utf-8');
  stream.pipe(parser);
  for await (const row of parser) yield row;
}

// ============================================================
//  Normalize + derive record
// ============================================================
function normalizeRow(row: Record<string, unknown>, fileName: string, rowNumber: number, monthLabel: string) {
  const tol = parseTolerance(row.toleranceRaw);
  return {
    akunPenyesuaian: row.akunPenyesuaian ? String(row.akunPenyesuaian).trim() : null,
    status: row.status ? String(row.status).trim() : null,
    resto: String(row.resto ?? '').trim(),
    namaBahan: String(row.namaBahan ?? '').trim(),
    satuan: row.satuan ? String(row.satuan).trim() : null,
    qtyBom: toNum(row.qtyBom), qtyCom: toNum(row.qtyCom), qtyDeviasi: toNum(row.qtyDeviasi),
    qtyWaste: toNum(row.qtyWaste), qtySusut: toNum(row.qtySusut), qtyTrial: toNum(row.qtyTrial),
    qtyLossSurplus: toNum(row.qtyLossSurplus),
    nominalDeviasi: toNum(row.nominalDeviasi), nominalWaste: toNum(row.nominalWaste),
    nominalSusut: toNum(row.nominalSusut), nominalTrial: toNum(row.nominalTrial),
    nominalLossSurplus: toNum(row.nominalLossSurplus), nominalSales: toNum(row.nominalSales),
    qtyWasteSusut: toNum(row.qtyWasteSusut), pctWasteSusut: toNum(row.pctWasteSusut),
    tolerancePct: tol.value, toleranceRaw: tol.rawStr,
    pctQtyDeviasiToBom: toNum(row.pctQtyDeviasiToBom), pctQtyWasteToBom: toNum(row.pctQtyWasteToBom),
    pctQtySusutToBom: toNum(row.pctQtySusutToBom), pctQtyTrialToBom: toNum(row.pctQtyTrialToBom),
    pctQtyLossToBom: toNum(row.pctQtyLossToBom),
    area: String(row.area ?? '').trim(), bulan: String(row.bulan ?? '').trim(),
    bulan2: row.bulan2 ? String(row.bulan2).trim() : null,
    weekLabel: String(row.weekLabel ?? '').trim().toUpperCase(),
    monthLabel, sourceFile: fileName, rowNumber,
  };
}

function deriveRecord(n: any) {
  const qtyDeviasi = n.qtyDeviasi;
  const direction = qtyDeviasi === null ? 'NEUTRAL' : qtyDeviasi > 0 ? 'LOSS' : qtyDeviasi < 0 ? 'SURPLUS' : 'NEUTRAL';
  const w = n.qtyWaste ?? 0, s = n.qtySusut ?? 0, t = n.qtyTrial ?? 0;
  const explained = Math.abs(w + s + t);
  const absDev = Math.abs(qtyDeviasi ?? 0);
  const absResidual = absDev - explained;
  const sign = (qtyDeviasi ?? 0) >= 0 ? 1 : -1;
  const residualQty = sign * absResidual;
  const residualRatio = absDev > 0 ? absResidual / absDev : null;
  const parsed = parseOutletCode(n.resto);
  return {
    direction, residualQty, residualRatio,
    residualNominal: sign * (Math.abs(n.nominalDeviasi ?? 0) - Math.abs((n.nominalWaste ?? 0) + (n.nominalSusut ?? 0) + (n.nominalTrial ?? 0))),
    absQtyDeviasi: qtyDeviasi !== null ? Math.abs(qtyDeviasi) : null,
    absNominalDeviasi: n.nominalDeviasi !== null ? Math.abs(n.nominalDeviasi) : null,
    absQtyLossSurplus: n.qtyLossSurplus !== null ? Math.abs(n.qtyLossSurplus) : null,
    absNominalLossSurplus: n.nominalLossSurplus !== null ? Math.abs(n.nominalLossSurplus) : null,
    outletCode: parsed?.fullCode ?? n.resto, outletName: parsed?.name ?? n.resto,
    outletNumericCode: parsed?.numericCode ?? '',
  };
}

// ============================================================
//  Create tables (same as /api/setup)
// ============================================================
async function createTables() {
  console.log('Creating tables if not exist...');
  const tables = [
    `CREATE TABLE IF NOT EXISTS "SourceFile" (id INTEGER PRIMARY KEY AUTOINCREMENT, "fileName" TEXT NOT NULL UNIQUE, "filePath" TEXT NOT NULL, "monthLabel" TEXT NOT NULL, "monthKey" TEXT NOT NULL, "fileHash" TEXT NOT NULL UNIQUE, "rowCount" INTEGER NOT NULL DEFAULT 0, "dqStatus" TEXT NOT NULL DEFAULT 'OK', "dqErrorCount" INTEGER NOT NULL DEFAULT 0, "dqWarningCount" INTEGER NOT NULL DEFAULT 0, "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);`,
    `CREATE TABLE IF NOT EXISTS "Week" (id INTEGER PRIMARY KEY AUTOINCREMENT, "sourceFileId" INTEGER NOT NULL, "weekLabel" TEXT NOT NULL, "weekKey" TEXT NOT NULL, "monthKey" TEXT NOT NULL, "periodStart" INTEGER NOT NULL, "periodEnd" INTEGER NOT NULL, UNIQUE("sourceFileId", "weekLabel"));`,
    `CREATE TABLE IF NOT EXISTS "Outlet" (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, "outletCode" TEXT NOT NULL, area TEXT NOT NULL);`,
    `CREATE TABLE IF NOT EXISTS "Item" (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, satuan TEXT, category TEXT);`,
    `CREATE TABLE IF NOT EXISTS "InventoryRecord" (id INTEGER PRIMARY KEY AUTOINCREMENT, "sourceFileId" INTEGER NOT NULL, "weekId" INTEGER NOT NULL, "outletId" INTEGER NOT NULL, "itemId" INTEGER NOT NULL, "akunPenyesuaian" TEXT, status TEXT, satuan TEXT, "qtyBom" REAL, "qtyCom" REAL, "qtyDeviasi" REAL, "qtyWaste" REAL, "qtySusut" REAL, "qtyTrial" REAL, "qtyLossSurplus" REAL, "nominalDeviasi" REAL, "nominalWaste" REAL, "nominalSusut" REAL, "nominalTrial" REAL, "nominalLossSurplus" REAL, "nominalSales" REAL, "avgPrice" REAL, "tolerancePct" REAL, "toleranceRaw" TEXT, "pctWasteSusut" REAL, "pctQtyDeviasiToBom" REAL, "pctQtyWasteToBom" REAL, "pctQtySusutToBom" REAL, "pctQtyTrialToBom" REAL, "pctQtyLossToBom" REAL, direction TEXT, "residualQty" REAL, "residualNominal" REAL, "residualRatio" REAL, "absQtyDeviasi" REAL, "absNominalDeviasi" REAL, "absQtyLossSurplus" REAL, "absNominalLossSurplus" REAL, area TEXT NOT NULL, bulan TEXT NOT NULL, "bulan2" TEXT, "weekLabel" TEXT NOT NULL, "monthLabel" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE("weekId", "outletId", "itemId", "akunPenyesuaian"));`,
    `CREATE TABLE IF NOT EXISTS "Setting" (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, value TEXT NOT NULL, category TEXT NOT NULL, label TEXT NOT NULL, description TEXT, "dataType" TEXT NOT NULL, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedBy" TEXT);`,
    `CREATE TABLE IF NOT EXISTS "AuditLog" (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, detail TEXT NOT NULL, duration INTEGER, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);`,
    `CREATE TABLE IF NOT EXISTS "DQIssue" (id INTEGER PRIMARY KEY AUTOINCREMENT, "sourceFileId" INTEGER NOT NULL, "weekId" INTEGER, "outletId" INTEGER, "itemId" INTEGER, severity TEXT NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL, "rawValue" TEXT, "rowNumber" INTEGER, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);`,
    `CREATE TABLE IF NOT EXISTS "AggregationCache" (id INTEGER PRIMARY KEY AUTOINCREMENT, "cacheKey" TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, "computedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);`,
  ];
  for (const sql of tables) {
    await db.$executeRawUnsafe(sql);
  }
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "idx_inv_outlet_week" ON "InventoryRecord"("outletId", "weekId");`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "idx_inv_item_week" ON "InventoryRecord"("itemId", "weekId");`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "idx_inv_area_week" ON "InventoryRecord"("area", "weekId");`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "idx_inv_month_week" ON "InventoryRecord"("monthLabel", "weekLabel");`);
  console.log('✅ Tables ready');
}

// ============================================================
//  Ingest single file
// ============================================================
async function ingestFile(filePath: string) {
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  console.log(`\n📄 Processing: ${fileName}`);

  const fileHash = await hashFile(filePath);

  // Check if already ingested
  const existing = await db.sourceFile.findUnique({ where: { fileHash }, select: { id: true, rowCount: true } });
  if (existing) {
    const count = await db.inventoryRecord.count({ where: { sourceFileId: existing.id } });
    if (count > 0) {
      console.log(`  ⏭️  Already ingested (${count} rows). Skipping.`);
      return;
    }
    await db.dQIssue.deleteMany({ where: { sourceFileId: existing.id } });
    await db.inventoryRecord.deleteMany({ where: { sourceFileId: existing.id } });
    await db.week.deleteMany({ where: { sourceFileId: existing.id } });
    await db.sourceFile.delete({ where: { id: existing.id } });
  }

  // Convert Excel to CSV if needed
  let csvPath = filePath;
  if (ext === '.xlsx') {
    csvPath = filePath.replace(/\.xlsx$/i, '.csv');
    if (!fs.existsSync(csvPath) || fs.statSync(csvPath).size === 0) {
      console.log('  📊 Converting Excel to CSV...');
      await convertExcelToCsv(filePath, csvPath);
      console.log('  ✅ CSV created');
    }
  }

  // Parse month
  const monthInfo = parseMonthFromFilename(fileName);
  const monthLabel = monthInfo?.monthLabel || fileName.replace(/\.(xlsx|csv)$/i, '');
  const monthKey = monthInfo?.monthKey || 'unknown';

  // Create SourceFile
  const sourceFile = await db.sourceFile.create({
    data: { fileName, filePath, monthLabel, monthKey, fileHash, rowCount: 0, dqStatus: 'OK' },
  });

  const weekDbMap = new Map<string, number>();
  const outletDbMap = new Map<string, number>();
  const itemDbMap = new Map<string, number>();
  const dedupSet = new Set<string>();
  const BATCH = 500;
  let batch: any[] = [];
  let total = 0;

  for await (const rawRow of parseCsvStream(csvPath)) {
    const n = normalizeRow(rawRow, fileName, total + 2, monthLabel);
    const d = deriveRecord(n);
    const wk = n.weekLabel || 'UNKNOWN';

    if (!weekDbMap.has(wk)) {
      const periods: Record<string, { start: number; end: number }> = {
        'WEEK 1': { start: 1, end: 7 }, 'WEEK 2': { start: 8, end: 14 }, 'WEEK 3': { start: 15, end: 31 },
      };
      const p = periods[wk] || { start: 1, end: 31 };
      const w = await db.week.upsert({
        where: { sourceFileId_weekLabel: { sourceFileId: sourceFile.id, weekLabel: wk } },
        update: {},
        create: { sourceFileId: sourceFile.id, weekLabel: wk, weekKey: `${monthKey}-${wk.replace(/\s+/g, '')}`, monthKey, periodStart: p.start, periodEnd: p.end },
      });
      weekDbMap.set(wk, w.id);
    }

    if (d.outletCode && !outletDbMap.has(d.outletCode)) {
      const ex = await db.outlet.findUnique({ where: { code: d.outletCode }, select: { id: true } });
      if (ex) outletDbMap.set(d.outletCode, ex.id);
      else { const c = await db.outlet.create({ data: { code: d.outletCode, name: d.outletName, outletCode: d.outletNumericCode, area: n.area } }); outletDbMap.set(d.outletCode, c.id); }
    }

    if (n.namaBahan && !itemDbMap.has(n.namaBahan)) {
      const ex = await db.item.findUnique({ where: { name: n.namaBahan }, select: { id: true, satuan: true } });
      if (ex) { itemDbMap.set(n.namaBahan, ex.id); if (!ex.satuan && n.satuan) await db.item.update({ where: { id: ex.id }, data: { satuan: n.satuan } }); }
      else { const c = await db.item.create({ data: { name: n.namaBahan, satuan: n.satuan } }); itemDbMap.set(n.namaBahan, c.id); }
    }

    const weekId = weekDbMap.get(wk) ?? 0;
    const outletId = outletDbMap.get(d.outletCode) ?? 0;
    const itemId = itemDbMap.get(n.namaBahan) ?? 0;

    if (weekId > 0 && outletId > 0 && itemId > 0) {
      const dedupKey = `${weekId}|${outletId}|${itemId}|${n.akunPenyesuaian || ''}`;
      if (dedupSet.has(dedupKey)) continue;
      dedupSet.add(dedupKey);

      batch.push({
        sourceFileId: sourceFile.id, weekId, outletId, itemId,
        akunPenyesuaian: n.akunPenyesuaian, status: n.status, satuan: n.satuan,
        qtyBom: n.qtyBom, qtyCom: n.qtyCom, qtyDeviasi: n.qtyDeviasi,
        qtyWaste: n.qtyWaste, qtySusut: n.qtySusut, qtyTrial: n.qtyTrial, qtyLossSurplus: n.qtyLossSurplus,
        nominalDeviasi: n.nominalDeviasi, nominalWaste: n.nominalWaste, nominalSusut: n.nominalSusut,
        nominalTrial: n.nominalTrial, nominalLossSurplus: n.nominalLossSurplus, nominalSales: n.nominalSales,
        avgPrice: n.qtyDeviasi && n.nominalDeviasi && n.qtyDeviasi !== 0 ? Math.abs(n.nominalDeviasi / n.qtyDeviasi) : null,
        tolerancePct: n.tolerancePct, toleranceRaw: n.toleranceRaw,
        pctWasteSusut: n.pctWasteSusut, pctQtyDeviasiToBom: n.pctQtyDeviasiToBom,
        pctQtyWasteToBom: n.pctQtyWasteToBom, pctQtySusutToBom: n.pctQtySusutToBom,
        pctQtyTrialToBom: n.pctQtyTrialToBom, pctQtyLossToBom: n.pctQtyLossToBom,
        direction: d.direction, residualQty: d.residualQty, residualNominal: d.residualNominal,
        residualRatio: d.residualRatio, absQtyDeviasi: d.absQtyDeviasi,
        absNominalDeviasi: d.absNominalDeviasi, absQtyLossSurplus: d.absQtyLossSurplus,
        absNominalLossSurplus: d.absNominalLossSurplus,
        area: n.area, bulan: n.bulan, bulan2: n.bulan2, weekLabel: n.weekLabel, monthLabel: n.monthLabel,
      });
    }

    if (batch.length >= BATCH) {
      await db.inventoryRecord.createMany({ data: batch });
      total += batch.length;
      batch = [];
      process.stdout.write(`\r  📦 Inserted: ${total.toLocaleString()} rows`);
    }
  }

  if (batch.length > 0) {
    await db.inventoryRecord.createMany({ data: batch });
    total += batch.length;
  }

  await db.sourceFile.update({ where: { id: sourceFile.id }, data: { rowCount: total } });
  console.log(`\n  ✅ Done: ${total.toLocaleString()} rows`);
}

// ============================================================
//  Main
// ============================================================
async function main() {
  try {
    // Create tables
    await createTables();

    // Find all Excel/CSV files
    const files = fs.readdirSync(DATA_DIR)
      .filter(f => (f.toLowerCase().endsWith('.xlsx') || f.toLowerCase().endsWith('.csv')) && !f.startsWith('~$'))
      .map(f => path.join(DATA_DIR, f))
      .sort();

    if (files.length === 0) {
      console.log(`\n❌ No Excel/CSV files found in ${DATA_DIR}`);
      console.log('Put your Excel files in that folder and try again.');
      process.exit(1);
    }

    console.log(`\nFound ${files.length} files to process:`);
    files.forEach((f, i) => console.log(`  ${i + 1}. ${path.basename(f)}`));

    // Process each file
    for (const file of files) {
      await ingestFile(file);
    }

    // Summary
    const totalRecords = await db.inventoryRecord.count();
    const totalOutlets = await db.outlet.count();
    const totalItems = await db.item.count();
    const totalFiles = await db.sourceFile.count();

    console.log('\n═══════════════════════════════════════════════');
    console.log('  ✅ UPLOAD COMPLETE!');
    console.log('═══════════════════════════════════════════════');
    console.log(`  Files:    ${totalFiles}`);
    console.log(`  Records:  ${totalRecords.toLocaleString()}`);
    console.log(`  Outlets:  ${totalOutlets}`);
    console.log(`  Items:    ${totalItems}`);
    console.log('═══════════════════════════════════════════════');
    console.log('\nData is now in Turso. Your Vercel dashboard can read it.');
  } catch (e: any) {
    console.error('\n❌ Error:', e?.message || String(e));
    if (e?.stack) console.error(e.stack);
    process.exit(1);
  } finally {
    await db.$disconnect();
  }
}

main();
