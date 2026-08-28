#!/usr/bin/env bun
// ============================================================
//  backfill-outlet-period-sales.ts — DB-06 backfill script
//  ---------------------------------------------------------
//  One-time backfill of the OutletPeriodSales table from existing
//  InventoryRecord data. Computes MODE(nominalSales) per
//  (outletId, monthLabel, weekLabel) using the SAME logic as the
//  inline `sales_counts → ranked_sales → sales_mode` CTE pipeline
//  that is being replaced:
//
//    ROW_NUMBER() OVER (
//      PARTITION BY "outletId", "monthLabel", "weekLabel"
//      ORDER BY COUNT(*) DESC, "nominalSales" ASC
//    ) → WHERE rn = 1
//
//  Smaller-value-wins tie-break matches computeSalesModePerOutlet
//  (src/lib/metrics/sales.ts:26-62) exactly.
//
//  Uses INSERT ... SELECT ... ON CONFLICT DO UPDATE so it is safe
//  to re-run (idempotent). The sourceFileId is taken from the
//  latest contributing InventoryRecord (MAX) — provenance for
//  cascade delete when the source file is re-ingested.
//
//  Usage:  bun run scripts/backfill-outlet-period-sales.ts
// ============================================================
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient({ log: ['error'] });

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  DB-06 Backfill: OutletPeriodSales');
  console.log('═══════════════════════════════════════════════');

  const before = await db.outletPeriodSales.count();
  console.log(`Existing OutletPeriodSales rows: ${before}`);

  // Single INSERT ... SELECT ... ON CONFLICT DO UPDATE.
  // The ranked subquery mirrors the inline CTE pipeline exactly.
  // prisma.$executeRawUnsafe lets us avoid template-literal type
  // inference issues with the multi-line SQL.
  const sql = `
    INSERT INTO "OutletPeriodSales"
      ("outletId", "monthLabel", "weekLabel", "salesMode", "sourceFileId", "computedAt")
    SELECT
      ranked."outletId",
      ranked."monthLabel",
      ranked."weekLabel",
      ranked."nominalSales"   AS "salesMode",
      ranked."sourceFileId"   AS "sourceFileId",
      NOW()
    FROM (
      SELECT
        ir."outletId",
        ir."monthLabel",
        ir."weekLabel",
        ir."nominalSales",
        MAX(ir."sourceFileId") AS "sourceFileId",
        ROW_NUMBER() OVER (
          PARTITION BY ir."outletId", ir."monthLabel", ir."weekLabel"
          ORDER BY COUNT(*) DESC, ir."nominalSales" ASC
        ) AS rn
      FROM "InventoryRecord" ir
      WHERE ir."nominalSales" IS NOT NULL AND ir."nominalSales" > 0
      GROUP BY ir."outletId", ir."monthLabel", ir."weekLabel", ir."nominalSales"
    ) ranked
    WHERE ranked.rn = 1
    ON CONFLICT ("outletId", "monthLabel", "weekLabel") DO UPDATE
    SET
      "salesMode"     = EXCLUDED."salesMode",
      "sourceFileId"  = EXCLUDED."sourceFileId",
      "computedAt"    = NOW()
  `;

  console.log('Running backfill...');
  const start = Date.now();
  const result = await db.$executeRawUnsafe(sql);
  const elapsed = ((Date.now() - start) / 1000).toFixed(2);

  const after = await db.outletPeriodSales.count();
  console.log(`✓ Done in ${elapsed}s — ${result} rows upserted.`);
  console.log(`OutletPeriodSales rows now: ${after}`);

  // Sanity: cross-check a sample row against the inline CTE pipeline.
  // Mirrors the canonical sales_counts → ranked_sales → sales_mode CTE
  // (two nested subqueries — PostgreSQL forbids combining GROUP BY with
  // window PARTITION BY over non-grouped columns in one SELECT).
  const sample = await db.$queryRaw<Array<{
    outletId: number;
    monthLabel: string;
    weekLabel: string;
    precomputed: number;
    inlineCte: number | null;
  }>>`
    SELECT ops."outletId", ops."monthLabel", ops."weekLabel",
           ops."salesMode" AS "precomputed",
           inline.sales    AS "inlineCte"
    FROM "OutletPeriodSales" ops
    LEFT JOIN LATERAL (
      SELECT sales FROM (
        SELECT "nominalSales" AS sales,
          ROW_NUMBER() OVER (
            PARTITION BY "outletId", "monthLabel", "weekLabel"
            ORDER BY cnt DESC, "nominalSales" ASC
          ) AS rn
        FROM (
          SELECT "outletId", "monthLabel", "weekLabel", "nominalSales", COUNT(*) AS cnt
          FROM "InventoryRecord"
          WHERE "outletId"   = ops."outletId"
            AND "monthLabel" = ops."monthLabel"
            AND "weekLabel"  = ops."weekLabel"
            AND "nominalSales" IS NOT NULL AND "nominalSales" > 0
          GROUP BY "outletId", "monthLabel", "weekLabel", "nominalSales"
        ) sc
      ) rs
      WHERE rn = 1
      LIMIT 1
    ) inline ON true
    LIMIT 20
  `;

  let mismatches = 0;
  for (const r of sample) {
    const pre = Number(r.precomputed);
    const inline = r.inlineCte == null ? null : Number(r.inlineCte);
    const match = inline == null ? false : Math.abs(pre - inline) < 0.01;
    if (!match) {
      mismatches++;
      console.log(`  ✗ MISMATCH outletId=${r.outletId} ${r.monthLabel} ${r.weekLabel} ` +
        `precomputed=${pre} inlineCte=${inline}`);
    }
  }
  if (mismatches === 0 && sample.length > 0) {
    console.log(`✓ Parity check passed (${sample.length} sample rows match inline CTE output).`);
  } else if (sample.length === 0) {
    console.log('⚠ No rows in OutletPeriodSales to spot-check (table is empty).');
  } else {
    console.log(`⚠ ${mismatches}/${sample.length} rows mismatch — investigate before deploying.`);
  }
}

main()
  .catch((e) => {
    console.error('Backfill failed:', e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
