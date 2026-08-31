// ============================================================
//  Ingestion — processRowsForImport() Import Flow
//  --------------------------------------------------------
//  Per-week / per-batch row-processing path used by
//  /api/ingest-process. Takes raw rows, validates + normalizes
//  + derives records, ensures outlet/item exist (race-safe
//  upserts, BUG-5-5), batch-inserts InventoryRecords, then
//  pre-computes OutletPeriodSales MODE for the sourceFileId
//  (DRY: computeOutletPeriodSales).
//
//  P2 fix: shared logic for ImportService unification — both
//  processIngestion (full file) and ingest-process (per-week)
//  historically used ~150 LOC of duplicate logic. This function
//  is the per-week variant.
//
//  INVARIANTS:
//   - BUG2-INGEST-3: tx propagation — if caller passes a `tx`
//     (Prisma.TransactionClient), all writes use it so they
//     roll back on failure. Falls back to global `db` only when
//     no tx is provided (legacy non-transactional callers).
//   - BUG-5-5: outlet + item creation use upsert (ON CONFLICT
//     DO UPDATE) to avoid P2002 under concurrent imports.
// ============================================================
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { normalizeRow, deriveRecord, type NumberLocale } from '@/engine/transform';
import { validateRow, type DQIssueRow } from '@/engine/validator';
import { computeOutletPeriodSales } from './outlet-period-sales';
import type { ProcessRowsResult } from './types';

/**
 * Process rows for import — shared logic for both full-file and per-week ingestion.
 *
 * Takes raw rows, validates + normalizes + derives + ensures outlet/item exists,
 * batch inserts InventoryRecords, returns insertion count + DQ issues.
 *
 * @param rows - Raw rows from Excel/CSV parse
 * @param sourceFileId - SourceFile.id for this import
 * @param weekId - Week.id for these rows
 * @param fileName - Original filename (for normalizeRow)
 * @param monthLabel - Month label (e.g., "MEI 2026")
 * @param startRowNumber - Row number offset (for multi-week imports)
 * @param outletDbMap - Pre-populated outlet cache (code → id)
 * @param itemDbMap - Pre-populated item cache (name → {id, satuan})
 * @param seenKeys - Set of seen (outlet+item+week) keys for dedup
 * @param fastMode - When true, skip validateRow() + DQ issue tracking (pure import, ~3-5x faster)
 * @param numberLocale - Number format locale ('auto' | 'id' | 'us') for CSV separator parsing
 * @param tx - Optional Prisma transaction client. When provided, all DB writes (outlet/item upserts,
 *             inventoryRecord createMany) use this transaction client. This enables the caller to
 *             wrap delete + insert in a single atomic transaction (FIX BUG2-INGEST-3: prevents
 *             data loss if createMany fails after deleteMany succeeds).
 * @returns { inserted, skippedErrors, dqIssues }
 */
export async function processRowsForImport(
  rows: Array<Record<string, unknown> & { _sheetName?: string }>,
  sourceFileId: number,
  weekId: number,
  fileName: string,
  monthLabel: string,
  startRowNumber: number = 0,
  outletDbMap?: Map<string, number>,
  itemDbMap?: Map<string, { id: number; satuan: string | null }>,
  seenKeys?: Set<string>,
  fastMode?: boolean,
  numberLocale?: NumberLocale,
  tx?: Prisma.TransactionClient,
): Promise<ProcessRowsResult> {
  // FIX (BUG2-INGEST-3): Use the transaction client if provided, otherwise fall back to the
  // global db client. This allows the caller to wrap delete + insert in a single atomic
  // transaction so that if createMany fails, the preceding deleteMany is rolled back.
  const client = tx ?? db;
  const _outletDbMap = outletDbMap ?? new Map<string, number>();
  const _itemDbMap = itemDbMap ?? new Map<string, { id: number; satuan: string | null }>();
  const _seenKeys = seenKeys ?? new Set<string>();
  const allIssues: DQIssueRow[] = [];
  const BATCH_SIZE = 500;
  let batchRecords: Prisma.InventoryRecordCreateManyInput[] = [];
  let inserted = 0;
  let skippedErrors = 0;

  for (let i = 0; i < rows.length; i++) {
    const rawRow = rows[i];
    const rowNumber = startRowNumber + i + 1;

    // FAST MODE: skip validateRow() entirely — pure normalize + derive + insert.
    // Validation can be run separately later via /api/dq-check (or similar).
    // ~3-5x faster because validateRow() is the bottleneck for large files.
    if (!fastMode) {
      const issues = validateRow(rawRow, rowNumber, _seenKeys, rawRow._sheetName, numberLocale || 'auto');
      allIssues.push(...issues);

      const hasError = issues.some((iss) => iss.severity === 'ERROR');
      if (hasError) {
        skippedErrors++;
        continue;
      }
    }

    const n = normalizeRow(rawRow, fileName, rowNumber, monthLabel, numberLocale || 'auto');
    const derived = deriveRecord(n);

    // FIX-A-4 (BUG-5-5): Race-safe outlet creation — use upsert instead of
    // findUnique + create. Two concurrent imports of different weeks for the
    // same NEW outlet code previously raced: both findUnique miss → both create →
    // P2002 unique constraint violation → entire week import fails.
    // Upsert is atomic: if the row exists, update area/name if changed; if not,
    // create it. Either way, no P2002.
    if (derived.outletCode && !_outletDbMap.has(derived.outletCode)) {
      const outlet = await client.outlet.upsert({
        where: { code: derived.outletCode },
        // LOGIC-12 fix: update area + name if outlet moved to different area.
        update: n.area ? { area: n.area, name: derived.outletName } : {},
        create: {
          code: derived.outletCode,
          name: derived.outletName,
          outletCode: derived.outletNumericCode,
          area: n.area,
        },
        select: { id: true },
      });
      _outletDbMap.set(derived.outletCode, outlet.id);
    }

    // FIX-A-4 (BUG-5-5): Race-safe item creation — use upsert instead of
    // findUnique + create to handle concurrent imports of the same new item.
    // Preserves the original behavior of back-filling `satuan` on existing items
    // when the DB row has null satuan and the current row provides one.
    if (n.namaBahan && !_itemDbMap.has(n.namaBahan)) {
      const item = await client.item.upsert({
        where: { name: n.namaBahan },
        // If existing item has no satuan, fill it from the current row.
        // (Prisma returns the row AFTER the upsert, so the returned satuan is the
        // post-update value — either the newly-filled one or the pre-existing one.)
        update: n.satuan ? { satuan: n.satuan } : {},
        create: { name: n.namaBahan, satuan: n.satuan },
        select: { id: true, satuan: true },
      });
      _itemDbMap.set(n.namaBahan, { id: item.id, satuan: item.satuan });
    }

    const outletId = _outletDbMap.get(derived.outletCode) ?? 0;
    const itemEntry = _itemDbMap.get(n.namaBahan);
    const itemId = itemEntry?.id ?? 0;

    if (weekId > 0 && outletId > 0 && itemId > 0) {
      batchRecords.push({
        sourceFileId, weekId, outletId, itemId,
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

    if (batchRecords.length >= BATCH_SIZE) {
      // FIX DB2-2: skipDuplicates is PostgreSQL-only — try/catch fallback for SQLite
      // FIX (BUG2-INGEST-3): use `client` (tx if provided) so this is part of the caller's transaction.
      let result;
      try {
        result = await client.inventoryRecord.createMany({ data: batchRecords, skipDuplicates: true });
      } catch {
        let count = 0;
        for (const rec of batchRecords) {
          try { await client.inventoryRecord.create({ data: rec }); count++; } catch {}
        }
        result = { count };
      }
      inserted += result.count;
      batchRecords = [];
    }
  }

  if (batchRecords.length > 0) {
    // FIX (BUG2-INGEST-3): use `client` (tx if provided) so this is part of the caller's transaction.
    let result2;
    try {
      result2 = await client.inventoryRecord.createMany({ data: batchRecords, skipDuplicates: true });
    } catch {
      let count = 0;
      for (const rec of batchRecords) {
        try { await client.inventoryRecord.create({ data: rec }); count++; } catch {}
      }
      result2 = { count };
    }
    inserted += result2.count;
  }

  // API-02 FIX: Pre-compute sales MODE per (outlet, period) — same as processIngestion STEP 3.5.
  // Without this, UI uploads (FileUploadDialog → /api/ingest-process) leave OutletPeriodSales
  // empty → "Top by Sales" widget blank, peer comparison broken, sales=0 everywhere.
  //
  // DRY (Task 4-b): the SQL is now centralized in computeOutletPeriodSales() — both
  // processIngestion and processRowsForImport invoke it. Byte-identical to the
  // original inline block (was duplicated verbatim L761-792 here and L479-510
  // in process-ingestion).
  //
  // FIX (BUG2-INGEST-3): pass `client` (tx if provided) so this is part of the
  // caller's transaction. The helper is signature-compatible with both
  // Prisma.TransactionClient and PrismaClient (Proxy).
  await computeOutletPeriodSales(client, sourceFileId);

  return { inserted, skippedErrors, dqIssues: allIssues };
}
