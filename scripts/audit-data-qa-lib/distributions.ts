import type { DataQaContext } from './context';

// ============================================================
//  distributions.ts — QA sections 22–27 (by-month distributions
//  + full listings / outlier scans)
//  SPLIT-F (pure code motion) from audit-data-qa.ts main().
// ============================================================

// ============================================================
//  22. Direction counts BY month (verify migration applied to all)
// ============================================================
export async function section22_directionCountsByMonth(ctx: DataQaContext): Promise<void> {
  ctx.section('22. DIRECTION COUNTS BY MONTH');
  const dirByMonth = await ctx.raw<{ monthLabel: string; direction: string | null; n: bigint }[]>(`
    SELECT "monthLabel", direction::text, COUNT(*)::bigint as n
    FROM "InventoryRecord"
    GROUP BY "monthLabel", direction
    ORDER BY "monthLabel", direction
  `);
  for (const r of dirByMonth) ctx.log(`  ${r.monthLabel} | ${r.direction ?? 'NULL'}: ${r.n}`);
}

// ============================================================
//  23. WEEK 3 presence
// ============================================================
export async function section23_weekLabelsByMonth(ctx: DataQaContext): Promise<void> {
  ctx.section('23. WEEK LABELS BY MONTH');
  const weekByMonth = await ctx.raw<{ monthLabel: string; weekLabel: string; n: bigint }[]>(`
    SELECT "monthLabel", "weekLabel", COUNT(*)::bigint as n
    FROM "InventoryRecord"
    GROUP BY "monthLabel", "weekLabel"
    ORDER BY "monthLabel", "weekLabel"
  `);
  for (const r of weekByMonth) ctx.log(`  ${r.monthLabel} | ${r.weekLabel}: ${r.n}`);
}

// ============================================================
//  24. residualQty < 0 breakdown — is it always LOSS direction?
// ============================================================
export async function section24_residualNegBreakdown(ctx: DataQaContext): Promise<void> {
  ctx.section('24. RESIDUAL < 0 BREAKDOWN');
  const residualNegByDir = await ctx.raw<{ direction: string; n: bigint }[]>(`
    SELECT direction, COUNT(*)::bigint as n
    FROM "InventoryRecord"
    WHERE "residualQty" < 0
    GROUP BY direction
  `);
  for (const r of residualNegByDir) ctx.log(`  residualQty<0 & direction=${r.direction}: ${r.n}`);
}

// ============================================================
//  25. Outlets with extra "BAKSO" area
// ============================================================
export async function section25_baksoAreaOutlet(ctx: DataQaContext): Promise<void> {
  ctx.section('25. BAKSO AREA OUTLET');
  const baksoOutlet = await ctx.raw<{ id: number; code: string; name: string; area: string }[]>(`
    SELECT id, code, name, area FROM "Outlet" WHERE area='BAKSO'
  `);
  for (const r of baksoOutlet) ctx.log(`  id=${r.id} code=${r.code} name=${r.name} area=${r.area}`);
}

// ============================================================
//  26. Items extra (count vs expected 109)
// ============================================================
export async function section26_itemNames(ctx: DataQaContext): Promise<void> {
  ctx.section('26. ITEM NAMES (sample extra vs 109 expected)');
  const itemsAll = await ctx.raw<{ id: number; name: string }[]>(`
    SELECT id, name FROM "Item" ORDER BY name
  `);
  ctx.log(`  Total items: ${itemsAll.length}`);
  // Find suspicious items (longest names or special chars)
  const suspicious = itemsAll.filter(i => /[\(\)\.]/.test(i.name) || i.name.length > 60).slice(0, 10);
  ctx.log(`  Suspicious item names (with parentheses/dots/very long):`);
  for (const r of suspicious) ctx.log(`    id=${r.id} "${r.name}"`);

  // Items with different cases (same name different case)
  const itemCaseDup = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM (
      SELECT LOWER(name) as ln FROM "Item" GROUP BY LOWER(name) HAVING COUNT(*) > 1
    ) t
  `);
  ctx.log(`  Item name case-duplicate groups: ${itemCaseDup[0]?.n ?? 0}`);
}

// ============================================================
//  27. outlets vs 333 expected
// ============================================================
export async function section27_outletList(ctx: DataQaContext): Promise<void> {
  ctx.section('27. OUTLET LIST (sample extra vs 333 expected)');
  // Look for outliers (codes not matching standard pattern)
  const outletsAll = await ctx.raw<{ id: number; code: string; name: string; area: string }[]>(`
    SELECT id, code, name, area FROM "Outlet" ORDER BY code
  `);
  ctx.log(`  Total outlets: ${outletsAll.length}`);
  const weirdOutlets = outletsAll.filter(o => !/^\d+\.[A-Z]+$/.test(o.code) && !/^B\.\d+\.[A-Z]+$/.test(o.code));
  ctx.log(`  Outlets with non-standard code format: ${weirdOutlets.length}`);
  for (const r of weirdOutlets.slice(0, 10)) ctx.log(`    id=${r.id} code="${r.code}" name="${r.name}" area="${r.area}"`);
}
