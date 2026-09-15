// ============================================================
//  Ingestion — processRowsForImport() Import Flow
//  --------------------------------------------------------
//  Per-week / per-batch row-processing path used by
//  /api/ingest-process. Takes raw rows, validates + normalizes
//  + derives records, ensures outlet/item exist (race-safe,
//  BUG-5-5), batch-inserts InventoryRecords, then pre-computes
//  OutletPeriodSales MODE for the sourceFileId (DRY:
//  computeOutletPeriodSales).
//
//  P2 fix: shared logic for ImportService unification — both
//  processIngestion (full file) and ingest-process (per-week)
//  historically used ~150 LOC of duplicate logic. This function
//  is the per-week variant.
//
//  PERF-IMPORT-2 (bulk master-data resolution): the old loop
//  issued a sequential awaited `outlet.upsert` / `item.upsert`
//  on the FIRST row where each new code/name appeared — with
//  333 outlets + 109 items that is ~442 network round trips
//  INSIDE the interactive transaction (5-15ms each through the
//  Supabase transaction pooler → 3-8s of pure latency per
//  import, repeated on EVERY upload because the maps start
//  empty per request). The flow is now three passes:
//    PASS 1 (CPU): validate + normalize + derive all rows,
//                  collecting distinct outlet/item candidates.
//    PASS 2 (DB):  resolve ALL outlets/items with 2-6 set-based
//                  queries (findMany IN + createMany for missing).
//    PASS 3 (DB):  enqueue + batch-insert with pure Map lookups
//                  (zero per-row master-data queries).
//
//  INVARIANTS:
//   - BUG2-INGEST-3: tx propagation — if caller passes a `tx`
//     (Prisma.TransactionClient), all writes use it so they
//     roll back on failure. Falls back to global `db` only when
//     no tx is provided (legacy non-transactional callers).
//   - BUG-5-5: outlet + item creation uses createMany with
//     skipDuplicates (ON CONFLICT DO NOTHING) to avoid P2002
//     under concurrent imports — same tolerance as the old
//     per-row upserts.
//   - LOGIC-12: existing outlets get area+name refreshed when the
//     first-seen row's values actually differ (the old upsert
//     wrote them unconditionally; outcome-identical, fewer writes).
//   - AUDIT-BUG-3: in-memory natural-key dedup — NULL akunPenyesuaian
//     rows escape the DB unique constraint (NULL ≠ NULL in PG) and
//     fastMode skips validateRow's seenKeys check.
//   - AUDIT-BUG-4: insertInventoryRecords — per-row insert failures are
//     either counted duplicates (P2002) or RETHROWN (no silent data loss).
// ============================================================
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { normalizeRow, deriveRecord, type NumberLocale } from '@/engine/transform';
import { validateRow, type DQIssueRow } from '@/engine/validator';
import { computeOutletPeriodSales } from './outlet-period-sales';
import { insertInventoryRecords } from './batch-insert';
import type { ProcessRowsResult } from './types';
import { logger } from '../logger';

type NormalizedRow = ReturnType<typeof normalizeRow>;
type Derived = ReturnType<typeof deriveRecord>;

/** PASS-1 output: one CPU-normalized row (no DB touched yet). */
interface PreparedRow {
  rowNumber: number;
  n: NormalizedRow;
  derived: Derived;
}

/** Distinct outlet to resolve (first-seen row wins, matching old upsert-on-first-encounter). */
// PERF (PAKET B / F3): exported so process-ingestion/ (the /api/ingest &
// import-drive path — a folder since the SPLIT-D code-motion split) can
// reuse the exact same set-based resolution helpers.
export interface OutletCandidate {
  code: string;
  name: string;
  outletCode: string;
  area: string;
}

/**
 * PASS 2 helper — resolve every distinct outlet code in ≤4 set-based queries:
 * findMany(existing) → [update only changed] → createMany(missing, skipDuplicates)
 * → findMany(created ids). Replaces ~333 sequential upsert round trips.
 */
export async function ensureOutletsExist(
  client: Prisma.TransactionClient,
  outletDbMap: Map<string, number>,
  candidates: Map<string, OutletCandidate>,
): Promise<void> {
  // Only resolve codes the caller's pre-populated map doesn't already cover.
  const codes = [...candidates.keys()].filter((c) => !outletDbMap.has(c));
  if (codes.length === 0) return;

  const existing = await client.outlet.findMany({
    where: { code: { in: codes } },
    select: { id: true, code: true, area: true, name: true },
  });
  const existingByCode = new Map(existing.map((o) => [o.code, o]));

  let updated = 0;
  for (const code of codes) {
    const found = existingByCode.get(code);
    if (!found) continue;
    outletDbMap.set(code, found.id);
    const cand = candidates.get(code)!;
    // LOGIC-12 parity: refresh area+name only when they actually differ
    // (the old upsert rewrote them on every import — same end state, but
    // ~333 no-op UPDATEs per upload).
    if (cand.area && (found.area !== cand.area || found.name !== cand.name)) {
      await client.outlet.update({ where: { code }, data: { area: cand.area, name: cand.name } });
      updated++;
    }
  }
  if (updated > 0) logger.info(`process-rows: refreshed area/name for ${updated} existing outlet(s)`);

  const missing = codes.filter((c) => !existingByCode.has(c));
  if (missing.length > 0) {
    // BUG-5-5 parity: skipDuplicates (= ON CONFLICT DO NOTHING) tolerates a
    // concurrent creator exactly like the old per-row upsert did.
    await client.outlet.createMany({
      data: missing.map((c) => {
        const cand = candidates.get(c)!;
        return { code: c, name: cand.name, outletCode: cand.outletCode, area: cand.area };
      }),
      skipDuplicates: true,
    });
    // Refetch to obtain ids (also covers rows a concurrent transaction
    // created between our findMany and createMany).
    const created = await client.outlet.findMany({
      where: { code: { in: missing } },
      select: { id: true, code: true },
    });
    for (const o of created) outletDbMap.set(o.code, o.id);
  }
}

/**
 * PASS 2 helper — resolve every distinct item name in ≤3 set-based queries.
 * Replaces ~109 sequential upsert round trips. Existing items keep their
 * satuan; it is back-filled only when the DB row has NULL satuan and the
 * first-seen row provides one (the documented intent of the old upsert).
 */
export async function ensureItemsExist(
  client: Prisma.TransactionClient,
  itemDbMap: Map<string, { id: number; satuan: string | null }>,
  candidates: Map<string, string | null>,
): Promise<void> {
  const names = [...candidates.keys()].filter((nm) => !itemDbMap.has(nm));
  if (names.length === 0) return;

  const existing = await client.item.findMany({
    where: { name: { in: names } },
    select: { id: true, name: true, satuan: true },
  });
  const existingNames = new Set(existing.map((e) => e.name));

  for (const it of existing) {
    const satuan = candidates.get(it.name) ?? null;
    // Satuan back-fill (see module header): only when DB has NULL and the
    // row provides one. The map must reflect the post-update value.
    if (satuan && !it.satuan) {
      await client.item.update({ where: { name: it.name }, data: { satuan } });
      itemDbMap.set(it.name, { id: it.id, satuan });
    } else {
      itemDbMap.set(it.name, { id: it.id, satuan: it.satuan });
    }
  }

  const missing = names.filter((nm) => !existingNames.has(nm));
  if (missing.length > 0) {
    await client.item.createMany({
      data: missing.map((nm) => ({ name: nm, satuan: candidates.get(nm) ?? null })),
      skipDuplicates: true,
    });
    const created = await client.item.findMany({
      where: { name: { in: missing } },
      select: { id: true, name: true, satuan: true },
    });
    for (const it of created) itemDbMap.set(it.name, { id: it.id, satuan: it.satuan });
  }
}

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
 * @returns { inserted, skippedErrors, dqIssues, skippedDuplicates }
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
  // FIX (AUDIT-BUG-3): in-memory natural-key dedup. PostgreSQL unique indexes
  // treat NULL ≠ NULL, so rows with akunPenyesuaian = NULL escape BOTH the
  // @@unique constraint AND createMany({skipDuplicates}) until the NULL-safe
  // index from scripts/fix-null-akun-duplicates.ts is applied. This path is
  // ALWAYS fastMode (see /api/ingest-process) → validateRow's seenKeys
  // DUPLICATE check never runs → this Set is the last line of defense.
  // Key mirrors the NULL-safe index expression: COALESCE(akun, '').
  const _naturalKeys = new Set<string>();
  let skippedDuplicates = 0;
  const allIssues: DQIssueRow[] = [];
  // PERF-IMPORT-1: 500 → 1000. Each InventoryRecordCreateManyInput carries 42
  // columns → 1000 rows = 42,000 bind parameters, well under PostgreSQL's
  // 65,535 limit. Halves the sequential createMany round trips per week
  // (35K rows: 70 → 35 statements), each paying a full pooler round trip.
  const BATCH_SIZE = 1000;
  let batchRecords: Prisma.InventoryRecordCreateManyInput[] = [];
  let inserted = 0;
  let skippedErrors = 0;

  // ============================================================
  // PASS 1 — CPU only: validate (non-fastMode) + normalize + derive.
  // ============================================================
  const prepared: PreparedRow[] = [];
  const outletCandidates = new Map<string, OutletCandidate>();
  const itemCandidates = new Map<string, string | null>();

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
    prepared.push({ rowNumber, n, derived });

    // First occurrence wins — matches the old upsert-on-first-encounter
    // semantics (later rows for the same code/name never re-upserted).
    if (derived.outletCode && !outletCandidates.has(derived.outletCode)) {
      outletCandidates.set(derived.outletCode, {
        code: derived.outletCode,
        name: derived.outletName,
        outletCode: derived.outletNumericCode,
        area: n.area,
      });
    }
    if (n.namaBahan && !itemCandidates.has(n.namaBahan)) {
      itemCandidates.set(n.namaBahan, n.satuan ?? null);
    }
  }

  // ============================================================
  // PASS 2 — Set-based master-data resolution (2-6 queries total,
  // replacing ~442 sequential per-row upserts).
  // ============================================================
  await ensureOutletsExist(client, _outletDbMap, outletCandidates);
  await ensureItemsExist(client, _itemDbMap, itemCandidates);

  // ============================================================
  // PASS 3 — Enqueue + batch insert (pure Map lookups, zero
  // per-row master-data DB queries).
  // ============================================================
  for (const { rowNumber, n, derived } of prepared) {
    const outletId = _outletDbMap.get(derived.outletCode) ?? 0;
    const itemEntry = _itemDbMap.get(n.namaBahan);
    const itemId = itemEntry?.id ?? 0;

    if (weekId > 0 && outletId > 0 && itemId > 0) {
      // FIX (AUDIT-BUG-3): natural-key dedup BEFORE enqueueing — first
      // occurrence wins (mirrors ON CONFLICT DO NOTHING). fastMode: counted
      // only (returned via skippedDuplicates); non-fastMode: also a WARNING
      // DQ issue so the drop is visible in the DQ report.
      const naturalKey = `${weekId}|${outletId}|${itemId}|${n.akunPenyesuaian ?? ''}`;
      if (_naturalKeys.has(naturalKey)) {
        skippedDuplicates++;
        if (!fastMode) {
          allIssues.push({
            severity: 'WARNING',
            code: 'DUPLICATE',
            message: `Row ${rowNumber}: duplikat natural key ${naturalKey} — baris dilewati`,
            rawValue: naturalKey,
            rowNumber,
          });
        }
        continue;
      }
      _naturalKeys.add(naturalKey);
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
      // FIX (AUDIT-BUG-4): insertInventoryRecords — duplicates (P2002 / ON
      // CONFLICT) are skipped + counted; every OTHER error is rethrown so the
      // caller's transaction rolls back. The old per-row `catch {}` here silently
      // dropped rows on connection/timeout/data errors (import "succeeded"
      // with missing data).
      // FIX (BUG2-INGEST-3): uses `client` (tx if provided) so this is part of
      // the caller's transaction.
      const result = await insertInventoryRecords(client, batchRecords);
      inserted += result.inserted;
      batchRecords = [];
    }
  }

  if (batchRecords.length > 0) {
    // FIX (AUDIT-BUG-4): same error-strict semantics for the final flush.
    // FIX (BUG2-INGEST-3): uses `client` (tx if provided) so this is part of
    // the caller's transaction.
    const result2 = await insertInventoryRecords(client, batchRecords);
    inserted += result2.inserted;
  }

  // API-02 FIX: Pre-compute sales MODE per (outlet, period) — same as processIngestion STEP 3.5.
  // Without this, UI uploads (FileUploadDialog → /api/ingest-process) leave OutletPeriodSales
  // empty → "Top by Sales" widget blank, peer comparison broken, sales=0 everywhere.
  //
  // DRY (Task 4-b): the SQL is now centralized in computeOutletPeriodSales() — both
  // processIngestion and processRowsForImport invoke it.
  //
  // FIX (BUG2-INGEST-3): pass `client` (tx if provided) so this is part of the
  // caller's transaction. The helper is signature-compatible with both
  // Prisma.TransactionClient and PrismaClient (Proxy).
  await computeOutletPeriodSales(client, sourceFileId);

  return { inserted, skippedErrors, dqIssues: allIssues, skippedDuplicates };
}
