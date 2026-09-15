import type { DataQaContext } from './context';

// ============================================================
//  master-data.ts — QA sections 9–12 (calendar, outlets/items,
//  PIC assignments, areas)
//  SPLIT-F (pure code motion) from audit-data-qa.ts main().
// ============================================================

// ============================================================
//  9. Month/week consistency (QA-8)
// ============================================================
export async function section09_monthWeekConsistency(ctx: DataQaContext): Promise<void> {
  ctx.section('9. MONTH/WEEK CONSISTENCY');
  const monthCounts = await ctx.raw<{ monthLabel: string; n: bigint }[]>(`
    SELECT "monthLabel", COUNT(*)::bigint as n
    FROM "InventoryRecord" GROUP BY "monthLabel" ORDER BY n DESC
  `);
  ctx.log(`  monthLabel distribution:`);
  for (const r of monthCounts) ctx.log(`    ${r.monthLabel}: ${r.n}`);

  const weekCounts = await ctx.raw<{ weekLabel: string; n: bigint }[]>(`
    SELECT "weekLabel", COUNT(*)::bigint as n
    FROM "InventoryRecord" GROUP BY "weekLabel" ORDER BY "weekLabel"
  `);
  ctx.log(`  weekLabel distribution:`);
  for (const r of weekCounts) ctx.log(`    ${r.weekLabel}: ${r.n}`);

  const fileMonthKeys = await ctx.raw<{ monthLabel: string; monthKey: string }[]>(`
    SELECT DISTINCT "monthLabel", "monthKey" FROM "SourceFile"
  `);
  ctx.log(`  SourceFile monthLabel/monthKey:`);
  for (const r of fileMonthKeys) ctx.log(`    ${r.monthLabel} → ${r.monthKey}`);

  // Orphaned weeks: weeks in InventoryRecord but no Week table entry
  const orphanWeeks = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" ir
    WHERE NOT EXISTS (SELECT 1 FROM "Week" w WHERE w.id = ir."weekId")
  `);
  ctx.log(`  Orphaned InventoryRecord (no Week row): ${orphanWeeks[0]?.n ?? 0}`);
}

// ============================================================
//  10. Outlet/Item counts (QA-9)
// ============================================================
export async function section10_outletItemCounts(ctx: DataQaContext): Promise<void> {
  ctx.section('10. OUTLET/ITEM COUNTS');
  const outletCount = await ctx.db.outlet.count();
  const itemCount = await ctx.db.item.count();
  ctx.log(`  Outlet count: ${outletCount}`);
  ctx.log(`  Item count: ${itemCount}`);

  const outletNoArea = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "Outlet" WHERE area IS NULL OR area = ''
  `);
  ctx.log(`  Outlets with NULL/empty area: ${outletNoArea[0]?.n ?? 0}`);

  const itemNoName = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "Item" WHERE name IS NULL OR name = ''
  `);
  ctx.log(`  Items with NULL/empty name: ${itemNoName[0]?.n ?? 0}`);

  const dupOutletCodes = await ctx.raw<{ code: string; n: bigint }[]>(`
    SELECT code, COUNT(*)::bigint as n FROM "Outlet" GROUP BY code HAVING COUNT(*) > 1
  `);
  ctx.log(`  Duplicate Outlet.code: ${dupOutletCodes.length} (should be 0)`);

  const dupItemNames = await ctx.raw<{ name: string; n: bigint }[]>(`
    SELECT name, COUNT(*)::bigint as n FROM "Item" GROUP BY name HAVING COUNT(*) > 1
  `);
  ctx.log(`  Duplicate Item.name: ${dupItemNames.length} (should be 0)`);

  // Records with NULL outletId/itemId
  const nullOutletId = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" WHERE "outletId" IS NULL
  `);
  ctx.log(`  Records with NULL outletId: ${nullOutletId[0]?.n ?? 0}`);
}

// ============================================================
//  11. PIC assignments (QA-10)
// ============================================================
export async function section11_picAssignments(ctx: DataQaContext): Promise<void> {
  ctx.section('11. PIC ASSIGNMENTS');
  const picCount = await ctx.db.outletPIC.count();
  ctx.log(`  OutletPIC count: ${picCount}`);
  const uniquePics = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(DISTINCT pic)::bigint as n FROM "OutletPIC"
  `);
  ctx.log(`  Unique PICs: ${uniquePics[0]?.n ?? 0}`);

  const outletsWithoutPIC = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "Outlet" o
    WHERE NOT EXISTS (SELECT 1 FROM "OutletPIC" p WHERE p."outletCode" = o.code)
  `);
  ctx.log(`  Outlets without PIC: ${outletsWithoutPIC[0]?.n ?? 0}`);

  // Case inconsistent PIC names
  const picCaseDup = await ctx.raw<{ pic_lower: string; variants: number; n: bigint }[]>(`
    SELECT LOWER(pic) as pic_lower, COUNT(DISTINCT pic) as variants, COUNT(*)::bigint as n
    FROM "OutletPIC"
    GROUP BY LOWER(pic)
    HAVING COUNT(DISTINCT pic) > 1
  `);
  ctx.log(`  PIC names with case variants (should be 0): ${picCaseDup.length}`);
  for (const r of picCaseDup.slice(0, 5)) ctx.log(`    "${r.pic_lower}" — ${r.variants} variants`);
}

// ============================================================
//  12. Area values (QA-11)
// ============================================================
export async function section12_areaValues(ctx: DataQaContext): Promise<void> {
  ctx.section('12. AREA VALUES');
  const areas = await ctx.raw<{ area: string; n: bigint }[]>(`
    SELECT area, COUNT(*)::bigint as n FROM "Outlet" GROUP BY area ORDER BY area
  `);
  ctx.log(`  Areas (Outlet table, ${areas.length} unique):`);
  for (const r of areas) ctx.log(`    "${r.area}": ${r.n} outlets`);

  const mixedCaseAreas = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "Outlet"
    WHERE area != UPPER(area)
  `);
  ctx.log(`  Outlets with non-uppercase area: ${mixedCaseAreas[0]?.n ?? 0}`);
}
