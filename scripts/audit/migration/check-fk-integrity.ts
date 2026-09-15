import type { MigrationAuditContext } from './context';
import { q } from './db';
import { hr } from './report';

// ============================================================
// CHECK 2: FK INTEGRITY (NEW DB)
// ============================================================
export async function check2_fkIntegrity(ctx: MigrationAuditContext) {
  hr('CHECK 2 — Foreign Key Integrity (NEW DB)');
  const checks = [
    { name: 'InventoryRecord.weekId → Week.id', sql: `SELECT COUNT(*)::bigint AS c FROM "InventoryRecord" ir WHERE ir."weekId" NOT IN (SELECT id FROM "Week")` },
    { name: 'InventoryRecord.outletId → Outlet.id', sql: `SELECT COUNT(*)::bigint AS c FROM "InventoryRecord" ir WHERE ir."outletId" NOT IN (SELECT id FROM "Outlet")` },
    { name: 'InventoryRecord.itemId → Item.id', sql: `SELECT COUNT(*)::bigint AS c FROM "InventoryRecord" ir WHERE ir."itemId" NOT IN (SELECT id FROM "Item")` },
    { name: 'InventoryRecord.sourceFileId → SourceFile.id', sql: `SELECT COUNT(*)::bigint AS c FROM "InventoryRecord" ir WHERE ir."sourceFileId" NOT IN (SELECT id FROM "SourceFile")` },
    { name: 'OutletPeriodSales.outletId → Outlet.id', sql: `SELECT COUNT(*)::bigint AS c FROM "OutletPeriodSales" o WHERE o."outletId" NOT IN (SELECT id FROM "Outlet")` },
    { name: 'OutletPeriodSales.sourceFileId → SourceFile.id', sql: `SELECT COUNT(*)::bigint AS c FROM "OutletPeriodSales" o WHERE o."sourceFileId" NOT IN (SELECT id FROM "SourceFile")` },
    { name: 'DQIssue.sourceFileId → SourceFile.id', sql: `SELECT COUNT(*)::bigint AS c FROM "DQIssue" d WHERE d."sourceFileId" NOT IN (SELECT id FROM "SourceFile")` },
    { name: 'Week.sourceFileId → SourceFile.id', sql: `SELECT COUNT(*)::bigint AS c FROM "Week" w WHERE w."sourceFileId" NOT IN (SELECT id FROM "SourceFile")` },
    // Additional: DQIssue optional FKs (nullable)
    { name: 'DQIssue.weekId (nullable) → Week.id', sql: `SELECT COUNT(*)::bigint AS c FROM "DQIssue" d WHERE d."weekId" IS NOT NULL AND d."weekId" NOT IN (SELECT id FROM "Week")` },
    { name: 'DQIssue.outletId (nullable) → Outlet.id', sql: `SELECT COUNT(*)::bigint AS c FROM "DQIssue" d WHERE d."outletId" IS NOT NULL AND d."outletId" NOT IN (SELECT id FROM "Outlet")` },
    { name: 'DQIssue.itemId (nullable) → Item.id', sql: `SELECT COUNT(*)::bigint AS c FROM "DQIssue" d WHERE d."itemId" IS NOT NULL AND d."itemId" NOT IN (SELECT id FROM "Item")` },
  ];
  let fkIssues = 0;
  for (const c of checks) {
    try {
      const r = await q(ctx.newPool, c.sql);
      const n = Number(r.rows[0].c);
      const status = n === 0 ? '✓ OK' : '✗ ORPHANS';
      console.log(`  ${c.name.padEnd(58)} orphaned=${String(n).padStart(8)}  ${status}`);
      if (n > 0) {
        fkIssues++;
        ctx.addIssue(`MIGR-02-${c.name.split('→')[0].trim().replace(/\s+/g, '_')}`, 'P1',
          `FK violation: ${c.name}`,
          `${n} orphaned rows in NEW DB reference a non-existent parent.`,
          'Queries that JOIN through these FKs will silently drop the orphaned rows. May also indicate ReferentialAction CASCADE was not honored during migration.',
          'Investigate which parent rows are missing. Either restore missing parent rows or DELETE the orphans (after confirming they are truly orphaned, not just ID-mismatched).'
        );
      }
    } catch (e: any) {
      console.log(`  ⚠ ${c.name}: ${e.message}`);
    }
  }
  if (fkIssues === 0) console.log('\n  ✓ All FK relationships intact in NEW DB.');
}
