import type { MigrationAuditContext } from './context';
import { q } from './db';
import { hr } from './report';

// ============================================================
// CHECK 10: PERFORMANCE CHECK
// ============================================================
export async function check10_performance(ctx: MigrationAuditContext) {
  hr('CHECK 10 — Performance Check (NEW DB)');
  // Simple aggregate
  const t1 = Date.now();
  const r1 = await q(ctx.newPool, `SELECT COUNT(*)::bigint AS c, COALESCE(SUM("nominalDeviasi"), 0)::float AS sum_dev FROM "InventoryRecord" WHERE "monthLabel" = (SELECT "monthLabel" FROM "InventoryRecord" ORDER BY id DESC LIMIT 1)`);
  const t1Ms = Date.now() - t1;
  console.log(`  Simple aggregate (COUNT + SUM on latest month): ${t1Ms}ms — ${r1.rows[0].c} rows, sum=${r1.rows[0].sum_dev}`);
  if (t1Ms > 2000) {
    ctx.addIssue('MIGR-10', 'P2',
      'Slow aggregate query on InventoryRecord',
      `Simple COUNT+SUM took ${t1Ms}ms (threshold 2000ms).`,
      'Dashboard cold loads will feel sluggish. May indicate missing index on monthLabel.',
      'Verify InventoryRecord_monthLabel_weekLabel_idx exists and is being used (see Check 4). Consider adding an index on monthLabel alone if missing.'
    );
  }

  // EXPLAIN ANALYZE a representative query (filter by outlet + week, common in dashboard)
  const r2 = await q(ctx.newPool, `
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT * FROM "InventoryRecord"
    WHERE "outletId" = (SELECT id FROM "Outlet" LIMIT 1)
      AND "weekId" = (SELECT id FROM "Week" ORDER BY id DESC LIMIT 1)
    LIMIT 10
  `);
  const plan = r2.rows.map((r: any) => r['QUERY PLAN']).join('\n');
  console.log('\n  EXPLAIN ANALYZE (filter by outletId + weekId, LIMIT 10):');
  plan.split('\n').forEach((l: string) => console.log('    ' + l));
  const usesSeqScan = plan.includes('Seq Scan') && !plan.includes('Index Scan') && !plan.includes('Index Only Scan');
  if (usesSeqScan) {
    ctx.addIssue('MIGR-10b', 'P2',
      'Sequential scan on InventoryRecord (index not used)',
      'EXPLAIN ANALYZE shows a Seq Scan on InventoryRecord — the (outletId, weekId) index is not being used.',
      'Full table scan of ~600K rows on every dashboard filter. Adds seconds to every page load.',
      'Run ANALYZE "InventoryRecord"; to refresh planner statistics. If still seq scan, verify the index exists (Check 4) and the column types match the query parameter types.'
    );
  } else {
    console.log('\n  ✓ Index scan used (no full table scan).');
  }
  // Extract execution time
  const execTimeMatch = plan.match(/Execution Time: (\d+\.\d+) ms/);
  if (execTimeMatch) {
    const ms = parseFloat(execTimeMatch[1]);
    console.log(`\n  Execution Time: ${ms}ms`);
  }
}
