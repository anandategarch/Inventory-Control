#!/usr/bin/env bun
// ============================================================
//  scripts/fix-duplicate-weeks.ts — AUDIT-BUG-1 cleanup script
//  ---------------------------------------------------------
//  One-time (idempotent) repair for duplicate Week buckets.
//
//  BUG (AUDIT-BUG-1): Week.weekKey's "unique" existed only as a comment.
//  Re-importing a month under a DIFFERENT fileName created a second
//  SourceFile + second Week row for the same (monthKey, weekLabel) →
//  every period-filtered aggregate (analysis, pareto, outlet-items,
//  export-report, …) DOUBLE-COUNTED those records.
//
//  What this script does, per (monthKey, weekLabel) group with >1 Week:
//    1. KEEP the week whose SourceFile was imported most recently
//       (max importedAt; tie-break: higher InventoryRecord count).
//       Safety deviation: a week with ZERO records never wins over a week
//       WITH records (a failed/mid-way import must not erase good data —
//       such empty newest weeks are real: createMany used to fail after
//       the Week row was created, before BUG2-INGEST-3 made it atomic).
//    2. DELETE each loser week's: InventoryRecords, DQIssues tied to the
//       week (weekId), OutletPeriodSales owned by its file for this
//       weekLabel (a SourceFile belongs to ONE month), the Week row.
//    3. DELETE a loser's SourceFile (+ its remaining DQIssues) ONLY if it
//       has no weeks left (fully superseded file).
//  Each group is fixed in its own small transaction (all-or-nothing).
//
//  Idempotent: a second run finds zero groups and exits 0.
//
//  Usage:
//    bun run scripts/fix-duplicate-weeks.ts
//    (or: bun run db:fix-duplicate-weeks)
//
//  AFTER this script succeeds, run `bun run db:push` to add the new
//  @@unique([monthKey, weekLabel]) constraint on Week (schema.prisma)
//  so duplicates can never be created again.
// ============================================================
import { db } from '../src/lib/db';

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  AUDIT-BUG-1: duplicate (monthKey, weekLabel) Week cleanup');
  console.log('═══════════════════════════════════════════════');

  // Groups of (monthKey, weekLabel) having more than one Week row.
  const dupGroups = await db.week.groupBy({
    by: ['monthKey', 'weekLabel'],
    _count: { _all: true },
    having: { _count: { _all: { gt: 1 } } },
  });

  if (dupGroups.length === 0) {
    console.log('✓ No duplicate (monthKey, weekLabel) buckets found — nothing to fix.');
    console.log('\nRun `bun run db:push` afterwards to add the new unique constraint.');
    return;
  }

  console.log(`Found ${dupGroups.length} duplicate group(s):\n`);

  let groupsFixed = 0;
  let weeksDeleted = 0;
  let recordsDeleted = 0;
  let dqIssuesDeleted = 0;
  let filesDeleted = 0;

  for (const group of dupGroups) {
    const { monthKey, weekLabel } = group;

    const weeks = await db.week.findMany({
      where: { monthKey, weekLabel },
      select: {
        id: true,
        sourceFileId: true,
        sourceFile: { select: { id: true, fileName: true, importedAt: true } },
        _count: { select: { records: true } },
      },
    });

    // Keeper selection (see header comment):
    //   prefer weeks WITH records; among them, max importedAt, tie-break
    //   higher record count. If ALL weeks have 0 records, keep the most
    //   recent one (nothing to lose).
    const withData = weeks.filter((w) => w._count.records > 0);
    const pool = withData.length > 0 ? withData : weeks;
    const sorted = [...pool].sort((a, b) => {
      const at = a.sourceFile.importedAt.getTime();
      const bt = b.sourceFile.importedAt.getTime();
      if (at !== bt) return bt - at; // most recent import wins
      return b._count.records - a._count.records; // tie-break: more data wins
    });
    const keeper = sorted[0];
    const losers = weeks.filter((w) => w.id !== keeper.id);

    // Small transaction per group — a failure mid-group rolls the whole
    // group back (no half-deleted period).
    await db.$transaction(
      async (tx) => {
        for (const w of losers) {
          const delRecs = await tx.inventoryRecord.deleteMany({ where: { weekId: w.id } });
          recordsDeleted += delRecs.count;
          // DQ issues pointing directly at the removed week (DQIssue.weekId
          // has no FK/cascade — clean them explicitly).
          const delDq = await tx.dQIssue.deleteMany({ where: { weekId: w.id } });
          dqIssuesDeleted += delDq.count;
          // Precomputed sales MODE owned by the loser's file for this period
          // (a SourceFile belongs to ONE month, so (sourceFileId, weekLabel)
          // pins exactly this bucket; the keeper's import recomputes its own).
          await tx.outletPeriodSales.deleteMany({
            where: { sourceFileId: w.sourceFileId, weekLabel },
          });
          await tx.week.delete({ where: { id: w.id } });
          weeksDeleted++;

          // Fully superseded file? (no weeks left) → delete it + its DQ issues.
          const remainingWeeks = await tx.week.count({ where: { sourceFileId: w.sourceFileId } });
          if (remainingWeeks === 0) {
            const delFileDq = await tx.dQIssue.deleteMany({ where: { sourceFileId: w.sourceFileId } });
            dqIssuesDeleted += delFileDq.count;
            await tx.sourceFile.delete({ where: { id: w.sourceFileId } });
            filesDeleted++;
            console.log(`  ✗ deleted superseded SourceFile ${w.sourceFile.fileName} (no weeks left)`);
          }
        }
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    groupsFixed++;

    console.log(
      `✓ ${monthKey} / ${weekLabel}: kept week #${keeper.id}` +
      ` (file "${keeper.sourceFile.fileName}", imported ${keeper.sourceFile.importedAt.toISOString()},` +
      ` ${keeper._count.records} records) — removed ${losers.length} duplicate week(s)` +
      (keeper._count.records === 0 ? ' ⚠️ keeper has 0 records (all duplicates were empty)' : '')
    );
  }

  console.log('\n───────────────────────────────');
  console.log('Summary:');
  console.log(`  duplicate groups fixed : ${groupsFixed}`);
  console.log(`  week rows deleted      : ${weeksDeleted}`);
  console.log(`  inventory records del. : ${recordsDeleted}`);
  console.log(`  DQ issues deleted      : ${dqIssuesDeleted}`);
  console.log(`  source files deleted   : ${filesDeleted}`);
  console.log('───────────────────────────────');
  console.log('Run `bun run db:push` afterwards to add the new unique constraint.');
  console.log('(Then restart the app so Prisma Client picks up the new @@unique.)');
}

main()
  .catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('❌ fix-duplicate-weeks FAILED (database error — no partial commits):', msg);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
