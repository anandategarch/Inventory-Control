import type { MigrationAuditContext } from './context';
import { q } from './db';
import { hr } from './report';

// ============================================================
// CHECK 9: NULL/EMPTY CHECK ON CRITICAL COLUMNS
// ============================================================
export async function check9_nullChecks(ctx: MigrationAuditContext) {
  hr('CHECK 9 — Null/Empty Check on Critical Columns (NEW DB)');
  const checks: Array<{ name: string; sql: string }> = [
    { name: 'InventoryRecord.area (should NOT be null)', sql: `SELECT COUNT(*)::bigint AS c FROM "InventoryRecord" WHERE area IS NULL` },
    { name: 'InventoryRecord.monthLabel (should NOT be null)', sql: `SELECT COUNT(*)::bigint AS c FROM "InventoryRecord" WHERE "monthLabel" IS NULL` },
    { name: 'InventoryRecord.weekLabel (should NOT be null)', sql: `SELECT COUNT(*)::bigint AS c FROM "InventoryRecord" WHERE "weekLabel" IS NULL` },
    { name: 'InventoryRecord.bulan (should NOT be null)', sql: `SELECT COUNT(*)::bigint AS c FROM "InventoryRecord" WHERE bulan IS NULL` },
    { name: 'InventoryRecord.qtyBom (nullable per schema — informational)', sql: `SELECT COUNT(*)::bigint AS c FROM "InventoryRecord" WHERE "qtyBom" IS NULL` },
    { name: 'InventoryRecord.qtyDeviasi (nullable per schema — informational)', sql: `SELECT COUNT(*)::bigint AS c FROM "InventoryRecord" WHERE "qtyDeviasi" IS NULL` },
    { name: 'InventoryRecord.direction (nullable per schema)', sql: `SELECT COUNT(*)::bigint AS c FROM "InventoryRecord" WHERE direction IS NULL` },
    { name: 'Outlet.code (should NOT be null)', sql: `SELECT COUNT(*)::bigint AS c FROM "Outlet" WHERE code IS NULL` },
    { name: 'Outlet.name (should NOT be null)', sql: `SELECT COUNT(*)::bigint AS c FROM "Outlet" WHERE name IS NULL` },
    { name: 'Outlet.area (should NOT be null)', sql: `SELECT COUNT(*)::bigint AS c FROM "Outlet" WHERE area IS NULL` },
    { name: 'Item.name (should NOT be null)', sql: `SELECT COUNT(*)::bigint AS c FROM "Item" WHERE name IS NULL` },
    { name: 'Week.weekLabel (should NOT be null)', sql: `SELECT COUNT(*)::bigint AS c FROM "Week" WHERE "weekLabel" IS NULL` },
    { name: 'Week.monthKey (should NOT be null)', sql: `SELECT COUNT(*)::bigint AS c FROM "Week" WHERE "monthKey" IS NULL` },
    { name: 'SourceFile.fileName (should NOT be null)', sql: `SELECT COUNT(*)::bigint AS c FROM "SourceFile" WHERE "fileName" IS NULL` },
    { name: 'SourceFile.monthLabel (should NOT be null)', sql: `SELECT COUNT(*)::bigint AS c FROM "SourceFile" WHERE "monthLabel" IS NULL` },
  ];
  let nullIssues = 0;
  for (const c of checks) {
    try {
      const r = await q(ctx.newPool, c.sql);
      const n = Number(r.rows[0].c);
      const isCritical = !c.name.includes('informational') && !c.name.includes('nullable per schema');
      const status = n === 0 ? '✓' : (isCritical ? '✗' : '⚠');
      console.log(`  ${status} ${c.name.padEnd(60)} nulls=${String(n).padStart(8)}`);
      if (n > 0 && isCritical) {
        nullIssues++;
        ctx.addIssue(`MIGR-09-${c.name.split('(')[0].trim().replace(/\W+/g, '_')}`, 'P1',
          `Unexpected NULLs: ${c.name}`,
          `${n} rows have NULL in this column.`,
          'Queries that filter or group by this column will silently drop these rows. May indicate a parsing bug in migration (column mapping error).',
          'Investigate the source rows. Either backfill the missing values or fix the migration script and re-import the affected rows.'
        );
      }
    } catch (e: any) {
      console.log(`  ⚠ ${c.name}: ${e.message}`);
    }
  }
  if (nullIssues === 0) console.log('\n  ✓ No unexpected NULLs in critical columns.');
}
