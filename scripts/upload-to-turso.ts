#!/usr/bin/env bun
// ============================================================
//  upload-to-turso.ts — Upload Excel data directly to Turso
//  Uses raw @libsql/client (no Prisma) to avoid env issues
// ============================================================
import { createClient } from '@libsql/client';
import ExcelJS from 'exceljs';
import { stringify } from 'csv-stringify/sync';
import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse';
import { createReadStream } from 'fs';

const DB_URL = process.env.DATABASE_URL;
const DB_TOKEN = process.env.DATABASE_AUTH_TOKEN;
const DATA_DIR = process.argv[2] || './data/inventory';

if (!DB_URL) {
  console.error('❌ DATABASE_URL not set!');
  process.exit(1);
}

console.log('═══════════════════════════════════════════════');
console.log('  Upload Data ke Turso (raw libsql)');
console.log('═══════════════════════════════════════════════');
console.log(`  Database: ${DB_URL}`);
console.log(`  Data dir: ${DATA_DIR}`);
console.log(`  Token: ${DB_TOKEN ? 'SET' : 'NOT SET'}`);
console.log('');

const client = createClient({ url: DB_URL, authToken: DB_TOKEN || undefined });

// ============================================================
const HEADER_ALIASES: Record<string, string> = {
  'akun penyesuaian persediaan': 'akunPenyesuaian', 'status': 'status', 'resto': 'resto',
  'nama bahan': 'namaBahan', 'satuan': 'satuan', 'qty bom': 'qtyBom', 'qty com': 'qtyCom',
  'qty deviasi': 'qtyDeviasi', 'qty waste': 'qtyWaste', 'qty susut': 'qtySusut',
  'qty trial': 'qtyTrial', 'qty loss surplus': 'qtyLossSurplus',
  'nominal deviasi': 'nominalDeviasi', 'nominal waste': 'nominalWaste',
  'nominal susut': 'nominalSusut', 'nominal trial': 'nominalTrial',
  'nominal loss/surplus': 'nominalLossSurplus', 'qty waste + susut': 'qtyWasteSusut',
  '% waste + susut': 'pctWasteSusut', '%toleransi': 'toleranceRaw',
  '% qty deviasi to bom': 'pctQtyDeviasiToBom', 'qty waste to bom': 'pctQtyWasteToBom',
  'qty susut to bom': 'pctQtySusutToBom', 'qty trial to bom': 'pctQtyTrialToBom',
  'qty loss/ surplus to bom': 'pctQtyLossToBom', 'area': 'area', 'bulan': 'bulan',
  'penjualan': 'nominalSales', 'status bulan': 'weekLabel', 'bulan 2': 'bulan2',
};

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
    const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
    if (lc > ld) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (s.includes(',')) {
    const lc = s.lastIndexOf(','), ac = s.slice(lc + 1);
    if (ac.length === 3 && /^\d+$/.test(ac)) s = s.replace(/,/g, '');
    else if (ac.length >= 1 && ac.length <= 2 && /^\d+$/.test(ac)) s = s.replace(/,/g, '.');
    else s = s.replace(/,/g, '');
  }
  const n = Number(s);
  if (isNaN(n)) return null;
  return isPercent ? (isNegative ? -Math.abs(n) : n) / 100 : (isNegative ? -Math.abs(n) : n);
}

function parseTolerance(raw: unknown) {
  if (raw === null || raw === undefined || raw === '') return { value: null, rawStr: null };
  if (typeof raw === 'number') return { value: raw, rawStr: String(raw) };
  const s = String(raw).trim();
  if (s.toUpperCase().includes('BELUM ADA TOLERANSI')) return { value: null, rawStr: s };
  const n = Number(s.replace(/,/g, '.'));
  return { value: isNaN(n) ? null : n, rawStr: s };
}

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
  base = base.replace(/\s*-\s*Google\s+.*$/i, '').trim();
  let m = base.match(/^(?:(\d+)\.\s*)?([A-Za-z]+)\s+(\d{2,4})$/);
  if (m) { const f = MONTH_MAP[m[2].toLowerCase()]; if (f) { let y = m[3]; if (y.length === 2) y = `20${y}`; return { monthLabel: `${f.name} ${y}`, monthKey: `${y}-${f.num}` }; } }
  m = base.match(/(?:(\d+)\.\s*)?([A-Za-z]{3,9})\s+(\d{2,4})/);
  if (m) { const f = MONTH_MAP[m[2].toLowerCase()]; if (f) { let y = m[3]; if (y.length === 2) y = `20${y}`; return { monthLabel: `${f.name} ${y}`, monthKey: `${y}-${f.num}` }; } }
  return null;
}

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

async function hashFile(filePath: string): Promise<string> {
  const crypto = await import('crypto');
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function convertExcelToCsv(excelPath: string, csvPath: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(excelPath);
  const ws = wb.worksheets.find((s) => s.state === 'visible') || wb.worksheets[0];
  if (!ws) throw new Error('No worksheets found');
  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  for (let c = 1; c <= ws.columnCount; c++) headers.push(String(cellToValue(headerRow.getCell(c)) ?? '').trim());
  fs.writeFileSync(csvPath, stringify([headers]));
  const CHUNK = 2000; let chunk: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return;
    const values: string[] = [];
    for (let c = 1; c <= ws.columnCount; c++) { const v = cellToValue(row.getCell(c)); values.push(v === null || v === undefined ? '' : String(v)); }
    chunk.push(values);
    if (chunk.length >= CHUNK) { fs.appendFileSync(csvPath, stringify(chunk)); chunk = []; }
  });
  if (chunk.length > 0) fs.appendFileSync(csvPath, stringify(chunk));
}

async function* parseCsvStream(csvPath: string) {
  const parser = parse({
    columns: (headers: string[]) => headers.map((h: string) => { const c = h.toLowerCase().replace(/\s+/g, ' ').trim(); return HEADER_ALIASES[c] || HEADER_ALIASES[c.replace(/\s*\/\s*/g, '/')] || c; }),
    skip_empty_lines: true, trim: true, bom: true, relax_quotes: true, relax_column_count: true,
  });
  createReadStream(csvPath, 'utf-8').pipe(parser);
  for await (const row of parser) yield row;
}

// ============================================================
async function createTables() {
  console.log('Creating tables...');
  const stmts = [
    `CREATE TABLE IF NOT EXISTS SourceFile (id INTEGER PRIMARY KEY AUTOINCREMENT, fileName TEXT NOT NULL UNIQUE, filePath TEXT NOT NULL, monthLabel TEXT NOT NULL, monthKey TEXT NOT NULL, fileHash TEXT NOT NULL UNIQUE, rowCount INTEGER NOT NULL DEFAULT 0, dqStatus TEXT NOT NULL DEFAULT 'OK', dqErrorCount INTEGER NOT NULL DEFAULT 0, dqWarningCount INTEGER NOT NULL DEFAULT 0, importedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS Week (id INTEGER PRIMARY KEY AUTOINCREMENT, sourceFileId INTEGER NOT NULL, weekLabel TEXT NOT NULL, weekKey TEXT NOT NULL, monthKey TEXT NOT NULL, periodStart INTEGER NOT NULL, periodEnd INTEGER NOT NULL, UNIQUE(sourceFileId, weekLabel))`,
    `CREATE TABLE IF NOT EXISTS Outlet (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, outletCode TEXT NOT NULL, area TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS Item (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, satuan TEXT, category TEXT)`,
    `CREATE TABLE IF NOT EXISTS InventoryRecord (id INTEGER PRIMARY KEY AUTOINCREMENT, sourceFileId INTEGER NOT NULL, weekId INTEGER NOT NULL, outletId INTEGER NOT NULL, itemId INTEGER NOT NULL, akunPenyesuaian TEXT, status TEXT, satuan TEXT, qtyBom REAL, qtyCom REAL, qtyDeviasi REAL, qtyWaste REAL, qtySusut REAL, qtyTrial REAL, qtyLossSurplus REAL, nominalDeviasi REAL, nominalWaste REAL, nominalSusut REAL, nominalTrial REAL, nominalLossSurplus REAL, nominalSales REAL, avgPrice REAL, tolerancePct REAL, toleranceRaw TEXT, pctWasteSusut REAL, pctQtyDeviasiToBom REAL, pctQtyWasteToBom REAL, pctQtySusutToBom REAL, pctQtyTrialToBom REAL, pctQtyLossToBom REAL, direction TEXT, residualQty REAL, residualNominal REAL, residualRatio REAL, absQtyDeviasi REAL, absNominalDeviasi REAL, absQtyLossSurplus REAL, absNominalLossSurplus REAL, area TEXT NOT NULL, bulan TEXT NOT NULL, bulan2 TEXT, weekLabel TEXT NOT NULL, monthLabel TEXT NOT NULL, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(weekId, outletId, itemId, akunPenyesuaian))`,
    `CREATE TABLE IF NOT EXISTS Setting (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, value TEXT NOT NULL, category TEXT NOT NULL, label TEXT NOT NULL, description TEXT, dataType TEXT NOT NULL, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedBy TEXT)`,
    `CREATE TABLE IF NOT EXISTS AuditLog (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, detail TEXT NOT NULL, duration INTEGER, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS DQIssue (id INTEGER PRIMARY KEY AUTOINCREMENT, sourceFileId INTEGER NOT NULL, weekId INTEGER, outletId INTEGER, itemId INTEGER, severity TEXT NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL, rawValue TEXT, rowNumber INTEGER, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  ];
  for (const sql of stmts) await client.execute(sql);
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_inv_outlet_week ON InventoryRecord(outletId, weekId)`);
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_inv_item_week ON InventoryRecord(itemId, weekId)`);
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_inv_area_week ON InventoryRecord(area, weekId)`);
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_inv_month_week ON InventoryRecord(monthLabel, weekLabel)`);
  console.log('✅ Tables ready');
}

async function getOrInsert(table: string, where: string, data: any): Promise<number> {
  const res = await client.execute(`SELECT id FROM ${table} WHERE ${where}`);
  if (res.rows.length > 0) return res.rows[0].id as number;
  const cols = Object.keys(data);
  const vals = cols.map(c => data[c] === null ? 'NULL' : `'${String(data[c]).replace(/'/g, "''")}'`);
  const ins = await client.execute(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${vals.join(',')})`);
  return Number(ins.lastInsertRowid);
}

async function ingestFile(filePath: string) {
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  console.log(`\n📄 ${fileName}`);

  const fileHash = await hashFile(filePath);

  // Check existing
  const existing = await client.execute({ sql: `SELECT id, rowCount FROM SourceFile WHERE fileHash = ?`, args: [fileHash] });
  if (existing.rows.length > 0) {
    const sfId = existing.rows[0].id as number;
    const countRes = await client.execute({ sql: `SELECT COUNT(*) as c FROM InventoryRecord WHERE sourceFileId = ?`, args: [sfId] });
    if ((countRes.rows[0].c as number) > 0) { console.log(`  ⏭️  Already ingested. Skip.`); return; }
    await client.execute({ sql: `DELETE FROM DQIssue WHERE sourceFileId = ?`, args: [sfId] });
    await client.execute({ sql: `DELETE FROM InventoryRecord WHERE sourceFileId = ?`, args: [sfId] });
    await client.execute({ sql: `DELETE FROM Week WHERE sourceFileId = ?`, args: [sfId] });
    await client.execute({ sql: `DELETE FROM SourceFile WHERE id = ?`, args: [sfId] });
  }

  let csvPath = filePath;
  if (ext === '.xlsx') {
    csvPath = filePath.replace(/\.xlsx$/i, '.csv');
    if (!fs.existsSync(csvPath) || fs.statSync(csvPath).size === 0) {
      console.log('  📊 Converting to CSV...');
      await convertExcelToCsv(filePath, csvPath);
    }
  }

  const monthInfo = parseMonthFromFilename(fileName);
  const monthLabel = monthInfo?.monthLabel || fileName.replace(/\.(xlsx|csv)$/i, '');
  const monthKey = monthInfo?.monthKey || 'unknown';

  const sfRes = await client.execute({
    sql: `INSERT INTO SourceFile (fileName, filePath, monthLabel, monthKey, fileHash, rowCount, dqStatus) VALUES (?, ?, ?, ?, ?, 0, 'OK')`,
    args: [fileName, filePath, monthLabel, monthKey, fileHash]
  });
  const sourceFileId = Number(sfRes.lastInsertRowid);

  const weekMap = new Map<string, number>();
  const outletMap = new Map<string, number>();
  const itemMap = new Map<string, number>();
  const dedupSet = new Set<string>();
  let total = 0;
  let batch: string[][] = [];

  for await (const rawRow of parseCsvStream(csvPath)) {
    const n = { ...rawRow } as any;
    const tol = parseTolerance(n.toleranceRaw);
    const qtyDeviasi = toNum(n.qtyDeviasi);
    const direction = qtyDeviasi === null ? 'NEUTRAL' : qtyDeviasi > 0 ? 'LOSS' : qtyDeviasi < 0 ? 'SURPLUS' : 'NEUTRAL';
    const w = toNum(n.qtyWaste) ?? 0, s = toNum(n.qtySusut) ?? 0, t = toNum(n.qtyTrial) ?? 0;
    const explained = Math.abs(w + s + t);
    const absDev = Math.abs(qtyDeviasi ?? 0);
    const residualQty = (qtyDeviasi ?? 0) >= 0 ? 1 : -1 * (absDev - explained);
    const residualRatio = absDev > 0 ? (absDev - explained) / absDev : null;
    const parsed = parseOutletCode(n.resto || '');
    const wk = (n.weekLabel || 'UNKNOWN').toUpperCase();
    const namaBahan = String(n.namaBahan || '').trim();
    const outletCode = parsed?.fullCode || n.resto || '';

    // Get/create week
    if (!weekMap.has(wk)) {
      const periods: Record<string, [number, number]> = { 'WEEK 1': [1, 7], 'WEEK 2': [8, 14], 'WEEK 3': [15, 31] };
      const [ps, pe] = periods[wk] || [1, 31];
      const ex = await client.execute({ sql: `SELECT id FROM Week WHERE sourceFileId = ? AND weekLabel = ?`, args: [sourceFileId, wk] });
      if (ex.rows.length > 0) weekMap.set(wk, ex.rows[0].id as number);
      else {
        const ins = await client.execute({ sql: `INSERT INTO Week (sourceFileId, weekLabel, weekKey, monthKey, periodStart, periodEnd) VALUES (?, ?, ?, ?, ?, ?)`, args: [sourceFileId, wk, `${monthKey}-${wk.replace(/\s/g, '')}`, monthKey, ps, pe] });
        weekMap.set(wk, Number(ins.lastInsertRowid));
      }
    }

    // Get/create outlet
    if (outletCode && !outletMap.has(outletCode)) {
      const ex = await client.execute({ sql: `SELECT id FROM Outlet WHERE code = ?`, args: [outletCode] });
      if (ex.rows.length > 0) outletMap.set(outletCode, ex.rows[0].id as number);
      else { const ins = await client.execute({ sql: `INSERT INTO Outlet (code, name, outletCode, area) VALUES (?, ?, ?, ?)`, args: [outletCode, parsed?.name || outletCode, parsed?.numericCode || '', n.area || ''] }); outletMap.set(outletCode, Number(ins.lastInsertRowid)); }
    }

    // Get/create item
    if (namaBahan && !itemMap.has(namaBahan)) {
      const ex = await client.execute({ sql: `SELECT id, satuan FROM Item WHERE name = ?`, args: [namaBahan] });
      if (ex.rows.length > 0) { itemMap.set(namaBahan, ex.rows[0].id as number); if (!ex.rows[0].satuan && n.satuan) await client.execute({ sql: `UPDATE Item SET satuan = ? WHERE id = ?`, args: [n.satuan, ex.rows[0].id] }); }
      else { const ins = await client.execute({ sql: `INSERT INTO Item (name, satuan) VALUES (?, ?)`, args: [namaBahan, n.satuan || null] }); itemMap.set(namaBahan, Number(ins.lastInsertRowid)); }
    }

    const weekId = weekMap.get(wk) ?? 0;
    const outletId = outletMap.get(outletCode) ?? 0;
    const itemId = itemMap.get(namaBahan) ?? 0;
    if (weekId === 0 || outletId === 0 || itemId === 0) continue;

    const dedupKey = `${weekId}|${outletId}|${itemId}|${n.akunPenyesuaian || ''}`;
    if (dedupSet.has(dedupKey)) continue;
    dedupSet.add(dedupKey);

    const vals = [
      sourceFileId, weekId, outletId, itemId,
      n.akunPenyesuaian || null, n.status || null, n.satuan || null,
      toNum(n.qtyBom), toNum(n.qtyCom), toNum(n.qtyDeviasi),
      toNum(n.qtyWaste), toNum(n.qtySusut), toNum(n.qtyTrial), toNum(n.qtyLossSurplus),
      toNum(n.nominalDeviasi), toNum(n.nominalWaste), toNum(n.nominalSusut),
      toNum(n.nominalTrial), toNum(n.nominalLossSurplus), toNum(n.nominalSales),
      toNum(n.qtyDeviasi) && toNum(n.nominalDeviasi) && toNum(n.qtyDeviasi) !== 0 ? Math.abs(toNum(n.nominalDeviasi)! / toNum(n.qtyDeviasi)!) : null,
      tol.value, tol.rawStr,
      toNum(n.pctWasteSusut), toNum(n.pctQtyDeviasiToBom), toNum(n.pctQtyWasteToBom),
      toNum(n.pctQtySusutToBom), toNum(n.pctQtyTrialToBom), toNum(n.pctQtyLossToBom),
      direction, residualQty, residualRatio,
      toNum(n.qtyDeviasi) !== null ? Math.abs(toNum(n.qtyDeviasi)!) : null,
      toNum(n.nominalDeviasi) !== null ? Math.abs(toNum(n.nominalDeviasi)!) : null,
      toNum(n.qtyLossSurplus) !== null ? Math.abs(toNum(n.qtyLossSurplus)!) : null,
      toNum(n.nominalLossSurplus) !== null ? Math.abs(toNum(n.nominalLossSurplus)!) : null,
      n.area || '', n.bulan || '', n.bulan2 || null, n.weekLabel || '', monthLabel
    ];

    // Batch insert using transaction
    batch.push(vals.map(v => v === null ? 'NULL' : typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : String(v)));

    if (batch.length >= 200) {
      const sql = `INSERT OR IGNORE INTO InventoryRecord (sourceFileId, weekId, outletId, itemId, akunPenyesuaian, status, satuan, qtyBom, qtyCom, qtyDeviasi, qtyWaste, qtySusut, qtyTrial, qtyLossSurplus, nominalDeviasi, nominalWaste, nominalSusut, nominalTrial, nominalLossSurplus, nominalSales, avgPrice, tolerancePct, toleranceRaw, pctWasteSusut, pctQtyDeviasiToBom, pctQtyWasteToBom, pctQtySusutToBom, pctQtyTrialToBom, pctQtyLossToBom, direction, residualQty, residualRatio, absQtyDeviasi, absNominalDeviasi, absQtyLossSurplus, absNominalLossSurplus, area, bulan, bulan2, weekLabel, monthLabel) VALUES `;
      const valStrs = batch.map(b => `(${b.join(',')})`).join(',');
      await client.execute(sql + valStrs);
      total += batch.length;
      batch = [];
      process.stdout.write(`\r  📦 ${total.toLocaleString()} rows`);
    }
  }

  if (batch.length > 0) {
    const sql = `INSERT OR IGNORE INTO InventoryRecord (sourceFileId, weekId, outletId, itemId, akunPenyesuaian, status, satuan, qtyBom, qtyCom, qtyDeviasi, qtyWaste, qtySusut, qtyTrial, qtyLossSurplus, nominalDeviasi, nominalWaste, nominalSusut, nominalTrial, nominalLossSurplus, nominalSales, avgPrice, tolerancePct, toleranceRaw, pctWasteSusut, pctQtyDeviasiToBom, pctQtyWasteToBom, pctQtySusutToBom, pctQtyTrialToBom, pctQtyLossToBom, direction, residualQty, residualRatio, absQtyDeviasi, absNominalDeviasi, absQtyLossSurplus, absNominalLossSurplus, area, bulan, bulan2, weekLabel, monthLabel) VALUES `;
    const valStrs = batch.map(b => `(${b.join(',')})`).join(',');
    await client.execute(sql + valStrs);
    total += batch.length;
  }

  await client.execute({ sql: `UPDATE SourceFile SET rowCount = ? WHERE id = ?`, args: [total, sourceFileId] });
  console.log(`\n  ✅ ${total.toLocaleString()} rows`);
}

async function main() {
  await createTables();

  const files = fs.readdirSync(DATA_DIR)
    .filter(f => (f.toLowerCase().endsWith('.xlsx') || f.toLowerCase().endsWith('.csv')) && !f.startsWith('~$'))
    .map(f => path.join(DATA_DIR, f)).sort();

  if (files.length === 0) { console.log(`\n❌ No files in ${DATA_DIR}`); process.exit(1); }
  console.log(`\nFound ${files.length} files`);

  for (const file of files) await ingestFile(file);

  const totalRes = await client.execute(`SELECT COUNT(*) as c FROM InventoryRecord`);
  const outletRes = await client.execute(`SELECT COUNT(*) as c FROM Outlet`);
  const itemRes = await client.execute(`SELECT COUNT(*) as c FROM Item`);
  const fileRes = await client.execute(`SELECT COUNT(*) as c FROM SourceFile`);

  console.log('\n═══════════════════════════════════════════════');
  console.log('  ✅ UPLOAD COMPLETE!');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Files:    ${fileRes.rows[0].c}`);
  console.log(`  Records:  ${totalRes.rows[0].c}`);
  console.log(`  Outlets:  ${outletRes.rows[0].c}`);
  console.log(`  Items:    ${itemRes.rows[0].c}`);
  console.log('═══════════════════════════════════════════════');
  process.exit(0);
}

main().catch(e => { console.error('❌', e?.message || e); process.exit(1); });
