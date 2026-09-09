#!/usr/bin/env bun
// ============================================================
//  scripts/recreate-covering-indexes.ts — AUDIT-DB-PUSH-2 repair
//  ---------------------------------------------------------
//  Prisma CANNOT model INCLUDE (covering) index columns, so EVERY
//  `prisma db push` / `prisma migrate` will:
//    1. DROP the INCLUDE versions of the perf covering indexes
//       (index-only scans — e.g. queryHistoricalStatsMultiMetric
//       went 8s → 1.6s thanks to them), and
//    2. CREATE plain shadow copies without the INCLUDE columns.
//
//  This script restores the INCLUDE versions (idempotent —
//  CREATE INDEX IF NOT EXISTS) and removes the plain shadows
//  that a push created (same key columns, no INCLUDE → redundant
//  duplicates once the covering twin exists).
//
//  RUN AFTER EVERY db:push / db:migrate:
//    bun run db:recreate-covering-indexes
//
//  Definitions below are byte-identical to the live production
//  definitions (pg_indexes) — verified 2026-09-09.
// ============================================================
import { db } from '../src/lib/db';

// (name, CREATE statement) — the three covering indexes.
const COVERING_INDEXES: Array<{ name: string; ddl: string }> = [
  {
    name: 'InventoryRecord_histAgg_cover_idx',
    ddl: `CREATE INDEX IF NOT EXISTS "InventoryRecord_histAgg_cover_idx"
      ON "InventoryRecord" ("weekLabel", "monthLabel", "outletId", "itemId")
      INCLUDE ("qtyBom", "qtyDeviasi", "qtyWaste", "qtySusut", "qtyTrial")`,
  },
  {
    name: 'InventoryRecord_month_week_item_covering_idx',
    ddl: `CREATE INDEX IF NOT EXISTS "InventoryRecord_month_week_item_covering_idx"
      ON "InventoryRecord" ("monthLabel", "weekLabel", "itemId")
      INCLUDE ("absNominalDeviasi")`,
  },
  {
    name: 'InventoryRecord_month_week_trend_covering_idx',
    ddl: `CREATE INDEX IF NOT EXISTS "InventoryRecord_month_week_trend_covering_idx"
      ON "InventoryRecord" ("monthLabel", "weekLabel")
      INCLUDE ("nominalDeviasi", "qtyBom", "qtyDeviasi", "nominalLossSurplus",
               "absNominalDeviasi", "absNominalLossSurplus", "outletId", "area")`,
  },
];

// Plain shadows a push creates for two of the covering indexes — dropped
// ONLY when their covering twin exists (so we never remove an index that
// is the sole servant of its key prefix).
// NOTE: InventoryRecord_monthLabel_weekLabel_idx is intentionally NOT
// listed — it predates the covering indexes and coexists with them in
// the known-good production state (planner status quo, do not touch).
const REDUNDANT_SHADOWS: Array<{ plain: string; covering: string }> = [
  {
    plain: 'InventoryRecord_monthLabel_weekLabel_itemId_idx',
    covering: 'InventoryRecord_month_week_item_covering_idx',
  },
  {
    plain: 'InventoryRecord_weekLabel_monthLabel_outletId_itemId_idx',
    covering: 'InventoryRecord_histAgg_cover_idx',
  },
];

async function indexExists(name: string): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ${name}
    ) AS "exists"
  `;
  return rows[0]?.exists === true;
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Restore covering (INCLUDE) indexes post db:push');
  console.log('═══════════════════════════════════════════════');

  for (const { name, ddl } of COVERING_INDEXES) {
    if (await indexExists(name)) {
      console.log(`✓ ${name} already exists — skipped`);
      continue;
    }
    await db.$executeRawUnsafe(ddl);
    console.log(`✓ created ${name} (with INCLUDE columns)`);
  }

  for (const { plain, covering } of REDUNDANT_SHADOWS) {
    const plainExists = await indexExists(plain);
    const coveringExists = await indexExists(covering);
    if (plainExists && coveringExists) {
      await db.$executeRawUnsafe(`DROP INDEX IF EXISTS "${plain}"`);
      console.log(`✓ dropped redundant plain shadow ${plain} (covering twin ${covering} present)`);
    } else if (!plainExists) {
      console.log(`· ${plain} not present — nothing to clean`);
    } else {
      console.log(
        `⚠ kept ${plain} — covering twin ${covering} is MISSING; ` +
        're-run this script after creating it (never leave the key prefix unserved).',
      );
    }
  }

  console.log('\nDone. Index-only scans restored.');
}

main()
  .catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('❌ recreate-covering-indexes FAILED:', msg);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
