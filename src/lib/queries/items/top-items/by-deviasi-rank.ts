// ============================================================
//  Top Items by Deviasi Rank
//  --------------------------------------------------------
//  Two query functions sharing a common base CTE (extracted to
//  ./shared-cte.ts as buildDeviasiRankBaseCte):
//
//    1. queryTopItemsByDeviasiRank — NATIONAL top-N items across
//       all outlets, ranked by ABS(nominalDeviasi) DESC. Returns
//       per-(item,outlet) rows with national rank + peer benchmark
//       (avgDeviasiByBom = AVG ABS(qtyDeviasi) of OTHER outlets
//       with same item AND qtyBom within ±50% range).
//
//    2. queryTopItemsByDeviasiRankForOutlet — selected outlet's
//       top-N items, with NATIONAL rank + peer benchmark attached.
//       Used by RankingNasionalCard when a specific resto is
//       selected for analysis.
//
//  The two paths diverge ONLY in the top-N filter CTE:
//    - National:  top_items AS (SELECT * FROM ranked WHERE rankNominal <= N)
//    - Per-outlet: outlet_top AS (SELECT * FROM (SELECT *,
//      ROW_NUMBER() OVER (PARTITION BY outletCode ...) as outletRank
//      FROM ranked_all WHERE outletCode = X) t WHERE outletRank <= N)
//
//  Source: split out of src/lib/queries/items/top-items.ts (722 LOC,
//  Task 1-d). All SQL + comments preserved verbatim; the shared base
//  CTE was extracted into ./shared-cte.ts to avoid drift.
// ============================================================
import { withStatementTimeout, type SqlFilterOpts } from '../../shared';
import { buildDeviasiRankBaseCte } from './shared-cte';

// ============================================================
//  Top Items by Deviasi Rank — national item ranking
//  Returns per (item, resto) with:
//  - Rank Item Nasional (by abs(nominalDeviasi) DESC)
//  - Rank BOM (by abs(qtyBom) DESC)
//  - qtyDeviasi, qtyWaste, qtyLossSurplus, qtyBom (all signed)
//  - pctLossSurplusToBom = SUM(qtyLossSurplus) / SUM(qtyBom) (signed, tanpa ABS)
//  - avgDeviasiByBom = AVG(ABS(pctQtyDeviasiToBom)) across ALL outlets for that item (network avg)
//  - nominalDeviasi (signed)
//  - PIC, Satuan
// ============================================================
export async function queryTopItemsByDeviasiRank(
  week: string,
  month: string,
  filters: SqlFilterOpts,
  limit: number = 20
): Promise<Array<{
  itemName: string;
  outletCode: string;
  outletName: string;
  pic: string | null;
  satuan: string | null;
  qtyDeviasi: number;
  qtyWaste: number;
  qtyLossSurplus: number;
  pctLossSurplusToBom: number | null;
  qtyBom: number;
  avgDeviasiByBom: number | null;
  nominalDeviasi: number;
  rankNominal: number;
  rankBom: number;
}>> {
  // OPTIMIZE-ENGINE: replaced 2 correlated subqueries (EXISTS + AVG, each
  // per-row) with a single CTE + LEFT JOIN. The CTE computes per-(item,outlet)
  // bucket averages in ONE pass; the main SELECT just reads them via JOIN.
  // Old query ran ~500 sub-executions per call; new query is 1 hash-join.
  //
  // FIX M-J (AUDIT-3): bucket_avg CTE was self-joining item_per_outlet × item_per_outlet
  // (ALL ~36K pairs) but only top-50 were returned. Refactored to compute bucket_avg
  // only for the top-50 (ranked CTE + top_items filter). Reduces self-join from
  // N×N to 50×N — ~720× less work for the bucket_avg step.
  //
  // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap in withStatementTimeout to enforce 30s query timeout
  // (PgBouncer tx mode strips the URL-level statement_timeout param).
  // Row shape matches the SELECT in the SQL below: 13 fields, with
  // avgDeviasiByBom + pctLossSurplusToBom + rankBom being NULLABLE (CASE-NULL).
  const baseCte = buildDeviasiRankBaseCte({
    month,
    week,
    filters,
    firstCteName: 'item_per_outlet',
    rankedCteName: 'ranked',
  });
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{
    itemName: string;
    outletCode: string;
    outletName: string;
    pic: string | null;
    satuan: string | null;
    qtyDeviasi: number | bigint;
    qtyWaste: number | bigint;
    qtyLossSurplus: number | bigint;
    pctLossSurplusToBom: number | null;
    qtyBom: number | bigint;
    nominalDeviasi: number | bigint;
    avgDeviasiByBom: number | null;
    rankNominal: number | bigint;
    rankBom: number | null;
  }>>`
    WITH ${baseCte},
    -- FIX M-J: only compute bucket_avg for top-N items (not all 36K pairs)
    top_items AS (
      SELECT * FROM ranked WHERE "rankNominal" <= ${limit}
    ),
    -- Bucket average: for each top-N item, average ABS(qtyDeviasi) of OTHER outlets
    -- with same itemName AND qtyBom within ±50% range. Self-join is now top_items ×
    -- item_per_outlet (50 × N) instead of N × N.
    bucket_avg AS (
      SELECT
        ti."itemName",
        ti."outletCode",
        AVG(CASE WHEN ipo2."outletCode" != ti."outletCode"
                 THEN ipo2."absQtyDeviasi" END) as "avgDeviasiByBom",
        SUM(CASE WHEN ipo2."outletCode" != ti."outletCode"
                 THEN 1 ELSE 0 END) as "otherCount"
      FROM top_items ti
      JOIN item_per_outlet ipo2
        ON ipo2."itemName" = ti."itemName"
        AND ABS(ti."qtyBom") > 0  -- FIX CALC-7: skip BOM=0 items
        AND ABS(ipo2."qtyBom") > 0
        AND ABS(ipo2."qtyBom") BETWEEN ABS(ti."qtyBom") * 0.5 AND ABS(ti."qtyBom") * 1.5
      GROUP BY ti."itemName", ti."outletCode"
    )
    SELECT
      ti."itemName", ti."outletCode", ti."outletName", ti.pic, ti."satuan",
      ti."qtyDeviasi", ti."qtyWaste", ti."qtyLossSurplus", ti."pctLossSurplusToBom",
      ti."qtyBom", ti."nominalDeviasi",
      -- avgDeviasiByBom: only if at least 1 OTHER resto exists in the bucket
      -- FIX CALC-7: BOM=0 items get NULL (bucket concept doesn't apply)
      CASE WHEN ti."qtyBom" != 0 AND ba."otherCount" > 0 THEN ba."avgDeviasiByBom" ELSE NULL END as "avgDeviasiByBom",
      ti."rankNominal",
      ti."rankBom"
    FROM top_items ti
    LEFT JOIN bucket_avg ba
      ON ti."itemName" = ba."itemName"
     AND ti."outletCode" = ba."outletCode"
    ORDER BY ti."rankNominal"
  `);
  // Coerce BigInt/Decimal to Number
  return rows.map((r) => ({
    ...r,
    qtyDeviasi: Number(r.qtyDeviasi),
    qtyWaste: Number(r.qtyWaste),
    qtyLossSurplus: Number(r.qtyLossSurplus),
    pctLossSurplusToBom: r.pctLossSurplusToBom != null ? Number(r.pctLossSurplusToBom) : null,
    qtyBom: Number(r.qtyBom),
    avgDeviasiByBom: r.avgDeviasiByBom != null ? Number(r.avgDeviasiByBom) : null,
    nominalDeviasi: Number(r.nominalDeviasi),
    rankNominal: Number(r.rankNominal),
    rankBom: Number(r.rankBom),
  }));
}

// ============================================================
//  Top Items by Deviasi Rank — PER OUTLET (top N for a specific outlet)
//  Returns the selected outlet's top-N items (by ABS(nominalDeviasi)),
//  enriched with:
//  - rankNominal: NATIONAL rank (across ALL outlets) — so the user sees
//    where this item ranks nationally, not just within the outlet
//  - rankBom: NATIONAL rank by ABS(qtyBom)
//  - avgDeviasiByBom: peer benchmark (other outlets with same item + BOM ±50%)
//  - All signed qty/nominal fields for display
//
//  Used by RankingNasionalCard when a resto is selected for analysis.
//  Differs from queryTopItemsByDeviasiRank (national top-50 across all
//  outlets) — this returns the selected outlet's top-N items, with
//  national rank + peer benchmark attached.
// ============================================================
export async function queryTopItemsByDeviasiRankForOutlet(
  week: string,
  month: string,
  outletCode: string,
  limit: number = 30
): Promise<Array<{
  itemName: string;
  outletCode: string;
  outletName: string;
  pic: string | null;
  satuan: string | null;
  qtyDeviasi: number;
  qtyWaste: number;
  qtyLossSurplus: number;
  pctLossSurplusToBom: number | null;
  qtyBom: number;
  avgDeviasiByBom: number | null;
  nominalDeviasi: number;
  rankNominal: number;
  rankBom: number;
}>> {
  // Compute per-(item,outlet) aggregates for ALL outlets (needed for national
  // rank + peer benchmark), then filter to the target outlet's top-N.
  const baseCte = buildDeviasiRankBaseCte({
    month,
    week,
    filters: null, // per-outlet query needs ALL outlets for national rank
    firstCteName: 'all_item_per_outlet',
    rankedCteName: 'ranked_all',
  });
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{
    itemName: string;
    outletCode: string;
    outletName: string;
    pic: string | null;
    satuan: string | null;
    qtyDeviasi: number | bigint;
    qtyWaste: number | bigint;
    qtyLossSurplus: number | bigint;
    pctLossSurplusToBom: number | null;
    qtyBom: number | bigint;
    nominalDeviasi: number | bigint;
    avgDeviasiByBom: number | null;
    rankNominal: number | bigint;
    rankBom: number | null;
  }>>`
    WITH ${baseCte},
    -- Target outlet's top-N items (ranked within outlet by ABS(nominalDeviasi))
    outlet_top AS (
      SELECT * FROM (
        SELECT ra.*,
          ROW_NUMBER() OVER (PARTITION BY ra."outletCode" ORDER BY ABS(ra."nominalDeviasi") DESC) as "outletRank"
        FROM ranked_all ra
        WHERE ra."outletCode" = ${outletCode}
      ) t WHERE "outletRank" <= ${limit}
    ),
    -- Peer benchmark: for each outlet_top item, average ABS(qtyDeviasi) of OTHER
    -- outlets with same itemName AND qtyBom within ±50% range.
    bucket_avg AS (
      SELECT
        ti."itemName",
        ti."outletCode",
        AVG(CASE WHEN ipo2."outletCode" != ti."outletCode"
                 THEN ipo2."absQtyDeviasi" END) as "avgDeviasiByBom",
        SUM(CASE WHEN ipo2."outletCode" != ti."outletCode"
                 THEN 1 ELSE 0 END) as "otherCount"
      FROM outlet_top ti
      JOIN all_item_per_outlet ipo2
        ON ipo2."itemName" = ti."itemName"
        AND ABS(ti."qtyBom") > 0
        AND ABS(ipo2."qtyBom") > 0
        AND ABS(ipo2."qtyBom") BETWEEN ABS(ti."qtyBom") * 0.5 AND ABS(ti."qtyBom") * 1.5
      GROUP BY ti."itemName", ti."outletCode"
    )
    SELECT
      ti."itemName", ti."outletCode", ti."outletName", ti.pic, ti."satuan",
      ti."qtyDeviasi", ti."qtyWaste", ti."qtyLossSurplus", ti."pctLossSurplusToBom",
      ti."qtyBom", ti."nominalDeviasi",
      CASE WHEN ti."qtyBom" != 0 AND ba."otherCount" > 0 THEN ba."avgDeviasiByBom" ELSE NULL END as "avgDeviasiByBom",
      ti."rankNominal",
      ti."rankBom"
    FROM outlet_top ti
    LEFT JOIN bucket_avg ba
      ON ti."itemName" = ba."itemName"
     AND ti."outletCode" = ba."outletCode"
    ORDER BY ti."outletRank"
  `);
  // Coerce BigInt/Decimal to Number (matches queryTopItemsByDeviasiRank coercion)
  return rows.map((r) => ({
    ...r,
    qtyDeviasi: Number(r.qtyDeviasi),
    qtyWaste: Number(r.qtyWaste),
    qtyLossSurplus: Number(r.qtyLossSurplus),
    pctLossSurplusToBom: r.pctLossSurplusToBom != null ? Number(r.pctLossSurplusToBom) : null,
    qtyBom: Number(r.qtyBom),
    avgDeviasiByBom: r.avgDeviasiByBom != null ? Number(r.avgDeviasiByBom) : null,
    nominalDeviasi: Number(r.nominalDeviasi),
    rankNominal: Number(r.rankNominal),
    rankBom: Number(r.rankBom),
  }));
}
