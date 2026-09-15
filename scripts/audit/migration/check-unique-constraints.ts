import type { MigrationAuditContext } from './context';
import { q } from './db';
import { hr } from './report';

// ============================================================
// CHECK 5: UNIQUE CONSTRAINT INTEGRITY
// ============================================================
export async function check5_uniqueConstraints(ctx: MigrationAuditContext) {
  hr('CHECK 5 — Unique Constraint Integrity (NEW DB)');
  // Check that unique constraints exist AND that data actually respects them
  const constraints: Array<{ name: string; table: string; cols: string; sql: string }> = [
    { name: 'Outlet.code (unique)', table: 'Outlet', cols: 'code', sql: `SELECT COUNT(*)::bigint AS c FROM (SELECT code FROM "Outlet" GROUP BY code HAVING COUNT(*) > 1) x` },
    { name: 'Item.name (unique)', table: 'Item', cols: 'name', sql: `SELECT COUNT(*)::bigint AS c FROM (SELECT name FROM "Item" GROUP BY name HAVING COUNT(*) > 1) x` },
    { name: 'OutletPIC.outletCode (unique)', table: 'OutletPIC', cols: 'outletCode', sql: `SELECT COUNT(*)::bigint AS c FROM (SELECT "outletCode" FROM "OutletPIC" GROUP BY "outletCode" HAVING COUNT(*) > 1) x` },
    { name: 'Setting.key (unique)', table: 'Setting', cols: 'key', sql: `SELECT COUNT(*)::bigint AS c FROM (SELECT key FROM "Setting" GROUP BY key HAVING COUNT(*) > 1) x` },
    { name: 'AggregationCache.cacheKey (unique)', table: 'AggregationCache', cols: 'cacheKey', sql: `SELECT COUNT(*)::bigint AS c FROM (SELECT "cacheKey" FROM "AggregationCache" GROUP BY "cacheKey" HAVING COUNT(*) > 1) x` },
    { name: 'SourceFile.fileName (unique)', table: 'SourceFile', cols: 'fileName', sql: `SELECT COUNT(*)::bigint AS c FROM (SELECT "fileName" FROM "SourceFile" GROUP BY "fileName" HAVING COUNT(*) > 1) x` },
    { name: 'SourceFile.fileHash (unique)', table: 'SourceFile', cols: 'fileHash', sql: `SELECT COUNT(*)::bigint AS c FROM (SELECT "fileHash" FROM "SourceFile" GROUP BY "fileHash" HAVING COUNT(*) > 1) x` },
    { name: 'Week(sourceFileId, weekLabel) unique', table: 'Week', cols: 'sourceFileId, weekLabel', sql: `SELECT COUNT(*)::bigint AS c FROM (SELECT "sourceFileId", "weekLabel" FROM "Week" GROUP BY "sourceFileId", "weekLabel" HAVING COUNT(*) > 1) x` },
    { name: 'InventoryRecord(weekId, outletId, itemId, akunPenyesuaian) unique', table: 'InventoryRecord', cols: '...', sql: `SELECT COUNT(*)::bigint AS c FROM (SELECT "weekId", "outletId", "itemId", "akunPenyesuaian" FROM "InventoryRecord" GROUP BY "weekId", "outletId", "itemId", "akunPenyesuaian" HAVING COUNT(*) > 1) x` },
    { name: 'OutletPeriodSales(outletId, monthLabel, weekLabel) unique', table: 'OutletPeriodSales', cols: '...', sql: `SELECT COUNT(*)::bigint AS c FROM (SELECT "outletId", "monthLabel", "weekLabel" FROM "OutletPeriodSales" GROUP BY "outletId", "monthLabel", "weekLabel" HAVING COUNT(*) > 1) x` },
    { name: 'FileChunk(fileHash, chunkIndex) unique', table: 'FileChunk', cols: '...', sql: `SELECT COUNT(*)::bigint AS c FROM (SELECT "fileHash", "chunkIndex" FROM "FileChunk" GROUP BY "fileHash", "chunkIndex" HAVING COUNT(*) > 1) x` },
  ];
  let dupIssues = 0;
  for (const c of constraints) {
    try {
      const r = await q(ctx.newPool, c.sql);
      const dupGroups = Number(r.rows[0].c);
      const status = dupGroups === 0 ? '✓ OK' : '✗ DUPLICATES';
      console.log(`  ${c.name.padEnd(60)} dup_groups=${String(dupGroups).padStart(4)}  ${status}`);
      if (dupGroups > 0) {
        dupIssues++;
        ctx.addIssue(`MIGR-05-${c.table}`, 'P1',
          `Duplicate values violate unique constraint: ${c.name}`,
          `${dupGroups} duplicate value-groups exist in ${c.table}.`,
          'Future INSERTs/UPDATEs may succeed when they should fail, OR future INSERTs will fail because the constraint exists but data already violates it.',
          'Either deduplicate the rows (keep one, delete others) or DROP the constraint if the migration introduced legit duplicates. Investigate migration script — it should have used upsert or skipDuplicates.'
        );
      }
    } catch (e: any) {
      console.log(`  ⚠ ${c.name}: ${e.message}`);
    }
  }
  // Also verify the constraints actually exist in pg_constraint
  console.log('\n  Constraint existence check (pg_constraint):');
  const cR = await q(ctx.newPool, `SELECT conname, conrelid::regclass AS tbl FROM pg_constraint WHERE contype='u' AND connamespace='public'::regnamespace ORDER BY conrelid::regclass::text, conname`);
  for (const row of cR.rows) {
    console.log(`    ✓ ${row.tbl}.${row.conname}`);
  }
  if (dupIssues === 0) console.log('\n  ✓ All unique constraints respected by data.');
}
