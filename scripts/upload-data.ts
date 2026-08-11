#!/usr/bin/env bun
// ============================================================
//  upload-data.ts — Upload Excel data to database via Prisma
//  Supports PostgreSQL (Supabase) / SQLite / Turso
//  Usage: bun run scripts/upload-data.ts <data-dir>
// ============================================================
import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.argv[2] || './upload';
const db = new PrismaClient({ log: ['error', 'warn'] });

console.log('═══════════════════════════════════════════════');
console.log('  Upload Data ke Database (via Prisma)');
console.log('═══════════════════════════════════════════════');
console.log(`  Data dir: ${DATA_DIR}`);
console.log('');

// ============================================================
//  Helpers
// ============================================================
const MONTH_MAP: Record<string, string> = {
  'JANUARI': '01', 'FEBRUARI': '02', 'MARET': '03', 'APRIL': '04',
  'MEI': '05', 'JUNI': '06', 'JULI': '07', 'AGUSTUS': '08',
  'SEPTEMBER': '09', 'OKTOBER': '10', 'NOVEMBER': '11', 'DESEMBER': '12',
};

function parseMonthFromFile(fileName: string): { monthLabel: string; monthKey: string } {
  const base = fileName.replace(/\.(xlsx|csv)$/i, '').trim();
  const m = base.match(/(JANUARI|FEBRUARI|MARET|APRIL|MEI|JUNI|JULI|AGUSTUS|SEPTEMBER|OKTOBER|NOVEMBER|DESEMBER)\s*(\d{4})/i);
  if (m) {
    const monthName = m[1].toUpperCase();
    const year = m[2];
    const monthNum = MONTH_MAP[monthName];
    return { monthLabel: `${monthName} ${year}`, monthKey: `${year}-${monthNum}` };
  }
  return { monthLabel: base, monthKey: '2026-01' };
}

function parseTolerance(raw: unknown): { pct: number | null; raw: string } {
  if (raw == null) return { pct: null, raw: '' };
  const s = String(raw).trim();
  if (!s || s.toUpperCase().includes('BELUM')) return { pct: null, raw: s };
  const num = parseFloat(s.replace('%', '').replace(',', '.'));
  if (isNaN(num)) return { pct: null, raw: s };
  const pct = num > 1 ? num / 100 : num;
  return { pct, raw: s };
}

function toNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return isNaN(v) ? null : v;
  if (typeof v === 'object' && v !== null && 'result' in v) {
    const r = (v as { result: unknown }).result;
    return typeof r === 'number' ? r : null;
  }
  const s = String(v).trim();
  if (!s) return null;
  const n = parseFloat(s.replace(/[^\d.-]/g, ''));
  return isNaN(n) ? null : n;
}

function weekPeriod(weekLabel: string): { start: number; end: number } {
  if (weekLabel.includes('1')) return { start: 1, end: 7 };
  if (weekLabel.includes('2')) return { start: 8, end: 14 };
  if (weekLabel.includes('3') || weekLabel.includes('4')) return { start: 15, end: 31 };
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
    return 0;
  }

  const monthInfo = parseMonthFromFile(fileName);
  console.log(`  📅 Month: ${monthInfo.monthLabel} (${monthInfo.monthKey})`);

  // Read Excel
  console.log(`  📖 Reading Excel...`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.getWorksheet(1);
  if (!ws) {
    console.log(`  ❌ No worksheet found`);
    return 0;
  }

  // Get headers
  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell((cell, col) => {
    headers[col - 1] = String(cell.value || '').trim().toUpperCase();
  });

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

  // Create SourceFile
  const fileHash = `${fileName}-${Date.now()}`;
  const sourceFile = await db.sourceFile.upsert({
    where: { fileName },
    create: { fileName, filePath, monthLabel: monthInfo.monthLabel, monthKey: monthInfo.monthKey, fileHash, rowCount: 0 },
    update: { filePath, monthLabel: monthInfo.monthLabel, monthKey: monthInfo.monthKey, fileHash, rowCount: 0 },
  });
  const sourceFileId = sourceFile.id;

  // Cache outlets and items
  const outletCache = new Map<string, number>();
  const itemCache = new Map<string, number>();
  const weekCache = new Map<string, number>();

  const existingOutlets = await db.outlet.findMany({ select: { id: true, code: true } });
  for (const o of existingOutlets) outletCache.set(o.code, o.id);
  const existingItems = await db.item.findMany({ select: { id: true, name: true } });
  for (const i of existingItems) itemCache.set(i.name, i.id);

  let rowCount = 0;
  const BATCH_SIZE = 500;
  let batch: Array<{
    sourceFileId: number; weekId: number; outletId: number; itemId: number;
    akunPenyesuaian: string | null; status: string | null; satuan: string | null;
    qtyBom: number | null; qtyCom: number | null; qtyDeviasi: number | null;
    qtyWaste: number | null; qtySusut: number | null; qtyTrial: number | null; qtyLossSurplus: number | null;
    nominalDeviasi: number | null; nominalWaste: number | null; nominalSusut: number | null;
    nominalTrial: number | null; nominalLossSurplus: number | null; nominalSales: number | null;
    avgPrice: number | null; tolerancePct: number | null; toleranceRaw: string | null;
    pctWasteSusut: number | null; pctQtyDeviasiToBom: number | null; pctQtyWasteToBom: number | null;
    pctQtySusutToBom: number | null; pctQtyTrialToBom: number | null; pctQtyLossToBom: number | null;
    direction: string | null; residualQty: number | null; residualNominal: number | null; residualRatio: number | null;
    absQtyDeviasi: number | null; absNominalDeviasi: number | null; absQtyLossSurplus: number | null; absNominalLossSurplus: number | null;
    area: string; bulan: string; bulan2: string | null; weekLabel: string; monthLabel: string;
  }> = [];

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

    const outletCode = resto;
    const parts = resto.split('.');
    const outletName = parts.length > 1 ? parts.slice(1).join('.') : resto;
    const outletNumeric = parts[0] || resto;

    // Get or create outlet
    let outletId = outletCache.get(outletCode);
    if (outletId == null) {
      const o = await db.outlet.upsert({
        where: { code: outletCode },
        create: { code: outletCode, name: outletName, outletCode: outletNumeric, area: area || 'UNKNOWN' },
        update: {},
      });
      outletId = o.id;
      outletCache.set(outletCode, outletId);
    }

    // Get or create item
    let itemId = itemCache.get(namaBahan);
    if (itemId == null) {
      const it = await db.item.upsert({
        where: { name: namaBahan },
        create: { name: namaBahan, satuan },
        update: {},
      });
      itemId = it.id;
      itemCache.set(namaBahan, itemId);
    }

    // Get or create week
    let weekId = weekCache.get(weekLabel);
    if (weekId == null) {
      const period = weekPeriod(weekLabel);
      const weekKey = `${monthInfo.monthKey}-W${weekLabel.replace(/\D/g, '')}`;
      const w = await db.week.upsert({
        where: { sourceFileId_weekLabel: { sourceFileId, weekLabel } },
        create: { sourceFileId, weekLabel, weekKey, monthKey: monthInfo.monthKey, periodStart: period.start, periodEnd: period.end },
        update: {},
      });
      weekId = w.id;
      weekCache.set(weekLabel, weekId);
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
    const { pct: tolerancePct, raw: toleranceRawVal } = parseTolerance(get('toleranceRaw'));

    const direction = nominalDeviasi == null ? null : nominalDeviasi > 0 ? 'LOSS' : nominalDeviasi < 0 ? 'SURPLUS' : 'NEUTRAL';
    const residualQty = (qtyDeviasi != null && qtyWaste != null && qtySusut != null && qtyTrial != null)
      ? qtyDeviasi - (qtyWaste + qtySusut + qtyTrial) : null;
    const residualNominal = (nominalDeviasi != null && nominalWaste != null && nominalSusut != null && nominalTrial != null)
      ? nominalDeviasi - (nominalWaste + nominalSusut + nominalTrial) : null;
    const residualRatio = (residualQty != null && qtyDeviasi != null && qtyDeviasi !== 0)
      ? residualQty / qtyDeviasi : null;
    const avgPrice = (nominalDeviasi != null && qtyDeviasi != null && qtyDeviasi !== 0)
      ? Math.abs(nominalDeviasi / qtyDeviasi) : null;

    batch.push({
      sourceFileId, weekId, outletId, itemId,
      akunPenyesuaian, status, satuan,
      qtyBom, qtyCom, qtyDeviasi, qtyWaste, qtySusut, qtyTrial, qtyLossSurplus,
      nominalDeviasi, nominalWaste, nominalSusut, nominalTrial, nominalLossSurplus, nominalSales,
      avgPrice, tolerancePct, toleranceRaw: toleranceRawVal,
      pctWasteSusut, pctQtyDeviasiToBom, pctQtyWasteToBom, pctQtySusutToBom, pctQtyTrialToBom, pctQtyLossToBom,
      direction, residualQty, residualNominal, residualRatio,
      absQtyDeviasi: qtyDeviasi != null ? Math.abs(qtyDeviasi) : null,
      absNominalDeviasi: nominalDeviasi != null ? Math.abs(nominalDeviasi) : null,
      absQtyLossSurplus: qtyLossSurplus != null ? Math.abs(qtyLossSurplus) : null,
      absNominalLossSurplus: nominalLossSurplus != null ? Math.abs(nominalLossSurplus) : null,
      area, bulan, bulan2, weekLabel, monthLabel: monthInfo.monthLabel,
    });

    rowCount++;
    if (batch.length >= BATCH_SIZE) {
      await db.inventoryRecord.createMany({ data: batch, skipDuplicates: true });
      batch = [];
      if (rowCount % 5000 === 0) console.log(`    ... ${rowCount} rows processed`);
    }
  }

  if (batch.length > 0) {
    await db.inventoryRecord.createMany({ data: batch, skipDuplicates: true });
  }

  await db.sourceFile.update({ where: { id: sourceFileId }, data: { rowCount } });
  console.log(`  ✅ ${rowCount} rows inserted`);
  return rowCount;
}

// ============================================================
//  Upload PIC.csv
// ============================================================
async function uploadPIC(csvPath: string) {
  if (!fs.existsSync(csvPath)) {
    console.log('⚠️  PIC.csv not found, skipping');
    return;
  }
  console.log('\n📄 PIC.csv');
  const content = fs.readFileSync(csvPath, 'utf-8').replace(/^\uFEFF/, '');
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  const data: Array<{ outletCode: string; pic: string }> = [];
  for (const line of lines) {
    const parts = line.includes(';') ? line.split(';') : line.split(',');
    const outletCode = parts[0]?.trim().replace(/"/g, '');
    const pic = parts[1]?.trim().replace(/"/g, '');
    if (!outletCode || !pic) continue;
    if (outletCode.toUpperCase() === 'RESTO' || pic.toUpperCase() === 'PIC') continue;
    data.push({ outletCode, pic });
  }
  await db.outletPIC.createMany({ data, skipDuplicates: true });
  console.log(`  ✅ ${data.length} PIC entries inserted`);
}

// ============================================================
//  Main
// ============================================================
async function main() {
  try {
    const files = fs.readdirSync(DATA_DIR)
      .filter(f => f.toLowerCase().endsWith('.xlsx'))
      .sort();
    console.log(`Found ${files.length} Excel files\n`);

    let totalRecords = 0;
    for (const f of files) {
      const count = await uploadFile(path.join(DATA_DIR, f));
      totalRecords += count;
    }

    const picPath = path.join(DATA_DIR, 'PIC.csv');
    await uploadPIC(picPath);

    const outlets = await db.outlet.count();
    const items = await db.item.count();
    const records = await db.inventoryRecord.count();
    const months = await db.sourceFile.findMany({ select: { monthLabel: true }, orderBy: { monthLabel: true } });

    console.log('\n═══════════════════════════════════════════════');
    console.log('  ✅ UPLOAD COMPLETE!');
    console.log('═══════════════════════════════════════════════');
    console.log(`  Files:      ${files.length}`);
    console.log(`  Months:     ${months.map(m => m.monthLabel).join(', ')}`);
    console.log(`  Records:    ${records}`);
    console.log(`  Outlets:    ${outlets}`);
    console.log(`  Items:      ${items}`);
    console.log('═══════════════════════════════════════════════');
  } finally {
    await db.$disconnect();
  }
}

main().catch(e => {
  console.error('❌ Fatal error:', e);
  process.exit(1);
});
