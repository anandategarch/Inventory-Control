// ============================================================
//  /api/ingest — Excel file ingestion endpoint
//  Body: { filePath?: string } OR { fileName: string } OR { dir: string }
//  If no body, ingests all .xlsx in DATA_DIR (configurable via env)
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { parseExcelFile, parseMonthFromFilename } from '@/lib/excel';
import { normalizeRow, deriveRecord } from '@/engine/transform';
import { validateRow, summarizeDQ } from '@/engine/validator';
import { parseOutletCode } from '@/lib/outlet';
import path from 'path';
import fs from 'fs/promises';

export const dynamic = 'force-dynamic';

// ============================================================
//  DATA_DIR — configurable via environment variable.
//  Set INVENTORY_DATA_DIR in .env.local to point to your actual data folder.
//  Examples:
//    Windows: INVENTORY_DATA_DIR=C:\KERJA\1. RESTO\99.TOOLS\DATA BASE DEVIASI\DEVIASI_BULANAN
//    Linux:   INVENTORY_DATA_DIR=/home/user/inventory-data
//  If not set, falls back to ./data/inventory relative to project root.
// ============================================================
const DATA_DIR = process.env.INVENTORY_DATA_DIR
  ? path.resolve(process.env.INVENTORY_DATA_DIR)
  : path.resolve(process.cwd(), 'data/inventory');

async function findExcelFiles(dirOverride?: string): Promise<string[]> {
  const dir = dirOverride || DATA_DIR;
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((f) => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$'))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    let files: string[] = [];

    if (body.filePath) {
      // Absolute path to a specific file
      files = [body.filePath];
    } else if (body.dir) {
      // Scan a specific directory (overrides DATA_DIR for this request)
      files = await findExcelFiles(body.dir);
    } else if (body.fileName) {
      // Filename relative to DATA_DIR
      files = [path.join(DATA_DIR, body.fileName)];
    } else {
      // Default: scan DATA_DIR (env-configurable)
      files = await findExcelFiles();
    }

    if (files.length === 0) {
      return NextResponse.json({
        success: false,
        message: `No .xlsx files found in ${DATA_DIR}. Please upload files first.`,
      }, { status: 404 });
    }

    const results: Array<{
      fileName: string;
      status: 'INGESTED' | 'SKIPPED' | 'ERROR';
      rowCount: number;
      dqStatus: string;
      dqErrors: number;
      dqWarnings: number;
      error?: string;
    }> = [];

    for (const filePath of files) {
      try {
        const parsed = await parseExcelFile(filePath);

        const existing = await db.sourceFile.findUnique({
          where: { fileHash: parsed.fileHash },
          select: { id: true, fileName: true, rowCount: true },
        });
        if (existing) {
          // BUG FIX #3: Verify actual records exist (not just SourceFile stub from failed ingest)
          const actualCount = await db.inventoryRecord.count({ where: { sourceFileId: existing.id } });
          if (actualCount > 0) {
            results.push({
              fileName: parsed.fileName, status: 'SKIPPED', rowCount: actualCount,
              dqStatus: 'OK', dqErrors: 0, dqWarnings: 0,
            });
            continue;
          }
          // Stale SourceFile stub from previous failed ingest — clean up and re-ingest
          await db.dQIssue.deleteMany({ where: { sourceFileId: existing.id } });
          await db.inventoryRecord.deleteMany({ where: { sourceFileId: existing.id } });
          await db.week.deleteMany({ where: { sourceFileId: existing.id } });
          await db.sourceFile.delete({ where: { id: existing.id } });
        }

        const monthInfo = parseMonthFromFilename(parsed.fileName);
        const monthLabel = monthInfo?.monthLabel || parsed.fileName.replace(/\.xlsx$/i, '');
        const monthKey = monthInfo?.monthKey || 'unknown';

        const allRows: Array<{ row: Record<string, unknown>; rowNumber: number }> = [];
        for (const sheet of parsed.sheets) {
          sheet.rows.forEach((row, idx) => allRows.push({ row, rowNumber: idx + 2 }));
        }

        const seenKeys = new Set<string>();
        const allIssues: any[] = [];
        for (const { row, rowNumber } of allRows) {
          const issues = validateRow(row, rowNumber, seenKeys);
          allIssues.push(...issues);
        }
        const dq = summarizeDQ(allIssues);

        const sourceFile = await db.sourceFile.create({
          data: {
            fileName: parsed.fileName, filePath: parsed.filePath,
            monthLabel, monthKey, fileHash: parsed.fileHash,
            rowCount: 0, dqStatus: dq.status, // will update after dedup
            dqErrorCount: dq.severityCounts.ERROR, dqWarningCount: dq.severityCounts.WARNING,
          },
        });

        const weekMap = new Map<string, { weekLabel: string; periodStart: number; periodEnd: number }>();
        const outletMap = new Map<string, { code: string; name: string; numericCode: string; area: string }>();
        const itemMap = new Map<string, { name: string; satuan: string | null }>();

        const normalized = allRows.map(({ row, rowNumber }) => {
          const n = normalizeRow(row, parsed.fileName, rowNumber, monthLabel);
          const wk = n.weekLabel || 'UNKNOWN';
          if (!weekMap.has(wk)) {
            const periods: Record<string, { start: number; end: number }> = {
              'WEEK 1': { start: 1, end: 7 }, 'WEEK 2': { start: 8, end: 14 }, 'WEEK 3': { start: 15, end: 31 },
            };
            const p = periods[wk] || { start: 1, end: 31 };
            weekMap.set(wk, { weekLabel: wk, periodStart: p.start, periodEnd: p.end });
          }
          const parsedOutlet = parseOutletCode(n.resto);
          if (parsedOutlet && !outletMap.has(parsedOutlet.fullCode)) {
            outletMap.set(parsedOutlet.fullCode, { code: parsedOutlet.fullCode, name: parsedOutlet.name, numericCode: parsedOutlet.numericCode, area: n.area });
          }
          if (n.namaBahan && !itemMap.has(n.namaBahan)) {
            itemMap.set(n.namaBahan, { name: n.namaBahan, satuan: n.satuan });
          }
          return n;
        });

        const weekDbMap = new Map<string, number>();
        for (const [wkLabel, wk] of weekMap) {
          const w = await db.week.upsert({
            where: { sourceFileId_weekLabel: { sourceFileId: sourceFile.id, weekLabel: wk.weekLabel } },
            update: {},
            create: {
              sourceFileId: sourceFile.id, weekLabel: wk.weekLabel,
              weekKey: `${monthKey}-${wk.weekLabel.replace(/\s+/g, '')}`,
              monthKey, periodStart: wk.periodStart, periodEnd: wk.periodEnd,
            },
          });
          weekDbMap.set(wkLabel, w.id);
        }

        const outletDbMap = new Map<string, number>();
        for (const [code, o] of outletMap) {
          const existing = await db.outlet.findUnique({ where: { code: o.code }, select: { id: true } });
          if (existing) outletDbMap.set(code, existing.id);
          else {
            const created = await db.outlet.create({ data: { code: o.code, name: o.name, outletCode: o.numericCode, area: o.area } });
            outletDbMap.set(code, created.id);
          }
        }

        const itemDbMap = new Map<string, number>();
        for (const [name, it] of itemMap) {
          const existing = await db.item.findUnique({ where: { name: it.name }, select: { id: true, satuan: true } });
          if (existing) {
            itemDbMap.set(name, existing.id);
            if (!existing.satuan && it.satuan) await db.item.update({ where: { id: existing.id }, data: { satuan: it.satuan } });
          } else {
            const created = await db.item.create({ data: { name: it.name, satuan: it.satuan } });
            itemDbMap.set(name, created.id);
          }
        }

        const BATCH = 500;
        // ===== BUG FIX #8: Dedup by natural key (weekId,outletId,itemId,akunPenyesuaian) =====
        // Keep the LAST occurrence (later rows override earlier). This handles duplicate
        // rows in source Excel gracefully instead of crashing on unique constraint.
        const dedupMap = new Map<string, any>();
        for (const n of normalized) {
          const derived = deriveRecord(n);
          const weekId = weekDbMap.get(n.weekLabel) ?? 0;
          const outletId = outletDbMap.get(derived.outletCode) ?? 0;
          const itemId = itemDbMap.get(n.namaBahan) ?? 0;
          if (weekId === 0 || outletId === 0 || itemId === 0) continue;
          const key = `${weekId}|${outletId}|${itemId}|${n.akunPenyesuaian || ''}`;
          dedupMap.set(key, {
            sourceFileId: sourceFile.id,
            weekId, outletId, itemId,
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
            direction: derived.direction, residualQty: derived.residualQty, residualNominal: derived.residualNominal,
            residualRatio: derived.residualRatio, absQtyDeviasi: derived.absQtyDeviasi,
            absNominalDeviasi: derived.absNominalDeviasi, absQtyLossSurplus: derived.absQtyLossSurplus,
            absNominalLossSurplus: derived.absNominalLossSurplus,
            area: n.area, bulan: n.bulan, bulan2: n.bulan2, weekLabel: n.weekLabel, monthLabel: n.monthLabel,
          });
        }
        const allRecords = [...dedupMap.values()];

        for (let i = 0; i < allRecords.length; i += BATCH) {
          const batch = allRecords.slice(i, i + BATCH);
          await db.inventoryRecord.createMany({ data: batch });
        }

        // Update rowCount with actual deduped count
        await db.sourceFile.update({
          where: { id: sourceFile.id },
          data: { rowCount: allRecords.length },
        });

        if (allIssues.length > 0) {
          const dqRecords = allIssues.map((i) => ({
            sourceFileId: sourceFile.id, severity: i.severity, code: i.code,
            message: i.message, rawValue: i.rawValue ?? null, rowNumber: i.rowNumber ?? null,
          }));
          for (let i = 0; i < dqRecords.length; i += 500) {
            await db.dQIssue.createMany({ data: dqRecords.slice(i, i + 500) });
          }
        }

        await db.auditLog.create({
          data: {
            action: 'INGEST', detail: `${parsed.fileName}: ${allRows.length} rows, ${outletMap.size} outlets, ${itemMap.size} items`,
            duration: Date.now() - startedAt,
          },
        });

        results.push({
          fileName: parsed.fileName, status: 'INGESTED', rowCount: allRecords.length,
          dqStatus: dq.status, dqErrors: dq.severityCounts.ERROR, dqWarnings: dq.severityCounts.WARNING,
        });
      } catch (e: any) {
        results.push({
          fileName: path.basename(filePath), status: 'ERROR', rowCount: 0,
          dqStatus: 'ERROR', dqErrors: 1, dqWarnings: 0, error: e?.message || String(e),
        });
      }
    }

    return NextResponse.json({ success: true, results, durationMs: Date.now() - startedAt });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function GET() {
  return POST({ json: async () => ({}) } as NextRequest);
}
