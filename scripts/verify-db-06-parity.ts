#!/usr/bin/env bun
// ============================================================
//  verify-db-06-parity.ts — DB-06 parity verification
//  ---------------------------------------------------------
//  Runs each refactored query against the live DB and verifies
//  that the returned sales values match what the original
//  inline CTE pipeline would produce. Catches regressions from
//  the OutletPeriodSales refactor.
//
//  Usage:  bun run scripts/verify-db-06-parity.ts
// ============================================================
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient({ log: ['error'] });

interface Check {
  name: string;
  queryArgs: any;
  // Run the refactored query
  refactored: () => Promise<any[]>;
  // Build the inline-CTE SQL (original implementation) and return rows
  inlineCte: () => Promise<any[]>;
  // Compare sales values from both
  extract: (row: any) => { key: string; sales: number } | null;
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  DB-06 Parity Verification');
  console.log('═══════════════════════════════════════════════');

  // Find the latest period in the DB to use for testing
  const latest = await db.inventoryRecord.findFirst({
    orderBy: [{ monthLabel: 'desc' }, { weekLabel: 'desc' }],
    select: { monthLabel: true, weekLabel: true },
  });
  if (!latest) {
    console.log('⚠ No InventoryRecord data — skipping parity check.');
    return;
  }
  console.log(`Using latest period: month="${latest.monthLabel}" week="${latest.weekLabel}"\n`);

  // Find an outlet code to test peer-comparison with
  const sampleOutlet = await db.outlet.findFirst({ select: { code: true } });
  const outletCode = sampleOutlet?.code ?? '1030.BDGSET';

  const filters = { area: null, outletCode: null, itemName: null, picOutletCodes: null, kelompok: null };

  // === Check 1: queryTopOutlets — compare refactored vs inline CTE ===
  console.log('--- Check 1: queryTopOutlets (Variant A) ---');
  // Import the refactored query
  const { queryTopOutlets } = await import('../src/lib/queries/outlets/top-outlets');
  const refactoredRows = await queryTopOutlets(latest.weekLabel, latest.monthLabel, filters, 50);

  // Build inline-CTE SQL (the original implementation)
  const inlineRows = await db.$queryRaw<Array<{ outletCode: string; sales: number }>>`
    WITH sales_counts AS (
      SELECT ir."outletId", ir."nominalSales", COUNT(*) as cnt
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${latest.monthLabel} AND ir."weekLabel" = ${latest.weekLabel}
        AND ir."nominalSales" IS NOT NULL AND ir."nominalSales" > 0
      GROUP BY ir."outletId", ir."nominalSales"
    ),
    ranked_sales AS (
      SELECT "outletId", "nominalSales",
        ROW_NUMBER() OVER (PARTITION BY "outletId" ORDER BY cnt DESC, "nominalSales" ASC) as rn
      FROM sales_counts
    ),
    sales_mode AS (
      SELECT "outletId", "nominalSales" as sales FROM ranked_sales WHERE rn = 1
    )
    SELECT o.code as "outletCode", COALESCE(sm.sales, 0) as sales
    FROM sales_mode sm
    JOIN "Outlet" o ON sm."outletId" = o.id
  `;
  const inlineMap = new Map<string, number>();
  for (const r of inlineRows) {
    inlineMap.set(r.outletCode, Number(r.sales));
  }
  let mismatches = 0;
  for (const row of refactoredRows) {
    const expected = inlineMap.get(row.outletCode);
    if (expected === undefined) {
      console.log(`  ✗ ${row.outletCode}: not in inline CTE output`);
      mismatches++;
      continue;
    }
    const actual = Number(row.sales);
    if (Math.abs(actual - expected) > 0.01) {
      console.log(`  ✗ ${row.outletCode}: refactored=${actual} inline=${expected}`);
      mismatches++;
    }
  }
  if (mismatches === 0) {
    console.log(`  ✓ ${refactoredRows.length} outlets match inline CTE sales values.`);
  } else {
    console.log(`  ⚠ ${mismatches} mismatches in ${refactoredRows.length} outlets.`);
  }

  // === Check 2: queryExecSummary — compare refactored vs inline CTE ===
  console.log('\n--- Check 2: queryExecSummary (Variant D — grand total) ---');
  const { queryExecSummary } = await import('../src/lib/queries/dashboard');
  const refactoredSummary = await queryExecSummary(latest.weekLabel, latest.monthLabel, filters);
  const inlineSummary = await db.$queryRaw<Array<{ sales: number }>>`
    WITH sales_counts AS (
      SELECT ir."outletId", ir."nominalSales", COUNT(*) as cnt
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${latest.monthLabel} AND ir."weekLabel" = ${latest.weekLabel}
        AND ir."nominalSales" IS NOT NULL AND ir."nominalSales" > 0
      GROUP BY ir."outletId", ir."nominalSales"
    ),
    ranked_sales AS (
      SELECT "outletId", "nominalSales",
        ROW_NUMBER() OVER (PARTITION BY "outletId" ORDER BY cnt DESC, "nominalSales" ASC) as rn
      FROM sales_counts
    ),
    sales_mode AS (
      SELECT SUM("nominalSales") as sales FROM ranked_sales WHERE rn = 1
    )
    SELECT COALESCE(sales, 0) as sales FROM sales_mode
  `;
  const refactoredSales = Number(refactoredSummary?.sales ?? 0);
  const inlineSalesTotal = Number(inlineSummary[0]?.sales ?? 0);
  if (Math.abs(refactoredSales - inlineSalesTotal) > 0.01) {
    console.log(`  ✗ refactored=${refactoredSales} inline=${inlineSalesTotal}`);
    mismatches++;
  } else {
    console.log(`  ✓ grand total sales match: ${refactoredSales} (inline: ${inlineSalesTotal})`);
  }

  // === Check 3: queryAreaAnalysis — compare refactored vs inline CTE ===
  console.log('\n--- Check 3: queryAreaAnalysis (Variant A — per-area SUM) ---');
  const { queryAreaAnalysis } = await import('../src/lib/queries/areas');
  const refactoredAreas = await queryAreaAnalysis(latest.weekLabel, latest.monthLabel, filters);
  const inlineAreas = await db.$queryRaw<Array<{ area: string; totalSales: number }>>`
    WITH sales_counts AS (
      SELECT ir.area, ir."outletId", ir."nominalSales", COUNT(*) as cnt
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${latest.monthLabel} AND ir."weekLabel" = ${latest.weekLabel}
        AND ir."nominalSales" IS NOT NULL AND ir."nominalSales" > 0
      GROUP BY ir.area, ir."outletId", ir."nominalSales"
    ),
    ranked_sales AS (
      SELECT area, "outletId", "nominalSales",
        ROW_NUMBER() OVER (PARTITION BY area, "outletId" ORDER BY cnt DESC, "nominalSales" ASC) as rn
      FROM sales_counts
    ),
    sales_mode AS (
      SELECT area, "outletId", "nominalSales" as sales FROM ranked_sales WHERE rn = 1
    ),
    area_sales AS (
      SELECT area, SUM(sales) as "totalSales" FROM sales_mode GROUP BY area
    )
    SELECT area, "totalSales" FROM area_sales
  `;
  const inlineAreaMap = new Map<string, number>();
  for (const r of inlineAreas) {
    inlineAreaMap.set(r.area, Number(r.totalSales));
  }
  let areaMismatches = 0;
  for (const row of refactoredAreas) {
    const expected = inlineAreaMap.get(row.area);
    if (expected === undefined) {
      console.log(`  ✗ ${row.area}: not in inline CTE output`);
      areaMismatches++;
      continue;
    }
    const actual = Number(row.totalSales);
    if (Math.abs(actual - expected) > 0.01) {
      console.log(`  ✗ ${row.area}: refactored=${actual} inline=${expected}`);
      areaMismatches++;
    }
  }
  if (areaMismatches === 0) {
    console.log(`  ✓ ${refactoredAreas.length} areas match inline CTE totalSales values.`);
  } else {
    console.log(`  ⚠ ${areaMismatches} area mismatches in ${refactoredAreas.length} areas.`);
    mismatches += areaMismatches;
  }

  // === Check 4: queryPeerComparison — verify targetSales ===
  console.log(`\n--- Check 4: queryPeerComparison (Variant A — target sales) ---`);
  const { queryPeerComparison } = await import('../src/lib/queries/outlets/peer-comparison');
  // Determine the max week for month mode
  const maxWeek = await db.inventoryRecord.findFirst({
    where: { monthLabel: latest.monthLabel },
    orderBy: { weekLabel: 'desc' },
    select: { weekLabel: true },
  });
  const { targetSales } = await queryPeerComparison(
    outletCode, latest.monthLabel, maxWeek?.weekLabel ?? null, 'week', 20, null,
  );
  // Compute target sales directly via inline CTE
  const inlineTarget = await db.$queryRaw<Array<{ sales: number }>>`
    WITH sales_counts AS (
      SELECT ir."outletId", ir."nominalSales", COUNT(*) as cnt
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${latest.monthLabel}
        AND ir."weekLabel" = ${maxWeek?.weekLabel}
        AND ir."nominalSales" IS NOT NULL AND ir."nominalSales" > 0
      GROUP BY ir."outletId", ir."nominalSales"
    ),
    ranked_sales AS (
      SELECT "outletId", "nominalSales",
        ROW_NUMBER() OVER (PARTITION BY "outletId" ORDER BY cnt DESC, "nominalSales" ASC) as rn
      FROM sales_counts
    ),
    sales_mode AS (
      SELECT "outletId", "nominalSales" as sales FROM ranked_sales WHERE rn = 1
    )
    SELECT sm.sales FROM sales_mode sm JOIN "Outlet" o ON sm."outletId" = o.id
    WHERE o.code = ${outletCode}
  `;
  const inlineTargetSales = Number(inlineTarget[0]?.sales ?? 0);
  if (Math.abs(targetSales - inlineTargetSales) > 0.01) {
    console.log(`  ✗ targetSales refactored=${targetSales} inline=${inlineTargetSales}`);
    mismatches++;
  } else {
    console.log(`  ✓ targetSales for ${outletCode} matches: ${targetSales} (inline: ${inlineTargetSales})`);
  }

  console.log('\n═══════════════════════════════════════════════');
  if (mismatches === 0) {
    console.log('  ✓ All parity checks PASSED.');
  } else {
    console.log(`  ⚠ ${mismatches} mismatches found — investigate before deploying.`);
  }
  console.log('═══════════════════════════════════════════════');
}

main()
  .catch((e) => {
    console.error('Parity verification failed:', e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
