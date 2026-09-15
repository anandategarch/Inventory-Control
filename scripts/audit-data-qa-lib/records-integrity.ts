import type { DataQaContext } from './context';

// ============================================================
//  records-integrity.ts — QA sections 13–17 (sales, null/zero
//  quantities, duplicates, FK integrity, SourceFile/Week structure)
//  SPLIT-F (pure code motion) from audit-data-qa.ts main().
// ============================================================

// ============================================================
//  13. Sales data (QA-12)
// ============================================================
export async function section13_salesData(ctx: DataQaContext): Promise<void> {
  ctx.section('13. SALES DATA');
  const nullSales = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" WHERE "nominalSales" IS NULL
  `);
  ctx.log(`  Records with NULL nominalSales: ${nullSales[0]?.n ?? 0}`);

  const zeroSales = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" WHERE "nominalSales" = 0
  `);
  ctx.log(`  Records with zero nominalSales: ${zeroSales[0]?.n ?? 0}`);

  const negSales = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" WHERE "nominalSales" < 0
  `);
  ctx.log(`  Records with negative nominalSales: ${negSales[0]?.n ?? 0}`);

  // Sales consistency per outlet: distinct sales values per outlet
  const outletsWithMultiSales = await ctx.raw<{ outletId: number; cnt: bigint; vals: string }[]>(`
    SELECT "outletId", COUNT(DISTINCT "nominalSales")::bigint as cnt,
      STRING_AGG(DISTINCT "nominalSales"::text, ', ') as vals
    FROM "InventoryRecord"
    WHERE "nominalSales" IS NOT NULL AND "nominalSales" > 0
    GROUP BY "outletId"
    HAVING COUNT(DISTINCT "nominalSales") > 1
    ORDER BY cnt DESC
    LIMIT 10
  `);
  ctx.log(`  Outlets with multiple distinct sales values (top 10): ${outletsWithMultiSales.length}`);
  for (const r of outletsWithMultiSales.slice(0, 5)) ctx.log(`    outletId=${r.outletId} cnt=${r.cnt} vals=${r.vals?.slice(0,80)}`);
}

// ============================================================
//  14. NULL quantity fields (QA-13)
// ============================================================
export async function section14_nullZeroQuantities(ctx: DataQaContext): Promise<void> {
  ctx.section('14. NULL/ZERO QUANTITIES');
  const nullQtyBom = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" WHERE "qtyBom" IS NULL
  `);
  ctx.log(`  Records with NULL qtyBom: ${nullQtyBom[0]?.n ?? 0}`);

  const nullQtyDeviasi = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" WHERE "qtyDeviasi" IS NULL
  `);
  ctx.log(`  Records with NULL qtyDeviasi: ${nullQtyDeviasi[0]?.n ?? 0}`);

  const nullNomDeviasi = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" WHERE "nominalDeviasi" IS NULL
  `);
  ctx.log(`  Records with NULL nominalDeviasi: ${nullNomDeviasi[0]?.n ?? 0}`);

  const nullNomLS = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" WHERE "nominalLossSurplus" IS NULL
  `);
  ctx.log(`  Records with NULL nominalLossSurplus: ${nullNomLS[0]?.n ?? 0}`);

  const allZeroQtys = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE COALESCE("qtyBom",0)=0 AND COALESCE("qtyCom",0)=0 AND COALESCE("qtyDeviasi",0)=0
      AND COALESCE("qtyWaste",0)=0 AND COALESCE("qtySusut",0)=0 AND COALESCE("qtyTrial",0)=0
      AND COALESCE("qtyLossSurplus",0)=0
  `);
  ctx.log(`  Records with ALL qty fields = 0: ${allZeroQtys[0]?.n ?? 0}`);
}

// ============================================================
//  15. Duplicate records (QA-14)
// ============================================================
export async function section15_duplicateRecords(ctx: DataQaContext): Promise<void> {
  ctx.section('15. DUPLICATE RECORDS');
  const dupKey = await ctx.raw<{ cnt: bigint }[]>(`
    SELECT COUNT(*)::bigint as cnt FROM (
      SELECT "outletId", "itemId", "weekId", "akunPenyesuaian", COUNT(*)::bigint as c
      FROM "InventoryRecord"
      GROUP BY "outletId", "itemId", "weekId", "akunPenyesuaian"
      HAVING COUNT(*) > 1
    ) t
  `);
  ctx.log(`  Duplicate (outletId, itemId, weekId, akunPenyesuaian) groups: ${dupKey[0]?.cnt ?? 0}`);

  const dupSample = await ctx.raw<{ outletId: number; itemId: number; weekId: number; akun: string | null; c: bigint }[]>(`
    SELECT "outletId", "itemId", "weekId", "akunPenyesuaian", COUNT(*)::bigint as c
    FROM "InventoryRecord"
    GROUP BY "outletId", "itemId", "weekId", "akunPenyesuaian"
    HAVING COUNT(*) > 1
    ORDER BY c DESC
    LIMIT 5
  `);
  for (const r of dupSample) ctx.log(`    outlet=${r.outletId} item=${r.itemId} week=${r.weekId} akun="${r.akun}" → ${r.c} dupes`);
}

// ============================================================
//  16. FK integrity (QA-15)
// ============================================================
export async function section16_fkIntegrity(ctx: DataQaContext): Promise<void> {
  ctx.section('16. FK INTEGRITY');
  const fkOutlet = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" ir
    WHERE NOT EXISTS (SELECT 1 FROM "Outlet" o WHERE o.id = ir."outletId")
  `);
  ctx.log(`  Records with invalid outletId FK: ${fkOutlet[0]?.n ?? 0}`);

  const fkItem = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" ir
    WHERE NOT EXISTS (SELECT 1 FROM "Item" i WHERE i.id = ir."itemId")
  `);
  ctx.log(`  Records with invalid itemId FK: ${fkItem[0]?.n ?? 0}`);

  const fkWeek = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" ir
    WHERE NOT EXISTS (SELECT 1 FROM "Week" w WHERE w.id = ir."weekId")
  `);
  ctx.log(`  Records with invalid weekId FK: ${fkWeek[0]?.n ?? 0}`);

  const fkSourceFile = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" ir
    WHERE NOT EXISTS (SELECT 1 FROM "SourceFile" s WHERE s.id = ir."sourceFileId")
  `);
  ctx.log(`  Records with invalid sourceFileId FK: ${fkSourceFile[0]?.n ?? 0}`);
}

// ============================================================
//  17. SourceFile + Week structure
// ============================================================
export async function section17_sourceFileWeek(ctx: DataQaContext): Promise<void> {
  ctx.section('17. SOURCEFILE/WEEK');
  const srcFiles = await ctx.db.sourceFile.findMany({ select: { id: true, fileName: true, monthLabel: true, monthKey: true, rowCount: true } });
  ctx.log(`  SourceFile count: ${srcFiles.length}`);
  for (const f of srcFiles) ctx.log(`    id=${f.id} "${f.fileName}" month="${f.monthLabel}" key=${f.monthKey} rowCount=${f.rowCount}`);

  const weeks = await ctx.raw<{ id: number; weekLabel: string; monthKey: string; sourceFileId: number; periodStart: number; periodEnd: number }[]>(`
    SELECT id, "weekLabel", "monthKey", "sourceFileId", "periodStart", "periodEnd"
    FROM "Week" ORDER BY "monthKey", "weekLabel"
  `);
  ctx.log(`  Week count: ${weeks.length}`);
  for (const w of weeks) ctx.log(`    id=${w.id} ${w.weekLabel} monthKey=${w.monthKey} period=${w.periodStart}-${w.periodEnd} sfId=${w.sourceFileId}`);
}
