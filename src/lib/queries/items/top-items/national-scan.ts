// ============================================================
//  Deviasi National Scan — ONE shared national scan for the
//  per-outlet deviasi-rank view (PERF-FILTER1 / B3)
//  --------------------------------------------------------
//  queryTopItemsByDeviasiRankForOutlet (by-deviasi-rank.ts) used to
//  re-run the FULL national CTE chain (all_item_per_outlet +
//  ranked_all + bucket_avg) for EVERY outlet selection — the
//  "Filter Resto" cold path's single heaviest query (~3-7s of the
//  measured 11-15s /api/outlet-items cold compute). The national
//  aggregates are OUTLET-INDEPENDENT: only the final outlet_top
//  slice + the display columns are per-outlet.
//
//  This module caches the slim national table under
//  'q-devrank-scan' keyed by (month, week) ONLY:
//    { itemName, outletCode, nominalDeviasi, qtyBom, absQtyDeviasi }
//  (~20-30K rows ≈ 1.5-2.5MB JSON — one row per (item, outlet) pair
//  with ABS(nominalDeviasi) > 0 records in the period, the exact
//  all_item_per_outlet grain). The per-outlet path then runs ONE
//  cheap indexed query (the target outlet's ~60-200 display rows)
//  and computes ranks + the ±50% BOM bucket average in pure JS
//  (computeDeviasiRankForOutlet in by-deviasi-rank.ts).
//
//  Semantics preserved vs the old SQL:
//    - rankNominal: ROW_NUMBER over ABS(nominalDeviasi) DESC. The
//      SQL tie order was arbitrary (ROW_NUMBER without a full
//      ORDER BY key); JS sorts with a deterministic tiebreak
//      (outletCode, itemName) — both are valid ROW_NUMBER
//      orderings, and ties are rare (exact equal ABS sums).
//    - rankBom: ROW_NUMBER PARTITION BY (qtyBom != 0) ORDER BY
//      ABS(qtyBom) DESC → JS rank among qtyBom>0 rows; NULL when
//      the pair's qtyBom is 0 (qtyBom = SUM(ABS(qtyBom)) ≥ 0).
//    - avgDeviasiByBom: AVG over OTHER outlets' absQtyDeviasi with
//      same itemName, both qtyBom > 0, and candidate qtyBom BETWEEN
//      target*0.5 AND target*1.5 (peerBomBucketPredicate's bucket,
//      inclusive bounds); NULL when no candidates (otherCount=0) or
//      target qtyBom = 0.
//
//  Freshness: cachedSharedQuery TTL 30 min + 'q-devrank-scan' listed
//  in invalidate.ts's routes array — same contract as every q-* row.
// ============================================================
import { buildDeviasiRankBaseCte } from './shared-cte';
import { withStatementTimeout, type SqlFilterOpts } from '../../shared';
import { cachedSharedQuery } from '../../query-cache';

/** Slim national row — JSON-safe (cached). */
export interface DeviasiNationalScanRow {
  itemName: string;
  outletCode: string;
  /** Signed SUM(nominalDeviasi) per (item, outlet). */
  nominalDeviasi: number;
  /** SUM(ABS(qtyBom)) per (item, outlet) — ≥ 0. */
  qtyBom: number;
  /** ABS(SUM(qtyDeviasi)) per (item, outlet) — the bucket-average input. */
  absQtyDeviasi: number;
}

export interface DeviasiNationalScan {
  rows: DeviasiNationalScanRow[];
}

/** No-OP filter set — the national scan is deliberately unfiltered. */
const NO_FILTERS: SqlFilterOpts = {
  area: null,
  kelompok: null,
  outletCode: null,
  itemName: null,
  picOutletCodes: null,
};

const toNum = (v: number | bigint | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

async function queryDeviasiNationalScan(
  week: string,
  month: string,
): Promise<DeviasiNationalScan> {
  // Same base CTE as the national top-N query (all_item_per_outlet) —
  // filters: null keeps ALL outlets (the per-outlet variant's semantic:
  // national rank + peer benchmark need the full network).
  const baseCte = buildDeviasiRankBaseCte({
    month,
    week,
    filters: null,
    firstCteName: 'all_item_per_outlet',
    rankedCteName: 'ranked_all',
  });
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{
    itemName: string;
    outletCode: string;
    nominalDeviasi: number | bigint;
    qtyBom: number | bigint;
    absQtyDeviasi: number | bigint;
  }>>`
    WITH ${baseCte}
    SELECT
      "itemName",
      "outletCode",
      "nominalDeviasi",
      "qtyBom",
      "absQtyDeviasi"
    FROM all_item_per_outlet
  `);
  return {
    rows: rows.map((r) => ({
      itemName: r.itemName,
      outletCode: r.outletCode,
      nominalDeviasi: toNum(r.nominalDeviasi),
      qtyBom: toNum(r.qtyBom),
      absQtyDeviasi: toNum(r.absQtyDeviasi),
    })),
  };
}

/**
 * Get the shared national deviasi scan for (month, week) — cached 30 min
 * under 'q-devrank-scan'. Switching the Filter Resto outlet after the
 * first view of a period re-reads this row instead of re-running the
 * national window-function chain.
 */
export async function getDeviasiNationalScan(
  week: string,
  month: string,
): Promise<DeviasiNationalScan> {
  // awaitWrite=true (PERF-FILTER1 B write-durability): same rationale as
  // q-peer-band-scan — the ~2MB national table must LAND before the
  // response returns, or every outlet switch re-pays the multi-second scan.
  return cachedSharedQuery<DeviasiNationalScan>(
    'q-devrank-scan',
    {
      month,
      week,
      filters: NO_FILTERS,
      // v2: scan shape version — bump when the row shape changes so old
      // rows miss once (same convention as ANALYSIS_PAYLOAD_SCHEMA_VERSION).
      extra: { v: 2 },
    },
    () => queryDeviasiNationalScan(week, month),
    true,
  );
}
