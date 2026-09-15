// ============================================================
//  Top Items by Other Metric — Pareto by |Dev/BOM|
//  --------------------------------------------------------
//  queryParetoByDevBom — Pareto 80/20 for items with
//  |Dev/BOM| > threshold (group by item, drill-down ke outlet).
//  The "Network Item Risk" banner below is a historical design
//  note kept verbatim from the original file (no function in
//  this module implements it).
//
//  Split from ./by-other-metric.ts (SPLIT-E — pure code motion;
//  SQL, comments and behavior preserved verbatim). Stays
//  re-exported from ./by-other-metric.ts.
// ============================================================
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../../shared';
import type { ParetoDevBomResult, ParetoDevBomRow, ParetoDevBomOutletRow } from './types';

// ============================================================
//  Network Item Risk — per-item scoring across ALL outlets
//  --------------------------------------------------------
//  Instead of per-(item × outlet) ranking, this scores each ITEM
//  across the entire network to surface SYSTEMIC issues:
//    - How many outlets have this item with deviation?
//    - What's the total financial impact (SUM |nominalDeviasi|)?
//    - What's the avg / max deviation ratio (Dev/BOM)?
//    - Is this systemic (many outlets) or isolated (few outlets)?
//
//  Scoring (computed in JS — keeps SQL portable + testable):
//    systemicScore     = min(100, (deviatingOutlets / totalOutlets) * 200)
//    financialImpact   = min(100, totalAbsNominal / 100_000_000 * 100)
//    riskScore         = round(systemic*0.4 + financial*0.4 + avgDevBom*100*0.2)
//    riskLevel         = >=55 TINGGI | >=30 SEDANG | else RENDAH
//
//  `deviationThreshold` = STD_DEVIASI_BOM_PCT (passed from runtime thresholds)
//  so an outlet is counted as "deviating" when its abs(Dev/BOM) > threshold.
// ============================================================

// ============================================================
//  Pareto 80/20 untuk Item dengan |Dev/BOM| > 50%
//  Group by item, drill-down ke outlet. Konsep seperti Nested Pareto.
// ============================================================
export async function queryParetoByDevBom(
  week: string,
  month: string,
  filters: SqlFilterOpts,
  maxDrivers: number = 20,
  threshold: number = 0.50,
): Promise<ParetoDevBomResult> {
  const f = buildSqlFilters(filters);

  // PERF (TAHAP-2 / P2-10): previously TWO sequential scans of the same
  // filtered period — (1) GROUP BY (item, outletId) → item-level top-20,
  // then (2) GROUP BY (item, outlet) again with outlet columns + i.name IN
  // (top items) for the drill-down rows. Both scans shared the same WHERE /
  // HAVING / (item × outlet) grouping, so this now runs ONE scan that returns
  // ALL threshold-passing (item, outlet) rows (with the sums needed to
  // re-derive the item level in JS — the same expressions scan 1 used:
  // outletCount = COUNT(DISTINCT outletId) → rows per item;
  // devBom = Σ qtyDeviasi / Σ |qtyBom|; devBomAbs = Σ |Σ qtyDeviasi| / Σ |qtyBom|;
  // absNominal = ABS(Σ nominalDeviasi)).
  // Row volume is bounded by (item × outlet) pairs above the 50% threshold —
  // typically a few hundred rows, far below the period itself.
  // The per-item top-20 outlet cap (old ROW_NUMBER rn <= 20) is a JS sort by
  // (absNominal DESC, outletCode) + slice — same deterministic tie-break.
  const outletRows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{
    itemName: string; outletCode: string; outletName: string; area: string;
    devBom: number; devBomAbs: number; nominalDeviasi: number; absNominal: number;
    totalQtyDeviasi: number; totalQtyBom: number;
  }>>`
    WITH per_outlet AS (
      SELECT i.name as "itemName", o.code as "outletCode", o.name as "outletName", o.area,
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ir."qtyDeviasi") / SUM(ABS(ir."qtyBom"))
          ELSE 0 END as "devBom",
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE 0 END as "devBomAbs",
        SUM(ir."nominalDeviasi") as "nominalDeviasi",
        ABS(SUM(ir."nominalDeviasi")) as "absNominal",
        SUM(ir."qtyDeviasi") as "totalQtyDeviasi",
        SUM(ABS(ir."qtyBom")) as "totalQtyBom"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      JOIN "Outlet" o ON ir."outletId" = o.id
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
        AND ir."qtyBom" IS NOT NULL AND ir."qtyBom" != 0
        ${f}
      GROUP BY i.name, o.code, o.name, o.area
      HAVING CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE 0 END > ${threshold}
    )
    SELECT "itemName", "outletCode", "outletName", "area", "devBom", "devBomAbs",
      "nominalDeviasi", "absNominal", "totalQtyDeviasi", "totalQtyBom"
    FROM per_outlet
    ORDER BY "itemName", "absNominal" DESC, "outletCode"
  `);

  // Group rows per item (SQL order gives per-item absNominal DESC + outletCode
  // tie-break — the same order the old ROW_NUMBER cap used).
  const rowsByItem = new Map<string, typeof outletRows>();
  for (const row of outletRows) {
    const list = rowsByItem.get(row.itemName) ?? [];
    list.push(row);
    rowsByItem.set(row.itemName, list);
  }

  // Item-level derivation (same expressions the old topItems scan used).
  interface ItemAgg {
    itemName: string;
    outletCount: number;
    devBom: number;
    devBomAbs: number;
    nominalDeviasi: number;
    absNominal: number;
    rows: typeof outletRows;
  }
  const itemAggs: ItemAgg[] = [];
  for (const [itemName, rows] of rowsByItem) {
    let sumQtyDeviasi = 0, sumAbsQtyDeviasi = 0, sumQtyBom = 0, sumNominalDeviasi = 0;
    for (const r of rows) {
      sumQtyDeviasi += Number(r.totalQtyDeviasi) || 0;
      sumAbsQtyDeviasi += Math.abs(Number(r.totalQtyDeviasi) || 0);
      sumQtyBom += Number(r.totalQtyBom) || 0;
      sumNominalDeviasi += Number(r.nominalDeviasi) || 0;
    }
    itemAggs.push({
      itemName,
      outletCount: rows.length,
      devBom: sumQtyBom > 0 ? sumQtyDeviasi / sumQtyBom : 0,
      devBomAbs: sumQtyBom > 0 ? sumAbsQtyDeviasi / sumQtyBom : 0,
      nominalDeviasi: sumNominalDeviasi,
      absNominal: Math.abs(sumNominalDeviasi),
      rows,
    });
  }

  if (itemAggs.length === 0) {
    return { drivers: [], remainderCount: 0, remainderPct: 0, totalAbsNominal: 0, totalCount: 0, thresholdPct: threshold };
  }

  // Top items by absNominal DESC (itemName tie-break for determinism), capped
  // at maxDrivers — same cap + order as the old scan-1 LIMIT.
  const topItems = itemAggs
    .sort((a, b) => (b.absNominal - a.absNominal) || a.itemName.localeCompare(b.itemName))
    .slice(0, maxDrivers);

  // FIX (BUG-2-c): grandTotal is the FULL population total over ALL
  // threshold-passing items (outletRows returns every (item, outlet) row —
  // no SQL LIMIT — so the population is fully materialized here), NOT just
  // the top-N slice. sharePct/cumPct are therefore honest percentages of the
  // population (same semantics as computePareto8020 on the by-dimension
  // cards) instead of inflating to a misleading 100% at row maxDrivers;
  // remainderPct = 100 − cumPct becomes the true "rest of population".
  const grandTotal = itemAggs.reduce((s, r) => s + r.absNominal, 0);
  let cumPct = 0;

  const drivers: ParetoDevBomRow[] = topItems.map((item) => {
    const sharePct = grandTotal > 0 ? (item.absNominal / grandTotal) * 100 : 0;
    cumPct += sharePct;

    // Top 20 outlets per item (old rn <= 20 cap) — rows arrive pre-sorted by
    // (absNominal DESC, outletCode) from the SQL ORDER BY.
    const outletRows = item.rows.slice(0, 20);
    const outletTotal = outletRows.reduce((s, r) => s + Number(r.absNominal), 0);
    let outletCum = 0;
    const outlets: ParetoDevBomOutletRow[] = outletRows.map((r) => {
      const oShare = outletTotal > 0 ? (Number(r.absNominal) / outletTotal) * 100 : 0;
      outletCum += oShare;
      return {
        outletCode: r.outletCode,
        outletName: r.outletName,
        area: r.area,
        devBom: Number(r.devBom) || 0,
        devBomAbs: Number(r.devBomAbs) || 0,
        nominalDeviasi: Number(r.nominalDeviasi) || 0,
        absNominal: Number(r.absNominal) || 0,
        sharePct: Number(oShare.toFixed(1)),
        cumPct: Number(outletCum.toFixed(1)),
      };
    });

    return {
      itemName: item.itemName,
      outletCount: item.outletCount,
      devBom: Number(item.devBom) || 0,
      devBomAbs: Number(item.devBomAbs) || 0,
      nominalDeviasi: Number(item.nominalDeviasi) || 0,
      absNominal: item.absNominal,
      sharePct: Number(sharePct.toFixed(1)),
      cumPct: Number(cumPct.toFixed(1)),
      outlets,
    };
  });

  return {
    drivers,
    // BUG-Q (population semantics, completing BUG-2-c): remainderCount /
    // totalCount now report the FULL threshold-passing population, matching
    // the population-honest sharePct/cumPct/remainderPct/totalAbsNominal
    // above (same convention as computePareto8020 + the nested-Pareto
    // populationTotal window). Previously totalCount was the top-N slice
    // length (== drivers.length — the UI badge "N item · M total" showed
    // N == M whenever the population exceeded maxDrivers) and remainderCount
    // was hardcoded 0 while remainderPct honestly reported the rest of
    // population.
    remainderCount: itemAggs.length - topItems.length,
    remainderPct: Number(Math.max(0, 100 - cumPct).toFixed(1)),
    totalAbsNominal: grandTotal,
    totalCount: itemAggs.length,
    thresholdPct: threshold,
  };
}
