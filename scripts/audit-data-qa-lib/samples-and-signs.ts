import type { DataQaContext } from './context';

// ============================================================
//  samples-and-signs.ts — QA sections 18–21 (sign cross-checks,
//  sample rows, outlet priority proxy)
//  SPLIT-F (pure code motion) from audit-data-qa.ts main().
// ============================================================

// ============================================================
//  18. nominalDeviasi vs nominalLossSurplus — sign consistency
// ============================================================
export async function section18_nominalDeviasiVsLossSurplus(ctx: DataQaContext): Promise<void> {
  ctx.section('18. nominalDeviasi vs nominalLossSurplus');
  const lsVsDev = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE "nominalDeviasi" IS NOT NULL AND "nominalLossSurplus" IS NOT NULL
      AND "nominalDeviasi" != 0 AND "nominalLossSurplus" != 0
      AND SIGN("nominalDeviasi") != SIGN("nominalLossSurplus")
  `);
  ctx.log(`  Records where nominalDeviasi sign != nominalLossSurplus sign (non-zero both): ${lsVsDev[0]?.n ?? 0}`);
}

// ============================================================
//  19. Sample direction=LOSS rows (verify sign)
// ============================================================
export async function section19_sampleLossRows(ctx: DataQaContext): Promise<void> {
  ctx.section('19. SAMPLE 5 LOSS ROWS');
  const lossSample = await ctx.raw<{ outletCode: string; itemName: string; qtyDeviasi: number; nominalLossSurplus: number; direction: string }[]>(`
    SELECT o.code as "outletCode", i.name as "itemName", ir."qtyDeviasi", ir."nominalLossSurplus", ir.direction
    FROM "InventoryRecord" ir
    JOIN "Outlet" o ON ir."outletId"=o.id
    JOIN "Item" i ON ir."itemId"=i.id
    WHERE ir.direction='LOSS' AND ir."nominalLossSurplus" IS NOT NULL
    LIMIT 5
  `);
  for (const r of lossSample) ctx.log(`    ${r.outletCode} | ${r.itemName} | qtyDeviasi=${r.qtyDeviasi} | nominalLossSurplus=${r.nominalLossSurplus} | direction=${r.direction}`);
}

// ============================================================
//  20. Sample direction=SURPLUS rows
// ============================================================
export async function section20_sampleSurplusRows(ctx: DataQaContext): Promise<void> {
  ctx.section('20. SAMPLE 5 SURPLUS ROWS');
  const surplusSample = await ctx.raw<{ outletCode: string; itemName: string; qtyDeviasi: number; nominalLossSurplus: number; direction: string }[]>(`
    SELECT o.code as "outletCode", i.name as "itemName", ir."qtyDeviasi", ir."nominalLossSurplus", ir.direction
    FROM "InventoryRecord" ir
    JOIN "Outlet" o ON ir."outletId"=o.id
    JOIN "Item" i ON ir."itemId"=i.id
    WHERE ir.direction='SURPLUS' AND ir."nominalLossSurplus" IS NOT NULL
    LIMIT 5
  `);
  for (const r of surplusSample) ctx.log(`    ${r.outletCode} | ${r.itemName} | qtyDeviasi=${r.qtyDeviasi} | nominalLossSurplus=${r.nominalLossSurplus} | direction=${r.direction}`);
}

// ============================================================
//  21. Top-N outlets priority score range (simplified)
// ============================================================
export async function section21_outletPriorityScore(ctx: DataQaContext): Promise<void> {
  ctx.section('21. OUTLET PRIORITY SCORE (via outlets.ts formula)');
  const priorityScores = await ctx.raw<{ outletcode: string; outletname: string; priorityscore: number }[]>(`
    WITH oa AS (
      SELECT ir."outletId",
        SUM(ir."nominalDeviasi") as "nominalDeviasi",
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE 0 END as "devBom",
        SUM(CASE WHEN ir."nominalLossSurplus" < 0 THEN ABS(ir."nominalLossSurplus") ELSE 0 END) as "totalLoss",
        SUM(CASE WHEN ir."nominalLossSurplus" > 0 THEN ir."nominalLossSurplus" ELSE 0 END) as "totalSurplus"
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel"='MEI 2026' AND ir."weekLabel"='WEEK 4'
      GROUP BY ir."outletId"
    )
    SELECT o.code as outletcode, o.name as outletname,
      GREATEST(0, LEAST(100, ROUND(
        LEAST(100, (CASE WHEN AVG(oa."devBom") OVER () > 0 THEN oa."devBom" / AVG(oa."devBom") OVER () ELSE 0 END) * 33) * 0.12 +
        LEAST(100, oa."totalLoss" * 100) * 0.05 +  -- proxy for loss/sales component
        0
      ))) as priorityscore
    FROM oa
    JOIN "Outlet" o ON oa."outletId" = o.id
    ORDER BY priorityscore DESC
    LIMIT 10
  `);
  ctx.log(`  Top 10 outlet priority (rough proxy):`);
  for (const r of priorityScores) ctx.log(`    ${r.outletcode} (${r.outletname}) → ${r.priorityscore}`);
}
