// ============================================================
//  Compliance Dashboard Query — "Kontrol & Kepatuhan" tab
//  --------------------------------------------------------
//  ONE physical scan of the period produces SIX analytical
//  lenses (tolerance compliance, tolerance-setting priority,
//  unexplained-deviation residual per outlet, sales-normalized
//  efficiency, BAHAN vs PACKAGING category split, and
//  cross-outlet loss↔surplus transfer signals, plus cross-AREA
//  mismatch pairs derived from the same transfer rows):
//
//    base        — period + filter scan, per-record expressions
//    tol_item    — GROUP BY itemId  (tolerance breach stats)
//    outlet_agg  — GROUP BY outletId (residual + sales ratio)
//    cat_agg     — GROUP BY Item.category (BAHAN/PACKAGING)
//    transfer_agg— GROUP BY itemId, area, direction
//    transfer_top— ROW_NUMBER top outlet per (item,area,direction)
//    totals      — single-row grand totals
//
//  transfer_agg feeds TWO lenses (no extra scan): within-area
//  pairing (v1 — loss outlets ↔ surplus outlets in the SAME area)
//  and cross-area mismatch pairs (v2 — item LOSS in area A while
//  SURPLUS in area B ≠ A: stock moving between areas without a
//  transfer document, or double-sided misrecording).
//
//  PERF (PAKET E — scan-merge): `base` is referenced by six CTEs,
//  so PostgreSQL materializes it ONCE (multi-reference CTEs are
//  not inlined) — one physical scan of the period, then six cheap
//  aggregate passes over the materialized set. Same philosophy as
//  PERF-DB-SCAN-1/2 (Paket B). All lenses are returned in ONE
//  round-trip via a UNION ALL of (lens, to_jsonb(row)) pairs —
//  to_jsonb also normalizes PG bigint COUNTs to JSON numbers.
//
//  Threshold parity: breach semantics replicate rule-evaluation.ts
//  (f_tol_breach / f_tol_breach_high / f_tol_not_set) — the SAME
//  RuntimeThresholds values are passed in by the route, so the
//  panel and the rule engine can never disagree.
// ============================================================
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from './shared';
import { toNum } from '@/lib/format';

/** Thresholds needed by this query (subset of RuntimeThresholds). */
export interface ComplianceThresholds {
  /** ABS(pctQtyDeviasiToBom) above this with no tolerance → "not set, high" (f_tol_not_set parity). */
  stdDevBomPct: number;
  /** Residual share above this → WARN (RESIDUAL_LOSS_WARN_PCT parity). */
  residualWarnPct: number;
  /** Residual share above this → HIGH (RESIDUAL_LOSS_HIGH_PCT parity). */
  residualHighPct: number;
}

// ------------------------------------------------------------
//  Public row types (shaped by shapeCompliance — see bottom)
// ------------------------------------------------------------
export interface ToleranceItemRow {
  itemId: number;
  itemName: string;
  satuan: string | null;
  n: number;
  nTol: number;
  nEval: number;
  nBreach: number;
  nBreachHigh: number;
  nNotSetHigh: number;
  nominalBreach: number;
  nNoTol: number;
  nominalNoTol: number;
  avgPctNoTol: number;
  maxPctNoTol: number;
  /** nBreach / nEval * 100 — null when no evaluable records. */
  breachRatePct: number | null;
}

export interface TolerancePriorityRow {
  itemId: number;
  itemName: string;
  satuan: string | null;
  nNoTol: number;
  nNotSetHigh: number;
  avgPctNoTol: number;
  maxPctNoTol: number;
  nominalNoTol: number;
}

export interface ResidualOutletRow {
  outletId: number;
  outletCode: string;
  outletName: string;
  area: string;
  n: number;
  absQtyDev: number;
  residualAbs: number;
  residualNominalAbs: number;
  absNominalDev: number;
  /** residualNominalAbs / absNominalDev * 100 — null when no nominal data. */
  unexplainedPct: number | null;
  /** Classification parity with f_resid_warn / f_resid_high. */
  level: 'HIGH' | 'WARN' | 'OK';
}

export interface SalesOutletRow {
  outletId: number;
  outletCode: string;
  outletName: string;
  area: string;
  nominalSales: number;
  absNominalDev: number;
  /** absNominalDev / nominalSales * 100. */
  devPerSalesPct: number;
}

export interface CategoryRow {
  category: string;
  n: number;
  absNominalDev: number;
  absQtyDev: number;
  residualNominalAbs: number;
  nominalWaste: number;
  nominalSusut: number;
  nominalTrial: number;
  /** Share of total absNominalDev (0-100). */
  sharePct: number;
}

export interface TransferSide {
  nOutlets: number;
  qtyTotal: number;
  nominalTotal: number;
  /** Largest contributing outlet on this side (null when side absent). */
  topOutletCode: string | null;
  topOutletQty: number;
}

export interface TransferSignalRow {
  itemId: number;
  itemName: string;
  area: string;
  loss: TransferSide;
  surplus: TransferSide;
  /** min(loss, surplus) — the amount that could "move" between sides. */
  matchQty: number;
  matchNominal: number;
}

/** Same item, same week, DIFFERENT areas: LOSS concentrated in one
 *  area while SURPLUS appears in another — cross-area mismatch pair. */
export interface CrossAreaPairRow {
  itemId: number;
  itemName: string;
  /** Area where this item shows net LOSS. */
  lossArea: string;
  /** A DIFFERENT area where the same item shows net SURPLUS. */
  surplusArea: string;
  loss: TransferSide;
  surplus: TransferSide;
  /** min(loss, surplus) across the two areas — candidate moved amount. */
  matchQty: number;
  matchNominal: number;
}

export interface ComplianceSummary {
  nRecords: number;
  nOutlets: number;
  nItems: number;
  nWithTolerance: number;
  nEval: number;
  nBreach: number;
  nBreachHigh: number;
  nNotSetHigh: number;
  nNoTolerance: number;
  breachRatePct: number;
  noTolerancePct: number;
  residualSharePct: number;
  residualNominalAbs: number;
  absNominalDev: number;
  transferSignalCount: number;
  transferMatchNominalTotal: number;
  /** Cross-area mismatch pairs (loss area ≠ surplus area). */
  crossAreaSignalCount: number;
  crossAreaMatchNominalTotal: number;
}

export interface ComplianceResult {
  summary: ComplianceSummary;
  toleranceItems: ToleranceItemRow[];
  tolerancePriority: TolerancePriorityRow[];
  residualOutlets: ResidualOutletRow[];
  salesOutlets: SalesOutletRow[];
  categories: CategoryRow[];
  transferSignals: TransferSignalRow[];
  crossAreaPairs: CrossAreaPairRow[];
}

// ------------------------------------------------------------
//  Raw SQL row — one per (lens, payload) pair
// ------------------------------------------------------------
interface RawLensRow {
  lens: string;
  payload: unknown;
}

// ------------------------------------------------------------
//  Main query — 1 scan, 6 lenses, 1 round-trip
// ------------------------------------------------------------
export async function queryComplianceDashboard(
  week: string,
  month: string,
  filters: SqlFilterOpts,
  thresholds: ComplianceThresholds,
  topN = 15,
): Promise<ComplianceResult> {
  const f = buildSqlFilters(filters);

  const rows = await withStatementTimeout((tx) => tx.$queryRaw<RawLensRow[]>`
    WITH base AS (
      SELECT
        ir."outletId", ir."itemId", ir."area",
        ir."tolerancePct", ir."pctQtyDeviasiToBom",
        ir."absQtyDeviasi", ir."absNominalDeviasi",
        ABS(COALESCE(ir."residualQty", 0))     AS "residualQtyAbs",
        ABS(COALESCE(ir."residualNominal", 0)) AS "residualNominalAbs",
        ir."nominalSales", ir."direction",
        ABS(COALESCE(ir."qtyDeviasi", 0))     AS "qtyDevAbs",
        ABS(COALESCE(ir."nominalDeviasi", 0)) AS "nominalDevAbs",
        ABS(COALESCE(ir."nominalWaste", 0))   AS "nominalWasteAbs",
        ABS(COALESCE(ir."nominalSusut", 0))   AS "nominalSusutAbs",
        ABS(COALESCE(ir."nominalTrial", 0))   AS "nominalTrialAbs"
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
        ${f}
    ),
    tol_item AS (
      SELECT b."itemId",
        COUNT(*) AS "n",
        COUNT(*) FILTER (WHERE b."tolerancePct" IS NOT NULL) AS "nTol",
        COUNT(*) FILTER (WHERE b."tolerancePct" IS NOT NULL
          AND b."pctQtyDeviasiToBom" IS NOT NULL) AS "nEval",
        -- Breach parity with rule-evaluation f_tol_breach / f_tol_breach_high
        COUNT(*) FILTER (WHERE b."tolerancePct" IS NOT NULL
          AND b."pctQtyDeviasiToBom" IS NOT NULL
          AND ABS(b."pctQtyDeviasiToBom") > ABS(b."tolerancePct")) AS "nBreach",
        COUNT(*) FILTER (WHERE b."tolerancePct" IS NOT NULL
          AND b."pctQtyDeviasiToBom" IS NOT NULL
          AND ABS(b."pctQtyDeviasiToBom") > 2 * ABS(b."tolerancePct")) AS "nBreachHigh",
        -- No tolerance but high ratio — f_tol_not_set parity
        COUNT(*) FILTER (WHERE b."tolerancePct" IS NULL
          AND b."pctQtyDeviasiToBom" IS NOT NULL
          AND ABS(b."pctQtyDeviasiToBom") > ${thresholds.stdDevBomPct}) AS "nNotSetHigh",
        COALESCE(SUM(b."nominalDevAbs") FILTER (WHERE b."tolerancePct" IS NOT NULL
          AND b."pctQtyDeviasiToBom" IS NOT NULL
          AND ABS(b."pctQtyDeviasiToBom") > ABS(b."tolerancePct")), 0) AS "nominalBreach",
        COUNT(*) FILTER (WHERE b."tolerancePct" IS NULL) AS "nNoTol",
        COALESCE(SUM(b."nominalDevAbs") FILTER (WHERE b."tolerancePct" IS NULL), 0) AS "nominalNoTol",
        COALESCE(AVG(ABS(b."pctQtyDeviasiToBom")) FILTER (WHERE b."tolerancePct" IS NULL), 0) AS "avgPctNoTol",
        COALESCE(MAX(ABS(b."pctQtyDeviasiToBom")) FILTER (WHERE b."tolerancePct" IS NULL), 0) AS "maxPctNoTol"
      FROM base b
      GROUP BY b."itemId"
    ),
    outlet_agg AS (
      SELECT b."outletId", b."area",
        COUNT(*) AS "n",
        COALESCE(SUM(b."absQtyDeviasi"), 0) AS "absQtyDev",
        COALESCE(SUM(b."residualQtyAbs"), 0) AS "residualAbs",
        COALESCE(SUM(b."residualNominalAbs"), 0) AS "residualNominalAbs",
        COALESCE(SUM(b."absNominalDeviasi"), 0) AS "absNominalDev",
        -- nominalSales is outlet-level denormalized (same value per record
        -- of the outlet within one week) — MAX is the safe single-week read.
        MAX(b."nominalSales") AS "nominalSales",
        COUNT(*) FILTER (WHERE b."residualQtyAbs" > 0) AS "nResidualPos",
        COUNT(*) FILTER (WHERE b."absQtyDeviasi" > 0) AS "nDevPos"
      FROM base b
      GROUP BY b."outletId", b."area"
    ),
    cat_agg AS (
      SELECT COALESCE(NULLIF(i."category", ''), 'TANPA KATEGORI') AS "category",
        COUNT(*) AS "n",
        COALESCE(SUM(b."absNominalDeviasi"), 0) AS "absNominalDev",
        COALESCE(SUM(b."absQtyDeviasi"), 0) AS "absQtyDev",
        COALESCE(SUM(b."residualNominalAbs"), 0) AS "residualNominalAbs",
        COALESCE(SUM(b."nominalWasteAbs"), 0) AS "nominalWaste",
        COALESCE(SUM(b."nominalSusutAbs"), 0) AS "nominalSusut",
        COALESCE(SUM(b."nominalTrialAbs"), 0) AS "nominalTrial"
      FROM base b
      JOIN "Item" i ON i."id" = b."itemId"
      GROUP BY 1
    ),
    transfer_agg AS (
      SELECT b."itemId", b."area", b."direction",
        COUNT(DISTINCT b."outletId") AS "nOutlets",
        COALESCE(SUM(b."qtyDevAbs"), 0) AS "qtyTotal",
        COALESCE(SUM(b."nominalDevAbs"), 0) AS "nominalTotal"
      FROM base b
      WHERE b."direction" IN ('LOSS', 'SURPLUS')
      GROUP BY b."itemId", b."area", b."direction"
    ),
    transfer_top AS (
      SELECT "itemId", "area", "direction", "outletId", "qtyDevAbs"
      FROM (
        SELECT b."itemId", b."area", b."direction", b."outletId", b."qtyDevAbs",
          ROW_NUMBER() OVER (PARTITION BY b."itemId", b."area", b."direction"
            ORDER BY b."qtyDevAbs" DESC, b."outletId") AS rn
        FROM base b
        WHERE b."direction" IN ('LOSS', 'SURPLUS')
      ) x
      WHERE x.rn = 1
    ),
    totals AS (
      SELECT
        COUNT(*) AS "n",
        COUNT(DISTINCT "outletId") AS "nOutlets",
        COUNT(DISTINCT "itemId") AS "nItems",
        COUNT(*) FILTER (WHERE "tolerancePct" IS NOT NULL) AS "nTol",
        COUNT(*) FILTER (WHERE "tolerancePct" IS NOT NULL
          AND "pctQtyDeviasiToBom" IS NOT NULL) AS "nEval",
        COUNT(*) FILTER (WHERE "tolerancePct" IS NOT NULL
          AND "pctQtyDeviasiToBom" IS NOT NULL
          AND ABS("pctQtyDeviasiToBom") > ABS("tolerancePct")) AS "nBreach",
        COUNT(*) FILTER (WHERE "tolerancePct" IS NOT NULL
          AND "pctQtyDeviasiToBom" IS NOT NULL
          AND ABS("pctQtyDeviasiToBom") > 2 * ABS("tolerancePct")) AS "nBreachHigh",
        COUNT(*) FILTER (WHERE "tolerancePct" IS NULL
          AND "pctQtyDeviasiToBom" IS NOT NULL
          AND ABS("pctQtyDeviasiToBom") > ${thresholds.stdDevBomPct}) AS "nNotSetHigh",
        COUNT(*) FILTER (WHERE "tolerancePct" IS NULL) AS "nNoTol",
        COALESCE(SUM("residualQtyAbs"), 0) AS "residualAbs",
        COALESCE(SUM("absQtyDeviasi"), 0) AS "absQtyDev",
        COALESCE(SUM("residualNominalAbs"), 0) AS "residualNominalAbs",
        COALESCE(SUM("absNominalDeviasi"), 0) AS "absNominalDev"
      FROM base
    )
    SELECT 'totals' AS lens, to_jsonb(t) AS payload FROM totals t
    UNION ALL
    SELECT 'tolItem' AS lens, to_jsonb(j) AS payload FROM (
      SELECT i."name" AS "itemName", i."satuan" AS "satuan", t.*
      FROM tol_item t JOIN "Item" i ON i."id" = t."itemId"
    ) j
    UNION ALL
    SELECT 'outlet' AS lens, to_jsonb(j) AS payload FROM (
      SELECT o."code" AS "outletCode", o."name" AS "outletName", t.*
      FROM outlet_agg t JOIN "Outlet" o ON o."id" = t."outletId"
    ) j
    UNION ALL
    SELECT 'category' AS lens, to_jsonb(c) AS payload FROM cat_agg c
    UNION ALL
    SELECT 'transfer' AS lens, to_jsonb(j) AS payload FROM (
      SELECT i."name" AS "itemName", t.*
      FROM transfer_agg t JOIN "Item" i ON i."id" = t."itemId"
    ) j
    UNION ALL
    SELECT 'transferTop' AS lens, to_jsonb(j) AS payload FROM (
      SELECT o."code" AS "outletCode", t.*
      FROM transfer_top t JOIN "Outlet" o ON o."id" = t."outletId"
    ) j
  `);

  return shapeCompliance(rows, topN, thresholds);
}

// ------------------------------------------------------------
//  Shaping — partition rows by lens, coerce, sort, slice
// ------------------------------------------------------------
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function num(v: unknown): number {
  return toNum(v) ?? 0;
}
function pct(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

function shapeCompliance(
  rows: RawLensRow[],
  topN: number,
  thresholds: ComplianceThresholds,
): ComplianceResult {
  const byLens = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const list = byLens.get(r.lens) ?? [];
    list.push(asRecord(r.payload));
    byLens.set(r.lens, list);
  }

  // ---- totals → summary ----
  const t = asRecord(byLens.get('totals')?.[0]);
  const nEval = num(t.nEval);
  const nRecords = num(t.n);
  const absNominalDev = num(t.absNominalDev);
  const summary: ComplianceSummary = {
    nRecords,
    nOutlets: num(t.nOutlets),
    nItems: num(t.nItems),
    nWithTolerance: num(t.nTol),
    nEval,
    nBreach: num(t.nBreach),
    nBreachHigh: num(t.nBreachHigh),
    nNotSetHigh: num(t.nNotSetHigh),
    nNoTolerance: num(t.nNoTol),
    breachRatePct: nEval > 0 ? (num(t.nBreach) / nEval) * 100 : 0,
    noTolerancePct: nRecords > 0 ? (num(t.nNoTol) / nRecords) * 100 : 0,
    residualSharePct: absNominalDev > 0 ? (num(t.residualNominalAbs) / absNominalDev) * 100 : 0,
    residualNominalAbs: num(t.residualNominalAbs),
    absNominalDev,
    transferSignalCount: 0,
    transferMatchNominalTotal: 0,
    crossAreaSignalCount: 0,
    crossAreaMatchNominalTotal: 0,
  };

  // ---- tolItem → toleranceItems + tolerancePriority ----
  const tolRaw = byLens.get('tolItem') ?? [];
  const tolItems: ToleranceItemRow[] = tolRaw.map((r) => {
    const nEvalItem = num(r.nEval);
    return {
      itemId: num(r.itemId),
      itemName: asString(r.itemName) ?? '?',
      satuan: asString(r.satuan),
      n: num(r.n),
      nTol: num(r.nTol),
      nEval: nEvalItem,
      nBreach: num(r.nBreach),
      nBreachHigh: num(r.nBreachHigh),
      nNotSetHigh: num(r.nNotSetHigh),
      nominalBreach: num(r.nominalBreach),
      nNoTol: num(r.nNoTol),
      nominalNoTol: num(r.nominalNoTol),
      avgPctNoTol: num(r.avgPctNoTol),
      maxPctNoTol: num(r.maxPctNoTol),
      breachRatePct: nEvalItem > 0 ? (num(r.nBreach) / nEvalItem) * 100 : null,
    };
  });
  const toleranceItems = [...tolItems]
    .sort((a, b) => b.nominalBreach - a.nominalBreach || b.nBreach - a.nBreach)
    .slice(0, topN);
  const tolerancePriority: TolerancePriorityRow[] = tolItems
    .filter((r) => r.nNoTol > 0 && (r.nominalNoTol > 0 || r.nNotSetHigh > 0))
    .sort((a, b) => b.nominalNoTol - a.nominalNoTol || b.nNotSetHigh - a.nNotSetHigh)
    .slice(0, 10)
    .map((r) => ({
      itemId: r.itemId,
      itemName: r.itemName,
      satuan: r.satuan,
      nNoTol: r.nNoTol,
      nNotSetHigh: r.nNotSetHigh,
      avgPctNoTol: r.avgPctNoTol,
      maxPctNoTol: r.maxPctNoTol,
      nominalNoTol: r.nominalNoTol,
    }));

  // ---- outlet → residualOutlets + salesOutlets ----
  const outletRaw = byLens.get('outlet') ?? [];
  const residualOutlets: ResidualOutletRow[] = outletRaw
    .map((r) => {
      const absNom = num(r.absNominalDev);
      const residualNom = num(r.residualNominalAbs);
      const share = absNom > 0 ? (residualNom / absNom) * 100 : null;
      return {
        outletId: num(r.outletId),
        outletCode: asString(r.outletCode) ?? '?',
        outletName: asString(r.outletName) ?? '?',
        area: asString(r.area) ?? '-',
        n: num(r.n),
        absQtyDev: num(r.absQtyDev),
        residualAbs: num(r.residualAbs),
        residualNominalAbs: residualNom,
        absNominalDev: absNom,
        unexplainedPct: share,
        level: (share !== null && share > thresholds.residualHighPct * 100
          ? 'HIGH'
          : share !== null && share > thresholds.residualWarnPct * 100
            ? 'WARN'
            : 'OK') as ResidualOutletRow['level'],
      };
    })
    .filter((r) => r.residualNominalAbs > 0 || r.residualAbs > 0)
    .sort((a, b) => b.residualNominalAbs - a.residualNominalAbs || b.residualAbs - a.residualAbs)
    .slice(0, topN);

  const salesOutlets: SalesOutletRow[] = outletRaw
    .map((r) => {
      const sales = num(r.nominalSales);
      const absNom = num(r.absNominalDev);
      return {
        outletId: num(r.outletId),
        outletCode: asString(r.outletCode) ?? '?',
        outletName: asString(r.outletName) ?? '?',
        area: asString(r.area) ?? '-',
        nominalSales: sales,
        absNominalDev: absNom,
        devPerSalesPct: sales > 0 ? (absNom / sales) * 100 : 0,
      };
    })
    .filter((r) => r.nominalSales > 0 && r.absNominalDev > 0)
    .sort((a, b) => b.devPerSalesPct - a.devPerSalesPct)
    .slice(0, topN);

  // ---- category ----
  const catTotal = (byLens.get('category') ?? []).reduce(
    (acc, r) => acc + num(r.absNominalDev), 0);
  const categories: CategoryRow[] = (byLens.get('category') ?? [])
    .map((r) => ({
      category: asString(r.category) ?? 'TANPA KATEGORI',
      n: num(r.n),
      absNominalDev: num(r.absNominalDev),
      absQtyDev: num(r.absQtyDev),
      residualNominalAbs: num(r.residualNominalAbs),
      nominalWaste: num(r.nominalWaste),
      nominalSusut: num(r.nominalSusut),
      nominalTrial: num(r.nominalTrial),
      sharePct: pct(num(r.absNominalDev), catTotal),
    }))
    .sort((a, b) => b.absNominalDev - a.absNominalDev);

  // ---- transfer → transferSignals + crossAreaPairs ----
  const key2 = (itemId: number, area: string) => `${itemId}\u0000${area}`;
  const lossMap = new Map<string, Record<string, unknown>>();
  const surplusMap = new Map<string, Record<string, unknown>>();
  // Per-item side lists (same rows as the maps above) — used by the
  // cross-area pairing below. O(items × areas²), areas is small.
  interface SideEntry { itemId: number; itemName: string; area: string; row: Record<string, unknown> }
  const lossByItem = new Map<number, SideEntry[]>();
  const surplusByItem = new Map<number, SideEntry[]>();
  const pushSide = (m: Map<number, SideEntry[]>, e: SideEntry) => {
    const list = m.get(e.itemId) ?? [];
    list.push(e);
    m.set(e.itemId, list);
  };
  for (const r of byLens.get('transfer') ?? []) {
    const direction = asString(r.direction);
    const itemId = num(r.itemId);
    const area = asString(r.area) ?? '-';
    const key = key2(itemId, area);
    if (direction === 'LOSS') {
      lossMap.set(key, r);
      pushSide(lossByItem, { itemId, itemName: asString(r.itemName) ?? '?', area, row: r });
    } else if (direction === 'SURPLUS') {
      surplusMap.set(key, r);
      pushSide(surplusByItem, { itemId, itemName: asString(r.itemName) ?? '?', area, row: r });
    }
  }
  const topMap = new Map<string, { outletCode: string; qtyDevAbs: number }>();
  for (const r of byLens.get('transferTop') ?? []) {
    topMap.set(
      `${key2(num(r.itemId), asString(r.area) ?? '-')}\u0000${asString(r.direction) ?? ''}`,
      { outletCode: asString(r.outletCode) ?? '?', qtyDevAbs: num(r.qtyDevAbs) },
    );
  }
  const sideOf = (
    r: Record<string, unknown> | undefined,
    direction: 'LOSS' | 'SURPLUS',
    itemId: number,
    area: string,
  ): TransferSide => {
    if (!r) {
      return { nOutlets: 0, qtyTotal: 0, nominalTotal: 0, topOutletCode: null, topOutletQty: 0 };
    }
    const top = topMap.get(`${key2(itemId, area)}\u0000${direction}`);
    return {
      nOutlets: num(r.nOutlets),
      qtyTotal: num(r.qtyTotal),
      nominalTotal: num(r.nominalTotal),
      topOutletCode: top?.outletCode ?? null,
      topOutletQty: top?.qtyDevAbs ?? 0,
    };
  };

  const allSignals: TransferSignalRow[] = [];
  for (const [key, lossRow] of lossMap) {
    const surplusRow = surplusMap.get(key);
    if (!surplusRow) continue;
    const itemId = num(lossRow.itemId);
    const area = asString(lossRow.area) ?? '-';
    const loss = sideOf(lossRow, 'LOSS', itemId, area);
    const surplus = sideOf(surplusRow, 'SURPLUS', itemId, area);
    const matchQty = Math.min(loss.qtyTotal, surplus.qtyTotal);
    const matchNominal = Math.min(loss.nominalTotal, surplus.nominalTotal);
    if (matchQty <= 0 && matchNominal <= 0) continue;
    allSignals.push({
      itemId,
      itemName: asString(lossRow.itemName) ?? asString(surplusRow.itemName) ?? '?',
      area,
      loss,
      surplus,
      matchQty,
      matchNominal,
    });
  }
  allSignals.sort((a, b) => b.matchNominal - a.matchNominal || b.matchQty - a.matchQty);
  summary.transferSignalCount = allSignals.length;
  summary.transferMatchNominalTotal = allSignals.reduce((acc, s) => acc + s.matchNominal, 0);
  const transferSignals = allSignals.slice(0, topN);

  // ---- transfer (cross-area) → crossAreaPairs ----
  // Each item's LOSS areas are paired with every SURPLUS area that is
  // DIFFERENT. Pairs are investigative candidates, NOT a partition —
  // one side can appear in several pairs (documented in the FE tooltip).
  const crossPairs: CrossAreaPairRow[] = [];
  for (const [itemId, losses] of lossByItem) {
    const surpluses = surplusByItem.get(itemId);
    if (!surpluses) continue;
    for (const l of losses) {
      for (const s of surpluses) {
        if (l.area === s.area) continue; // cross-area only — v1 covers same-area
        const loss = sideOf(l.row, 'LOSS', itemId, l.area);
        const surplus = sideOf(s.row, 'SURPLUS', itemId, s.area);
        const matchQty = Math.min(loss.qtyTotal, surplus.qtyTotal);
        const matchNominal = Math.min(loss.nominalTotal, surplus.nominalTotal);
        if (matchQty <= 0 && matchNominal <= 0) continue;
        crossPairs.push({
          itemId,
          itemName: l.itemName,
          lossArea: l.area,
          surplusArea: s.area,
          loss,
          surplus,
          matchQty,
          matchNominal,
        });
      }
    }
  }
  crossPairs.sort((a, b) =>
    b.matchNominal - a.matchNominal || b.matchQty - a.matchQty
    || a.itemId - b.itemId
    || a.lossArea.localeCompare(b.lossArea)
    || a.surplusArea.localeCompare(b.surplusArea));
  summary.crossAreaSignalCount = crossPairs.length;
  summary.crossAreaMatchNominalTotal = crossPairs.reduce((acc, p) => acc + p.matchNominal, 0);
  const crossAreaPairs = crossPairs.slice(0, topN);

  return {
    summary,
    toleranceItems,
    tolerancePriority,
    residualOutlets,
    salesOutlets,
    categories,
    transferSignals,
    crossAreaPairs,
  };
}
