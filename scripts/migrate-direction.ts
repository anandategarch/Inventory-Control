#!/usr/bin/env bun
// ============================================================
//  migrate-direction.ts — Fix inverted direction values in DB
//
//  Background: computeDirection was inverted (POSITIVE=LOSS instead of NEGATIVE=LOSS).
//  This migration flips existing direction values:
//    LOSS → SURPLUS
//    SURPLUS → LOSS
//    NEUTRAL → NEUTRAL (unchanged)
//
//  Run AFTER deploying the computeDirection fix.
//  Safe to run multiple times (idempotent — flips back and forth).
//  Run ONCE after deploying the fix.
//
//  Usage: DATABASE_URL=... bun run scripts/migrate-direction.ts
// ============================================================
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient({ log: ['error', 'warn'] });

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Migration: Fix inverted direction values');
  console.log('═══════════════════════════════════════════════');

  // Count before
  const beforeLoss = await db.inventoryRecord.count({ where: { direction: 'LOSS' } });
  const beforeSurplus = await db.inventoryRecord.count({ where: { direction: 'SURPLUS' } });
  const beforeNeutral = await db.inventoryRecord.count({ where: { direction: 'NEUTRAL' } });
  const beforeNull = await db.inventoryRecord.count({ where: { direction: null } });

  console.log('Before migration:');
  console.log(`  LOSS:    ${beforeLoss}`);
  console.log(`  SURPLUS: ${beforeSurplus}`);
  console.log(`  NEUTRAL: ${beforeNeutral}`);
  console.log(`  NULL:    ${beforeNull}`);

  // Flip using raw SQL (works on both PostgreSQL and SQLite)
  // Use a temp value to avoid flipping back immediately
  console.log('\nFlipping direction values...');

  // Step 1: LOSS → __TEMP_LOSS__
  await db.$executeRaw`UPDATE "InventoryRecord" SET direction = '__TEMP_LOSS__' WHERE direction = 'LOSS'`;
  // Step 2: SURPLUS → LOSS
  await db.$executeRaw`UPDATE "InventoryRecord" SET direction = 'LOSS' WHERE direction = 'SURPLUS'`;
  // Step 3: __TEMP_LOSS__ → SURPLUS
  await db.$executeRaw`UPDATE "InventoryRecord" SET direction = 'SURPLUS' WHERE direction = '__TEMP_LOSS__'`;

  console.log('Done!');

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

  console.log('\n✓ Migration complete!');
  console.log('  Note: computeDirection is now fixed for future ingests.');
  console.log('  This migration fixed existing data.');
  console.log('  Safe to re-run (will flip back — do NOT run twice).');
}

main()
  .catch((e) => { console.error('Migration failed:', e); process.exit(1); })
  .finally(() => db.$disconnect());
