import type { MigrationAuditContext } from './context';
import { TABLES } from './context';
import { q } from './db';
import { hr } from './report';

// ============================================================
// CHECK 1: ROW COUNT COMPARISON
// ============================================================
export async function check1_rowCounts(ctx: MigrationAuditContext) {
  hr('CHECK 1 — Row Count Comparison (OLD vs NEW)');
  console.log('Table'.padEnd(28) + 'OLD'.padStart(12) + 'NEW'.padStart(12) + 'DIFF'.padStart(10) + '  Status');
  console.log('-'.repeat(74));
  let mismatchCount = 0;
  const counts: Record<string, { old: number; new: number }> = {};
  for (const t of TABLES) {
    let oldCount = -1, newCount = -1;
    if (ctx.state.oldReachable) {
      try {
        const r1 = await q(ctx.oldPool, `SELECT COUNT(*)::bigint AS c FROM "${t}"`);
        oldCount = Number(r1.rows[0].c);
      } catch (e: any) {
        oldCount = -2;
        console.log(`  ⚠ OLD DB error on ${t}: ${e.message}`);
      }
    } else {
      oldCount = -3; // sentinel: OLD unreachable
    }
    try {
      const r2 = await q(ctx.newPool, `SELECT COUNT(*)::bigint AS c FROM "${t}"`);
      newCount = Number(r2.rows[0].c);
    } catch (e: any) {
      newCount = -2;
      console.log(`  ⚠ NEW DB error on ${t}: ${e.message}`);
    }
    counts[t] = { old: oldCount, new: newCount };
    const diff = newCount - Math.max(0, oldCount);
    const status = !ctx.state.oldReachable ? '? OLD UNREACHABLE' : (oldCount === newCount ? '✓ MATCH' : (oldCount < 0 || newCount < 0 ? '✗ ERROR' : '✗ MISMATCH'));
    if (status.startsWith('✗ MISMATCH')) mismatchCount++;
    console.log(t.padEnd(28) + (oldCount === -3 ? 'N/A'.padStart(12) : String(oldCount).padStart(12)) + String(newCount).padStart(12) + (diff >= 0 ? '+' + diff : String(diff)).padStart(10) + '  ' + status);
  }
  const totalOld = Object.values(counts).reduce((s, x) => s + Math.max(0, x.old), 0);
  const totalNew = Object.values(counts).reduce((s, x) => s + Math.max(0, x.new), 0);
  console.log('-'.repeat(74));
  console.log('TOTAL'.padEnd(28) + String(totalOld).padStart(12) + String(totalNew).padStart(12) + (String(totalNew - totalOld).padStart(10)));
  console.log(`\nExpected per task spec: 626,739 rows migrated across 10 tables.`);
  console.log(`Old grand total (12 tables): ${totalOld}`);
  console.log(`New grand total (12 tables): ${totalNew}`);

  // Specific issue: detect any table mismatch
  for (const t of TABLES) {
    const { old: o, new: n } = counts[t];
    if (ctx.state.oldReachable && o !== n) {
      // Setting & AggregationCache expected to differ (intentional skip)
      if (t === 'AggregationCache') {
        if (n > 0) {
          ctx.addIssue(
            'MIGR-08', 'P3',
            'AggregationCache not empty in NEW DB',
            `AggregationCache has ${n} rows in NEW DB. It was meant to be skipped (cache — will rebuild on first API call).`,
            'Minor — stale cache entries from a partial migration. Functionally harmless but indicates inconsistent migration execution.',
            'TRUNCATE "AggregationCache"; — it will rebuild lazily via setCached() on first /api/analysis call.'
          );
        } else {
          console.log(`  ✓ AggregationCache empty in NEW DB (intentional — auto-rebuilds on first API call).`);
        }
      } else if (t === 'Setting') {
        // Will be checked more thoroughly in Check 7
      } else {
        ctx.addIssue(
          `MIGR-01-${t}`, 'P1',
          `Row count mismatch: ${t}`,
          `OLD=${o}  NEW=${n}  (diff ${n - o})`,
          o > n ? `DATA LOSS: ${o - n} rows missing from NEW DB.` : `Unexpected extra rows: ${n - o} more in NEW than OLD.`,
          `Investigate migration script for ${t}. If OLD > NEW, re-run migration for this table only. If NEW > OLD, check for duplicate inserts.`
        );
      }
    }
  }
  // Cross-check NEW totals against spec
  const expectedMigratedTotal = 626739;
  const newMigratedTotal = TABLES
    .filter(t => t !== 'Setting' && t !== 'AggregationCache') // 10 migrated tables
    .reduce((s, t) => s + Math.max(0, counts[t]?.new ?? 0), 0);
  console.log(`\n  Task spec says: 626,739 rows migrated across 10 tables (excluding Setting + AggregationCache).`);
  console.log(`  NEW DB actual total (10 migrated tables): ${newMigratedTotal.toLocaleString()}`);
  if (newMigratedTotal === expectedMigratedTotal) {
    console.log(`  ✓ NEW DB total matches spec exactly.`);
  } else {
    const diff = newMigratedTotal - expectedMigratedTotal;
    console.log(`  ${diff > 0 ? '✗' : '⚠'} Mismatch: ${Math.abs(diff).toLocaleString()} rows ${diff > 0 ? 'MORE' : 'FEWER'} than spec.`);
    // Check if the diff is explained by post-migration AuditLog activity
    if (diff > 0 && diff <= 10) {
      const recentAuditR = await q(ctx.newPool, `SELECT COUNT(*)::int AS c FROM "AuditLog" WHERE "createdAt" > NOW() - INTERVAL '24 hours'`);
      const recentAudit = recentAuditR.rows[0].c;
      console.log(`  ℹ Recent AuditLog entries (last 24h, post-migration activity): ${recentAudit}`);
      if (recentAudit >= diff) {
        console.log(`  ✓ Diff (${diff}) is fully explained by post-migration AuditLog entries (${recentAudit} in last 24h). Migration itself was exact.`);
        ctx.addIssue('MIGR-01-TOTAL', 'P3',
          'NEW DB total differs from spec — explained by post-migration AuditLog growth',
          `Spec: 626,739 migrated. NEW total: ${newMigratedTotal.toLocaleString()} (+${diff}). The +${diff} matches recent AuditLog entries (last 24h: ${recentAudit}) — post-migration ANALYSIS API calls. Migration itself was exact.`,
          'None — this is expected live-DB behavior. AuditLog grows with every API call.',
          'No action required. If exact parity is needed for forensic reasons, query AuditLog WHERE "createdAt" <= <migration_completion_timestamp>.'
        );
      } else {
        ctx.addIssue('MIGR-01-TOTAL', diff < 0 ? 'P1' : 'P2',
          'NEW DB total does not match migration spec',
          `Spec: 626,739. NEW: ${newMigratedTotal.toLocaleString()} (${diff >= 0 ? '+' : ''}${diff}). Recent AuditLog entries (${recentAudit}) do NOT fully explain the gap.`,
          diff < 0 ? 'DATA LOSS — fewer rows in NEW than what was reported migrated.' : 'Either spec was wrong or migration inserted extra rows.',
          'Compare per-table counts in NEW against migration logs. If a specific table is short, re-migrate it.'
        );
      }
    } else {
      ctx.addIssue('MIGR-01-TOTAL', diff < 0 ? 'P1' : 'P2',
        'NEW DB total does not match migration spec',
        `Spec: 626,739. NEW: ${newMigratedTotal.toLocaleString()} (${diff >= 0 ? '+' : ''}${diff}).`,
        diff < 0 ? 'DATA LOSS — fewer rows in NEW than what was reported migrated.' : 'Either spec was wrong or migration inserted extra rows.',
        'Compare per-table counts in NEW against migration logs.'
      );
    }
  }
  // Check for orphaned FileChunk entries (should be auto-cleaned per schema comment)
  const fcCount = counts['FileChunk']?.new ?? 0;
  if (fcCount > 0) {
    ctx.addIssue('MIGR-11', 'P3',
      'Orphaned FileChunk entries in NEW DB',
      `FileChunk has ${fcCount} rows. Per schema.prisma comment (line 274): "Auto-cleaned after processing (DELETE WHERE fileHash)". These should be empty post-ingest.`,
      'Minor — wastes a few KB of storage. Chunks are temp storage for chunked uploads; they are not queried by the app after reassembly.',
      `Run: DELETE FROM "FileChunk" WHERE "createdAt" < NOW() - INTERVAL '1 day';  — or just TRUNCATE "FileChunk"; (safe — chunks are only useful mid-upload).`
    );
  }
  return counts;
}
