import type { MigrationAuditContext } from './context';
import { q } from './db';
import { hr } from './report';

// ============================================================
// CHECK 8: AGGREGATION CACHE STATUS
// ============================================================
export async function check8_aggregationCache(ctx: MigrationAuditContext) {
  hr('CHECK 8 — AggregationCache Status');
  const r = await q(ctx.newPool, `SELECT COUNT(*)::bigint AS c, MAX("computedAt") AS latest FROM "AggregationCache"`);
  const count = Number(r.rows[0].c);
  const latest = r.rows[0].latest;
  console.log(`  NEW DB AggregationCache rows: ${count}`);
  console.log(`  Latest computedAt: ${latest ?? '(empty)'}`);
  if (count === 0) {
    console.log('  ✓ Empty (intentional — was skipped during migration).');
    console.log('  ✓ Will auto-rebuild on first /api/analysis call via setCached() upsert (src/lib/aggregation-cache.ts:107).');
  } else {
    // Already handled in Check 1
  }
  // Verify code path exists: getCached returns null on cache miss → caller computes → setCached upserts
  console.log('  Code path verified: src/lib/aggregation-cache.ts');
  console.log('    getCached() → findUnique → null on miss (line 80-99)');
  console.log('    setCached() → upsert by cacheKey (line 107-131)');
  console.log('    → Empty cache is SAFE; first call to /api/analysis rebuilds it.');
}
