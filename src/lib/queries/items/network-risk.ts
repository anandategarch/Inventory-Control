// ============================================================
//  Network Item Risk — per-item scoring across ALL outlets.
//  Surfaces SYSTEMIC issues (many outlets) vs ISOLATED (few outlets).
// ============================================================
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { buildSqlFilters, withStatementTimeout } from '../shared';

export interface NetworkItemRiskOutlet {
  outletCode: string;
  outletName: string;
  nominalDeviasi: number;
  devBom: number;
}

export interface NetworkItemRisk {
  itemName: string;
  satuan: string;
  outletCount: number;          // how many outlets have this item
  deviatingOutlets: number;     // how many have deviation > threshold
  totalAbsNominal: number;      // SUM of |nominalDeviasi| across all outlets
  avgDevBom: number;            // avg deviation ratio
  maxDevBom: number;            // max deviation ratio (worst outlet)
  systemicScore: number;        // 0-100 (higher = more systemic)
  financialImpact: number;      // 0-100 (higher = more financial impact)
  riskScore: number;            // 0-100 (weighted combination)
  riskLevel: 'TINGGI' | 'SEDANG' | 'RENDAH';
  topDeviatingOutlets: NetworkItemRiskOutlet[];
}

// Raw row shape returned by SQL (before JS risk-score computation).
// `topDeviatingOutlets` comes back as a JSON string from PostgreSQL json_agg.
interface NetworkItemRiskRawRow {
  itemName: string;
  satuan: string | null;
  outletCount: number;
  deviatingOutlets: number;
  totalAbsNominal: number;
  avgDevBom: number;
  maxDevBom: number;
  totalOutlets: number;
  topDeviatingOutlets: string | NetworkItemRiskOutlet[] | null;
}

export async function queryNetworkItemRisk(
  week: string,
  month: string,
  filters: {
    area?: string | null;
    outletCode?: string | null;
    itemName?: string | null;
    picOutletCodes?: string[] | null;
  },
  limit: number = 10,
  deviationThreshold: number = 0.05,
): Promise<NetworkItemRisk[]> {
  const f = buildSqlFilters(filters);
  // Single query strategy:
  //   CTE 1 (item_per_outlet): per (item, outlet) — sum absNominalDeviasi,
  //     compute signed + abs Dev/BOM. Filters to rows with deviation > 0
  //     so outletCount only counts outlets that actually have this item with
  //     a non-zero deviation.
  //   CTE 2 (total_outlets): count DISTINCT outlets in the (filtered) period
  //     so systemicScore has the right denominator.
  //   CTE 3 (top_outlets): per item, top 3 outlets by ABS(nominalDeviasi)
  //     via ROW_NUMBER window — collected into JSON via json_agg.
  //   Final: GROUP BY item — aggregate across outlets, LEFT JOIN top_outlets
  //     JSON. Risk scores computed in JS (Math.min/round keeps SQL portable
  //     across PostgreSQL + SQLite).
  const rows = await db.$queryRaw<NetworkItemRiskRawRow[]>`
    WITH item_per_outlet AS (
      SELECT i.id as "itemId", i.name as "itemName", MAX(ir."satuan") as "satuan",
        ir."outletId",
        -- FIX (AUDIT-CALC-SQL SIGN-2): was SUM(absNominalDeviasi) (ABS, always positive)
        — labeled as "nominalDeviasi" which should be SIGNED everywhere else.
        Now uses SUM(nominalDeviasi) for consistency. absNominalDeviasi still available
        for sorting via the separate absDevBom column.
        SUM(ir."nominalDeviasi") as "nominalDeviasi",
        -- FIX CALC-11: use SUM(ABS(qtyBom)) > 0 (consistent with other queries)
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ir."qtyDeviasi") / SUM(ABS(ir."qtyBom"))
          ELSE 0 END as "devBom",
        CASE WHEN SUM(ABS(ir."qtyBom")) > 0
          THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
          ELSE 0 END as "absDevBom"
      FROM "InventoryRecord" ir
      JOIN "Item" i ON ir."itemId" = i.id
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        AND ir."absNominalDeviasi" IS NOT NULL AND ir."absNominalDeviasi" > 0
        ${f}
      GROUP BY i.id, i.name, ir."outletId"
    ),
    item_outlet_full AS (
      SELECT ipo.*, o.code as "outletCode", o.name as "outletName"
      FROM item_per_outlet ipo
      JOIN "Outlet" o ON ipo."outletId" = o.id
    ),
    total_outlets AS (
      SELECT CAST(COUNT(DISTINCT ir."outletId") AS INTEGER) as "totalOutlets"
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        ${f}
    ),
    top_outlets AS (
      SELECT "itemId",
        json_agg(json_build_object(
          'outletCode', "outletCode",
          'outletName', "outletName",
          'nominalDeviasi', "nominalDeviasi",
          'devBom', "devBom"
        ) ORDER BY ABS("nominalDeviasi") DESC) as "topDeviatingOutlets"
      FROM (
        SELECT "itemId", "outletCode", "outletName", "nominalDeviasi", "devBom",
          ROW_NUMBER() OVER (
            PARTITION BY "itemId"
            ORDER BY ABS("nominalDeviasi") DESC
          ) as rn
        FROM item_outlet_full
      ) ranked
      WHERE rn <= 3
      GROUP BY "itemId"
    ),
    item_aggs AS (
      SELECT "itemId", "itemName", MAX("satuan") as "satuan",
        CAST(COUNT(DISTINCT "outletId") AS INTEGER) as "outletCount",
        CAST(COUNT(DISTINCT CASE WHEN "absDevBom" > ${deviationThreshold} THEN "outletId" END) AS INTEGER) as "deviatingOutlets",
        COALESCE(SUM(ABS("nominalDeviasi")), 0) as "totalAbsNominal",
        AVG("absDevBom") as "avgDevBom",
        MAX("absDevBom") as "maxDevBom"
      FROM item_outlet_full
      GROUP BY "itemId", "itemName"
    )
    SELECT ia."itemName", ia."satuan",
      ia."outletCount", ia."deviatingOutlets",
      ia."totalAbsNominal",
      COALESCE(ia."avgDevBom", 0) as "avgDevBom",
      COALESCE(ia."maxDevBom", 0) as "maxDevBom",
      COALESCE((SELECT "totalOutlets" FROM total_outlets), 0) as "totalOutlets",
      COALESCE(to2."topDeviatingOutlets", '[]'::json) as "topDeviatingOutlets"
    FROM item_aggs ia
    LEFT JOIN top_outlets to2 ON ia."itemId" = to2."itemId"
    ORDER BY ia."totalAbsNominal" DESC
  `;

  // Compute risk scores in JS — keeps SQL portable + testable.
  const FINANCIAL_IMPACT_DENOMINATOR = 100_000_000; // Rp 100jt = score 100

  const results: NetworkItemRisk[] = rows.map((r) => {
    const outletCount = Number(r.outletCount) || 0;
    const deviatingOutlets = Number(r.deviatingOutlets) || 0;
    const totalOutlets = Number(r.totalOutlets) || 0;
    const totalAbsNominal = Number(r.totalAbsNominal) || 0;
    const avgDevBom = Number(r.avgDevBom) || 0;
    const maxDevBom = Number(r.maxDevBom) || 0;

    // systemicScore: 100 if >50% of outlets deviate, else proportional.
    // Formula: min(100, deviatingOutlets / totalOutlets * 200)
    const systemicScore = totalOutlets > 0
      ? Math.min(100, (deviatingOutlets / totalOutlets) * 200)
      : 0;

    // financialImpact: 100 if totalAbsNominal >= Rp 100jt, else proportional.
    const financialImpact = Math.min(100, (totalAbsNominal / FINANCIAL_IMPACT_DENOMINATOR) * 100);

    // riskScore: weighted combination (40% systemic + 40% financial + 20% avgDevBom×100)
    const riskScore = Math.round(
      systemicScore * 0.4 + financialImpact * 0.4 + Math.min(100, avgDevBom * 100) * 0.2
    );

    // riskLevel thresholds
    const riskLevel: NetworkItemRisk['riskLevel'] =
      riskScore >= 55 ? 'TINGGI'
      : riskScore >= 30 ? 'SEDANG'
      : 'RENDAH';

    // Parse topDeviatingOutlets — PostgreSQL returns json as string, SQLite may return object.
    let parsedOutlets: NetworkItemRiskOutlet[] = [];
    if (r.topDeviatingOutlets) {
      if (typeof r.topDeviatingOutlets === 'string') {
        try {
          parsedOutlets = JSON.parse(r.topDeviatingOutlets);
        } catch {
          parsedOutlets = [];
        }
      } else if (Array.isArray(r.topDeviatingOutlets)) {
        parsedOutlets = r.topDeviatingOutlets as NetworkItemRiskOutlet[];
      }
    }
    // Coerce numeric fields (BigInt/Decimal safety)
    parsedOutlets = parsedOutlets.map((o) => ({
      outletCode: String(o.outletCode ?? ''),
      outletName: String(o.outletName ?? ''),
      nominalDeviasi: Number(o.nominalDeviasi ?? 0),
      devBom: Number(o.devBom ?? 0),
    }));

    return {
      itemName: String(r.itemName ?? ''),
      satuan: r.satuan ? String(r.satuan) : '',
      outletCount,
      deviatingOutlets,
      totalAbsNominal,
      avgDevBom,
      maxDevBom,
      systemicScore: Math.round(systemicScore),
      financialImpact: Math.round(financialImpact),
      riskScore,
      riskLevel,
      topDeviatingOutlets: parsedOutlets,
    };
  });

  // Sort by riskScore DESC (then by totalAbsNominal DESC for tie-break) and slice top N
  results.sort((a, b) =>
    b.riskScore - a.riskScore || b.totalAbsNominal - a.totalAbsNominal
  );
  return results.slice(0, limit);
}

// ============================================================
//  Global Item Search — cross-outlet view for a single item
//  --------------------------------------------------------
//  When user searches "CABAI" and selects an item, this query
//  returns that item's deviation across ALL outlets (not just
//  the selected one). Surfaces systemic patterns: which outlets
//  have the worst deviation for this specific item.
//
//  Returns per-(item, outlet) rows with:
//    - outlet code/name/area/pic
//    - signed qtyDeviasi, qtyBom, nominalDeviasi (for display)
//    - abs(qtyDeviasi) for sorting
//    - devBom ratio (signed)
//    - direction (LOSS/SURPLUS/NEUTRAL)
//
//  Note: `itemNameFilter` is the EXACT item name (already resolved
//  by the caller via /api/item-search?q=...). We filter by exact
//  match on i.name (case-insensitive via LOWER) to avoid partial
//  matches crossing items (e.g. "CABAI" matching "CABAI FROZEN"
//  AND "CABAI MERAH" — caller should pick one).
// ============================================================
