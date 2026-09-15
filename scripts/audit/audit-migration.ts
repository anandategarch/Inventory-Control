#!/usr/bin/env bun
// ============================================================
//  audit-migration.ts — DB Migration Integrity Audit
//  ---------------------------------------------------------
//  Verifies migration from OLD Supabase DB (vefkgapveggbmkloaslw)
//  to NEW Supabase DB (proosjqivxadwgftofry).
//
//  Checks:
//   1. Row count comparison (12 tables)
//   2. FK integrity in NEW DB
//   3. Sequence synchronization (MAX(id) vs last_value)
//   4. Index integrity vs schema.prisma
//   5. Unique constraint integrity
//   6. Sample record spot-check (5 InventoryRecord IDs, all 44 cols)
//   7. Setting table comparison (old vs new)
//   8. AggregationCache status
//   9. Null/empty check on critical columns
//  10. Performance: simple aggregate + EXPLAIN ANALYZE
//
//  Usage:  bun run scripts/audit/audit-migration.ts
//
//  SPLIT-F module map (pure code motion — behavior unchanged):
//    migration/context.ts                — Issue type, TABLES, shared mutable
//                                          state (oldReachable) + issue tracker
//    migration/db.ts                     — createPools() + q() query helper
//    migration/report.ts                 — hr() banner, summary printer,
//                                          /tmp JSON dump
//    migration/check-row-counts.ts        — CHECK 1
//    migration/check-fk-integrity.ts      — CHECK 2
//    migration/check-sequences.ts         — CHECK 3
//    migration/check-indexes.ts           — CHECK 4
//    migration/check-unique-constraints.ts— CHECK 5
//    migration/check-sample-records.ts    — CHECK 6
//    migration/check-settings.ts          — CHECK 7
//    migration/check-aggregation-cache.ts — CHECK 8
//    migration/check-null-checks.ts       — CHECK 9
//    migration/check-performance.ts       — CHECK 10
//    this file                           — thin entry: env validation, pools,
//                                          connectivity ping, orchestration
// ============================================================
import { createPools, q } from './migration/db';
import { createMigrationAuditContext } from './migration/context';
import { printIssueSummary, writeIssuesJson } from './migration/report';
import { check1_rowCounts } from './migration/check-row-counts';
import { check2_fkIntegrity } from './migration/check-fk-integrity';
import { check3_sequences } from './migration/check-sequences';
import { check4_indexes } from './migration/check-indexes';
import { check5_uniqueConstraints } from './migration/check-unique-constraints';
import { check6_sampleRecords } from './migration/check-sample-records';
import { check7_settings } from './migration/check-settings';
import { check8_aggregationCache } from './migration/check-aggregation-cache';
import { check9_nullChecks } from './migration/check-null-checks';
import { check10_performance } from './migration/check-performance';

// FIX (AUDIT-SEC-ENV): these were previously HARDCODED connection strings with
// real passwords — committed to git history (see AUDIT-REPORT.md P0). The
// passwords are now sourced from environment variables, and git history was
// purged with git-filter-repo. Rotate the Supabase password regardless
// (purge cannot retract anything already cloned/cached).
//   NEW DB: DATABASE_URL
//   OLD DB: OLD_DATABASE_URL (optional — cross-DB checks skip when unset)
const OLD_URL = process.env.OLD_DATABASE_URL || '';
const NEW_URL = process.env.DATABASE_URL || '';

if (!NEW_URL) {
  throw new Error('DATABASE_URL is not set — cannot audit the NEW database. ' +
    'Usage: DATABASE_URL=postgresql://... bun run scripts/audit/audit-migration.ts');
}
if (!OLD_URL) {
  console.log('ℹ OLD_DATABASE_URL not set — cross-DB (old vs new) checks will be skipped.');
}

const { oldPool, newPool } = createPools(OLD_URL, NEW_URL);
const ctx = createMigrationAuditContext(oldPool, newPool);

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('╔' + '═'.repeat(68) + '╗');
  console.log('║  AUDIT-MIGRATION — DB Migration Integrity Audit                   ║');
  console.log('║  OLD: vefkgapveggbmkloaslw  →  NEW: proosjqivxadwgftofry         ║');
  console.log('╚' + '═'.repeat(68) + '╝');

  // Connectivity ping
  try {
    const r = await q(oldPool, 'SELECT NOW() AS t');
    console.log(`✓ OLD DB connected at ${r.rows[0].t}`);
  } catch (e: any) {
    console.error(`✗ OLD DB connection FAILED: ${e.message}`);
    console.error(`  Direct hostname db.vefkgapveggbmkloaslw.supabase.co and pooler both unreachable.`);
    console.error(`  This likely means the OLD Supabase project was PAUSED (free tier auto-pause after 7d inactivity) or DELETED.`);
    console.error(`  Continuing with NEW-only checks. Cross-DB checks (row-count comparison, sample record spot-check) will be skipped.`);
    ctx.state.oldReachable = false;
    ctx.addIssue('MIGR-00', 'P1',
      'OLD DB unreachable — cannot perform full cross-DB comparison',
      `OLD Supabase project vefkgapveggbmkloaslw is unreachable. Pooler returns: "${e.message}". Direct hostname db.vefkgapveggbmkloaslw.supabase.co does not resolve in DNS.`,
      'Cannot verify migration parity by direct row-count or sample-record comparison. Migration success must be inferred from NEW DB state alone (row counts vs spec, FK integrity, sequence sync, indexes).',
      'Restore OLD DB: log into Supabase dashboard, find project vefkgapveggbmkloaslw, click "Restore" (if paused) or restore from backup (if deleted). Then re-run this audit. If OLD is permanently gone, treat NEW DB as ground truth and ensure all NEW-only checks pass.'
    );
  }
  try {
    const r = await q(newPool, 'SELECT NOW() AS t');
    console.log(`✓ NEW DB connected at ${r.rows[0].t}`);
  } catch (e: any) {
    console.error(`✗ NEW DB connection FAILED: ${e.message}`);
    process.exit(1);
  }

  const counts = await check1_rowCounts(ctx);
  await check2_fkIntegrity(ctx);
  await check3_sequences(ctx);
  await check4_indexes(ctx);
  await check5_uniqueConstraints(ctx);
  await check6_sampleRecords(ctx);
  await check7_settings(ctx);
  await check8_aggregationCache(ctx);
  await check9_nullChecks(ctx);
  await check10_performance(ctx);

  // Final summary
  printIssueSummary(ctx.issues);
  // Save issues to JSON for the worklog writer
  await writeIssuesJson(ctx.issues, counts);
}

main()
  .catch((e) => {
    console.error('Audit failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await oldPool.end();
    await newPool.end();
  });
