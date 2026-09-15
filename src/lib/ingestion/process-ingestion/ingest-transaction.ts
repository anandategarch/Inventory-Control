// ============================================================
//  processIngestion — the atomic ingestion transaction
//  ----------------------------------------------------------
//  BUG2-INGEST-1 atomic core: dedup-delete + SourceFile create +
//  master-data resolution + batch insert + DQ + sales precompute,
//  all inside ONE db.$transaction. Shared mutable state that the
//  orchestrator also touches (allIssues) is passed by reference —
//  identical to the original closure flow.
//
//  SPLIT-D (pure code motion): extracted verbatim from
//  src/lib/ingestion/process-ingestion.ts (old file deleted;
//  './process-ingestion' from the ingestion barrel now resolves to
//  this folder's index.ts — same import path for every caller).
// ============================================================
import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { logger } from '../../logger';
import { CFG_RECON_SETTINGS } from '@/config/settings';
import { ensureOutletsExist, ensureItemsExist, type OutletCandidate } from '../process-rows-for-import';
import { acquireDbAdvisoryLock } from '../ingestion-lock';
import { computeOutletPeriodSales } from '../outlet-period-sales';
import { insertInventoryRecords } from '../batch-insert';
import { summarizeDQ, type DQIssueRow } from '@/engine/validator';
import type { PreparedRow } from './prepare-rows';

export interface IngestTransactionArgs {
  filePath: string;
  fileName: string;
  fileHash: string;
  monthLabel: string;
  monthKey: string;
  fastMode?: boolean;
  /** PASS 1's error-skip count — returned unchanged (raced branch returns 0). */
  skippedErrors: number;
  prepared: PreparedRow[];
  outletCandidates: Map<string, OutletCandidate>;
  itemCandidates: Map<string, string | null>;
  outletDbMap: Map<string, number>;
  itemDbMap: Map<string, { id: number; satuan: string | null }>;
  /** mutated here (PASS 3 DUPLICATE warnings) and read by the orchestrator */
  allIssues: DQIssueRow[];
}

export interface IngestTransactionResult {
  totalInserted: number;
  skippedErrors: number;
  /** AUDIT-BUG-3 natural-key dup skips — surfaced so the orchestrator can log them */
  skippedDuplicates: number;
  dq: ReturnType<typeof summarizeDQ>;
  duplicateOf?: { id: number; rowCount: number };
}

export async function runIngestTransaction(args: IngestTransactionArgs): Promise<IngestTransactionResult> {
  const {
    filePath, fileName, fileHash, monthLabel, monthKey, fastMode,
    skippedErrors, prepared, outletCandidates, itemCandidates,
    outletDbMap, itemDbMap, allIssues,
  } = args;

  // FIX (AUDIT-BUG-3): in-memory natural-key dedup — PostgreSQL unique indexes
  // treat NULL ≠ NULL, so rows with akunPenyesuaian = NULL escape BOTH the
  // @@unique([weekId, outletId, itemId, akunPenyesuaian]) constraint AND
  // createMany({skipDuplicates}) until the NULL-safe index from
  // scripts/fix-null-akun-duplicates.ts is applied. fastMode (and the
  // always-fastMode /api/ingest-process path) also skips validateRow's
  // seenKeys DUPLICATE check → this Set is the last line of defense.
  // Key mirrors the NULL-safe index expression: COALESCE(akun, '').
  const naturalKeys = new Set<string>();
  let skippedDuplicates = 0;
  const weekDbMap = new Map<string, number>();

  // FIX (BUG2-INGEST-1): Wrap dedup-delete + create + insert + update + DQ in a
  // single transaction so that if ANY step fails, ALL writes are rolled back.
  // Previously, the delete happened BEFORE the create/insert — a failure mid-insert
  // meant the old data was already gone (data loss). Now the delete is inside the
  // transaction, so it only commits if the entire insert succeeds.
  //
  // 240s timeout: import-drive maxDuration is 300s; ingest maxDuration is 30s.
  // For /api/ingest (30s), Vercel will kill the function before the transaction
  // timeout — PostgreSQL will then roll back automatically when the connection drops.
  // For /api/import-drive (300s), the 240s timeout gives headroom for post-tx work
  // (cache invalidation).
  const { totalInserted, dq, duplicateOf } = await db.$transaction(
    async (tx) => {
      // FIX (AUDIT-BUG-5): FIRST statement — transaction-scoped PostgreSQL advisory
      // lock keyed on monthKey. Serializes concurrent imports of the same month
      // ACROSS instances (the in-memory Set only guards one process; serverless
      // runs many). xact-scoped → auto-released at COMMIT/ROLLBACK, even on crash.
      // Best-effort no-op on non-PG backends (see ingestion-lock.ts).
      await acquireDbAdvisoryLock(tx, monthKey);

      // FIX (AUDIT-BUG-5): re-check the file hash INSIDE the lock. A concurrent
      // import may have committed this exact file between the unlocked check
      // above and the lock acquisition — without this re-check both imports
      // would run delete+insert interleaved. Skipping here is correct: the
      // data is already in, verified by the row count below.
      const racedFile = await tx.sourceFile.findUnique({
        where: { fileHash },
        select: { id: true },
      });
      if (racedFile) {
        const racedCount = await tx.inventoryRecord.count({
          where: { sourceFileId: racedFile.id },
        });
        if (racedCount > 0) {
          return {
            totalInserted: 0, skippedErrors: 0,
            dq: { summary: [], severityCounts: { ERROR: 0, WARNING: 0, INFO: 0 }, status: 'OK' as const },
            duplicateOf: { id: racedFile.id, rowCount: racedCount },
          };
        }
        // Stale stub (0 records) committed by a concurrent failed import →
        // purge it here, inside the lock, then proceed with our import.
        await tx.dQIssue.deleteMany({ where: { sourceFileId: racedFile.id } });
        await tx.inventoryRecord.deleteMany({ where: { sourceFileId: racedFile.id } });
        await tx.week.deleteMany({ where: { sourceFileId: racedFile.id } });
        await tx.sourceFile.delete({ where: { id: racedFile.id } });
      }

      // STEP 1 (deferred): Delete old SourceFiles for the same monthKey/monthLabel.
      // This runs INSIDE the transaction so it's rolled back if the insert fails.
      // FIX (AUDIT-BUG-5): the list is queried AFTER the advisory lock so a
      // concurrent import's commit is visible here (no stale snapshot → no
      // leftover second SourceFile for the month).
      const existingPeriodFiles = monthKey !== 'unknown'
        ? await tx.sourceFile.findMany({
            where: { monthKey },
            select: { id: true, fileName: true },
          })
        : await tx.sourceFile.findMany({
            where: { monthLabel },
            select: { id: true, fileName: true },
          });
      if (existingPeriodFiles.length > 0) {
        const oldIds = existingPeriodFiles.map(f => f.id);
        await tx.dQIssue.deleteMany({ where: { sourceFileId: { in: oldIds } } });
        await tx.inventoryRecord.deleteMany({ where: { sourceFileId: { in: oldIds } } });
        await tx.week.deleteMany({ where: { sourceFileId: { in: oldIds } } });
        await tx.sourceFile.deleteMany({ where: { id: { in: oldIds } } });
      }

      // STEP 2: Create SourceFile record
      const sourceFile = await tx.sourceFile.create({
        data: {
          fileName, filePath,
          monthLabel, monthKey, fileHash,
          rowCount: 0, dqStatus: 'OK',
        },
      });

      const BATCH_SIZE = 2000;
      let batchRecords: Prisma.InventoryRecordCreateManyInput[] = [];
      let totalInserted = 0;

      // ============================================================
      // STEP 2.5 (PERF PAKET B / F3) — PASS 2: set-based master-data
      // resolution (2-6 queries total, replacing the old per-row lazy
      // upserts). Uses the exact same race-safe helpers as the
      // /api/ingest-process path: BUG-5-5 parity (skipDuplicates =
      // ON CONFLICT DO NOTHING), LOGIC-12 parity (area/name refresh
      // only when actually changed), satuan backfill only when DB NULL.
      // ============================================================
      await ensureOutletsExist(tx, outletDbMap, outletCandidates);
      await ensureItemsExist(tx, itemDbMap, itemCandidates);

      // Weeks (only 3-4 unique labels per file) — resolve up front too.
      // FIX: Use CUMULATIVE week periods from config (W1=1-7, W2=1-14, W3=1-21, W4=1-25)
      // Previously: inline duplicate with WRONG discrete ranges (W2=8-14, W3/4=15-31)
      const uniqueWeekLabels = [...new Set(prepared.map((p) => p.n.weekLabel || 'UNKNOWN'))];
      for (const wk of uniqueWeekLabels) {
        if (weekDbMap.has(wk)) continue;
        let p = CFG_RECON_SETTINGS.WEEK_PERIODS[wk];
        if (!p) {
          // Derive for WEEK 5+ (rare): cumulative up to min(N*7, 31)
          const weekNum = parseInt(wk.replace(/\D/g, '')) || 1;
          p = { start: 1, end: Math.min(weekNum * 7, 31) };
          logger.warn(`Unknown weekLabel "${wk}", derived cumulative period ${p.start}-${p.end}`);
        }
        const w = await tx.week.upsert({
          where: { sourceFileId_weekLabel: { sourceFileId: sourceFile.id, weekLabel: wk } },
          update: {},
          create: {
            sourceFileId: sourceFile.id, weekLabel: wk,
            weekKey: `${monthKey}-${wk.replace(/\s+/g, '')}`,
            monthKey, periodStart: p.start, periodEnd: p.end,
          },
        });
        weekDbMap.set(wk, w.id);
      }

      // ============================================================
      // PASS 3 — enqueue + batch insert (pure Map lookups, zero
      // per-row master-data DB queries).
      // ============================================================
      for (const { rowNumber, n, derived } of prepared) {
        // Get IDs from cache (O(1) Map lookup, no DB query)
        const wk = n.weekLabel || 'UNKNOWN';
        const weekId = weekDbMap.get(wk) ?? 0;
        const outletId = outletDbMap.get(derived.outletCode) ?? 0;
        const itemEntry = itemDbMap.get(n.namaBahan);
        const itemId = itemEntry?.id ?? 0;

        if (weekId > 0 && outletId > 0 && itemId > 0) {
          // FIX (AUDIT-BUG-3): natural-key dedup BEFORE enqueueing — see the
          // naturalKeys declaration above. First occurrence wins (mirrors
          // ON CONFLICT DO NOTHING). fastMode: only counted (DQ validation is
          // off); non-fastMode: also surfaced as a WARNING DQ issue.
          const naturalKey = `${weekId}|${outletId}|${itemId}|${n.akunPenyesuaian ?? ''}`;
          if (naturalKeys.has(naturalKey)) {
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
          naturalKeys.add(naturalKey);
          batchRecords.push({
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
            direction: derived.direction, residualQty: derived.residualQty, residualNominal: derived.residualNominal,
            residualRatio: derived.residualRatio, absQtyDeviasi: derived.absQtyDeviasi,
            absNominalDeviasi: derived.absNominalDeviasi, absQtyLossSurplus: derived.absQtyLossSurplus,
            absNominalLossSurplus: derived.absNominalLossSurplus,
            area: n.area, bulan: n.bulan, bulan2: n.bulan2, weekLabel: n.weekLabel, monthLabel: n.monthLabel,
          });
        }

        // Batch insert
        if (batchRecords.length >= BATCH_SIZE) {
          // BUG-06 fix: createMany returns { count: N } — use actual count, not batch length
          // FIX (AUDIT-BUG-4): insertInventoryRecords — duplicates (P2002 / ON
          // CONFLICT) are skipped + counted; every OTHER error is rethrown so
          // this transaction rolls back. The old per-row `catch {}` here silently
          // dropped rows on connection/timeout/data errors (import "succeeded"
          // with missing data).
          const result = await insertInventoryRecords(tx, batchRecords);
          totalInserted += result.inserted;
          batchRecords = [];
        }
      }

      // Insert remaining records
      if (batchRecords.length > 0) {
        // FIX (AUDIT-BUG-4): same error-strict semantics for the final flush.
        const result2 = await insertInventoryRecords(tx, batchRecords);
        totalInserted += result2.inserted;
      }

      // STEP 4: Update source file record
      // FAST MODE: skip summarizeDQ() — return empty DQ summary (OK, 0 errors, 0 warnings).
      // Validation can be run separately later and update these counts.
      const dq = fastMode
        ? { summary: [], severityCounts: { ERROR: 0, WARNING: 0, INFO: 0 }, status: 'OK' as const }
        : summarizeDQ(allIssues);
      await tx.sourceFile.update({
        where: { id: sourceFile.id },
        data: {
          rowCount: totalInserted,
          dqStatus: dq.status,
          dqErrorCount: dq.severityCounts.ERROR,
          dqWarningCount: dq.severityCounts.WARNING,
        },
      });

      // STEP 3.5 (DB-06): Pre-compute sales MODE per (outlet, period).
      // Replaces the duplicated `sales_counts → ranked_sales → sales_mode`
      // CTE pipeline inlined across 10+ query call sites
      // (areas.ts, dashboard.ts, outlets/*.ts, health-ranking.ts,
      // /api/peer-comparison/items). The MODE is computed exactly the
      // same way as the inline CTE (ROW_NUMBER OVER PARTITION BY
      // outlet+period ORDER BY COUNT(*) DESC, nominalSales ASC WHERE
      // rn=1, with smaller-value-wins tie-break) — see
      // scripts/backfill-outlet-period-sales.ts for parity validation.
      //
      // Source-filtered to this ingestion's records only; ON CONFLICT
      // DO UPDATE handles the (rare) case where the same (outlet, period)
      // appears in multiple SourceFiles (latest wins). Cascade-deleted
      // with the parent SourceFile at re-ingest time.
      //
      // Cost: ~50-150ms (single INSERT...SELECT over ~13K rows).
      // Negligible vs total ingest time of 5-15s.
      //
      // DRY (Task 4-b): the SQL is now centralized in
      // computeOutletPeriodSales() — both processIngestion and
      // processRowsForImport invoke it. Byte-identical to the original
      // inline block (was duplicated verbatim L479-510 here and
      // L761-792 in process-rows-for-import).
      await computeOutletPeriodSales(tx, sourceFile.id);

      // Insert DQ issues — skip entirely in fast mode (allIssues stays empty).
      if (!fastMode && allIssues.length > 0) {
        const dqRecords = allIssues.map((i) => ({
          sourceFileId: sourceFile.id, severity: i.severity, code: i.code,
          message: i.message, rawValue: i.rawValue ?? null, rowNumber: i.rowNumber ?? null,
          sheetName: i.sheetName ?? null, // P1-9 fix
        }));
        for (let i = 0; i < dqRecords.length; i += 500) {
          await tx.dQIssue.createMany({ data: dqRecords.slice(i, i + 500) });
        }
      }

      return { totalInserted, skippedErrors, dq, duplicateOf: undefined };
    },
    { timeout: 240_000, maxWait: 10_000 },
  );

  return { totalInserted, skippedErrors, dq, duplicateOf, skippedDuplicates };
}
