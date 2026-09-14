// ============================================================
//  scripts/db-maintenance.ts — one-command database size maintenance
//  --------------------------------------------------------
//  Runbook for "kenapa file database makin bengkak":
//
//    bun run db:maintenance                # report + safe cleanup + ANALYZE
//    bun run db:maintenance --vacuum-full  # + physical shrink (locks tables)
//
//  Default mode (safe — no exclusive locks, finishes in seconds):
//    1. Report: per-table size (heap + indexes), live vs dead tuples,
//       dead %, last autovacuum, database total size
//    2. Purge orphaned FileChunk rows (> 24h old — leaked chunks from
//       uploads that were never processed / crashed parses)
//    3. Purge AggregationCache rows older than 90 min (same TTL as the
//       app's cleanupExpiredCache — catches keys never re-read on an
//       idle dashboard)
//    4. ANALYZE the hot tables (refresh planner stats after the deletes)
//    5. ALTER TABLE autovacuum tuning (idempotent — same settings the
//       app applies on boot via ensureAutovacuumTuning)
//
//  --vacuum-full: VACUUM FULL ANALYZE rewrites each table + its indexes
//  compactly — the ONLY way to physically return dead space to the OS
//  (plain VACUUM only marks it reusable for future writes). Takes an
//  ACCESS EXCLUSIVE lock per table for the rewrite: at this project's
//  scale (~600K rows) each table takes seconds, but run it at quiet
//  hours — app queries that queue behind the lock for >30s would hit
//  their statement_timeout.
//
//  NOTE: the script auto-switches the Supabase pooler from transaction
//  mode (port 6543) to session mode (port 5432) — VACUUM cannot run
//  through transaction pooling ("VACUUM cannot run inside a
//  transaction block").
// ============================================================
import pg from 'pg';

const VACUUM_FULL = process.argv.includes('--vacuum-full');

// Same TTLs as the runtime helpers (src/lib/db-maintenance.ts +
// aggregation-cache/store.ts) — keep in sync.
const FILE_CHUNK_TTL_HOURS = 24;
const CACHE_TTL_MINUTES = 90;

const TUNING: ReadonlyArray<{ table: string; scale: string }> = [
  { table: 'InventoryRecord', scale: '0.02' },
  { table: 'DQIssue', scale: '0.02' },
  { table: 'AggregationCache', scale: '0.10' },
];

const HOT_TABLES: ReadonlyArray<string> = [
  'InventoryRecord',
  'DQIssue',
  'AggregationCache',
  'FileChunk',
  'OutletPeriodSales',
];

interface TableStat {
  table_name: string;
  total: string;   // pg_size_pretty(total_relation_size)
  heap: string;    // pg_size_pretty(relation_size)
  idx: string;     // pg_size_pretty(indexes_size)
  total_bytes: number;
  live: number;
  dead: number;
  dead_pct: string;
  last_vac: string;
}

function requireDatabaseUrl(): string {
  let url = process.env.DATABASE_URL || '';
  if (!url.startsWith('postgresql://') && !url.startsWith('postgres://')) {
    console.error('❌ DATABASE_URL not set or not postgresql://. Add to .env first.');
    process.exit(1);
  }
  // VACUUM / session-level statements cannot run through the transaction
  // pooler — switch to the session pooler for this maintenance run.
  if (url.includes('.pooler.supabase.com:6543/')) {
    url = url.replace('.pooler.supabase.com:6543/', '.pooler.supabase.com:5432/');
    console.log('ℹ  Pooler switched 6543 → 5432 (session mode) — VACUUM/ALTER need a session connection.');
  }
  return url;
}

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: requireDatabaseUrl() });
  await client.connect();
  console.log('✓ Connected to database\n');

  async function exec(label: string, sql: string): Promise<boolean> {
    const t0 = Date.now();
    try {
      await client.query(sql);
      console.log(`✓ ${label} (${Date.now() - t0}ms)`);
      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`✗ ${label} FAILED (${Date.now() - t0}ms): ${msg.slice(0, 200)}`);
      return false;
    }
  }

  async function fetchStats(): Promise<TableStat[]> {
    const r = await client.query(`
      SELECT c.relname AS table_name,
             pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
             pg_size_pretty(pg_relation_size(c.oid)) AS heap,
             pg_size_pretty(pg_indexes_size(c.oid)) AS idx,
             pg_total_relation_size(c.oid) AS total_bytes,
             s.n_live_tup AS live,
             s.n_dead_tup AS dead,
             COALESCE(ROUND(100.0 * s.n_dead_tup / NULLIF(s.n_live_tup + s.n_dead_tup, 0), 1), 0)::text AS dead_pct,
             COALESCE(s.last_autovacuum::text, 'never') AS last_vac
      FROM pg_stat_user_tables s
      JOIN pg_class c ON c.oid = s.relid
      ORDER BY pg_total_relation_size(c.oid) DESC`);
    return r.rows as TableStat[];
  }

  async function dbTotal(): Promise<string> {
    const r = await client.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS s`);
    return r.rows[0].s as string;
  }

  function printReport(title: string, rows: TableStat[]): void {
    console.log(`── ${title} ──────────────────────────────────────────────`);
    const w = (s: string, n: number): string => String(s).padEnd(n);
    console.log(`${w('table', 22)}${w('total', 10)}${w('heap', 10)}${w('indexes', 10)}${w('live', 9)}${w('dead', 9)}${w('dead%', 7)}last autovacuum`);
    for (const r of rows) {
      console.log(`${w(r.table_name, 22)}${w(r.total, 10)}${w(r.heap, 10)}${w(r.idx, 10)}${w(r.live, 9)}${w(r.dead, 9)}${w(r.dead_pct, 7)}${r.last_vac}`);
    }
    console.log('');
  }

  // ── BEFORE ────────────────────────────────────────────────
  const before = await fetchStats();
  const beforeTotal = await dbTotal();
  printReport('BEFORE', before);
  console.log(`Database total: ${beforeTotal}\n`);

  // ── 1. Orphaned FileChunk purge (> TTL) ───────────────────
  try {
    const r = await client.query(`
      SELECT COUNT(*)::int AS n,
             COALESCE(SUM(octet_length("data")), 0)::bigint AS bytes
      FROM "FileChunk"
      WHERE "createdAt" < now() - interval '${FILE_CHUNK_TTL_HOURS} hours'`);
    const { n, bytes } = r.rows[0];
    const mb = (Number(bytes) / 1024 / 1024).toFixed(1);
    if (n > 0) {
      console.log(`FileChunk orphans (> ${FILE_CHUNK_TTL_HOURS}h): ${n} rows / ${mb} MB → purging…`);
      await exec('purge orphaned FileChunk', `DELETE FROM "FileChunk" WHERE "createdAt" < now() - interval '${FILE_CHUNK_TTL_HOURS} hours'`);
    } else {
      console.log(`FileChunk orphans (> ${FILE_CHUNK_TTL_HOURS}h): none ✓`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`✗ FileChunk check skipped: ${msg.slice(0, 160)} (fresh DB — table not created yet?)`);
  }

  // ── 2. AggregationCache purge (> TTL) ─────────────────────
  try {
    const r = await client.query(`
      SELECT COUNT(*)::int AS n, COALESCE(SUM(octet_length("payload")), 0)::bigint AS bytes
      FROM "AggregationCache"
      WHERE "computedAt" < now() - interval '${CACHE_TTL_MINUTES} minutes'`);
    const { n, bytes } = r.rows[0];
    const mb = (Number(bytes) / 1024 / 1024).toFixed(1);
    if (n > 0) {
      console.log(`AggregationCache expired (> ${CACHE_TTL_MINUTES} min): ${n} rows / ${mb} MB → purging…`);
      await exec('purge expired AggregationCache', `DELETE FROM "AggregationCache" WHERE "computedAt" < now() - interval '${CACHE_TTL_MINUTES} minutes'`);
    } else {
      console.log(`AggregationCache expired (> ${CACHE_TTL_MINUTES} min): none ✓`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`✗ AggregationCache check skipped: ${msg.slice(0, 160)} (fresh DB — table not created yet?)`);
  }
  console.log('');

  // ── 3. Reclaim / refresh stats ────────────────────────────
  console.log(VACUUM_FULL
    ? `VACUUM FULL ANALYZE on ${HOT_TABLES.length} tables (each takes an ACCESS EXCLUSIVE lock)…`
    : `ANALYZE on ${HOT_TABLES.length} tables (plain ANALYZE — no exclusive locks)…`);
  for (const t of HOT_TABLES) {
    if (VACUUM_FULL) {
      await exec(`VACUUM FULL ANALYZE "${t}"`, `VACUUM FULL ANALYZE "${t}"`);
    } else {
      await exec(`ANALYZE "${t}"`, `ANALYZE "${t}"`);
    }
  }
  console.log('');

  // ── 4. Autovacuum tuning (idempotent) ─────────────────────
  for (const { table, scale } of TUNING) {
    await exec(
      `autovacuum tune ${table} (scale ${scale})`,
      `ALTER TABLE "${table}" SET (autovacuum_vacuum_scale_factor = ${scale}, autovacuum_vacuum_cost_delay = 0)`,
    );
  }
  console.log('');

  // ── AFTER + deltas ────────────────────────────────────────
  const after = await fetchStats();
  const afterTotal = await dbTotal();
  printReport('AFTER', after);
  console.log(`Database total: ${beforeTotal} → ${afterTotal}`);

  const beforeMap = new Map(before.map((r) => [r.table_name, r.total_bytes]));
  const deltas: string[] = [];
  for (const r of after) {
    const b = beforeMap.get(r.table_name);
    if (b !== undefined && b !== r.total_bytes) {
      const d = r.total_bytes - b;
      deltas.push(`${r.table_name}: ${d > 0 ? '+' : ''}${(d / 1024 / 1024).toFixed(1)} MB`);
    }
  }
  if (deltas.length > 0) {
    console.log(`\nΔ per table: ${deltas.join(' · ')}`);
  } else {
    console.log('\nΔ per table: no size changes this run (normal when dead tuples were already recycled).');
  }

  if (!VACUUM_FULL) {
    console.log('\nTip: to PHYSICALLY shrink bloated tables (reclaim disk from dead tuples + index bloat):');
    console.log('    bun run db:maintenance --vacuum-full   (ACCESS EXCLUSIVE lock per table — quiet hours)');
  }
  console.log('\n✓ Done. After each new data upload, also run: bun run db:refresh-stats');

  await client.end();
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error('FATAL:', msg.slice(0, 300));
  process.exit(1);
});
