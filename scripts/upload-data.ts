#!/usr/bin/env bun
// ============================================================
//  upload-data.ts — Upload Excel data to local SQLite / Turso
//  Usage: bun run scripts/upload-data.ts <data-dir> [monthLabel]
// ============================================================
import { createClient, type InValue } from '@libsql/client';
import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';

const DB_URL = process.env.DATABASE_URL || 'file:./db/custom.db';
const DB_TOKEN = process.env.DATABASE_AUTH_TOKEN;
const DATA_DIR = process.argv[2] || './upload';
const FORCE_MONTH = process.argv[3] || null; // override monthLabel

const client = createClient({ url: DB_URL, authToken: DB_TOKEN || undefined });

console.log('═══════════════════════════════════════════════');
console.log('  Upload Data ke Database');
console.log('═══════════════════════════════════════════════');
console.log(`  Database: ${DB_URL}`);
console.log(`  Data dir: ${DATA_DIR}`);
console.log('');

// ============================================================
//  Table creation (matches /api/setup route)
// ============================================================
const CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS "SourceFile" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    "fileName" TEXT NOT NULL UNIQUE,
    "filePath" TEXT NOT NULL,
    "monthLabel" TEXT NOT NULL,
    "monthKey" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL UNIQUE,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "dqStatus" TEXT NOT NULL DEFAULT 'OK',
    "dqErrorCount" INTEGER NOT NULL DEFAULT 0,
    "dqWarningCount" INTEGER NOT NULL DEFAULT 0,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS "Week" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    "sourceFileId" INTEGER NOT NULL,
    "weekLabel" TEXT NOT NULL,
    "weekKey" TEXT NOT NULL,
    "monthKey" TEXT NOT NULL,
    "periodStart" INTEGER NOT NULL,
    "periodEnd" INTEGER NOT NULL,
    UNIQUE("sourceFileId", "weekLabel")
  )`,
  `CREATE TABLE IF NOT EXISTS "Outlet" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    "outletCode" TEXT NOT NULL,
    area TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "Item" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    satuan TEXT,
    category TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS "InventoryRecord" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    "sourceFileId" INTEGER NOT NULL,
    "weekId" INTEGER NOT NULL,
    "outletId" INTEGER NOT NULL,
    "itemId" INTEGER NOT NULL,
    "akunPenyesuaian" TEXT,
    status TEXT,
    satuan TEXT,
    "qtyBom" REAL,
    "qtyCom" REAL,
    "qtyDeviasi" REAL,
    "qtyWaste" REAL,
    "qtySusut" REAL,
    "qtyTrial" REAL,
    "qtyLossSurplus" REAL,
    "nominalDeviasi" REAL,
    "nominalWaste" REAL,
    "nominalSusut" REAL,
    "nominalTrial" REAL,
    "nominalLossSurplus" REAL,
    "nominalSales" REAL,
    "avgPrice" REAL,
    "tolerancePct" REAL,
    "toleranceRaw" TEXT,
    "pctWasteSusut" REAL,
    "pctQtyDeviasiToBom" REAL,
    "pctQtyWasteToBom" REAL,
    "pctQtySusutToBom" REAL,
    "pctQtyTrialToBom" REAL,
    "pctQtyLossToBom" REAL,
    direction TEXT,
    "residualQty" REAL,
    "residualNominal" REAL,
    "residualRatio" REAL,
    "absQtyDeviasi" REAL,
    "absNominalDeviasi" REAL,
    "absQtyLossSurplus" REAL,
    "absNominalLossSurplus" REAL,
    area TEXT NOT NULL,
    bulan TEXT NOT NULL,
    "bulan2" TEXT,
    "weekLabel" TEXT NOT NULL,
    "monthLabel" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE("weekId", "outletId", "itemId", "akunPenyesuaian")
  )`,
  `CREATE TABLE IF NOT EXISTS "OutletPIC" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    "outletCode" TEXT NOT NULL UNIQUE,
    pic TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS "idx_inv_outlet_week" ON "InventoryRecord"("outletId", "weekId")`,
  `CREATE INDEX IF NOT EXISTS "idx_inv_item_week" ON "InventoryRecord"("itemId", "weekId")`,
  `CREATE INDEX IF NOT EXISTS "idx_inv_area_week" ON "InventoryRecord"("area", "weekId")`,
  `CREATE INDEX IF NOT EXISTS "idx_inv_month_week" ON "InventoryRecord"("monthLabel", "weekLabel")`,
];

async function createTables() {
  console.log('Creating tables...');
  for (const sql of CREATE_TABLES) {
    await client.execute(sql);
  }
  console.log('✅ Tables ready\n');
}

// ============================================================
//  Helpers
// ============================================================
const MONTH_MAP: Record<string, string> = {
  'JANUARI': '01', 'FEBRUARI': '02', 'MARET': '03', 'APRIL': '04',
  'MEI': '05', 'JUNI': '06', 'JULI': '07', 'AGUSTUS': '08',
  'SEPTEMBER': '09', 'OKTOBER': '10', 'NOVEMBER': '11', 'DESEMBER': '12',
};

function parseMonthFromFile(fileName: string): { monthLabel: string; monthKey: string } {
  // "17.MEI 2026.xlsx" → monthLabel="MEI 2026", monthKey="2026-05"
  const base = fileName.replace(/\.(xlsx|csv)$/i, '').trim();
  // Match patterns like "MEI 2026", "JULI 2026", etc.
  const m = base.match(/(JANUARI|FEBRUARI|MARET|APRIL|MEI|JUNI|JULI|AGUSTUS|SEPTEMBER|OKTOBER|NOVEMBER|DESEMBER)\s*(\d{4})/i);
  if (m) {
    const monthName = m[1].toUpperCase();
    const year = m[2];
    const monthNum = MONTH_MAP[monthName];
    return { monthLabel: `${monthName} ${year}`, monthKey: `${year}-${monthNum}` };
  }
  // Fallback: use filename as label
  return { monthLabel: base, monthKey: '2026-01' };
}

function parseTolerance(raw: unknown): { pct: number | null; raw: string } {
  if (raw == null) return { pct: null, raw: '' };
  const s = String(raw).trim();
  if (!s || s.toUpperCase().includes('BELUM')) return { pct: null, raw: s };
  // Parse "5%" or "5" or "0.05"
  const num = parseFloat(s.replace('%', '').replace(',', '.'));
  if (isNaN(num)) return { pct: null, raw: s };
  // If value > 1, treat as percentage (5 → 0.05). If < 1, treat as ratio (0.05 → 0.05)
  const pct = num > 1 ? num / 100 : num;
  return { pct, raw: s };
}

function toNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return isNaN(v) ? null : v;
  const s = String(v).trim();
  if (!s) return null;
  // Handle formula objects from ExcelJS
  if (typeof v === 'object' && v !== null && 'result' in v) {
    const r = (v as { result: unknown }).result;
    return typeof r === 'number' ? r : null;
  }
  const n = parseFloat(s.replace(/[^\d.-]/g, ''));
  return isNaN(n) ? null : n;
}

function weekPeriod(weekLabel: string): { start: number; end: number } {
  if (weekLabel.includes('1')) return { start: 1, end: 7 };
  if (weekLabel.includes('2')) return { start: 8, end: 14 };
  if (weekLabel.includes('3')) return { start: 15, end: 31 };
  return { start: 1, end: 31 };
}

// ============================================================
//  Main upload
// ============================================================
async function uploadFile(filePath: string) {
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  console.log(`📄 ${fileName}`);

  if (ext !== '.xlsx') {
    console.log(`  ⚠️  Skip non-xlsx file`);
    return;
  }

  const monthInfo = FORCE_MONTH
    ? { monthLabel: FORCE_MONTH, monthKey: `${new Date().getFullYear()}-${MONTH_MAP[FORCE_MONTH.split(' ')[0]] || '01'}` }
    : parseMonthFromFile(fileName);
  console.log(`  📅 Month: ${monthInfo.monthLabel} (${monthInfo.monthKey})`);

  // Read Excel
  console.log(`  📖 Reading Excel...`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.getWorksheet(1);
  if (!ws) {
    console.log(`  ❌ No worksheet found`);
    return;
  }

  // Get headers
  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell((cell, col) => {
    headers[col - 1] = String(cell.value || '').trim().toUpperCase();
  });

  // Find column indices
  const colIdx: Record<string, number> = {};
  const HEADER_ALIASES: Record<string, string[]> = {
    akunPenyesuaian: ['AKUN PENYESUAIAN PERSEDIAAN'],
    status: ['STATUS'],
    resto: ['RESTO'],
    namaBahan: ['NAMA BAHAN'],
    satuan: ['SATUAN'],
    qtyBom: ['QTY BOM'],
    qtyCom: ['QTY COM'],
    qtyDeviasi: ['QTY DEVIASI'],
    qtyWaste: ['QTY WASTE'],
    qtySusut: ['QTY SUSUT'],
    qtyTrial: ['QTY TRIAL'],
    qtyLossSurplus: ['QTY LOSS SURPLUS'],
    nominalDeviasi: ['NOMINAL DEVIASI'],
    nominalWaste: ['NOMINAL WASTE'],
    nominalSusut: ['NOMINAL SUSUT'],
    nominalTrial: ['NOMINAL TRIAL'],
    nominalLossSurplus: ['NOMINAL LOSS/SURPLUS'],
    pctWasteSusut: ['% WASTE + SUSUT'],
    toleranceRaw: ['%TOLERANSI'],
    pctQtyDeviasiToBom: ['% QTY DEVIASI TO BOM'],
    pctQtyWasteToBom: ['QTY WASTE TO BOM'],
    pctQtySusutToBom: ['QTY SUSUT TO BOM'],
    pctQtyTrialToBom: ['QTY TRIAL  TO BOM', 'QTY TRIAL TO BOM'],
    pctQtyLossToBom: ['QTY LOSS/ SURPLUS TO BOM'],
    area: ['AREA'],
    bulan: ['BULAN'],
    nominalSales: ['PENJUALAN'],
    weekLabel: ['STATUS BULAN'],
    bulan2: ['BULAN 2'],
  };
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    for (let i = 0; i < headers.length; i++) {
      if (aliases.includes(headers[i])) {
        colIdx[key] = i;
        break;
      }
    }
  }

  // Insert SourceFile
  const fileHash = `${fileName}-${Date.now()}`;
  let sourceFileId: number;
  try {
    const sfRes = await client.execute({
      sql: `INSERT INTO "SourceFile" ("fileName", "filePath", "monthLabel", "monthKey", "fileHash", "rowCount") VALUES (?, ?, ?, ?, ?, 0)`,
      args: [fileName, filePath, monthInfo.monthLabel, monthInfo.monthKey, fileHash],
    });
    sourceFileId = Number(sfRes.lastInsertRowid);
  } catch (e) {
    console.log(`  ⚠️  SourceFile exists or error: ${(e as Error).message}`);
    const existing = await client.execute({ sql: `SELECT id FROM "SourceFile" WHERE "fileName" = ?`, args: [fileName] });
    if (existing.rows.length === 0) throw e;
    sourceFileId = Number(existing.rows[0].id);
  }

  // Collect weeks and insert
  const weekMap = new Map<string, number>(); // weekLabel → weekId
  // We'll insert weeks as we encounter them

  // Cache outlets and items
  const outletCache = new Map<string, number>(); // code → id
  const itemCache = new Map<string, number>(); // name → id

  // Get existing outlets and items
  const existingOutlets = await client.execute(`SELECT id, code FROM "Outlet"`);
  for (const r of existingOutlets.rows) outletCache.set(String(r.code), Number(r.id));
  const existingItems = await client.execute(`SELECT id, name FROM "Item"`);
  for (const r of existingItems.rows) itemCache.set(String(r.name), Number(r.id));

  // Batch insert records
  let rowCount = 0;
  const BATCH_SIZE = 500;
  let batchStmts: Array<{ sql: string; args: InValue[] }> = [];

  console.log(`  📊 Processing ${ws.rowCount - 1} rows...`);

  for (let rowNum = 2; rowNum <= ws.rowCount; rowNum++) {
    const row = ws.getRow(rowNum);
    const get = (key: string): unknown => {
      const idx = colIdx[key];
      if (idx == null) return null;
      const cell = row.getCell(idx + 1);
      return cell.value;
    };

    const resto = String(get('resto') || '').trim();
    const namaBahan = String(get('namaBahan') || '').trim();
    if (!resto || !namaBahan) continue;

    const area = String(get('area') || '').trim();
    const satuan = String(get('satuan') || '').trim() || null;
    const weekLabel = String(get('weekLabel') || 'WEEK 1').trim().toUpperCase();
    const akunPenyesuaian = String(get('akunPenyesuaian') || '').trim() || null;
    const status = String(get('status') || '').trim() || null;
    const bulan = String(get('bulan') || '').trim();
    const bulan2 = String(get('bulan2') || '').trim() || null;

    // Parse outlet: "1030.BDGSET" → code="1030.BDGSET", name="BDGSET", outletCode="1030"
    const outletCode = resto;
    const parts = resto.split('.');
    const outletName = parts.length > 1 ? parts.slice(1).join('.') : resto;
    const outletNumeric = parts[0] || resto;

    // Get or create outlet
    let outletId = outletCache.get(outletCode);
    if (outletId == null) {
      try {
        const r = await client.execute({
          sql: `INSERT INTO "Outlet" (code, name, "outletCode", area) VALUES (?, ?, ?, ?)`,
          args: [outletCode, outletName, outletNumeric, area || 'UNKNOWN'],
        });
        outletId = Number(r.lastInsertRowid);
        outletCache.set(outletCode, outletId);
      } catch {
        const r = await client.execute({ sql: `SELECT id FROM "Outlet" WHERE code = ?`, args: [outletCode] });
        outletId = Number(r.rows[0].id);
        outletCache.set(outletCode, outletId);
      }
    }

    // Get or create item
    let itemId = itemCache.get(namaBahan);
    if (itemId == null) {
      try {
        const r = await client.execute({
          sql: `INSERT INTO "Item" (name, satuan) VALUES (?, ?)`,
          args: [namaBahan, satuan],
        });
        itemId = Number(r.lastInsertRowid);
        itemCache.set(namaBahan, itemId);
      } catch {
        const r = await client.execute({ sql: `SELECT id FROM "Item" WHERE name = ?`, args: [namaBahan] });
        itemId = Number(r.rows[0].id);
        itemCache.set(namaBahan, itemId);
      }
    }

    // Get or create week
    let weekId = weekMap.get(weekLabel);
    if (weekId == null) {
      const period = weekPeriod(weekLabel);
      const weekKey = `${monthInfo.monthKey}-W${weekLabel.replace(/\D/g, '')}`;
      try {
        const r = await client.execute({
          sql: `INSERT INTO "Week" ("sourceFileId", "weekLabel", "weekKey", "monthKey", "periodStart", "periodEnd") VALUES (?, ?, ?, ?, ?, ?)`,
          args: [sourceFileId, weekLabel, weekKey, monthInfo.monthKey, period.start, period.end],
        });
        weekId = Number(r.lastInsertRowid);
        weekMap.set(weekLabel, weekId);
      } catch {
        const r = await client.execute({
          sql: `SELECT id FROM "Week" WHERE "sourceFileId" = ? AND "weekLabel" = ?`,
          args: [sourceFileId, weekLabel],
        });
        weekId = Number(r.rows[0].id);
        weekMap.set(weekLabel, weekId);
      }
    }

    // Parse numeric values
    const qtyBom = toNum(get('qtyBom'));
    const qtyCom = toNum(get('qtyCom'));
    const qtyDeviasi = toNum(get('qtyDeviasi'));
    const qtyWaste = toNum(get('qtyWaste'));
    const qtySusut = toNum(get('qtySusut'));
    const qtyTrial = toNum(get('qtyTrial'));
    const qtyLossSurplus = toNum(get('qtyLossSurplus'));
    const nominalDeviasi = toNum(get('nominalDeviasi'));
    const nominalWaste = toNum(get('nominalWaste'));
    const nominalSusut = toNum(get('nominalSusut'));
    const nominalTrial = toNum(get('nominalTrial'));
    const nominalLossSurplus = toNum(get('nominalLossSurplus'));
    const nominalSales = toNum(get('nominalSales'));
    const pctWasteSusut = toNum(get('pctWasteSusut'));
    const pctQtyDeviasiToBom = toNum(get('pctQtyDeviasiToBom'));
    const pctQtyWasteToBom = toNum(get('pctQtyWasteToBom'));
    const pctQtySusutToBom = toNum(get('pctQtySusutToBom'));
    const pctQtyTrialToBom = toNum(get('pctQtyTrialToBom'));
    const pctQtyLossToBom = toNum(get('pctQtyLossToBom'));

    const { pct: tolerancePct, raw: toleranceRaw } = parseTolerance(get('toleranceRaw'));

    // Derived fields
    const direction = nominalDeviasi == null ? null : nominalDeviasi > 0 ? 'LOSS' : nominalDeviasi < 0 ? 'SURPLUS' : 'NEUTRAL';
    const residualQty = (qtyDeviasi != null && qtyWaste != null && qtySusut != null && qtyTrial != null)
      ? qtyDeviasi - (qtyWaste + qtySusut + qtyTrial) : null;
    const residualNominal = (nominalDeviasi != null && nominalWaste != null && nominalSusut != null && nominalTrial != null)
      ? nominalDeviasi - (nominalWaste + nominalSusut + nominalTrial) : null;
    const residualRatio = (residualQty != null && qtyDeviasi != null && qtyDeviasi !== 0)
      ? residualQty / qtyDeviasi : null;
    const avgPrice = (nominalDeviasi != null && qtyDeviasi != null && qtyDeviasi !== 0)
      ? Math.abs(nominalDeviasi / qtyDeviasi) : null;

    batchStmts.push({
      sql: `INSERT OR IGNORE INTO "InventoryRecord" (
        "sourceFileId", "weekId", "outletId", "itemId",
        "akunPenyesuaian", status, satuan,
        "qtyBom", "qtyCom", "qtyDeviasi", "qtyWaste", "qtySusut", "qtyTrial", "qtyLossSurplus",
        "nominalDeviasi", "nominalWaste", "nominalSusut", "nominalTrial", "nominalLossSurplus", "nominalSales",
        "avgPrice", "tolerancePct", "toleranceRaw",
        "pctWasteSusut", "pctQtyDeviasiToBom", "pctQtyWasteToBom", "pctQtySusutToBom", "pctQtyTrialToBom", "pctQtyLossToBom",
        direction, "residualQty", "residualNominal", "residualRatio",
        "absQtyDeviasi", "absNominalDeviasi", "absQtyLossSurplus", "absNominalLossSurplus",
        area, bulan, "bulan2", "weekLabel", "monthLabel"
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        sourceFileId, weekId, outletId, itemId,
        akunPenyesuaian, status, satuan,
        qtyBom, qtyCom, qtyDeviasi, qtyWaste, qtySusut, qtyTrial, qtyLossSurplus,
        nominalDeviasi, nominalWaste, nominalSusut, nominalTrial, nominalLossSurplus, nominalSales,
        avgPrice, tolerancePct, toleranceRaw,
        pctWasteSusut, pctQtyDeviasiToBom, pctQtyWasteToBom, pctQtySusutToBom, pctQtyTrialToBom, pctQtyLossToBom,
        direction, residualQty, residualNominal, residualRatio,
        qtyDeviasi != null ? Math.abs(qtyDeviasi) : null,
        nominalDeviasi != null ? Math.abs(nominalDeviasi) : null,
        qtyLossSurplus != null ? Math.abs(qtyLossSurplus) : null,
        nominalLossSurplus != null ? Math.abs(nominalLossSurplus) : null,
        area, bulan, bulan2, weekLabel, monthInfo.monthLabel,
      ],
    });

    rowCount++;
    if (batchStmts.length >= BATCH_SIZE) {
      await client.batch(batchStmts, 'write');
      batchStmts = [];
      if (rowCount % 5000 === 0) console.log(`    ... ${rowCount} rows processed`);
    }
  }

  // Flush remaining
  if (batchStmts.length > 0) {
    await client.batch(batchStmts, 'write');
  }

  // Update rowCount in SourceFile
  await client.execute({
    sql: `UPDATE "SourceFile" SET "rowCount" = ? WHERE id = ?`,
    args: [rowCount, sourceFileId],
  });

  console.log(`  ✅ ${rowCount} rows inserted`);
  return rowCount;
}

// ============================================================
//  Upload PIC.csv
// ============================================================
async function uploadPIC(csvPath: string) {
  if (!fs.existsSync(csvPath)) {
    console.log('⚠️  PIC.csv not found, skipping PIC upload');
    return;
  }
  console.log('\n📄 PIC.csv');
  const content = fs.readFileSync(csvPath, 'utf-8').replace(/^\uFEFF/, ''); // strip BOM
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  const stmts: Array<{ sql: string; args: InValue[] }> = [];
  let skipped = 0;
  for (const line of lines) {
    // Support both comma and semicolon delimiters
    const parts = line.includes(';') ? line.split(';') : line.split(',');
    const outletCode = parts[0]?.trim().replace(/"/g, '');
    const pic = parts[1]?.trim().replace(/"/g, '');
    if (!outletCode || !pic) continue;
    // Skip header row
    if (outletCode.toUpperCase() === 'RESTO' || pic.toUpperCase() === 'PIC') { skipped++; continue; }
    stmts.push({
      sql: `INSERT OR REPLACE INTO "OutletPIC" ("outletCode", pic) VALUES (?, ?)`,
      args: [outletCode, pic],
    });
  }
  await client.batch(stmts, 'write');
  console.log(`  ✅ ${stmts.length} PIC entries inserted${skipped ? ` (${skipped} header skipped)` : ''}`);
}

// ============================================================
//  Main
// ============================================================
async function main() {
  await createTables();

  // Find all .xlsx files in DATA_DIR
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.toLowerCase().endsWith('.xlsx'))
    .sort();
  console.log(`Found ${files.length} Excel files\n`);

  let totalRecords = 0;
  for (const f of files) {
    const count = await uploadFile(path.join(DATA_DIR, f));
    totalRecords += count;
  }

  // Upload PIC if exists
  const picPath = path.join(DATA_DIR, 'PIC.csv');
  await uploadPIC(picPath);

  // Summary
  const outlets = await client.execute(`SELECT COUNT(*) as n FROM "Outlet"`);
  const items = await client.execute(`SELECT COUNT(*) as n FROM "Item"`);
  const records = await client.execute(`SELECT COUNT(*) as n FROM "InventoryRecord"`);
  const months = await client.execute(`SELECT DISTINCT "monthLabel" FROM "SourceFile" ORDER BY "monthLabel"`);

  console.log('\n═══════════════════════════════════════════════');
  console.log('  ✅ UPLOAD COMPLETE!');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Files:      ${files.length}`);
  console.log(`  Months:     ${months.rows.map(r => r.monthLabel).join(', ')}`);
  console.log(`  Records:    ${records.rows[0].n}`);
  console.log(`  Outlets:    ${outlets.rows[0].n}`);
  console.log(`  Items:      ${items.rows[0].n}`);
  console.log('═══════════════════════════════════════════════');
}

main().catch(e => {
  console.error('❌ Fatal error:', e);
  process.exit(1);
});
