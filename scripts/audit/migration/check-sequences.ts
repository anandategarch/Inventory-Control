import type { MigrationAuditContext } from './context';
import { TABLES } from './context';
import { q } from './db';
import { hr } from './report';

// ============================================================
// CHECK 3: SEQUENCE SYNCHRONIZATION
// ============================================================
export async function check3_sequences(ctx: MigrationAuditContext) {
  hr('CHECK 3 — Sequence Synchronization (NEW DB)');
  console.log('Table'.padEnd(28) + 'MAX(id)'.padStart(12) + 'last_value'.padStart(14) + 'is_called'.padStart(12) + '  Status');
  console.log('-'.repeat(78));
  let seqIssues = 0;
  for (const t of TABLES) {
    try {
      const maxR = await q(ctx.newPool, `SELECT COALESCE(MAX(id), 0)::bigint AS m FROM "${t}"`);
      const maxId = Number(maxR.rows[0].m);
      const seqR = await q(ctx.newPool, `SELECT last_value::bigint AS lv, is_called FROM "${t}_id_seq"`);
      if (seqR.rows.length === 0) {
        console.log(`  ${t.padEnd(28)} — no _id_seq found`);
        continue;
      }
      const lastVal = Number(seqR.rows[0].lv);
      const isCalled = seqR.rows[0].is_called;
      // Correctness: after is_called=true, NEXTVAL returns last_value+1, which must be > MAX(id)
      // After is_called=false (fresh sequence), NEXTVAL returns last_value (the seed).
      const nextVal = isCalled ? lastVal + 1 : lastVal;
      const ok = nextVal > maxId;
      const status = ok ? '✓ OK' : '✗ STALE';
      if (!ok) seqIssues++;
      console.log(t.padEnd(28) + String(maxId).padStart(12) + String(lastVal).padStart(14) + String(isCalled).padStart(12) + '  ' + status);
      if (!ok) {
        ctx.addIssue(`MIGR-03-${t}`, 'P2',
          `Sequence out of sync: ${t}_id_seq`,
          `MAX(id)=${maxId} but last_value=${lastVal} (is_called=${isCalled}). Next INSERT will collide with existing id.`,
          'Next INSERT will fail with primary key violation, OR will silently reuse an existing ID and corrupt data.',
          `Run: SELECT setval('"${t}_id_seq"', (SELECT COALESCE(MAX(id), 0) + 1 FROM "${t}"), false); — sets next nextval() to MAX(id)+1.`
        );
      }
    } catch (e: any) {
      // Some tables (none in our schema) may not have an _id_seq
      if (e.message.includes('does not exist')) {
        console.log(`  ${t.padEnd(28)} — _id_seq does not exist (skipped)`);
      } else {
        console.log(`  ⚠ ${t}: ${e.message}`);
      }
    }
  }
  if (seqIssues === 0) console.log('\n  ✓ All sequences synchronized.');
}
