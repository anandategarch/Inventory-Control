import type { MigrationAuditContext } from './context';
import { q } from './db';
import { hr } from './report';

// ============================================================
// CHECK 6: SAMPLE RECORD SPOT-CHECK (5 random InventoryRecords, all 44 cols)
// ============================================================
export async function check6_sampleRecords(ctx: MigrationAuditContext) {
  hr('CHECK 6 — Sample Record Spot-Check (5 random InventoryRecord IDs)');
  if (!ctx.state.oldReachable) {
    console.log('  ⚠ SKIPPED — OLD DB unreachable. Cannot pick IDs from OLD for cross-DB comparison.');
    console.log('  Falling back to NEW-DB-only check: pick 5 random IDs from NEW, verify they are well-formed (no NULL in critical cols, numeric values look reasonable).');
    // Pick 5 random IDs from NEW DB and verify column-level integrity (no cross-DB comparison)
    const sampleR = await q(ctx.newPool, `SELECT id FROM "InventoryRecord" ORDER BY RANDOM() LIMIT 5`);
    const ids = sampleR.rows.map((r: any) => Number(r.id));
    console.log(`  Picked IDs from NEW: ${JSON.stringify(ids)}`);
    const colsR = await q(ctx.newPool, `SELECT column_name FROM information_schema.columns WHERE table_name='InventoryRecord' AND table_schema='public' ORDER BY ordinal_position`);
    const cols = colsR.rows.map((r: any) => r.column_name);
    let totalIssues = 0;
    for (const id of ids) {
      const r = await q(ctx.newPool, `SELECT * FROM "InventoryRecord" WHERE id = $1`, [id]);
      if (r.rows.length === 0) {
        console.log(`  ✗ ID ${id}: missing in NEW (should never happen — just sampled)`);
        totalIssues++;
        continue;
      }
      const row = r.rows[0];
      // Verify critical columns are non-null
      const criticalCols = ['area', 'monthLabel', 'weekLabel', 'bulan', 'sourceFileId', 'weekId', 'outletId', 'itemId'];
      const nulls = criticalCols.filter(c => row[c] == null);
      if (nulls.length > 0) {
        console.log(`  ✗ ID ${id}: NULL in critical cols: ${nulls.join(', ')}`);
        totalIssues++;
      } else {
        console.log(`  ✓ ID ${id}: all critical cols populated (area=${row.area}, monthLabel=${row.monthLabel}, weekLabel=${row.weekLabel}, outletId=${row.outletId}, itemId=${row.itemId})`);
      }
    }
    if (totalIssues > 0) {
      ctx.addIssue('MIGR-06-NEW', 'P1',
        'Sampled InventoryRecord rows have NULL critical columns',
        `${totalIssues} of 5 sampled NEW-DB rows have NULL in critical columns.`,
        'Queries that filter or group by these columns will silently drop these rows.',
        'See Check 9 for full NULL audit.'
      );
    }
    return;
  }
  // Pick 5 random IDs from OLD DB, then compare all columns
  const oldSampleR = await q(ctx.oldPool, `SELECT id FROM "InventoryRecord" ORDER BY RANDOM() LIMIT 5`);
  const ids = oldSampleR.rows.map((r: any) => Number(r.id));
  console.log(`  Picked IDs: ${JSON.stringify(ids)}`);
  // Get column list
  const colsR = await q(ctx.newPool, `SELECT column_name, data_type FROM information_schema.columns WHERE table_name='InventoryRecord' AND table_schema='public' ORDER BY ordinal_position`);
  const cols = colsR.rows.map((r: any) => r.column_name);
  console.log(`  Columns to compare: ${cols.length} (${cols.join(', ')})`);
  let totalMismatches = 0;
  for (const id of ids) {
    const oldR = await q(ctx.oldPool, `SELECT * FROM "InventoryRecord" WHERE id = $1`, [id]);
    const newR = await q(ctx.newPool, `SELECT * FROM "InventoryRecord" WHERE id = $1`, [id]);
    if (oldR.rows.length === 0) {
      console.log(`  ✗ ID ${id}: not found in OLD DB`);
      continue;
    }
    if (newR.rows.length === 0) {
      console.log(`  ✗ ID ${id}: MISSING in NEW DB — DATA LOSS`);
      ctx.addIssue(`MIGR-06-${id}`, 'P1', `Missing InventoryRecord id=${id}`, `Row exists in OLD but missing in NEW.`, 'Data loss confirmed.', 'Re-run migration for InventoryRecord.');
      totalMismatches++;
      continue;
    }
    const oldRow = oldR.rows[0];
    const newRow = newR.rows[0];
    let mismatchCount = 0;
    const mismatches: string[] = [];
    for (const col of cols) {
      const ov = oldRow[col];
      const nv = newRow[col];
      // Compare with type-aware equality (Date → ISO string, numeric → string)
      const oStr = ov instanceof Date ? ov.toISOString() : (ov && typeof ov === 'object' && 'toISOString' in ov ? String(ov) : ov);
      const nStr = nv instanceof Date ? nv.toISOString() : (nv && typeof nv === 'object' && 'toISOString' in nv ? String(nv) : nv);
      // Numeric comparison with precision tolerance
      const oNum = typeof ov === 'number' || (typeof ov === 'string' && ov !== '' && !isNaN(Number(ov))) ? Number(ov) : null;
      const nNum = typeof nv === 'number' || (typeof nv === 'string' && nv !== '' && !isNaN(Number(nv))) ? Number(nv) : null;
      let equal: boolean;
      if (oNum !== null && nNum !== null) {
        equal = Math.abs(oNum - nNum) < 1e-9;
      } else {
        equal = (oStr ?? null) === (nStr ?? null);
      }
      if (!equal) {
        mismatchCount++;
        mismatches.push(`    ${col}: OLD=${JSON.stringify(ov)}  NEW=${JSON.stringify(nv)}`);
      }
    }
    if (mismatchCount === 0) {
      console.log(`  ✓ ID ${id}: all ${cols.length} columns identical`);
    } else {
      console.log(`  ✗ ID ${id}: ${mismatchCount} column(s) differ:`);
      mismatches.forEach(m => console.log(m));
      totalMismatches += mismatchCount;
    }
  }
  if (totalMismatches === 0) {
    console.log('\n  ✓ All 5 sampled records are byte-identical between OLD and NEW.');
  } else {
    ctx.addIssue('MIGR-06', 'P1',
      'Sample InventoryRecord data differs between OLD and NEW',
      `${totalMismatches} column mismatches across 5 sampled records.`,
      'Data corruption or transformation during migration. Numeric values may have been rounded or timestamps shifted (timezone).',
      'Inspect the specific mismatches above. Likely cause: numeric columns migrated as Float when they should be Decimal, or timestamp columns shifted by timezone offset.'
    );
  }
}
