// ============================================================
//  /api/export-db — Database download (Excel) per periode
//  --------------------------------------------------------
//  GET (tanpa param)     : JSON daftar periode tersedia (bulan × week
//                          + jumlah record) untuk picker UI.
//  GET ?monthKey=YYYY-MM : .xlsx SEMUA record bulan itu (semua week).
//  GET ?monthKey&week=   : .xlsx record bulan+week, mis:
//                          /api/export-db?monthKey=2026-10&week=WEEK 2
//                          → "DATABASE - Oktober 2026 - WEEK 2.xlsx"
//  GET ?fileId=N         : .xlsx semua record dari satu SourceFile.
//  GET ?month=Oktober 2026 (legacy monthLabel — resolved case-insensitive
//                          ke monthKey, konvensi sama dengan DELETE /api/data).
//
//  Sheet "DATA" memakai nama kolom PERSIS format Excel sumber (kebalikan
//  HEADER_ALIASES di src/lib/excel.ts: "RESTO", "NAMA BAHAN", "STATUS BULAN",
//  dst) sehingga file hasil unduhan LANGSUNG bisa di-re-import lewat
//  Upload File / Import Drive (parseMonthFromFilename menemukan "Oktober 2026"
//  di nama file, normalizeHeader memetakan semua kolom).
//  Sheet "INFO" berisi metadata export (periode, jumlah record, source file,
//  waktu generate) untuk audit.
//
//  Rate limit: bucket export (10 req/min) — pembuatan workbook exceljs untuk
//  satu bulan penuh (~54K baris) adalah operasi berat, sama kelasnya dengan
//  /api/export-report.
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { validateQuery, exportDbQuerySchema } from '@/lib/validation';
import { CACHE_METADATA } from '@/lib/cache-headers';
import { errorResponse } from '@/lib/error-response';
import { sanitizeFileName } from '@/lib/filename';
import type { Prisma } from '@prisma/client';

export const dynamic = 'force-dynamic';
// Pembuatan xlsx satu bulan penuh (±54K baris) + fetch records bisa melebihi
// 30s di koneksi pooler lambat — samakan dengan route berat lain
// (/api/data DELETE, /api/ingest-process).
export const maxDuration = 300;

// ------------------------------------------------------------
//  Kolom export — mapping field DB → header Excel sumber.
//  Nama header dipilih agar normalizeHeader() (src/lib/excel.ts) memetakan
//  kembali ke field yang sama saat file ini di-re-import.
// ------------------------------------------------------------
interface ExportRecord {
  akunPenyesuaian: string | null;
  status: string | null;
  satuan: string | null;
  qtyBom: number | null;
  qtyCom: number | null;
  qtyDeviasi: number | null;
  qtyWaste: number | null;
  qtySusut: number | null;
  qtyTrial: number | null;
  qtyLossSurplus: number | null;
  nominalDeviasi: number | null;
  nominalWaste: number | null;
  nominalSusut: number | null;
  nominalTrial: number | null;
  nominalLossSurplus: number | null;
  nominalSales: number | null;
  area: string;
  bulan: string;
  bulan2: string | null;
  weekLabel: string;
  monthLabel: string;
  toleranceRaw: string | null;
  pctWasteSusut: number | null;
  pctQtyDeviasiToBom: number | null;
  pctQtyWasteToBom: number | null;
  pctQtySusutToBom: number | null;
  pctQtyTrialToBom: number | null;
  pctQtyLossToBom: number | null;
  outlet: { code: string };
  item: { name: string };
}

const EXPORT_COLUMNS: { header: string; width: number; get: (r: ExportRecord) => unknown }[] = [
  { header: 'AKUN PENYESUAIAN PERSEDIAAN', width: 26, get: r => r.akunPenyesuaian },
  { header: 'STATUS', width: 12, get: r => r.status },
  { header: 'RESTO', width: 16, get: r => r.outlet?.code },
  { header: 'NAMA BAHAN', width: 30, get: r => r.item?.name },
  { header: 'SATUAN', width: 9, get: r => r.satuan },
  { header: 'QTY BOM', width: 11, get: r => r.qtyBom },
  { header: 'QTY COM', width: 11, get: r => r.qtyCom },
  { header: 'QTY DEVIASI', width: 12, get: r => r.qtyDeviasi },
  { header: 'QTY WASTE', width: 11, get: r => r.qtyWaste },
  { header: 'QTY SUSUT', width: 11, get: r => r.qtySusut },
  { header: 'QTY TRIAL', width: 11, get: r => r.qtyTrial },
  { header: 'QTY LOSS SURPLUS', width: 13, get: r => r.qtyLossSurplus },
  { header: 'NOMINAL DEVIASI', width: 15, get: r => r.nominalDeviasi },
  { header: 'NOMINAL WASTE', width: 14, get: r => r.nominalWaste },
  { header: 'NOMINAL SUSUT', width: 14, get: r => r.nominalSusut },
  { header: 'NOMINAL TRIAL', width: 14, get: r => r.nominalTrial },
  { header: 'NOMINAL LOSS/SURPLUS', width: 16, get: r => r.nominalLossSurplus },
  { header: 'PENJUALAN', width: 14, get: r => r.nominalSales },
  { header: 'AREA', width: 18, get: r => r.area },
  { header: 'BULAN', width: 14, get: r => r.bulan },
  { header: 'STATUS BULAN', width: 12, get: r => r.weekLabel },
  { header: 'BULAN 2', width: 10, get: r => r.bulan2 },
  { header: '%TOLERANSI', width: 12, get: r => r.toleranceRaw },
  { header: 'QTY WASTE + SUSUT', width: 13, get: r => r.pctWasteSusut },
  { header: '% QTY DEVIASI TO BOM', width: 13, get: r => r.pctQtyDeviasiToBom },
  { header: '% QTY WASTE TO BOM', width: 13, get: r => r.pctQtyWasteToBom },
  { header: '% QTY SUSUT TO BOM', width: 13, get: r => r.pctQtySusutToBom },
  { header: '% QTY TRIAL TO BOM', width: 13, get: r => r.pctQtyTrialToBom },
  { header: '% QTY LOSS/SURPLUS TO BOM', width: 15, get: r => r.pctQtyLossToBom },
];

// Field yang diambil dari InventoryRecord (+ relasi outlet.code / item.name
// untuk kolom RESTO / NAMA BAHAN). select eksplisit menjaga payload tetap
// ramping (tidak ikut membawa id/FK/engine-derived fields).
const RECORD_SELECT = {
  akunPenyesuaian: true,
  status: true,
  satuan: true,
  qtyBom: true,
  qtyCom: true,
  qtyDeviasi: true,
  qtyWaste: true,
  qtySusut: true,
  qtyTrial: true,
  qtyLossSurplus: true,
  nominalDeviasi: true,
  nominalWaste: true,
  nominalSusut: true,
  nominalTrial: true,
  nominalLossSurplus: true,
  nominalSales: true,
  area: true,
  bulan: true,
  bulan2: true,
  weekLabel: true,
  monthLabel: true,
  toleranceRaw: true,
  pctWasteSusut: true,
  pctQtyDeviasiToBom: true,
  pctQtyWasteToBom: true,
  pctQtySusutToBom: true,
  pctQtyTrialToBom: true,
  pctQtyLossToBom: true,
  outlet: { select: { code: true } },
  item: { select: { name: true } },
} satisfies Prisma.InventoryRecordSelect;

// ------------------------------------------------------------
//  GET /api/export-db — dispatch: periods list ATAU xlsx download
// ------------------------------------------------------------
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const validation = validateQuery(exportDbQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }
    const { monthKey, month, week, fileId } = validation.data;

    // Mode 1: daftar periode (tanpa monthKey/month/fileId) — untuk picker.
    if (!monthKey && !month && !fileId) {
      return listPeriods();
    }

    // Download adalah operasi berat (SQL + exceljs) — bucket export
    // (10 req/min per IP), konsisten dengan /api/export-report.
    const ip = getClientIP(req);
    const rl = rateLimit(`export-db:${ip}`, RATE_LIMITS.export.maxRequests, RATE_LIMITS.export.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded. Tunggu beberapa saat sebelum export berikutnya.' },
        { status: 429 },
      );
    }

    // Normalisasi weekLabel → bentuk DB ("WEEK 2" uppercase, spasi tunggal).
    // weekLabelSchema menerima "week 2" (case-insensitive).
    const normalizedWeek = week
      ? week.toUpperCase().replace(/\s+/g, ' ').trim()
      : null;

    // ---------- Resolve target export ----------
    let resolvedMonthKey: string | null = monthKey || null;
    let targetFile: { id: number; fileName: string; monthLabel: string; monthKey: string } | null = null;

    if (fileId) {
      targetFile = await db.sourceFile.findUnique({
        where: { id: fileId },
        select: { id: true, fileName: true, monthLabel: true, monthKey: true },
      });
      if (!targetFile) {
        return NextResponse.json({ success: false, error: 'File tidak ditemukan' }, { status: 404 });
      }
      resolvedMonthKey = targetFile.monthKey;
    } else if (!resolvedMonthKey && month) {
      // Legacy monthLabel → monthKey (case-insensitive), konvensi DELETE /api/data.
      const sample = await db.sourceFile.findFirst({
        where: { monthLabel: { equals: month, mode: 'insensitive' } },
        select: { monthKey: true },
      });
      resolvedMonthKey = sample?.monthKey ?? null;
      if (!resolvedMonthKey) {
        return NextResponse.json(
          { success: false, error: `Tidak ada data untuk bulan ${month}` },
          { status: 404 },
        );
      }
    }

    // ---------- Where clause ----------
    const where: Prisma.InventoryRecordWhereInput = targetFile
      ? { sourceFileId: targetFile.id }
      : {
          week: {
            monthKey: resolvedMonthKey!,
            ...(normalizedWeek ? { weekLabel: normalizedWeek } : {}),
          },
        };

    // Validasi keberadaan week di bulan tsb SEBELUM count — supaya pesan
    // error 404-nya bisa menawarkan daftar week yang tersedia.
    const monthWeeks = await db.week.findMany({
      where: targetFile ? { sourceFileId: targetFile.id } : { monthKey: resolvedMonthKey! },
      select: {
        weekLabel: true,
        periodStart: true,
        periodEnd: true,
        sourceFile: { select: { fileName: true, rowCount: true, importedAt: true, monthLabel: true } },
      },
      orderBy: { periodStart: 'asc' },
    });

    if (normalizedWeek && !monthWeeks.some(w => w.weekLabel === normalizedWeek)) {
      const available = [...new Set(monthWeeks.map(w => w.weekLabel))].join(', ') || 'tidak ada';
      return NextResponse.json(
        {
          success: false,
          error: `Week "${normalizedWeek}" tidak ada di database untuk periode ini. Week tersedia: ${available}`,
        },
        { status: 404 },
      );
    }

    const recordCount = await db.inventoryRecord.count({ where });
    if (recordCount === 0) {
      return NextResponse.json(
        { success: false, error: 'Tidak ada record untuk periode tersebut' },
        { status: 404 },
      );
    }

    // ---------- Fetch records ----------
    const records = (await db.inventoryRecord.findMany({
      where,
      orderBy: [
        { week: { periodStart: 'asc' } },
        { outlet: { code: 'asc' } },
        { item: { name: 'asc' } },
      ],
      select: RECORD_SELECT,
    })) as ExportRecord[];

    // ---------- Label periode + nama file ----------
    const monthLabel = targetFile?.monthLabel
      ?? monthWeeks[0]?.sourceFile.monthLabel
      ?? records[0]?.monthLabel
      ?? resolvedMonthKey!;

    const periodSuffix = targetFile
      ? targetFile.fileName.replace(/\.(xlsx|csv)$/i, '')
      : normalizedWeek
        ? `${monthLabel} - ${normalizedWeek}`
        : `${monthLabel} - SEMUA WEEK`;
    const fileName = sanitizeFileName(`DATABASE - ${periodSuffix}.xlsx`)
      .replace(/\.(xlsx|csv)$/i, '') + '.xlsx';

    // ---------- Build workbook (exceljs di-import dinamis — 23MB,
    // konvensi PERF-FASE4-INFRA12 dari src/lib/excel.ts) ----------
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Inventory Control';
    wb.created = new Date();

    // --- Sheet DATA: format kolom Excel sumber (re-importable) ---
    const ws = wb.addWorksheet('DATA', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    ws.columns = EXPORT_COLUMNS.map(c => ({ header: c.header, width: c.width }));
    for (const r of records) {
      ws.addRow(EXPORT_COLUMNS.map(c => c.get(r)));
    }
    // Autofilter + header styling (1 baris saja — murah walaupun 54K rows).
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: EXPORT_COLUMNS.length },
    };
    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF166534' }, // hijau tua — tema "unduh database"
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    headerRow.height = 28;

    // --- Sheet INFO: metadata export untuk audit ---
    const info = wb.addWorksheet('INFO');
    info.columns = [
      { header: 'Properti', width: 26 },
      { header: 'Nilai', width: 64 },
    ];
    const titleCell = info.getCell('A1');
    titleCell.value = 'DATABASE EXPORT — INVENTORY CONTROL';
    titleCell.font = { bold: true, size: 13 };
    info.mergeCells(1, 1, 1, 2);

    const targetWeeks = normalizedWeek
      ? monthWeeks.filter(w => w.weekLabel === normalizedWeek)
      : monthWeeks;
    const uniqueOutlets = new Set(records.map(r => r.outlet?.code));
    const uniqueItems = new Set(records.map(r => r.item?.name));
    const sourceFiles = [
      ...new Map(
        (targetFile ? monthWeeks : targetWeeks)
          .map(w => w.sourceFile)
          .map(sf => [sf.fileName, sf] as const),
      ).values(),
    ];

    const infoRows: [string, string][] = [
      ['Periode', targetFile ? targetFile.fileName : `${monthLabel}${normalizedWeek ? ` — ${normalizedWeek}` : ' — SEMUA WEEK'}`],
      [
        'Rentang tanggal',
        normalizedWeek && targetWeeks[0]
          ? `Tanggal ${targetWeeks[0].periodStart}–${targetWeeks[targetWeeks.length - 1].periodEnd} (kumulatif)`
          : 'Seluruh bulan (semua week)',
      ],
      ['Jumlah record', recordCount.toLocaleString('id-ID')],
      ['Jumlah outlet unik', String(uniqueOutlets.size)],
      ['Jumlah item unik', String(uniqueItems.size)],
      ['Week termasuk', targetWeeks.map(w => w.weekLabel).join(', ') || '-'],
      ['Jumlah source file', String(sourceFiles.length)],
      ...sourceFiles.map(sf => [
        `  ↳ ${sf.fileName}`,
        `${sf.rowCount.toLocaleString('id-ID')} baris · diimport ${new Date(sf.importedAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`,
      ] as [string, string]),
      ['Digenerate', new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })],
    ];
    infoRows.forEach(([k, v], i) => {
      const row = info.getRow(3 + i);
      row.getCell(1).value = k;
      row.getCell(2).value = v;
      if (!k.startsWith('  ')) row.getCell(1).font = { bold: true, size: 10 };
    });

    // ---------- Response ----------
    const buffer = await wb.xlsx.writeBuffer();
    // Fallback ASCII untuk header Content-Disposition (fileName* UTF-8 tetap
    // akurat untuk nama non-ASCII).
    const asciiName = fileName.replace(/[^\x20-\x7E]/g, '_');
    return new NextResponse(new Uint8Array(buffer) as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        // Periode sama = data sama sampai re-import berikutnya — caching CDN
        // 5 menit sekelas /api/export-report.
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600, must-revalidate',
        'X-Record-Count': String(recordCount),
      },
    });
  } catch (e: unknown) {
    return errorResponse(e, 'export-db');
  }
}

// ------------------------------------------------------------
//  Mode 1 — daftar periode untuk picker UI (bulan × week + count)
// ------------------------------------------------------------
async function listPeriods(): Promise<NextResponse> {
  // _count.select.records → COUNT(*) per Week via relasi (satu query).
  const weeks = await db.week.findMany({
    select: {
      weekLabel: true,
      monthKey: true,
      periodStart: true,
      periodEnd: true,
      sourceFile: { select: { monthLabel: true } },
      _count: { select: { records: true } },
    },
    orderBy: [{ monthKey: 'desc' }, { periodStart: 'asc' }],
  });

  // Group by monthKey (bukan monthLabel — mixed-case "Juli 2026"/"JULI 2026"
  // akan memecah grup; konvensi FIX DEEP-AUDIT-API-4 di /api/data).
  const byMonth = new Map<
    string,
    {
      monthKey: string;
      monthLabel: string;
      totalRecords: number;
      weeks: { weekLabel: string; periodStart: number; periodEnd: number; recordCount: number }[];
    }
  >();
  for (const w of weeks) {
    let entry = byMonth.get(w.monthKey);
    if (!entry) {
      entry = {
        monthKey: w.monthKey,
        monthLabel: w.sourceFile.monthLabel,
        totalRecords: 0,
        weeks: [],
      };
      byMonth.set(w.monthKey, entry);
    }
    entry.weeks.push({
      weekLabel: w.weekLabel,
      periodStart: w.periodStart,
      periodEnd: w.periodEnd,
      recordCount: w._count.records,
    });
    entry.totalRecords += w._count.records;
  }

  return NextResponse.json(
    { success: true, periods: [...byMonth.values()] },
    { headers: CACHE_METADATA },
  );
}
