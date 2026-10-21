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
//
//  PERF-FILTER1 (B3): the per-outlet path no longer re-runs the FULL
//  national CTE chain per outlet. The national aggregates live in ONE
//  cached scan row ('q-devrank-scan' — ./national-scan.ts, keyed by
//  (month, week) only, 30-min TTL, mutation-invalidated); this path
//  runs ONE cheap indexed display query for the target outlet + the
//  pure computeDeviasiRankForOutlet below (national rank, BOM rank,
//  ±50% bucket peer average — SQL semantics documented at the fn).
// ============================================================
import { withStatementTimeout, type SqlFilterOpts } from '../../shared';
import { buildDeviasiRankBaseCte } from './shared-cte';
import { peerBomBucketPredicate } from '../peer-bucket';
import { getDeviasiNationalScan, type DeviasiNationalScanRow } from './national-scan';

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
  rankBom: number | null;
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
        AND ${peerBomBucketPredicate('ti', 'ipo2')}
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
    // FIX (BUG-1-01): preserve null — SQL returns NULL for qtyBom=0 items.
    // Was `Number(r.rankBom)` which coerced null→0 (misleading "rank 0").
    rankBom: r.rankBom != null ? Number(r.rankBom) : null,
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
//
//  PERF-FILTER1 (B3) shape: [shared cached national scan] ∥ [cheap
//  per-outlet display query] → pure compute. The display query is the
//  OLD base CTE's SELECT/GROUP BY with `AND o.code = ${outletCode}` —
//  an indexed ~60-200 row scan instead of the national window chain.
//  Ranks + the ±50% bucket average come from the cached scan row.
// ============================================================

/** Display-row shape from the per-outlet query (bigint coerced in compute). */
interface DeviasiOutletDisplayRow {
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
}

/**
 * Pure compute (exported for vitest): attach national ranks + the ±50%
 * BOM bucket peer average to the target outlet's display rows.
 *
 * SQL semantics preserved from the old single-query path:
 *   - top-N selection: the outlet's items by ABS(nominalDeviasi) DESC
 *     (the old outlet_top ROW_NUMBER; ties broken by itemName — the
 *     SQL tie order was arbitrary).
 *   - rankNominal: sequential over the FULL national set sorted by
 *     ABS(nominalDeviasi) DESC (ROW_NUMBER semantics — no shared ranks;
 *     deterministic tiebreak outletCode, itemName).
 *   - rankBom: sequential among qtyBom > 0 rows by qtyBom DESC; NULL
 *     for qtyBom = 0 (FIX BUG-1-01 preserved).
 *   - avgDeviasiByBom: AVG(absQtyDeviasi) over OTHER outlets with the
 *     same itemName, both qtyBom > 0, and candidate qtyBom BETWEEN
 *     target×0.5 AND target×1.5 (peerBomBucketPredicate bounds,
 *     inclusive); NULL when otherCount = 0 or target qtyBom = 0.
 *
 * Display rows missing from the scan (only possible if a mutation
 * landed BETWEEN the two parallel queries — READ COMMITTED snapshots)
 * degrade gracefully: rank falls back to the scan's tail position and
 * the bucket average to NULL, never throwing.
 */
export function computeDeviasiRankForOutlet(
  scanRows: DeviasiNationalScanRow[],
  displayRows: DeviasiOutletDisplayRow[],
  outletCode: string,
  limit: number = 30,
): Array<{
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
  rankBom: number | null;
}> {
  const pairKey = (o: string, i: string) => `${o}\u0000${i}`;
  // National rank maps (deterministic ROW_NUMBER orderings).
  const byNominal = [...scanRows].sort(
    (a, b) =>
      Math.abs(b.nominalDeviasi) - Math.abs(a.nominalDeviasi) ||
      a.outletCode.localeCompare(b.outletCode) ||
      a.itemName.localeCompare(b.itemName),
  );
  const rankNominalMap = new Map<string, number>();
  byNominal.forEach((r, idx) => rankNominalMap.set(pairKey(r.outletCode, r.itemName), idx + 1));
  const byBom = scanRows
    .filter((r) => r.qtyBom > 0)
    .sort(
      (a, b) =>
        b.qtyBom - a.qtyBom ||
        a.outletCode.localeCompare(b.outletCode) ||
        a.itemName.localeCompare(b.itemName),
    );
  const rankBomMap = new Map<string, number>();
  byBom.forEach((r, idx) => rankBomMap.set(pairKey(r.outletCode, r.itemName), idx + 1));
  // (item → national rows) index for the bucket averages.
  const byItem = new Map<string, DeviasiNationalScanRow[]>();
  for (const r of scanRows) {
    const list = byItem.get(r.itemName);
    if (list) list.push(r);
    else byItem.set(r.itemName, [r]);
  }
  // (outlet, item) → scan row — O(1) display-row lookups.
  const scanByPair = new Map<string, DeviasiNationalScanRow>();
  for (const r of scanRows) scanByPair.set(pairKey(r.outletCode, r.itemName), r);

  // Top-N display rows (the old outlet_top window, within-outlet rank).
  const top = [...displayRows]
    .sort(
      (a, b) =>
        Math.abs(Number(b.nominalDeviasi)) - Math.abs(Number(a.nominalDeviasi)) ||
        a.itemName.localeCompare(b.itemName),
    )
    .slice(0, limit);

  return top.map((t) => {
    const scanRow = scanByPair.get(pairKey(outletCode, t.itemName));
    // Graceful degradation for the (theoretically impossible, mutation
    // race) missing scan row — see the doc comment above.
    const rankNominal = scanRow
      ? rankNominalMap.get(pairKey(outletCode, t.itemName)) ?? scanRows.length
      : scanRows.length;
    const qtyBomNum = Number(t.qtyBom);
    const rankBom =
      scanRow && qtyBomNum > 0
        ? rankBomMap.get(pairKey(outletCode, t.itemName)) ?? null
        : null;
    // Bucket average: other outlets, same item, both BOM > 0, candidate
    // qtyBom BETWEEN target×0.5 AND target×1.5 (inclusive bounds).
    let avgDeviasiByBom: number | null = null;
    if (scanRow && scanRow.qtyBom > 0) {
      const candidates = (byItem.get(t.itemName) ?? []).filter(
        (c) =>
          c.outletCode !== outletCode &&
          c.qtyBom > 0 &&
          c.qtyBom >= scanRow.qtyBom * 0.5 &&
          c.qtyBom <= scanRow.qtyBom * 1.5,
      );
      if (candidates.length > 0) {
        avgDeviasiByBom =
          candidates.reduce((s, c) => s + c.absQtyDeviasi, 0) / candidates.length;
      }
    }
    return {
      itemName: t.itemName,
      outletCode: t.outletCode,
      outletName: t.outletName,
      pic: t.pic,
      satuan: t.satuan,
      qtyDeviasi: Number(t.qtyDeviasi),
      qtyWaste: Number(t.qtyWaste),
      qtyLossSurplus: Number(t.qtyLossSurplus),
      pctLossSurplusToBom: t.pctLossSurplusToBom != null ? Number(t.pctLossSurplusToBom) : null,
      qtyBom: qtyBomNum,
      avgDeviasiByBom,
      nominalDeviasi: Number(t.nominalDeviasi),
      rankNominal,
      // FIX (BUG-1-01): preserve null — qtyBom=0 items rank NULL (not 0).
      rankBom,
    };
  });
}

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
  rankBom: number | null;
}>> {
  // PERF-FILTER1 (B3): shared cached national scan (all outlets — ranks +
  // bucket inputs) ∥ cheap per-outlet display query — replaces the full
  // national CTE chain that used to re-run per outlet selection.
  const [scan, displayRows] = await Promise.all([
    getDeviasiNationalScan(week, month),
    // The display query mirrors the OLD base CTE's SELECT list + GROUP BY
    // with the outlet filter — same aggregates, so the values feeding the
    // ranks/buckets match the cached scan's exactly.
    withStatementTimeout((tx) => tx.$queryRaw<DeviasiOutletDisplayRow[]>`
      SELECT
        i.name as "itemName",
        o.code as "outletCode",
        o.name as "outletName",
        pic.pic,
        MAX(ir."satuan") as "satuan",
        SUM(ir."qtyDeviasi") as "qtyDeviasi",
        SUM(ir."qtyWaste") as "qtyWaste",
        SUM(ir."qtyLossSurplus") as "qtyLossSurplus",
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN ABS(SUM(ir."qtyLossSurplus")) / SUM(ABS(ir."qtyBom"))
          ELSE NULL END as "pctLossSurplusToBom",
        SUM(ABS(ir."qtyBom")) as "qtyBom",
        SUM(ir."nominalDeviasi") as "nominalDeviasi"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      JOIN "Outlet" o ON ir."outletId" = o.id
      LEFT JOIN "OutletPIC" pic ON o.code = pic."outletCode"
      WHERE ir."monthLabel" = ${month}
        AND ir."weekLabel" = ${week}
        AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
        AND o.code = ${outletCode}
      GROUP BY i.name, o.code, o.name, pic.pic
    `),
  ]);
  return computeDeviasiRankForOutlet(scan.rows, displayRows, outletCode, limit);
}
