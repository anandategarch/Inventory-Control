#!/usr/bin/env bun
// ============================================================
//  scripts/fix-null-akun-duplicates.ts — AUDIT-BUG-3 cleanup script
//  ---------------------------------------------------------
//  One-time (idempotent) repair for duplicate InventoryRecords
//  that share the natural key (weekId, outletId, itemId) with
//  akunPenyesuaian = NULL.
//
//  BUG (AUDIT-BUG-3): PostgreSQL unique indexes treat NULL ≠ NULL
//  (SQL standard: NULLs are distinct). The Prisma constraint
//  @@unique([weekId, outletId, itemId, akunPenyesuaian]) therefore
//  does NOT stop two rows with the SAME (week, outlet, item) and
//  akunPenyesuaian = NULL — createMany({skipDuplicates}) lets both
//  through → double-counted deviations/sales in every aggregate.
//  (/api/ingest-process also always runs fastMode → validateRow's
//  DUPLICATE check never fires.)
//
//  What this script does:
//    0. Normalize legacy empty-string akunPenyesuaian ('' → NULL).
//       transform.ts toStr() already maps '' → null, so '' rows can
//       only come from very old imports.
//    1. Find groups: same (weekId, outletId, itemId,
//       COALESCE(akunPenyesuaian, '')) with COUNT(*) > 1.
//    2. KEEP the row with the MOST non-null metric columns (the
//       "richest" row — a re-export with more filled columns must not
//       be beaten by an emptier one); tie-break: HIGHER id (latest
//       import wins, matching the app's latest-wins import semantics).
//    3. DELETE the losers (per-group small transactions).
//    4. CREATE the NULL-safe unique index:
//         CREATE UNIQUE INDEX InventoryRecord_nullsafe_akun
//         ON "InventoryRecord" ("weekId","outletId","itemId",
//                                COALESCE("akunPenyesuaian", ''))
//       This index is an EXPRESSION index — Prisma cannot express it
//       in schema.prisma, so it lives here (and is documented in the
//       schema comment next to @@unique). ON CONFLICT DO NOTHING used
//       by createMany({skipDuplicates}) honors expression indexes,
//       so the DB now dedups NULL-akun rows too.
//       NOTE: prisma db push / migrate will not drop an unknown
//       expression index (it cannot map it), but re-running this
//       script after any push is safe (CREATE IF NOT EXISTS).
//
//  Idempotent: a second run finds zero groups, index already exists.
//
//  Usage:
//    bun run scripts/fix-null-akun-duplicates.ts
//    (or: bun run db:fix-null-akun-duplicates)
//
//  Run BEFORE the next import whenever possible — new imports are
//  already protected in-memory (AUDIT-BUG-3 fix in process-ingestion.ts
//  + process-rows-for-import.ts), but only this index protects
//  cross-instance / pre-existing duplicates at the DB level.
// ============================================================
import { db } from '../src/lib/db';

// Columns considered when picking the "richest" keeper row.
const METRIC_COLUMNS = [
  'qtyBom', 'qtyCom', 'qtyDeviasi', 'qtyWaste', 'qtySusut', 'qtyTrial', 'qtyLossSurplus',
  'nominalDeviasi', 'nominalWaste', 'nominalSusut', 'nominalTrial', 'nominalLossSurplus',
  'nominalSales', 'avgPrice', 'tolerancePct', 'toleranceRaw',
] as const;

type MetricCol = (typeof METRIC_COLUMNS)[number];
const METRIC_SELECT: Record<MetricCol, true> = {
  qtyBom: true, qtyCom: true, qtyDeviasi: true, qtyWaste: true, qtySusut: true,
  qtyTrial: true, qtyLossSurplus: true,
  nominalDeviasi: true, nominalWaste: true, nominalSusut: true, nominalTrial: true,
  nominalLossSurplus: true, nominalSales: true, avgPrice: true,
  tolerancePct: true, toleranceRaw: true,
};

type DupRow = { id: number; createdAt: Date } & Record<MetricCol, unknown>;

// Number of non-null metric columns (richness) — deterministic keeper score.
function richness(r: DupRow): number {
  let acc = 0;
  for (const col of METRIC_COLUMNS) if (r[col] !== null) acc++;
  return acc;
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  AUDIT-BUG-3: NULL-akunPenyesuaian duplicate cleanup');
  console.log('═══════════════════════════════════════════════');

  // --- Step 0: normalize legacy '' → NULL -----------------------------
  const normalized = await db.inventoryRecord.updateMany({
    where: { akunPenyesuaian: '' },
    data: { akunPenyesuaian: null },
  });
  if (normalized.count > 0) {
    console.log(`✓ normalized ${normalized.count} legacy '' akunPenyesuaian value(s) → NULL`);
  }

  // --- Step 1: find duplicate groups (NULL-safe key) -------------------
  // FIX (SCRIPT-RUNTIME-2): was GROUP BY ... COALESCE("akunPenyesuaian", '')
  // while SELECTing the bare "akunPenyesuaian" column → Postgres 42803
  // ("column must appear in the GROUP BY clause"). Plain GROUP BY on the
  // column is correct here: GROUP BY treats NULLs as EQUAL (one group per
  // key — unlike unique indexes), and Step 0 has already normalized any
  // legacy '' to NULL, so the grouping is identical to the COALESCE intent.
  // (The COALESCE expression stays in the unique INDEX below — that is where
  // NULL≠NULL actually bites and the expression is required.)
  const dupGroups: Array<{
    weekId: number; outletId: number; itemId: number; akun: string | null; cnt: bigint;
  }> = await db.$queryRaw`
    SELECT "weekId", "outletId", "itemId", "akunPenyesuaian" AS "akun", COUNT(*) AS "cnt"
    FROM "InventoryRecord"
    GROUP BY "weekId", "outletId", "itemId", "akunPenyesuaian"
    HAVING COUNT(*) > 1
    ORDER BY "cnt" DESC
  `;

  if (dupGroups.length === 0) {
    console.log('✓ No duplicate natural-key rows found — nothing to fix.');
  } else {
    console.log(`Found ${dupGroups.length} duplicate group(s), ${dupGroups.reduce((a, g) => a + Number(g.cnt), 0)} rows total:\n`);
  }

  let groupsFixed = 0;
  let rowsDeleted = 0;

  for (const g of dupGroups) {
    const rows = await db.inventoryRecord.findMany({
      where: {
        weekId: g.weekId, outletId: g.outletId, itemId: g.itemId,
        akunPenyesuaian: g.akun,
      },
      select: { id: true, createdAt: true, ...METRIC_SELECT },
      orderBy: { id: 'asc' },
    });

    // Keeper = richest row (most non-null metrics); tie-break higher id
    // (latest import wins). Both keys are deterministic.
    const sorted = [...rows].sort((a, b) => {
      const d = richness(b) - richness(a);
      if (d !== 0) return d;
      return b.id - a.id;
    });
    const keeper = sorted[0];
    const losers = rows.filter((r) => r.id !== keeper.id);
    const loserIds = losers.map((r) => r.id);

    // Small transaction per group — a failure mid-group rolls the whole
    // group back (no half-cleaned key).
    await db.$transaction(
      async (tx) => {
        const del = await tx.inventoryRecord.deleteMany({ where: { id: { in: loserIds } } });
        rowsDeleted += del.count;
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    groupsFixed++;

    console.log(
      `✓ week#${g.weekId} outlet#${g.outletId} item#${g.itemId} akun=${g.akun === null ? 'NULL' : `"${g.akun}"`}:` +
      ` kept id#${keeper.id} (richest, ${richness(keeper)}/${METRIC_COLUMNS.length} metrics) — deleted ${losers.length} duplicate row(s)`,
    );
  }

  // --- Step 4: create the NULL-safe unique index -----------------------
  console.log('\nCreating NULL-safe unique index (idempotent)…');
  await db.$executeRaw`
    CREATE UNIQUE INDEX IF NOT EXISTS "InventoryRecord_nullsafe_akun"
    ON "InventoryRecord" ("weekId", "outletId", "itemId", COALESCE("akunPenyesuaian", ''))
  `;
  console.log('✓ index "InventoryRecord_nullsafe_akun" ready');

  console.log('\n───────────────────────────────');
  console.log('Summary:');
  console.log(`  '' → NULL normalized    : ${normalized.count}`);
  console.log(`  duplicate groups fixed  : ${groupsFixed}`);
  console.log(`  inventory records del.  : ${rowsDeleted}`);
  console.log('  unique index created    : InventoryRecord_nullsafe_akun');
  console.log('───────────────────────────────');
  console.log('New imports now dedup NULL-akun rows at the DB level');
  console.log('(ON CONFLICT DO NOTHING honors expression indexes).');
}

main()
  .catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('❌ fix-null-akun-duplicates FAILED (database error — no partial commits):', msg);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
