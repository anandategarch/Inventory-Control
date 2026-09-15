import type { DataQaContext } from './context';

// ============================================================
//  field-consistency.ts — QA sections 5–8 (abs fields, residual,
//  pct sign, tolerance)
//  SPLIT-F (pure code motion) from audit-data-qa.ts main().
// ============================================================

// ============================================================
//  5. absNominalDeviasi vs abs(nominalDeviasi) (QA-4)
// ============================================================
export async function section05_absFieldsConsistency(ctx: DataQaContext): Promise<void> {
  ctx.section('5. ABS FIELDS CONSISTENCY');
  const absDeviasiMismatch = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE "nominalDeviasi" IS NOT NULL AND "absNominalDeviasi" IS NOT NULL
      AND ABS("nominalDeviasi" - "absNominalDeviasi") > 0.01
      AND ABS("nominalDeviasi" + "absNominalDeviasi") > 0.01
  `);
  ctx.log(`  absNominalDeviasi != |nominalDeviasi|: ${absDeviasiMismatch[0]?.n ?? 0}`);

  const absLSMismatch = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE "nominalLossSurplus" IS NOT NULL AND "absNominalLossSurplus" IS NOT NULL
      AND ABS("nominalLossSurplus" - "absNominalLossSurplus") > 0.01
      AND ABS("nominalLossSurplus" + "absNominalLossSurplus") > 0.01
  `);
  ctx.log(`  absNominalLossSurplus != |nominalLossSurplus|: ${absLSMismatch[0]?.n ?? 0}`);

  const absQtyDeviasiMismatch = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE "qtyDeviasi" IS NOT NULL AND "absQtyDeviasi" IS NOT NULL
      AND ABS("qtyDeviasi" - "absQtyDeviasi") > 0.01
      AND ABS("qtyDeviasi" + "absQtyDeviasi") > 0.01
  `);
  ctx.log(`  absQtyDeviasi != |qtyDeviasi|: ${absQtyDeviasiMismatch[0]?.n ?? 0}`);

  const absQtyLSMismatch = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE "qtyLossSurplus" IS NOT NULL AND "absQtyLossSurplus" IS NOT NULL
      AND ABS("qtyLossSurplus" - "absQtyLossSurplus") > 0.01
      AND ABS("qtyLossSurplus" + "absQtyLossSurplus") > 0.01
  `);
  ctx.log(`  absQtyLossSurplus != |qtyLossSurplus|: ${absQtyLSMismatch[0]?.n ?? 0}`);

  // NULL abs where signed is non-null
  const nullAbsDeviasi = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE "nominalDeviasi" IS NOT NULL AND "absNominalDeviasi" IS NULL
  `);
  ctx.log(`  nominalDeviasi NOT NULL but absNominalDeviasi IS NULL: ${nullAbsDeviasi[0]?.n ?? 0}`);
}

// ============================================================
//  6. residualQty correctness (QA-5)
// ============================================================
export async function section06_residualQtyCorrectness(ctx: DataQaContext): Promise<void> {
  ctx.section('6. RESIDUAL QTY CORRECTNESS');
  const residualNeg = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE "residualQty" IS NOT NULL AND "residualQty" < 0
  `);
  ctx.log(`  residualQty < 0 (should be >= 0 due to clamp): ${residualNeg[0]?.n ?? 0}`);

  const residualMismatch = await ctx.raw<{ n: bigint }[]>(`
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
  ctx.log(`  residualQty != expected (abs(dev) - abs(w+s+t), signed): ${residualMismatch[0]?.n ?? 0}`);

  // sign of residualQty vs qtyDeviasi
  const residualSgnMismatch = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE "qtyDeviasi" IS NOT NULL AND "residualQty" IS NOT NULL
      AND "qtyDeviasi" != 0 AND "residualQty" != 0
      AND SIGN("qtyDeviasi") != SIGN("residualQty")
  `);
  ctx.log(`  residualQty sign != qtyDeviasi sign (non-zero both): ${residualSgnMismatch[0]?.n ?? 0}`);
}

// ============================================================
//  7. pctQtyDeviasiToBom sign (QA-6)
// ============================================================
export async function section07_pctQtyDeviasiToBomSign(ctx: DataQaContext): Promise<void> {
  ctx.section('7. pctQtyDeviasiToBom SIGN');
  const pctSgnMismatch = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE "pctQtyDeviasiToBom" IS NOT NULL AND "pctQtyDeviasiToBom" != 0
      AND "qtyDeviasi" IS NOT NULL AND "qtyDeviasi" != 0
      AND SIGN("pctQtyDeviasiToBom") != SIGN("qtyDeviasi")
  `);
  ctx.log(`  pctQtyDeviasiToBom sign != qtyDeviasi sign: ${pctSgnMismatch[0]?.n ?? 0}`);

  // BOM=0 but pctQtyDeviasiToBom NOT NULL?
  const bom0WithPct = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE "qtyBom" = 0 AND "pctQtyDeviasiToBom" IS NOT NULL
  `);
  ctx.log(`  BOM=0 but pctQtyDeviasiToBom IS NOT NULL (should be NULL): ${bom0WithPct[0]?.n ?? 0}`);
}

// ============================================================
//  8. tolerancePct NULL/sentinel (QA-7)
// ============================================================
export async function section08_tolerance(ctx: DataQaContext): Promise<void> {
  ctx.section('8. TOLERANCE');
  const tolStats = await ctx.raw<{ src: string; n: bigint }[]>(`
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
  ctx.log(`  tolerancePct distribution:`);
  for (const r of tolStats) ctx.log(`    ${r.src}: ${r.n}`);

  const tolRawSentinel = await ctx.raw<{ n: bigint }[]>(`
    SELECT COUNT(*)::bigint as n FROM "InventoryRecord"
    WHERE UPPER(COALESCE("toleranceRaw",'')) = 'BELUM ADA TOLERANSI'
  `);
  ctx.log(`  toleranceRaw = 'BELUM ADA TOLERANSI': ${tolRawSentinel[0]?.n ?? 0}`);

  // tolerancePct > 0 for LOSS items? (Excel convention: LOSS = negative)
  const tolSgnForLoss = await ctx.raw<{ sgn: string; n: bigint }[]>(`
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
  ctx.log(`  tolerancePct sign for LOSS items:`);
  for (const r of tolSgnForLoss) ctx.log(`    ${r.sgn}: ${r.n}`);
}
