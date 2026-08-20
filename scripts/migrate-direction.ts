#!/usr/bin/env bun
// ============================================================
//  migrate-direction.ts — Fix inverted direction values in DB
//
//  Background: computeDirection was inverted (POSITIVE=LOSS instead of NEGATIVE=LOSS).
//  Excel convention: nominalLossSurplus < 0 = LOSS, > 0 = SURPLUS.
//
//  IDEMPOTENT: This migration recomputes direction from nominalLossSurplus sign.
//  Safe to run multiple times — after first run, direction already matches,
//  so subsequent runs do nothing (0 rows updated).
//
//  Usage: DATABASE_URL=... bun run scripts/migrate-direction.ts
// ============================================================
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient({ log: ['error', 'warn'] });

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Migration: Fix direction from nominalLossSurplus sign');
  console.log('  (idempotent — safe to run multiple times)');
  console.log('═══════════════════════════════════════════════');

  // Count before
  const total = await db.inventoryRecord.count();
  if (total === 0) {
    console.log('✓ No records in DB — nothing to migrate.');
    return;
  }

  const beforeLoss = await db.inventoryRecord.count({ where: { direction: 'LOSS' } });
  const beforeSurplus = await db.inventoryRecord.count({ where: { direction: 'SURPLUS' } });
  const beforeNeutral = await db.inventoryRecord.count({ where: { direction: 'NEUTRAL' } });
  const beforeNull = await db.inventoryRecord.count({ where: { direction: null } });

  console.log(`\nTotal records: ${total}`);
  console.log('\nBefore migration:');
  console.log(`  LOSS:    ${beforeLoss}`);
  console.log(`  SURPLUS: ${beforeSurplus}`);
  console.log(`  NEUTRAL: ${beforeNeutral}`);
  console.log(`  NULL:    ${beforeNull}`);

  // Recompute direction from nominalLossSurplus sign.
  // IDEMPOTENT: only updates rows where direction doesn't match the sign.
  // Uses raw SQL for both PostgreSQL and SQLite compatibility.
  console.log('\nRecomputing direction from nominalLossSurplus sign...');

  // LOSS: nominalLossSurplus < 0
  const lossUpdated = await db.$executeRaw`
    UPDATE "InventoryRecord"
    SET direction = 'LOSS'
    WHERE "nominalLossSurplus" IS NOT NULL
      AND "nominalLossSurplus" < 0
      AND direction != 'LOSS'
  `;
  console.log(`  Set LOSS:    ${lossUpdated} rows updated`);

  // SURPLUS: nominalLossSurplus > 0
  const surplusUpdated = await db.$executeRaw`
    UPDATE "InventoryRecord"
    SET direction = 'SURPLUS'
    WHERE "nominalLossSurplus" IS NOT NULL
      AND "nominalLossSurplus" > 0
      AND direction != 'SURPLUS'
  `;
  console.log(`  Set SURPLUS: ${surplusUpdated} rows updated`);

  // NEUTRAL: nominalLossSurplus = 0 (or qtyDeviasi = 0 as fallback)
  const neutralUpdated = await db.$executeRaw`
    UPDATE "InventoryRecord"
    SET direction = 'NEUTRAL'
    WHERE "nominalLossSurplus" IS NOT NULL
      AND "nominalLossSurplus" = 0
      AND direction != 'NEUTRAL'
  `;
  console.log(`  Set NEUTRAL: ${neutralUpdated} rows updated`);

  // Count after
  const afterLoss = await db.inventoryRecord.count({ where: { direction: 'LOSS' } });
  const afterSurplus = await db.inventoryRecord.count({ where: { direction: 'SURPLUS' } });
  const afterNeutral = await db.inventoryRecord.count({ where: { direction: 'NEUTRAL' } });
  const afterNull = await db.inventoryRecord.count({ where: { direction: null } });

  console.log('\nAfter migration:');
  console.log(`  LOSS:    ${afterLoss} (was ${beforeLoss})`);
  console.log(`  SURPLUS: ${afterSurplus} (was ${beforeSurplus})`);
  console.log(`  NEUTRAL: ${afterNeutral} (was ${beforeNeutral})`);
  console.log(`  NULL:    ${afterNull} (was ${beforeNull})`);

  const totalUpdated = lossUpdated + surplusUpdated + neutralUpdated;
  if (totalUpdated === 0) {
    console.log('\n✓ Already migrated — 0 rows updated. DB is in correct state.');
  } else {
    console.log(`\n✓ Migration complete! ${totalUpdated} rows updated.`);
  }
}

main()
  .catch((e) => { console.error('Migration failed:', e); process.exit(1); })
  .finally(() => db.$disconnect());
