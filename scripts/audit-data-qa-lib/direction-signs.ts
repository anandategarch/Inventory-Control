import type { DataQaContext } from './context';

// ============================================================
//  direction-signs.ts — QA sections 1–4 (direction & sign checks)
//  SPLIT-F (pure code motion) from audit-data-qa.ts main().
// ============================================================

// ============================================================
//  1. Total records + direction counts
// ============================================================
export async function section01_directionCounts(ctx: DataQaContext): Promise<void> {
  ctx.section('1. DIRECTION COUNTS');
  const total = await ctx.db.inventoryRecord.count();
  ctx.log(`Total InventoryRecord: ${total}`);

  const dirCounts = await ctx.raw<{ direction: string | null; n: bigint }[]>(`
    SELECT direction::text, COUNT(*)::bigint as n
    FROM "InventoryRecord"
    GROUP BY direction
    ORDER BY n DESC
  `);
  ctx.log(`Direction counts:`);
  for (const r of dirCounts) ctx.log(`  ${r.direction ?? 'NULL'}: ${r.n}`);
}

// ============================================================
//  2. Direction vs sign mismatch (QA-1)
// ============================================================
export async function section02_directionSignMismatch(ctx: DataQaContext): Promise<void> {
  ctx.section('2. DIRECTION vs SIGN MISMATCH');
  const mismatchLoss = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE direction='LOSS' AND "nominalLossSurplus" IS NOT NULL AND "nominalLossSurplus" >= 0
  `);
  ctx.log(`  direction=LOSS but nominalLossSurplus >= 0: ${mismatchLoss[0]?.n ?? 0}`);

  const mismatchSurplus = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE direction='SURPLUS' AND "nominalLossSurplus" IS NOT NULL AND "nominalLossSurplus" <= 0
  `);
  ctx.log(`  direction=SURPLUS but nominalLossSurplus <= 0: ${mismatchSurplus[0]?.n ?? 0}`);

  const mismatchNeutral = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE direction='NEUTRAL' AND "nominalLossSurplus" IS NOT NULL AND "nominalLossSurplus" <> 0
  `);
  ctx.log(`  direction=NEUTRAL but nominalLossSurplus != 0: ${mismatchNeutral[0]?.n ?? 0}`);

  const nullDir = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord" WHERE direction IS NULL
  `);
  ctx.log(`  direction IS NULL: ${nullDir[0]?.n ?? 0}`);
}

// ============================================================
//  2a. Per-month direction/sign mismatch (which months are migrated?)
// ============================================================
export async function section02a_directionSignMismatchByMonth(ctx: DataQaContext): Promise<void> {
  ctx.section('2a. DIRECTION vs SIGN MISMATCH BY MONTH');
  const mismatchByMonth = await ctx.raw<{ monthLabel: string; total: bigint; mismatch: bigint }[]>(`
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
  for (const r of mismatchByMonth) ctx.log(`  ${r.monthLabel}: total=${r.total}, mismatched=${r.mismatch}`);
}

// ============================================================
//  3. Sign consistency qtyLossSurplus vs nominalLossSurplus (QA-2)
// ============================================================
export async function section03_qtyVsNominalSignMismatch(ctx: DataQaContext): Promise<void> {
  ctx.section('3. qtyLossSurplus vs nominalLossSurplus SIGN MISMATCH');
  const signMismatch = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE "qtyLossSurplus" IS NOT NULL AND "nominalLossSurplus" IS NOT NULL
      AND SIGN("qtyLossSurplus") != SIGN("nominalLossSurplus")
      AND "qtyLossSurplus" != 0 AND "nominalLossSurplus" != 0
  `);
  ctx.log(`  qtyLossSurplus sign != nominalLossSurplus sign (non-zero both): ${signMismatch[0]?.n ?? 0}`);

  const qtyLossSgn = await ctx.raw<{ sgn: number; n: bigint }[]>(`
    SELECT SIGN("qtyLossSurplus") as sgn, COUNT(*)::bigint as n
    FROM "InventoryRecord" WHERE "qtyLossSurplus" IS NOT NULL
    GROUP BY sgn ORDER BY sgn
  `);
  ctx.log(`  qtyLossSurplus sign distribution:`);
  for (const r of qtyLossSgn) ctx.log(`    sign=${r.sgn}: ${r.n}`);
}

// ============================================================
//  4. NEUTRAL records: is nominalLossSurplus=0? (QA-3)
// ============================================================
export async function section04_neutralRecords(ctx: DataQaContext): Promise<void> {
  ctx.section('4. NEUTRAL RECORDS');
  const neutralBreakdown = await ctx.raw<{ src: string; n: bigint }[]>(`
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
  ctx.log(`  NEUTRAL breakdown:`);
  for (const r of neutralBreakdown) ctx.log(`    ${r.src}: ${r.n}`);
}
