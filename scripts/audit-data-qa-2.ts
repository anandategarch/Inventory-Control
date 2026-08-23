#!/usr/bin/env bun
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient({ log: ['error'] });

async function raw<T = any>(sql: string): Promise<T[]> {
  try { return await db.$queryRawUnsafe<T[]>(sql); }
  catch (e: any) { console.log(`  [SQL ERROR] ${e.message}`); return []; }
}

async function main() {
  // Direction vs sign mismatch PER MONTH
  console.log('\n=== Per-month direction/sign mismatch ===');
  const perMonth = await raw<{ monthLabel: string; total: bigint; mismatch: bigint }>(`
    SELECT "monthLabel",
      COUNT(*)::bigint as total,
      COUNT(CASE WHEN
        (direction='LOSS'   AND "nominalLossSurplus" IS NOT NULL AND "nominalLossSurplus" >= 0) OR
        (direction='SURPLUS' AND "nominalLossSurplus" IS NOT NULL AND "nominalLossSurplus" <= 0) OR
        (direction='NEUTRAL' AND "nominalLossSurplus" IS NOT NULL AND "nominalLossSurplus" <> 0)
      THEN 1 END)::bigint as mismatch
    FROM "InventoryRecord"
    GROUP BY "monthLabel"
    ORDER BY "monthLabel"
  `);
  for (const r of perMonth) console.log(`  ${r.monthLabel}: total=${r.total}, mismatched=${r.mismatch}`);

  // Total mismatch
  const totalMismatch = await raw<{ n: bigint }>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE
      (direction='LOSS'   AND "nominalLossSurplus" IS NOT NULL AND "nominalLossSurplus" >= 0) OR
      (direction='SURPLUS' AND "nominalLossSurplus" IS NOT NULL AND "nominalLossSurplus" <= 0) OR
      (direction='NEUTRAL' AND "nominalLossSurplus" IS NOT NULL AND "nominalLossSurplus" <> 0)
  `);
  console.log(`\nTotal direction/sign mismatch: ${totalMismatch[0]?.n}`);

  // Distribution of mismatched records: is nominalLossSurplus >0 or =0?
  console.log('\n=== Mismatch detail (71 LOSS / 21 SURPLUS) ===');
  const detail = await raw<{ direction: string; nominal_sign: string; cnt: bigint }>(`
    SELECT direction,
      CASE
        WHEN "nominalLossSurplus" > 0 THEN 'positive'
        WHEN "nominalLossSurplus" < 0 THEN 'negative'
        WHEN "nominalLossSurplus" = 0 THEN 'zero'
      END as nominal_sign,
      COUNT(*)::bigint as cnt
    FROM "InventoryRecord"
    WHERE
      (direction='LOSS'   AND "nominalLossSurplus" IS NOT NULL AND "nominalLossSurplus" >= 0) OR
      (direction='SURPLUS' AND "nominalLossSurplus" IS NOT NULL AND "nominalLossSurplus" <= 0)
    GROUP BY direction, nominal_sign
    ORDER BY direction, nominal_sign
  `);
  for (const r of detail) console.log(`  direction=${r.direction}, nominal=${r.nominal_sign}: ${r.cnt}`);

  // Sample 5 mismatched records
  console.log('\n=== Sample 5 mismatched records ===');
  const sample = await raw<{ monthLabel: string; outletCode: string; itemName: string; qtyDeviasi: number; qtyLossSurplus: number; nominalLossSurplus: number; direction: string }>(`
    SELECT ir."monthLabel", o.code as "outletCode", i.name as "itemName",
      ir."qtyDeviasi", ir."qtyLossSurplus", ir."nominalLossSurplus", ir.direction
    FROM "InventoryRecord" ir
    JOIN "Outlet" o ON ir."outletId"=o.id
    JOIN "Item" i ON ir."itemId"=i.id
    WHERE
      (direction='LOSS'   AND "nominalLossSurplus" IS NOT NULL AND "nominalLossSurplus" >= 0) OR
      (direction='SURPLUS' AND "nominalLossSurplus" IS NOT NULL AND "nominalLossSurplus" <= 0)
    LIMIT 5
  `);
  for (const r of sample) console.log(`  ${r.monthLabel} | ${r.outletCode} | ${r.itemName} | qd=${r.qtyDeviasi} | qls=${r.qtyLossSurplus} | nls=${r.nominalLossSurplus} | dir=${r.direction}`);

  // residualQty < 0 in SURPLUS direction (24 records)
  console.log('\n=== residualQty<0 & direction=SURPLUS (anomaly) ===');
  const sampleNegRes = await raw<{ monthLabel: string; outletCode: string; itemName: string; qtyDeviasi: number; qtyLossSurplus: number; nominalLossSurplus: number; residualQty: number; direction: string }>(`
    SELECT ir."monthLabel", o.code as "outletCode", i.name as "itemName",
      ir."qtyDeviasi", ir."qtyLossSurplus", ir."nominalLossSurplus", ir."residualQty", ir.direction
    FROM "InventoryRecord" ir
    JOIN "Outlet" o ON ir."outletId"=o.id
    JOIN "Item" i ON ir."itemId"=i.id
    WHERE ir."residualQty" < 0 AND ir.direction='SURPLUS'
    LIMIT 5
  `);
  for (const r of sampleNegRes) console.log(`  ${r.monthLabel} | ${r.outletCode} | ${r.itemName} | qd=${r.qtyDeviasi} | qls=${r.qtyLossSurplus} | nls=${r.nominalLossSurplus} | res=${r.residualQty} | dir=${r.direction}`);

  // Sales consistency per outlet (top 10 with multiple distinct sales)
  console.log('\n=== Sales inconsistency: outlets with >1 distinct sales ===');
  const salesInconsistent = await raw<{ outletId: number; outletCode: string; outletName: string; distinctSales: bigint }>(`
    SELECT ir."outletId", o.code as "outletCode", o.name as "outletName",
      COUNT(DISTINCT "nominalSales")::bigint as "distinctSales"
    FROM "InventoryRecord" ir
    JOIN "Outlet" o ON ir."outletId"=o.id
    WHERE "nominalSales" IS NOT NULL AND "nominalSales" > 0
    GROUP BY ir."outletId", o.code, o.name
    HAVING COUNT(DISTINCT "nominalSales") > 1
    ORDER BY "distinctSales" DESC
    LIMIT 10
  `);
  for (const r of salesInconsistent) console.log(`  outlet=${r.outletCode} (${r.outletName}): ${r.distinctSales} distinct sales values`);

  // outlets with 12 distinct sales — these are across 12 month/week combinations (4 months × 3 weeks)
  // Let me check: distinct sales per outlet per month/week
  console.log('\n=== Sales per (outlet, month, week) for outletId=39 ===');
  const salesPerMW = await raw<{ monthLabel: string; weekLabel: string; nominalSales: number; n: bigint }>(`
    SELECT "monthLabel", "weekLabel", MAX("nominalSales") as "nominalSales", COUNT(*)::bigint as n
    FROM "InventoryRecord"
    WHERE "outletId"=39 AND "nominalSales" IS NOT NULL AND "nominalSales" > 0
    GROUP BY "monthLabel", "weekLabel"
    ORDER BY "monthLabel", "weekLabel"
  `);
  for (const r of salesPerMW) console.log(`  ${r.monthLabel} | ${r.weekLabel}: sales=${r.nominalSales} (n=${r.n} records)`);

  // Sample BAKSO outlet
  console.log('\n=== BAKSO outlet records ===');
  const baksoRecs = await raw<{ monthLabel: string; weekLabel: string; outletCode: string; itemName: string; qtyBom: number; nominalDeviasi: number; direction: string }>(`
    SELECT ir."monthLabel", ir."weekLabel", o.code as "outletCode", i.name as "itemName",
      ir."qtyBom", ir."nominalDeviasi", ir.direction
    FROM "InventoryRecord" ir
    JOIN "Outlet" o ON ir."outletId"=o.id
    JOIN "Item" i ON ir."itemId"=i.id
    WHERE o.area='BAKSO'
    LIMIT 5
  `);
  for (const r of baksoRecs) console.log(`  ${r.monthLabel} | ${r.weekLabel} | ${r.outletCode} | ${r.itemName} | bom=${r.qtyBom} | dev=${r.nominalDeviasi} | dir=${r.direction}`);

  // 0 qty / 0 nominal records (15787 records)
  console.log('\n=== All-zero qty records by month ===');
  const zeroByMonth = await raw<{ monthLabel: string; n: bigint }>(`
    SELECT "monthLabel", COUNT(*)::bigint as n
    FROM "InventoryRecord"
    WHERE COALESCE("qtyBom",0)=0 AND COALESCE("qtyCom",0)=0 AND COALESCE("qtyDeviasi",0)=0
      AND COALESCE("qtyWaste",0)=0 AND COALESCE("qtySusut",0)=0 AND COALESCE("qtyTrial",0)=0
      AND COALESCE("qtyLossSurplus",0)=0
    GROUP BY "monthLabel" ORDER BY "monthLabel"
  `);
  for (const r of zeroByMonth) console.log(`  ${r.monthLabel}: ${r.n} all-zero records`);

  // MEI 2026 WEEK 4 has 34966 records — too many. 333 outlets × 109 items = 36,297 max.
  // But MEI W4 = 34966, which is suspicious (almost max). Let me see distribution.
  console.log('\n=== MEI 2026 records per (week, outlet) ===');
  const meiOutletCounts = await raw<{ weekLabel: string; outletCount: bigint; avgRecs: number }>(`
    SELECT "weekLabel", COUNT(DISTINCT "outletId")::bigint as "outletCount",
      ROUND(COUNT(*)::numeric / COUNT(DISTINCT "outletId"), 1) as "avgRecs"
    FROM "InventoryRecord"
    WHERE "monthLabel"='MEI 2026'
    GROUP BY "weekLabel" ORDER BY "weekLabel"
  `);
  for (const r of meiOutletCounts) console.log(`  ${r.weekLabel}: ${r.outletCount} outlets, avg ${r.avgRecs} records/outlet`);

  // 219 zero-sales records
  console.log('\n=== Zero-sales records by month ===');
  const zeroSalesByMonth = await raw<{ monthLabel: string; n: bigint }>(`
    SELECT "monthLabel", COUNT(*)::bigint as n
    FROM "InventoryRecord"
    WHERE "nominalSales" = 0
    GROUP BY "monthLabel" ORDER BY "monthLabel"
  `);
  for (const r of zeroSalesByMonth) console.log(`  ${r.monthLabel}: ${r.n}`);

  // pctQtyDeviasiToBom sign vs qtyDeviasi sign — for LOSS items, both should be negative
  console.log('\n=== pctQtyDeviasiToBom sign distribution for direction=LOSS ===');
  const pctSgnForLoss = await raw<{ pct_sign: string; n: bigint }>(`
    SELECT
      CASE
        WHEN "pctQtyDeviasiToBom" IS NULL THEN 'NULL'
        WHEN "pctQtyDeviasiToBom" > 0 THEN 'positive'
        WHEN "pctQtyDeviasiToBom" < 0 THEN 'negative'
        ELSE 'zero'
      END as pct_sign,
      COUNT(*)::bigint as n
    FROM "InventoryRecord"
    WHERE direction='LOSS'
    GROUP BY pct_sign
  `);
  for (const r of pctSgnForLoss) console.log(`  LOSS items: pctQtyDeviasiToBom ${r.pct_sign}: ${r.n}`);

  console.log('\n=== pctQtyDeviasiToBom sign distribution for direction=SURPLUS ===');
  const pctSgnForSurplus = await raw<{ pct_sign: string; n: bigint }>(`
    SELECT
      CASE
        WHEN "pctQtyDeviasiToBom" IS NULL THEN 'NULL'
        WHEN "pctQtyDeviasiToBom" > 0 THEN 'positive'
        WHEN "pctQtyDeviasiToBom" < 0 THEN 'negative'
        ELSE 'zero'
      END as pct_sign,
      COUNT(*)::bigint as n
    FROM "InventoryRecord"
    WHERE direction='SURPLUS'
    GROUP BY pct_sign
  `);
  for (const r of pctSgnForSurplus) console.log(`  SURPLUS items: pctQtyDeviasiToBom ${r.pct_sign}: ${r.n}`);
}

main().finally(() => db.$disconnect());
