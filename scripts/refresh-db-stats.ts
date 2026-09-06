// ============================================================
//  scripts/refresh-db-stats.ts — Refresh PostgreSQL planner stats
//  --------------------------------------------------------
//  Run this AFTER uploading new inventory data. PostgreSQL's query
//  planner uses table statistics to choose indexes; without ANALYZE
//  after new data is loaded, stats become stale and the planner may
//  pick slow seq scans or wrong indexes.
//
//  Symptoms of stale stats:
//    - /api/analysis slow (10s+ vs ~3s expected)
//    - /api/pareto slow (5s+ vs ~2s expected)
//    - EXPLAIN shows "Seq Scan" where Index Scan is expected
//
//  Usage:
//    bun run scripts/refresh-db-stats.ts
//
//  What it does:
//    1. ANALYZE "InventoryRecord" — refreshes column stats
//    2. Verifies the FX-PERF covering index exists (creates if missing)
//    3. Sets work_mem = '16MB' for the postgres role (prevents HashAggregate
//       disk spills on the historical multi-metric aggregate)
//
//  Safe to run anytime — ANALYZE is read-only, CREATE INDEX IF NOT EXISTS
//  is idempotent. Does NOT lock tables (CONCURRENTLY where supported).
// ============================================================
import pg from 'pg';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('❌ DATABASE_URL not set. Add to .env first.');
    process.exit(1);
  }
  if (!url.startsWith('postgresql://') && !url.startsWith('postgres://')) {
    console.error('❌ DATABASE_URL must be a postgresql:// URL. Current:', url);
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  console.log('✓ Connected to database');

  async function exec(label, sql) {
    const t0 = Date.now();
    try {
      await client.query(sql);
      console.log(`✓ ${label} (${Date.now() - t0}ms)`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`✗ ${label} FAILED (${Date.now() - t0}ms): ${msg.slice(0, 200)}`);
    }
  }

  // 1. Covering index for queryHistoricalStatsMultiMetric (FX-PERF)
  // Without this, the historical Z-Score baseline takes 8s+ vs 1.6s with it.
  // Index-only scan (Heap Fetches=0) for 7 months × 44K records aggregate.
  await exec('CREATE covering index for historical aggregate', `
    CREATE INDEX IF NOT EXISTS "InventoryRecord_histAgg_cover_idx"
    ON "InventoryRecord" ("weekLabel", "monthLabel", "outletId", "itemId")
    INCLUDE ("qtyBom", "qtyDeviasi", "qtyWaste", "qtySusut", "qtyTrial")
  `);

  // 2. ANALYZE — refresh planner stats on all InventoryRecord columns
  await exec('ANALYZE InventoryRecord', `ANALYZE "InventoryRecord"`);

  // 3. Set work_mem = 16MB for postgres role (persists across sessions).
  // The historical multi-metric aggregate uses HashAggregate that spills
  // to disk with default 4MB. 16MB prevents the spill (Disk Usage: 0).
  // NOTE: PgBouncer transaction mode does NOT preserve per-session SET,
  // so this ALTER ROLE is the only way to make it effective for pooled
  // connections.
  await exec('ALTER ROLE postgres work_mem=16MB', `ALTER ROLE postgres SET work_mem = '16MB'`);

  await client.end();
  console.log('\n✓ Done. Run this script after each new data upload.');
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error('FATAL:', msg);
  process.exit(1);
});
