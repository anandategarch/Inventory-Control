// ============================================================
//  Ingestion — OutletPeriodSales MODE Pre-Compute (DRY Helper)
//  --------------------------------------------------------
//  DRY: previously duplicated VERBATIM between
//    - processIngestion  (was inline at ~L479-510, used `tx` + `sourceFile.id`)
//    - processRowsForImport (was inline at ~L761-792, used `client` + `sourceFileId`)
//  Both blocks were byte-identical except for the variable name
//  holding the transaction client + the sourceFile id.
//
//  Extracted here as `computeOutletPeriodSales(tx, sourceFileId)`.
//  SQL is preserved EXACTLY — see STEP 3.5 / API-02 fix comments
//  in the orchestrators for the rationale.
//
//  Computes the MODE of nominalSales per (outlet, month, week)
//  using ROW_NUMBER OVER PARTITION BY ... ORDER BY COUNT(*) DESC,
//  nominalSales ASC, picking rn=1 (with smaller-value-wins tie-
//  break). Source-filtered to the given sourceFileId. ON CONFLICT
//  DO UPDATE handles the (rare) case where the same (outlet, period)
//  appears in multiple SourceFiles (latest wins).
//
//  Cost: ~50-150ms (single INSERT...SELECT over ~13K rows).
//  Negligible vs total ingest time of 5-15s.
//
//  INVARIANTS:
//   - BUG2-INGEST-3: takes the caller's transaction client (`tx`)
//     so the INSERT is part of the caller's atomic transaction.
//     DO NOT use the global `db` here — that would break the
//     rollback boundary.
//   - The caller's transaction wraps delete → insert → this helper
//     → DQ issue insert → SourceFile update — all atomic.
// ============================================================
import { Prisma } from '@prisma/client';

/**
 * Pre-compute sales MODE per (outlet, period) for the given SourceFile.
 *
 * @param tx Prisma transaction client (or PrismaClient) — MUST be the
 *           caller's transaction client so this INSERT rolls back on
 *           failure (BUG2-INGEST-3).
 * @param sourceFileId The SourceFile.id whose InventoryRecords should
 *                     be aggregated.
 */
export async function computeOutletPeriodSales(
  tx: Prisma.TransactionClient,
  sourceFileId: number,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "OutletPeriodSales"
      ("outletId", "monthLabel", "weekLabel", "salesMode", "sourceFileId", "computedAt")
    SELECT
      ranked."outletId",
      ranked."monthLabel",
      ranked."weekLabel",
      ranked."nominalSales"   AS "salesMode",
      ${sourceFileId}        AS "sourceFileId",
      NOW()
    FROM (
      SELECT
        ir."outletId",
        ir."monthLabel",
        ir."weekLabel",
        ir."nominalSales",
        ROW_NUMBER() OVER (
          PARTITION BY ir."outletId", ir."monthLabel", ir."weekLabel"
          ORDER BY COUNT(*) DESC, ir."nominalSales" ASC
        ) AS rn
      FROM "InventoryRecord" ir
      WHERE ir."sourceFileId" = ${sourceFileId}
        AND ir."nominalSales" IS NOT NULL AND ir."nominalSales" > 0
      GROUP BY ir."outletId", ir."monthLabel", ir."weekLabel", ir."nominalSales"
    ) ranked
    WHERE ranked.rn = 1
    ON CONFLICT ("outletId", "monthLabel", "weekLabel") DO UPDATE
    SET
      "salesMode"     = EXCLUDED."salesMode",
      "sourceFileId"  = EXCLUDED."sourceFileId",
      "computedAt"    = NOW()
  `;
}
