// ============================================================
//  fetch-records — Section 2 of /api/outlet-items GET pipeline
//  --------------------------------------------------------
//  Extracted from the original 673-line route.ts (lines ~178-305).
//
//  Responsibilities:
//    1. Fire topDeviasiRankPromise in PARALLEL with the main Promise.all
//       (powers RankingNasionalCard — top N items for this outlet with
//       national rank). N comes from Settings.TOP_N_DEVIASI_RANK.
//    2. Promise.all of 5 queries:
//       a. currentRecs — per-(item, akunPenyesuaian) aggregates for this
//          outlet/week/month. 28 columns. Drives restoProfile + itemBreakdown.
//       b. prevRecs — same shape (6 cols) for previous period. Drives
//          growth + historical trend.
//       c. areaBench — SUM(ABS)/SUM(ABS) Dev/BOM aggregate for outlets
//          in the same area (FIX H1: JOIN Outlet + filter by o.area).
//       d. networkBench — SUM(ABS)/SUM(ABS) Dev/BOM aggregate for ALL
//          outlets (network-wide benchmark).
//       e. outletPIC — findUnique on outlet.code (null on miss/error).
//
//  FIX (AUDIT8-ROLLBACK-1, Item 8): raw SQL wrapped in withStatementTimeout
//  so a hung query in one Promise.all branch is killed at 30s rather than
//  blocking the whole batch indefinitely.
// ============================================================
import { db } from '@/lib/db';
import { withStatementTimeout } from '@/lib/queries/shared';
import { queryTopItemsByDeviasiRankForOutlet } from '@/lib/queries/items/top-items';
import type { OutletLookup } from './types';
import type {
  CurrentRecRow,
  PrevRecRow,
  BenchRow,
  FetchedRecords,
} from './types';
import type { RuntimeThresholds } from '@/lib/settings';

export async function fetchRecords(params: {
  outlet: OutletLookup;
  outletCode: string;
  month: string;
  week: string;
  prevWeek: string | null;
  prevMonth: string | null;
  thresholds: RuntimeThresholds;
}): Promise<FetchedRecords> {
  const { outlet, outletCode, month, week, prevWeek, prevMonth, thresholds } = params;

  // Fire top deviasi rank for this outlet in PARALLEL with the main queries
  // (powers RankingNasionalCard — top N items for this outlet with national rank).
  // FIX (AUDIT8-ROLLBACK-1, Item 15): read TOP_N_DEVIASI_RANK from Settings
  // (was hardcoded 30). thresholds is fetched above so this is a synchronous
  // read — no extra DB round-trip.
  const topDeviasiRankN = thresholds.TOP_N_DEVIASI_RANK || 30;
  const topDeviasiRankPromise = queryTopItemsByDeviasiRankForOutlet(
    week,
    month,
    outletCode,
    topDeviasiRankN,
  );

  // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout
  // so a hung query in one Promise.all branch is killed at 30s rather than
  // blocking the whole batch indefinitely.
  const [currentRecs, prevRecs, areaBench, networkBench, outletPIC] = await Promise.all([
    withStatementTimeout((tx) => tx.$queryRaw<Array<CurrentRecRow>>`
        SELECT ir."itemId", i.name as "itemName", i.satuan, ir."akunPenyesuaian",
          SUM(ir."qtyBom") as "qtyBom", SUM(ir."qtyCom") as "qtyCom", SUM(ir."qtyDeviasi") as "qtyDeviasi",
          SUM(ir."qtyWaste") as "qtyWaste", SUM(ir."qtySusut") as "qtySusut", SUM(ir."qtyTrial") as "qtyTrial", SUM(ir."qtyLossSurplus") as "qtyLossSurplus",
          SUM(ir."nominalDeviasi") as "nominalDeviasi", SUM(ir."nominalWaste") as "nominalWaste", SUM(ir."nominalSusut") as "nominalSusut",
          SUM(ir."nominalTrial") as "nominalTrial", SUM(ir."nominalLossSurplus") as "nominalLossSurplus", SUM(ir."nominalSales") as "nominalSales",
          AVG(ir."avgPrice") as "avgPrice",
          -- FIX SQL-6: was MAX(tolerancePct) which picks least-negative for LOSS items (false breach positives)
          -- Use MIN (most negative = strictest tolerance) for LOSS, MAX for SURPLUS
          CASE
            WHEN SUM(ir."nominalLossSurplus") < 0 THEN MIN(ir."tolerancePct")
            ELSE MAX(ir."tolerancePct")
          END as "tolerancePct",
          -- FIX FLOW3-3: was MAX(pctQtyDeviasiToBom) which understates LOSS magnitude
          -- (MAX picks least-negative for LOSS items). Use SUM(qtyDeviasi)/SUM(ABS(qtyBom)) instead.
          CASE WHEN SUM(ABS(ir."qtyBom")) > 0
            THEN SUM(ir."qtyDeviasi") / SUM(ABS(ir."qtyBom"))
            ELSE NULL END as "pctQtyDeviasiToBom",
          -- FIX SIGN-3: compute direction on-the-fly from nominalLossSurplus sign (not MAX(ir.direction) which depends on migration)
          -- FIX VERIFY3-7: add qtyDeviasi NULL fallback for rows where nominalLossSurplus is null
          CASE
            WHEN SUM(ir."nominalLossSurplus") IS NOT NULL AND SUM(ir."nominalLossSurplus") < 0 THEN 'LOSS'
            WHEN SUM(ir."nominalLossSurplus") IS NOT NULL AND SUM(ir."nominalLossSurplus") > 0 THEN 'SURPLUS'
            WHEN SUM(ir."nominalLossSurplus") IS NULL AND SUM(ir."qtyDeviasi") < 0 THEN 'LOSS'
            WHEN SUM(ir."nominalLossSurplus") IS NULL AND SUM(ir."qtyDeviasi") > 0 THEN 'SURPLUS'
            ELSE 'NEUTRAL'
          END as "direction",
          SUM(ir."residualQty") as "residualQty", SUM(ir."residualNominal") as "residualNominal",
          -- FIX SQL-6: was MAX(residualRatio) which overstates — use SUM(ABS(residualQty))/SUM(ABS(qtyDeviasi))
          CASE WHEN SUM(ABS(ir."qtyDeviasi")) > 0
            THEN SUM(ABS(ir."residualQty")) / SUM(ABS(ir."qtyDeviasi"))
            ELSE 0 END as "residualRatio",
          SUM(ir."absQtyDeviasi") as "absQtyDeviasi", SUM(ir."absNominalDeviasi") as "absNominalDeviasi",
          SUM(ir."absQtyLossSurplus") as "absQtyLossSurplus", SUM(ir."absNominalLossSurplus") as "absNominalLossSurplus"
        FROM "InventoryRecord" ir
        JOIN "Item" i ON ir."itemId" = i.id
        JOIN "Outlet" o ON ir."outletId" = o.id
        WHERE o.code = ${outletCode}
          AND ir."monthLabel" = ${month}
          AND ir."weekLabel" = ${week}
        GROUP BY ir."outletId", ir."itemId", ir."akunPenyesuaian", i.name, i.satuan
      `),
    prevWeek && prevMonth
      ? withStatementTimeout((tx) => tx.$queryRaw<Array<PrevRecRow>>`
        SELECT ir."itemId", ir."akunPenyesuaian",
          SUM(ir."qtyDeviasi") as "qtyDeviasi",
          SUM(ir."nominalDeviasi") as "nominalDeviasi",
          SUM(ir."qtyBom") as "qtyBom",
          -- FIX API-CALC-2: was MAX(pctQtyDeviasiToBom) — use SUM/SUM aggregate (matches FLOW3-3 fix)
          CASE WHEN SUM(ABS(ir."qtyBom")) > 0
            THEN SUM(ir."qtyDeviasi") / SUM(ABS(ir."qtyBom"))
            ELSE NULL END as "pctQtyDeviasiToBom",
          SUM(ir."nominalSales") as "nominalSales"
        FROM "InventoryRecord" ir
        JOIN "Outlet" o ON ir."outletId" = o.id
        WHERE o.code = ${outletCode}
          AND ir."monthLabel" = ${prevMonth}
          AND ir."weekLabel" = ${prevWeek}
        GROUP BY ir."outletId", ir."itemId", ir."akunPenyesuaian"
      `)
      : Promise.resolve([]),
    // Area benchmark — Phase 3: SUM(ABS)/SUM(ABS) matching computeDevBomAggregate
    // FIX H1 (AUDIT-3): was `WHERE ir.area = ${outlet.area}` — silently returned 0
    // when denormalized ir.area diverged from Outlet.area (e.g. MLGPAR: outlet="JAWA
    // TIMUR 1" vs ir="BAKSO"). JOIN Outlet and filter by o.area for correctness.
    withStatementTimeout((tx) => tx.$queryRaw<Array<BenchRow>>`
        SELECT
          CASE WHEN SUM(ABS(ir."qtyBom")) > 0
            THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
            ELSE 0 END as "avgDevBom",
          NULL as "lossToSales"
        FROM "InventoryRecord" ir
        JOIN "Outlet" o ON ir."outletId" = o.id
        WHERE o.area = ${outlet.area}
          AND ir."monthLabel" = ${month}
          AND ir."weekLabel" = ${week}
      `),
    // Network benchmark — Phase 3: SUM(ABS)/SUM(ABS)
    withStatementTimeout((tx) => tx.$queryRaw<Array<BenchRow>>`
        SELECT
          CASE WHEN SUM(ABS(ir."qtyBom")) > 0
            THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
            ELSE 0 END as "avgDevBom"
        FROM "InventoryRecord" ir
        WHERE ir."monthLabel" = ${month}
          AND ir."weekLabel" = ${week}
      `),
    // PIC
    db.outletPIC.findUnique({ where: { outletCode: outlet.code } }).catch(() => null),
  ]);

  return {
    currentRecs,
    prevRecs,
    areaBench,
    networkBench,
    outletPIC,
    topDeviasiRankPromise,
  };
}
