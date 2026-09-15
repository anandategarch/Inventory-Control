import type { MigrationAuditContext } from './context';
import { q } from './db';
import { hr } from './report';

// ============================================================
// CHECK 4: INDEX INTEGRITY (vs schema.prisma)
// ============================================================
export async function check4_indexes(ctx: MigrationAuditContext) {
  hr('CHECK 4 — Index Integrity (NEW DB)');
  // Fetch indexes WITH their column list so we can match by definition
  // (PostgreSQL truncates index names to 63 chars — Prisma's auto-generated
  // names often exceed this, so we need to match by columns as a fallback).
  const r = await q(ctx.newPool, `
    SELECT i.indexname, i.tablename, i.indexdef,
           array_to_string(array_agg(a.attname ORDER BY x.ord), ',') AS cols_csv
    FROM pg_indexes i
    JOIN pg_class c ON c.relname = i.tablename
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    JOIN pg_index ix ON ix.indexrelid = (
      SELECT oid FROM pg_class c2 WHERE c2.relname = i.indexname
    )
    JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS x(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = x.attnum
    WHERE i.schemaname = 'public'
    GROUP BY i.indexname, i.tablename, i.indexdef
    ORDER BY i.tablename, i.indexname
  `);
  const byTable: Record<string, Array<{ name: string; cols: string[] }>> = {};
  for (const row of r.rows) {
    if (!byTable[row.tablename]) byTable[row.tablename] = [];
    const cols = typeof row.cols_csv === 'string' ? row.cols_csv.split(',') : [];
    byTable[row.tablename].push({ name: row.indexname, cols });
  }
  // Expected indexes from schema.prisma: name + columns (for truncation-tolerant matching)
  const expected: Record<string, Array<{ name: string; cols: string[] }>> = {
    'SourceFile': [
      { name: 'SourceFile_fileName_key',           cols: ['fileName'] },
      { name: 'SourceFile_fileHash_key',           cols: ['fileHash'] },
    ],
    'Week': [
      { name: 'Week_sourceFileId_weekLabel_key',   cols: ['sourceFileId', 'weekLabel'] },
      { name: 'Week_monthKey_idx',                 cols: ['monthKey'] },
    ],
    'Outlet': [
      { name: 'Outlet_code_key',                   cols: ['code'] },
    ],
    'Item': [
      { name: 'Item_name_key',                     cols: ['name'] },
    ],
    'InventoryRecord': [
      { name: 'InventoryRecord_weekId_outletId_itemId_akunPenyesuaian_key', cols: ['weekId', 'outletId', 'itemId', 'akunPenyesuaian'] },
      { name: 'InventoryRecord_outletId_weekId_idx',                          cols: ['outletId', 'weekId'] },
      { name: 'InventoryRecord_itemId_weekId_idx',                            cols: ['itemId', 'weekId'] },
      { name: 'InventoryRecord_area_weekId_idx',                              cols: ['area', 'weekId'] },
      { name: 'InventoryRecord_monthLabel_weekLabel_idx',                     cols: ['monthLabel', 'weekLabel'] },
      { name: 'InventoryRecord_direction_idx',                                cols: ['direction'] },
      { name: 'InventoryRecord_outletId_itemId_idx',                          cols: ['outletId', 'itemId'] },
      { name: 'InventoryRecord_area_monthLabel_weekLabel_idx',                cols: ['area', 'monthLabel', 'weekLabel'] },
      { name: 'InventoryRecord_monthLabel_weekLabel_outletId_idx',            cols: ['monthLabel', 'weekLabel', 'outletId'] },
      { name: 'InventoryRecord_outletId_itemId_akunPenyesuaian_monthLabel_weekLabel_idx', cols: ['outletId', 'itemId', 'akunPenyesuaian', 'monthLabel', 'weekLabel'] },
      { name: 'InventoryRecord_sourceFileId_idx',                             cols: ['sourceFileId'] },
    ],
    'OutletPeriodSales': [
      { name: 'OutletPeriodSales_outletId_monthLabel_weekLabel_key', cols: ['outletId', 'monthLabel', 'weekLabel'] },
      { name: 'OutletPeriodSales_monthLabel_weekLabel_idx',          cols: ['monthLabel', 'weekLabel'] },
      { name: 'OutletPeriodSales_monthLabel_weekLabel_outletId_idx', cols: ['monthLabel', 'weekLabel', 'outletId'] },
      { name: 'OutletPeriodSales_sourceFileId_idx',                  cols: ['sourceFileId'] },
    ],
    'DQIssue': [
      { name: 'DQIssue_sourceFileId_idx',     cols: ['sourceFileId'] },
      { name: 'DQIssue_code_severity_idx',    cols: ['code', 'severity'] },
    ],
    'AggregationCache': [
      { name: 'AggregationCache_cacheKey_key',     cols: ['cacheKey'] },
      { name: 'AggregationCache_computedAt_idx',   cols: ['computedAt'] },
    ],
    'Setting': [
      { name: 'Setting_key_key',                   cols: ['key'] },
    ],
    'OutletPIC': [
      { name: 'OutletPIC_outletCode_key',          cols: ['outletCode'] },
    ],
    'FileChunk': [
      { name: 'FileChunk_fileHash_chunkIndex_key', cols: ['fileHash', 'chunkIndex'] },
      { name: 'FileChunk_fileHash_idx',            cols: ['fileHash'] },
    ],
    'AuditLog': [],
  };

  let missingCount = 0;
  let truncatedCount = 0;
  for (const [table, idxs] of Object.entries(expected)) {
    const actual = byTable[table] ?? [];
    console.log(`\n  ${table}: ${actual.length} indexes found`);
    for (const exp of idxs) {
      // Match by name first
      let found = actual.find(a => a.name === exp.name);
      let matchMode = 'name';
      if (!found) {
        // Fallback: match by column list (for PG-truncated names)
        found = actual.find(a => a.cols.length === exp.cols.length && a.cols.every((c, i) => c === exp.cols[i]));
        if (found) {
          matchMode = 'cols (name truncated by PG 63-char limit)';
          truncatedCount++;
        }
      }
      if (!found) {
        missingCount++;
        console.log(`    ✗ MISSING ${exp.name}  cols=[${exp.cols.join(',')}]`);
      } else {
        const tag = matchMode.startsWith('name') ? '✓' : '~';
        console.log(`    ${tag} ${exp.name}  →  actual="${found.name}"  cols=[${found.cols.join(',')}]${matchMode.startsWith('cols') ? '  (name truncated)' : ''}`);
      }
    }
  }
  if (missingCount > 0) {
    ctx.addIssue('MIGR-04', 'P2',
      'Missing indexes in NEW DB',
      `${missingCount} indexes from schema.prisma not present in NEW DB.`,
      'Queries that depend on these indexes will degrade to full table scans (seconds → minutes on InventoryRecord with ~600K rows).',
      'Run `bunx prisma db push --skip-generate` or `bunx prisma migrate deploy` to apply missing indexes.'
    );
  } else {
    console.log(`\n  ✓ All schema.prisma indexes present in NEW DB.`);
    if (truncatedCount > 0) {
      console.log(`  ℹ ${truncatedCount} index(es) have PG-truncated names (cosmetic — index exists and covers correct columns).`);
    }
  }
}
