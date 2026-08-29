// ============================================================
//  Enable pg_stat_statements on Supabase (free built-in extension)
//
//  PERF-FASE4-PGSTAT: This script enables the pg_stat_statements extension
//  on your Supabase PostgreSQL database. After enabling, you can query
//  performance statistics via:
//
//    SELECT query, calls, mean_exec_time, total_exec_time
//    FROM pg_stat_statements
//    ORDER BY mean_exec_time DESC
//    LIMIT 20;
//
//  This identifies the slowest queries in production — use it to verify
//  that Fase 1-3 optimizations (indexes, pre-computed CTE, SQL evaluators)
//  are actually being used by the query planner.
//
//  NOTE: Supabase may require enabling via Dashboard → Database → Extensions
//  instead of SQL if the database user lacks CREATE EXTENSION privileges.
//  The free tier includes this extension — no paid plan needed.
// ============================================================
import { db } from '../src/lib/db';

async function main() {
  console.log('Enabling pg_stat_statements extension...');

  // Check if already enabled
  const existing = await db.$queryRawUnsafe(`
    SELECT extname FROM pg_extension WHERE extname = 'pg_stat_statements'
  `) as Array<{ extname: string }>;

  if (existing.length > 0) {
    console.log('✅ pg_stat_statements already enabled');
  } else {
    try {
      await db.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`);
      console.log('✅ pg_stat_statements enabled successfully');
    } catch (e: any) {
      console.log('⚠️  Cannot create extension directly (permission denied).');
      console.log('   Enable via Supabase Dashboard:');
      console.log('   → Database → Extensions → search "pg_stat_statements" → toggle ON');
      console.log('   Error:', e.message);
    }
  }

  // Reset stats to start fresh monitoring
  try {
    await db.$executeRawUnsafe(`SELECT pg_stat_statements_reset()`);
    console.log('✅ Stats reset — start monitoring from now');
  } catch (e: any) {
    console.log('⚠️  Cannot reset stats (may need superuser):', e.message);
  }

  // Show top 5 slowest queries (if any stats exist)
  try {
    const topQueries = await db.$queryRawUnsafe(`
      SELECT
        LEFT(query, 120) as query_preview,
        calls,
        ROUND(mean_exec_time::numeric, 1) as mean_ms,
        ROUND(total_exec_time::numeric, 1) as total_ms
      FROM pg_stat_statements
      WHERE query NOT ILIKE '%pg_stat_statements%'
      ORDER BY mean_exec_time DESC
      LIMIT 10
    `) as Array<any>;

    if (topQueries.length > 0) {
      console.log('\n📊 Top 10 slowest queries (by mean execution time):');
      console.log('─'.repeat(100));
      for (const q of topQueries) {
        console.log(`  ${q.mean_ms}ms avg × ${q.calls} calls = ${q.total_ms}ms total`);
        console.log(`  ${q.query_preview}`);
        console.log('');
      }
    } else {
      console.log('\n📊 No query stats yet. Run some API requests, then re-run this script.');
    }
  } catch (e: any) {
    console.log('⚠️  Cannot read stats:', e.message);
  }
}

main().catch(e => { console.error('❌', e); process.exit(1); }).finally(() => db.$disconnect());
