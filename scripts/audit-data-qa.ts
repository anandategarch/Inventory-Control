#!/usr/bin/env bun
// ============================================================
//  audit-data-qa.ts — Data quality audit against Supabase
//  Runs ~17 checklist SQL queries + reports findings as JSON.
// ============================================================
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient({ log: ['error', 'warn'] });

const out: string[] = [];
function log(s: string) { out.push(s); console.log(s); }
function section(t: string) { log(`\n════════ ${t} ════════`); }

async function raw<T = any>(sql: string, params?: any[]): Promise<T[]> {
  try {
    return await db.$queryRawUnsafe<T[]>(sql, ...(params ?? []));
  } catch (e: any) {
    log(`  [SQL ERROR] ${e.message}`);
    return [];
  }
}

async function main() {
  // ============================================================
  //  1. Total records + direction counts
  // ============================================================
  section('1. DIRECTION COUNTS');
  const total = await db.inventoryRecord.count();
  log(`Total InventoryRecord: ${total}`);

  const dirCounts = await raw<{ direction: string | null; n: bigint }[]>(`
    SELECT direction::text, COUNT(*)::bigint as n
    FROM "InventoryRecord"
    GROUP BY direction
    ORDER BY n DESC
  `);
  log(`Direction counts:`);
  for (const r of dirCounts) log(`  ${r.direction ?? 'NULL'}: ${r.n}`);

  // ============================================================
  //  2. Direction vs sign mismatch (QA-1)
  // ============================================================
  section('2. DIRECTION vs SIGN MISMATCH');
  const mismatchLoss = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE direction='LOSS' AND "nominalLossSurplus" IS NOT NULL AND "nominalLossSurplus" >= 0
  `);
  log(`  direction=LOSS but nominalLossSurplus >= 0: ${mismatchLoss[0]?.n ?? 0}`);

  const mismatchSurplus = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE direction='SURPLUS' AND "nominalLossSurplus" IS NOT NULL AND "nominalLossSurplus" <= 0
  `);
  log(`  direction=SURPLUS but nominalLossSurplus <= 0: ${mismatchSurplus[0]?.n ?? 0}`);

  const mismatchNeutral = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE direction='NEUTRAL' AND "nominalLossSurplus" IS NOT NULL AND "nominalLossSurplus" <> 0
  `);
  log(`  direction=NEUTRAL but nominalLossSurplus != 0: ${mismatchNeutral[0]?.n ?? 0}`);

  const nullDir = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" WHERE direction IS NULL
  `);
  log(`  direction IS NULL: ${nullDir[0]?.n ?? 0}`);

  // ============================================================
  //  2a. Per-month direction/sign mismatch (which months are migrated?)
  // ============================================================
  section('2a. DIRECTION vs SIGN MISMATCH BY MONTH');
  const mismatchByMonth = await raw<{ monthLabel: string; total: bigint; mismatch: bigint }[]>(`
    SELECT "monthLabel",
      COUNT(*)::bigint as total,
      COUNT(CASE WHEN
        (direction='LOSS'   AND "nominalLossSurplus" IS NOT NULL AND "nominalLossSurplus" >= 0) OR
        (direction='SURPLUS' AND "nominalLossSurplus" IS NOT NULL AND "nominalLossSurplus" <= 0) OR
        (direction='NEUTRAL' AND "nominalLossSurplus" IS NOT NULL AND "nominalLossSurplus" <> 0)
      END)::bigint as mismatch
    FROM "InventoryRecord"
    GROUP BY "monthLabel"
    ORDER BY "monthLabel"
  `);
  for (const r of mismatchByMonth) log(`  ${r.monthLabel}: total=${r.total}, mismatched=${r.mismatch}`);

  // ============================================================
  //  3. Sign consistency qtyLossSurplus vs nominalLossSurplus (QA-2)
  // ============================================================
  section('3. qtyLossSurplus vs nominalLossSurplus SIGN MISMATCH');
  const signMismatch = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE "qtyLossSurplus" IS NOT NULL AND "nominalLossSurplus" IS NOT NULL
      AND SIGN("qtyLossSurplus") != SIGN("nominalLossSurplus")
      AND "qtyLossSurplus" != 0 AND "nominalLossSurplus" != 0
  `);
  log(`  qtyLossSurplus sign != nominalLossSurplus sign (non-zero both): ${signMismatch[0]?.n ?? 0}`);

  const qtyLossSgn = await raw<{ sgn: number; n: bigint }[]>(`
    SELECT SIGN("qtyLossSurplus") as sgn, COUNT(*)::bigint as n
    FROM "InventoryRecord" WHERE "qtyLossSurplus" IS NOT NULL
    GROUP BY sgn ORDER BY sgn
  `);
  log(`  qtyLossSurplus sign distribution:`);
  for (const r of qtyLossSgn) log(`    sign=${r.sgn}: ${r.n}`);

  // ============================================================
  //  4. NEUTRAL records: is nominalLossSurplus=0? (QA-3)
  // ============================================================
  section('4. NEUTRAL RECORDS');
  const neutralBreakdown = await raw<{ src: string; n: bigint }[]>(`
    SELECT
      CASE
        WHEN "nominalLossSurplus" = 0 THEN 'nominal=0'
        WHEN "nominalLossSurplus" IS NULL THEN 'nominal IS NULL'
        WHEN "qtyLossSurplus" = 0 THEN 'qty=0 (nominal non-zero)'
        ELSE 'OTHER'
      END as src,
      COUNT(*)::bigint as n
    FROM "InventoryRecord"
    WHERE direction='NEUTRAL'
    GROUP BY src
  `);
  log(`  NEUTRAL breakdown:`);
  for (const r of neutralBreakdown) log(`    ${r.src}: ${r.n}`);

  // ============================================================
  //  5. absNominalDeviasi vs abs(nominalDeviasi) (QA-4)
  // ============================================================
  section('5. ABS FIELDS CONSISTENCY');
  const absDeviasiMismatch = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE "nominalDeviasi" IS NOT NULL AND "absNominalDeviasi" IS NOT NULL
      AND ABS("nominalDeviasi" - "absNominalDeviasi") > 0.01
      AND ABS("nominalDeviasi" + "absNominalDeviasi") > 0.01
  `);
  log(`  absNominalDeviasi != |nominalDeviasi|: ${absDeviasiMismatch[0]?.n ?? 0}`);

  const absLSMismatch = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE "nominalLossSurplus" IS NOT NULL AND "absNominalLossSurplus" IS NOT NULL
      AND ABS("nominalLossSurplus" - "absNominalLossSurplus") > 0.01
      AND ABS("nominalLossSurplus" + "absNominalLossSurplus") > 0.01
  `);
  log(`  absNominalLossSurplus != |nominalLossSurplus|: ${absLSMismatch[0]?.n ?? 0}`);

  const absQtyDeviasiMismatch = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE "qtyDeviasi" IS NOT NULL AND "absQtyDeviasi" IS NOT NULL
      AND ABS("qtyDeviasi" - "absQtyDeviasi") > 0.01
      AND ABS("qtyDeviasi" + "absQtyDeviasi") > 0.01
  `);
  log(`  absQtyDeviasi != |qtyDeviasi|: ${absQtyDeviasiMismatch[0]?.n ?? 0}`);

  const absQtyLSMismatch = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE "qtyLossSurplus" IS NOT NULL AND "absQtyLossSurplus" IS NOT NULL
      AND ABS("qtyLossSurplus" - "absQtyLossSurplus") > 0.01
      AND ABS("qtyLossSurplus" + "absQtyLossSurplus") > 0.01
  `);
  log(`  absQtyLossSurplus != |qtyLossSurplus|: ${absQtyLSMismatch[0]?.n ?? 0}`);

  // NULL abs where signed is non-null
  const nullAbsDeviasi = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE "nominalDeviasi" IS NOT NULL AND "absNominalDeviasi" IS NULL
  `);
  log(`  nominalDeviasi NOT NULL but absNominalDeviasi IS NULL: ${nullAbsDeviasi[0]?.n ?? 0}`);

  // ============================================================
  //  6. residualQty correctness (QA-5)
  // ============================================================
  section('6. RESIDUAL QTY CORRECTNESS');
  const residualNeg = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE "residualQty" IS NOT NULL AND "residualQty" < 0
  `);
  log(`  residualQty < 0 (should be >= 0 due to clamp): ${residualNeg[0]?.n ?? 0}`);

  const residualMismatch = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE "qtyDeviasi" IS NOT NULL
      AND "residualQty" IS NOT NULL
      AND ABS(
        "residualQty" -
        SIGN("qtyDeviasi") * GREATEST(0,
          ABS("qtyDeviasi") - (ABS(COALESCE("qtyWaste",0)) + ABS(COALESCE("qtySusut",0)) + ABS(COALESCE("qtyTrial",0)))
        )
      ) > 0.05
  `);
  log(`  residualQty != expected (abs(dev) - abs(w+s+t), signed): ${residualMismatch[0]?.n ?? 0}`);

  // sign of residualQty vs qtyDeviasi
  const residualSgnMismatch = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE "qtyDeviasi" IS NOT NULL AND "residualQty" IS NOT NULL
      AND "qtyDeviasi" != 0 AND "residualQty" != 0
      AND SIGN("qtyDeviasi") != SIGN("residualQty")
  `);
  log(`  residualQty sign != qtyDeviasi sign (non-zero both): ${residualSgnMismatch[0]?.n ?? 0}`);

  // ============================================================
  //  7. pctQtyDeviasiToBom sign (QA-6)
  // ============================================================
  section('7. pctQtyDeviasiToBom SIGN');
  const pctSgnMismatch = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE "pctQtyDeviasiToBom" IS NOT NULL AND "pctQtyDeviasiToBom" != 0
      AND "qtyDeviasi" IS NOT NULL AND "qtyDeviasi" != 0
      AND SIGN("pctQtyDeviasiToBom") != SIGN("qtyDeviasi")
  `);
  log(`  pctQtyDeviasiToBom sign != qtyDeviasi sign: ${pctSgnMismatch[0]?.n ?? 0}`);

  // BOM=0 but pctQtyDeviasiToBom NOT NULL?
  const bom0WithPct = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE "qtyBom" = 0 AND "pctQtyDeviasiToBom" IS NOT NULL
  `);
  log(`  BOM=0 but pctQtyDeviasiToBom IS NOT NULL (should be NULL): ${bom0WithPct[0]?.n ?? 0}`);

  // ============================================================
  //  8. tolerancePct NULL/sentinel (QA-7)
  // ============================================================
  section('8. TOLERANCE');
  const tolStats = await raw<{ src: string; n: bigint }[]>(`
    SELECT
      CASE
        WHEN "tolerancePct" IS NULL THEN 'NULL'
        WHEN "tolerancePct" = 0 THEN 'zero'
        WHEN "tolerancePct" > 0 THEN 'positive'
        WHEN "tolerancePct" < 0 THEN 'negative'
      END as src,
      COUNT(*)::bigint as n
    FROM "InventoryRecord"
    GROUP BY src
  `);
  log(`  tolerancePct distribution:`);
  for (const r of tolStats) log(`    ${r.src}: ${r.n}`);

  const tolRawSentinel = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE UPPER(COALESCE("toleranceRaw",'')) = 'BELUM ADA TOLERANSI'
  `);
  log(`  toleranceRaw = 'BELUM ADA TOLERANSI': ${tolRawSentinel[0]?.n ?? 0}`);

  // tolerancePct > 0 for LOSS items? (Excel convention: LOSS = negative)
  const tolSgnForLoss = await raw<{ sgn: string; n: bigint }[]>(`
    SELECT
      CASE
        WHEN "tolerancePct" IS NULL THEN 'NULL'
        WHEN "tolerancePct" > 0 THEN 'positive'
        WHEN "tolerancePct" < 0 THEN 'negative'
        ELSE 'zero'
      END as sgn,
      COUNT(*)::bigint as n
    FROM "InventoryRecord"
    WHERE direction='LOSS' AND "tolerancePct" IS NOT NULL
    GROUP BY sgn
  `);
  log(`  tolerancePct sign for LOSS items:`);
  for (const r of tolSgnForLoss) log(`    ${r.sgn}: ${r.n}`);

  // ============================================================
  //  9. Month/week consistency (QA-8)
  // ============================================================
  section('9. MONTH/WEEK CONSISTENCY');
  const monthCounts = await raw<{ monthLabel: string; n: bigint }[]>(`
    SELECT "monthLabel", COUNT(*)::bigint as n
    FROM "InventoryRecord" GROUP BY "monthLabel" ORDER BY n DESC
  `);
  log(`  monthLabel distribution:`);
  for (const r of monthCounts) log(`    ${r.monthLabel}: ${r.n}`);

  const weekCounts = await raw<{ weekLabel: string; n: bigint }[]>(`
    SELECT "weekLabel", COUNT(*)::bigint as n
    FROM "InventoryRecord" GROUP BY "weekLabel" ORDER BY "weekLabel"
  `);
  log(`  weekLabel distribution:`);
  for (const r of weekCounts) log(`    ${r.weekLabel}: ${r.n}`);

  const fileMonthKeys = await raw<{ monthLabel: string; monthKey: string }[]>(`
    SELECT DISTINCT "monthLabel", "monthKey" FROM "SourceFile"
  `);
  log(`  SourceFile monthLabel/monthKey:`);
  for (const r of fileMonthKeys) log(`    ${r.monthLabel} → ${r.monthKey}`);

  // Orphaned weeks: weeks in InventoryRecord but no Week table entry
  const orphanWeeks = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" ir
    WHERE NOT EXISTS (SELECT 1 FROM "Week" w WHERE w.id = ir."weekId")
  `);
  log(`  Orphaned InventoryRecord (no Week row): ${orphanWeeks[0]?.n ?? 0}`);

  // ============================================================
  //  10. Outlet/Item counts (QA-9)
  // ============================================================
  section('10. OUTLET/ITEM COUNTS');
  const outletCount = await db.outlet.count();
  const itemCount = await db.item.count();
  log(`  Outlet count: ${outletCount}`);
  log(`  Item count: ${itemCount}`);

  const outletNoArea = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "Outlet" WHERE area IS NULL OR area = ''
  `);
  log(`  Outlets with NULL/empty area: ${outletNoArea[0]?.n ?? 0}`);

  const itemNoName = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "Item" WHERE name IS NULL OR name = ''
  `);
  log(`  Items with NULL/empty name: ${itemNoName[0]?.n ?? 0}`);

  const dupOutletCodes = await raw<{ code: string; n: bigint }[]>(`
    SELECT code, COUNT(*)::bigint as n FROM "Outlet" GROUP BY code HAVING COUNT(*) > 1
  `);
  log(`  Duplicate Outlet.code: ${dupOutletCodes.length} (should be 0)`);

  const dupItemNames = await raw<{ name: string; n: bigint }[]>(`
    SELECT name, COUNT(*)::bigint as n FROM "Item" GROUP BY name HAVING COUNT(*) > 1
  `);
  log(`  Duplicate Item.name: ${dupItemNames.length} (should be 0)`);

  // Records with NULL outletId/itemId
  const nullOutletId = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" WHERE "outletId" IS NULL
  `);
  log(`  Records with NULL outletId: ${nullOutletId[0]?.n ?? 0}`);

  // ============================================================
  //  11. PIC assignments (QA-10)
  // ============================================================
  section('11. PIC ASSIGNMENTS');
  const picCount = await db.outletPIC.count();
  log(`  OutletPIC count: ${picCount}`);
  const uniquePics = await raw<{ n: bigint }[]>(`
    SELECT COUNT(DISTINCT pic)::bigint as n FROM "OutletPIC"
  `);
  log(`  Unique PICs: ${uniquePics[0]?.n ?? 0}`);

  const outletsWithoutPIC = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "Outlet" o
    WHERE NOT EXISTS (SELECT 1 FROM "OutletPIC" p WHERE p."outletCode" = o.code)
  `);
  log(`  Outlets without PIC: ${outletsWithoutPIC[0]?.n ?? 0}`);

  // Case inconsistent PIC names
  const picCaseDup = await raw<{ pic_lower: string; variants: number; n: bigint }[]>(`
    SELECT LOWER(pic) as pic_lower, COUNT(DISTINCT pic) as variants, COUNT(*)::bigint as n
    FROM "OutletPIC"
    GROUP BY LOWER(pic)
    HAVING COUNT(DISTINCT pic) > 1
  `);
  log(`  PIC names with case variants (should be 0): ${picCaseDup.length}`);
  for (const r of picCaseDup.slice(0, 5)) log(`    "${r.pic_lower}" — ${r.variants} variants`);

  // ============================================================
  //  12. Area values (QA-11)
  // ============================================================
  section('12. AREA VALUES');
  const areas = await raw<{ area: string; n: bigint }[]>(`
    SELECT area, COUNT(*)::bigint as n FROM "Outlet" GROUP BY area ORDER BY area
  `);
  log(`  Areas (Outlet table, ${areas.length} unique):`);
  for (const r of areas) log(`    "${r.area}": ${r.n} outlets`);

  const mixedCaseAreas = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "Outlet"
    WHERE area != UPPER(area)
  `);
  log(`  Outlets with non-uppercase area: ${mixedCaseAreas[0]?.n ?? 0}`);

  // ============================================================
  //  13. Sales data (QA-12)
  // ============================================================
  section('13. SALES DATA');
  const nullSales = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" WHERE "nominalSales" IS NULL
  `);
  log(`  Records with NULL nominalSales: ${nullSales[0]?.n ?? 0}`);

  const zeroSales = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" WHERE "nominalSales" = 0
  `);
  log(`  Records with zero nominalSales: ${zeroSales[0]?.n ?? 0}`);

  const negSales = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" WHERE "nominalSales" < 0
  `);
  log(`  Records with negative nominalSales: ${negSales[0]?.n ?? 0}`);

  // Sales consistency per outlet: distinct sales values per outlet
  const outletsWithMultiSales = await raw<{ outletId: number; cnt: bigint; vals: string }[]>(`
    SELECT "outletId", COUNT(DISTINCT "nominalSales")::bigint as cnt,
      STRING_AGG(DISTINCT "nominalSales"::text, ', ') as vals
    FROM "InventoryRecord"
    WHERE "nominalSales" IS NOT NULL AND "nominalSales" > 0
    GROUP BY "outletId"
    HAVING COUNT(DISTINCT "nominalSales") > 1
    ORDER BY cnt DESC
    LIMIT 10
  `);
  log(`  Outlets with multiple distinct sales values (top 10): ${outletsWithMultiSales.length}`);
  for (const r of outletsWithMultiSales.slice(0, 5)) log(`    outletId=${r.outletId} cnt=${r.cnt} vals=${r.vals?.slice(0,80)}`);

  // ============================================================
  //  14. NULL quantity fields (QA-13)
  // ============================================================
  section('14. NULL/ZERO QUANTITIES');
  const nullQtyBom = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" WHERE "qtyBom" IS NULL
  `);
  log(`  Records with NULL qtyBom: ${nullQtyBom[0]?.n ?? 0}`);

  const nullQtyDeviasi = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" WHERE "qtyDeviasi" IS NULL
  `);
  log(`  Records with NULL qtyDeviasi: ${nullQtyDeviasi[0]?.n ?? 0}`);

  const nullNomDeviasi = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" WHERE "nominalDeviasi" IS NULL
  `);
  log(`  Records with NULL nominalDeviasi: ${nullNomDeviasi[0]?.n ?? 0}`);

  const nullNomLS = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" WHERE "nominalLossSurplus" IS NULL
  `);
  log(`  Records with NULL nominalLossSurplus: ${nullNomLS[0]?.n ?? 0}`);

  const allZeroQtys = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE COALESCE("qtyBom",0)=0 AND COALESCE("qtyCom",0)=0 AND COALESCE("qtyDeviasi",0)=0
      AND COALESCE("qtyWaste",0)=0 AND COALESCE("qtySusut",0)=0 AND COALESCE("qtyTrial",0)=0
      AND COALESCE("qtyLossSurplus",0)=0
  `);
  log(`  Records with ALL qty fields = 0: ${allZeroQtys[0]?.n ?? 0}`);

  // ============================================================
  //  15. Duplicate records (QA-14)
  // ============================================================
  section('15. DUPLICATE RECORDS');
  const dupKey = await raw<{ cnt: bigint }[]>(`
    SELECT COUNT(*)::bigint as cnt FROM (
      SELECT "outletId", "itemId", "weekId", "akunPenyesuaian", COUNT(*)::bigint as c
      FROM "InventoryRecord"
      GROUP BY "outletId", "itemId", "weekId", "akunPenyesuaian"
      HAVING COUNT(*) > 1
    ) t
  `);
  log(`  Duplicate (outletId, itemId, weekId, akunPenyesuaian) groups: ${dupKey[0]?.cnt ?? 0}`);

  const dupSample = await raw<{ outletId: number; itemId: number; weekId: number; akun: string | null; c: bigint }[]>(`
    SELECT "outletId", "itemId", "weekId", "akunPenyesuaian", COUNT(*)::bigint as c
    FROM "InventoryRecord"
    GROUP BY "outletId", "itemId", "weekId", "akunPenyesuaian"
    HAVING COUNT(*) > 1
    ORDER BY c DESC
    LIMIT 5
  `);
  for (const r of dupSample) log(`    outlet=${r.outletId} item=${r.itemId} week=${r.weekId} akun="${r.akun}" → ${r.c} dupes`);

  // ============================================================
  //  16. FK integrity (QA-15)
  // ============================================================
  section('16. FK INTEGRITY');
  const fkOutlet = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" ir
    WHERE NOT EXISTS (SELECT 1 FROM "Outlet" o WHERE o.id = ir."outletId")
  `);
  log(`  Records with invalid outletId FK: ${fkOutlet[0]?.n ?? 0}`);

  const fkItem = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" ir
    WHERE NOT EXISTS (SELECT 1 FROM "Item" i WHERE i.id = ir."itemId")
  `);
  log(`  Records with invalid itemId FK: ${fkItem[0]?.n ?? 0}`);

  const fkWeek = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" ir
    WHERE NOT EXISTS (SELECT 1 FROM "Week" w WHERE w.id = ir."weekId")
  `);
  log(`  Records with invalid weekId FK: ${fkWeek[0]?.n ?? 0}`);

  const fkSourceFile = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" ir
    WHERE NOT EXISTS (SELECT 1 FROM "SourceFile" s WHERE s.id = ir."sourceFileId")
  `);
  log(`  Records with invalid sourceFileId FK: ${fkSourceFile[0]?.n ?? 0}`);

  // ============================================================
  //  17. SourceFile + Week structure
  // ============================================================
  section('17. SOURCEFILE/WEEK');
  const srcFiles = await db.sourceFile.findMany({ select: { id: true, fileName: true, monthLabel: true, monthKey: true, rowCount: true } });
  log(`  SourceFile count: ${srcFiles.length}`);
  for (const f of srcFiles) log(`    id=${f.id} "${f.fileName}" month="${f.monthLabel}" key=${f.monthKey} rowCount=${f.rowCount}`);

  const weeks = await raw<{ id: number; weekLabel: string; monthKey: string; sourceFileId: number; periodStart: number; periodEnd: number }[]>(`
    SELECT id, "weekLabel", "monthKey", "sourceFileId", "periodStart", "periodEnd"
    FROM "Week" ORDER BY "monthKey", "weekLabel"
  `);
  log(`  Week count: ${weeks.length}`);
  for (const w of weeks) log(`    id=${w.id} ${w.weekLabel} monthKey=${w.monthKey} period=${w.periodStart}-${w.periodEnd} sfId=${w.sourceFileId}`);

  // ============================================================
  //  18. nominalDeviasi vs nominalLossSurplus — sign consistency
  // ============================================================
  section('18. nominalDeviasi vs nominalLossSurplus');
  const lsVsDev = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE "nominalDeviasi" IS NOT NULL AND "nominalLossSurplus" IS NOT NULL
      AND "nominalDeviasi" != 0 AND "nominalLossSurplus" != 0
      AND SIGN("nominalDeviasi") != SIGN("nominalLossSurplus")
  `);
  log(`  Records where nominalDeviasi sign != nominalLossSurplus sign (non-zero both): ${lsVsDev[0]?.n ?? 0}`);

  // ============================================================
  //  19. Sample direction=LOSS rows (verify sign)
  // ============================================================
  section('19. SAMPLE 5 LOSS ROWS');
  const lossSample = await raw<{ outletCode: string; itemName: string; qtyDeviasi: number; nominalLossSurplus: number; direction: string }[]>(`
    SELECT o.code as "outletCode", i.name as "itemName", ir."qtyDeviasi", ir."nominalLossSurplus", ir.direction
    FROM "InventoryRecord" ir
    JOIN "Outlet" o ON ir."outletId"=o.id
    JOIN "Item" i ON ir."itemId"=i.id
    WHERE ir.direction='LOSS' AND ir."nominalLossSurplus" IS NOT NULL
    LIMIT 5
  `);
  for (const r of lossSample) log(`    ${r.outletCode} | ${r.itemName} | qtyDeviasi=${r.qtyDeviasi} | nominalLossSurplus=${r.nominalLossSurplus} | direction=${r.direction}`);

  section('20. SAMPLE 5 SURPLUS ROWS');
  const surplusSample = await raw<{ outletCode: string; itemName: string; qtyDeviasi: number; nominalLossSurplus: number; direction: string }[]>(`
    SELECT o.code as "outletCode", i.name as "itemName", ir."qtyDeviasi", ir."nominalLossSurplus", ir.direction
    FROM "InventoryRecord" ir
    JOIN "Outlet" o ON ir."outletId"=o.id
    JOIN "Item" i ON ir."itemId"=i.id
    WHERE ir.direction='SURPLUS' AND ir."nominalLossSurplus" IS NOT NULL
    LIMIT 5
  `);
  for (const r of surplusSample) log(`    ${r.outletCode} | ${r.itemName} | qtyDeviasi=${r.qtyDeviasi} | nominalLossSurplus=${r.nominalLossSurplus} | direction=${r.direction}`);

  // ============================================================
  //  21. Top-N outlets priority score range (simplified)
  // ============================================================
  section('21. OUTLET PRIORITY SCORE (via outlets.ts formula)');
  const priorityScores = await raw<{ outletcode: string; outletname: string; priorityscore: number }[]>(`
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
  log(`  Top 10 outlet priority (rough proxy):`);
  for (const r of priorityScores) log(`    ${r.outletcode} (${r.outletname}) → ${r.priorityscore}`);

  // ============================================================
  //  22. Direction counts BY month (verify migration applied to all)
  // ============================================================
  section('22. DIRECTION COUNTS BY MONTH');
  const dirByMonth = await raw<{ monthLabel: string; direction: string | null; n: bigint }[]>(`
    SELECT "monthLabel", direction::text, COUNT(*)::bigint as n
    FROM "InventoryRecord"
    GROUP BY "monthLabel", direction
    ORDER BY "monthLabel", direction
  `);
  for (const r of dirByMonth) log(`  ${r.monthLabel} | ${r.direction ?? 'NULL'}: ${r.n}`);

  // ============================================================
  //  23. WEEK 3 presence
  // ============================================================
  section('23. WEEK LABELS BY MONTH');
  const weekByMonth = await raw<{ monthLabel: string; weekLabel: string; n: bigint }[]>(`
    SELECT "monthLabel", "weekLabel", COUNT(*)::bigint as n
    FROM "InventoryRecord"
    GROUP BY "monthLabel", "weekLabel"
    ORDER BY "monthLabel", "weekLabel"
  `);
  for (const r of weekByMonth) log(`  ${r.monthLabel} | ${r.weekLabel}: ${r.n}`);

  // ============================================================
  //  24. residualQty < 0 breakdown — is it always LOSS direction?
  // ============================================================
  section('24. RESIDUAL < 0 BREAKDOWN');
  const residualNegByDir = await raw<{ direction: string; n: bigint }[]>(`
    SELECT direction, COUNT(*)::bigint as n
    FROM "InventoryRecord"
    WHERE "residualQty" < 0
    GROUP BY direction
  `);
  for (const r of residualNegByDir) log(`  residualQty<0 & direction=${r.direction}: ${r.n}`);

  // ============================================================
  //  25. Outlets with extra "BAKSO" area
  // ============================================================
  section('25. BAKSO AREA OUTLET');
  const baksoOutlet = await raw<{ id: number; code: string; name: string; area: string }[]>(`
    SELECT id, code, name, area FROM "Outlet" WHERE area='BAKSO'
  `);
  for (const r of baksoOutlet) log(`  id=${r.id} code=${r.code} name=${r.name} area=${r.area}`);

  // ============================================================
  //  26. Items extra (count vs expected 109)
  // ============================================================
  section('26. ITEM NAMES (sample extra vs 109 expected)');
  const itemsAll = await raw<{ id: number; name: string }[]>(`
    SELECT id, name FROM "Item" ORDER BY name
  `);
  log(`  Total items: ${itemsAll.length}`);
  // Find suspicious items (longest names or special chars)
  const suspicious = itemsAll.filter(i => /[\(\)\.]/.test(i.name) || i.name.length > 60).slice(0, 10);
  log(`  Suspicious item names (with parentheses/dots/very long):`);
  for (const r of suspicious) log(`    id=${r.id} "${r.name}"`);

  // Items with different cases (same name different case)
  const itemCaseDup = await raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM (
      SELECT LOWER(name) as ln FROM "Item" GROUP BY LOWER(name) HAVING COUNT(*) > 1
    ) t
  `);
  log(`  Item name case-duplicate groups: ${itemCaseDup[0]?.n ?? 0}`);

  // ============================================================
  //  27. outlets vs 333 expected
  // ============================================================
  section('27. OUTLET LIST (sample extra vs 333 expected)');
  // Look for outliers (codes not matching standard pattern)
  const outletsAll = await raw<{ id: number; code: string; name: string; area: string }[]>(`
    SELECT id, code, name, area FROM "Outlet" ORDER BY code
  `);
  log(`  Total outlets: ${outletsAll.length}`);
  const weirdOutlets = outletsAll.filter(o => !/^\d+\.[A-Z]+$/.test(o.code) && !/^B\.\d+\.[A-Z]+$/.test(o.code));
  log(`  Outlets with non-standard code format: ${weirdOutlets.length}`);
  for (const r of weirdOutlets.slice(0, 10)) log(`    id=${r.id} code="${r.code}" name="${r.name}" area="${r.area}"`);

  // Save report
  const reportPath = '/tmp/audit-data-qa-report.txt';
  await Bun.write(reportPath, out.join('\n'));
  console.log(`\nReport saved to ${reportPath}`);
}

main()
  .catch((e) => { console.error('Audit failed:', e); process.exit(1); })
  .finally(() => db.$disconnect());
