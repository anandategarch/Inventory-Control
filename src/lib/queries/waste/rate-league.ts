// ============================================================
//  Waste Rate League — queryWasteRateLeague (W1, DEEPWASTE2-B §2)
//  --------------------------------------------------------
//  "Liga Waste-Rate" — per-item outlet league ranked by the
//  NORMALIZED waste rate Σ|qtyWaste| / Σ|qtyBom| over the
//  multi-month SAME-week window (most recent 12 months, incl.
//  running month) for the scoped filter set.
//
//  Business question (findings-DEEPWASTE2-B W1): "Bahan mana
//  yang waste-nya paling boros RELATIF terhadap pemakaiannya —
//  dan outlet mana paling boros pada bahan yang SAMA? (bukan
//  sekadar nominal terbesar)". The rate is UNITLESS (qty/qty of
//  the same item): BOM is the theoretical-usage proxy, so the
//  item is its own control — a within-item league needs NO
//  menu-category proxy. Outlets are ranked PER ITEM (item =
//  kontrol sendiri), which sidesteps the cross-item satuan
//  problem entirely (cross-ITEM comparisons stay out of scope;
//  the item list itself is the top-N Pareto door-in).
//
//  Methodology (every decision pinned by test):
//    rate(item, outlet) = Σ|qtyWaste| / Σ|qtyBom|  — null when
//      Σ|qtyBom| = 0 (no usage basis: waste without recorded
//      theoretical usage cannot be normalized; the outlet is
//      counted as `orphanWasteOutlets`, never ranked).
//    League population  = outlets with BOM > 0 for the item.
//    median + MAD       = computed over the FULL population
//      (INCLUDING zero-waste outlets, whose honest rate is 0 —
//      task spec: "median + MAD over outlets with BOM>0").
//      Excluding them would flatter the median and overstate
//      every wasting outlet's z.
//    robust-z           = (rate − median) / (1.4826 × MAD).
//      The 1.4826 consistency constant rescales MAD to a
//      normal-consistent σ estimate (Φ⁻¹(0.75) ≈ 1.4826), so z
//      reads like a familiar z-score while keeping the median/MAD
//      robustness ANALYTICS-A asked for (mean/σ are dragged by
//      outlier outlets). MAD = 0 (degenerate: more than half the
//      population sits exactly on the median — heavy
//      zero-inflation makes this common) → z = null for the WHOLE
//      item: reporting z = 0 would fabricate "exactly typical".
//    League rows        = population outlets with waste > 0,
//      ranked rate DESC (tie-break outletCode ASC). Zero-waste
//      outlets are NOT forced into the league as 0-rate rows
//      (findings-B: "tidak dipaksa 0 ke liga") — with 344
//      outlets they would drown the table AND they are already
//      inside the median/MAD population. They are reported
//      SEPARATELY as zeroWasteOutlets / zeroWasteShare per item
//      (zero-inflation honesty).
//    Guards             = min WASTE_RATE_LEAGUE_MIN_OUTLETS (5)
//      outlets with BOM>0 per item, else the league is omitted
//      and the item is listed with leagueOmittedReason (league
//      below 5 outlets is arithmetic, not evidence — mirrors the
//      W3 HHI <10-outlet guard rationale).
//
//  SCOPE DECISION (documented, defers PEER-AREA): the league
//  scope follows the USER'S ACTIVE FILTERS (month/week/area/
//  kelompok/pic) — national by default, area-scoped when an area
//  filter is active. findings-B W1 lists "PEER-AREA scope
//  decision" (national/pulau/provinsi median) as a pending
//  dependency; following the filter defers that decision
//  transparently (the median population is whatever the user
//  scoped, same contract as waste-series/waste-top-items) and a
//  later PEER-AREA verdict only changes the call-site, not this
//  module.
//
//  SQL shape — 3 round trips in the waste-top-items style, with
//  the months CTE derived ONCE up front (BUGHUNT-R1 FIX 9):
//    0. month derivation (cheapest) — window monthKeys;
//    1. per-item aggregate (totalWaste for the Pareto door-in +
//       wasteQty + bomQty) with the top-N LIMIT, optionally
//       pinned to ONE item by exact name (the `item` param — applied
//       in the OUTER wrapper AFTER the population window, so
//       populationTotal stays the full-network Pareto 100% in
//       item-pin mode too — FIX AUDIT-D F2);
//    2. per-(item, outlet) breakdown for the selected item ids —
//       Σ|qtyWaste| + Σ|qtyBom| + Outlet join (code/name/AREA from
//       the Outlet MASTER — FIX AUDIT-D F1; see the round-2 block
//       comment for why the record-level area label must never
//       re-enter this grain), grouped so one physical outlet =
//       exactly ONE population row per item.
//  Rounds 1-2 filter on the materialized IN list — identical
//  month set to a per-round CTE without rebuilding it. All
//  ranking/median/MAD/z math lives in the PURE builder
//  (testable — same compute/classify split as waste-series /
//  waste-top-items).
//
//  Module layout NOTE: this is deliberately a SINGLE new file
//  (not a folder) — W1 owns it end-to-end; constants live HERE,
//  not in ./shared.ts, because shared.ts is owned by sibling
//  waste agents (same footprint-conflict discipline W2-EXEC used
//  for persistence.ts constants).
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../shared';

// ------------------------------------------------------------
// Constants (module knobs, documented — house style: constants
// are hardcoded module thresholds, NOT runtime Settings; see
// findings-DEEPWASTE2-A §1a E4)
// ------------------------------------------------------------

/**
 * Max months in the league window (incl. running month) — mirrors
 * WASTE_WINDOW_MONTHS / WASTE_TOP_ITEMS_WINDOW_MONTHS. Local
 * (not imported from ./shared.ts) so this module owns its whole
 * footprint; the value is pinned by test to stay in sync.
 */
export const WASTE_RATE_LEAGUE_WINDOW_MONTHS = 12;

/** Default + max top-N items returned (house limit convention). */
export const WASTE_RATE_LEAGUE_DEFAULT_LIMIT = 20;
export const WASTE_RATE_LEAGUE_MAX_LIMIT = 50;

/**
 * Guard: minimum outlets with BOM > 0 per item before a league
 * is reported. Below this the median/MAD/z arithmetic is noise —
 * with 2 outlets the "league" is a coin flip (mirrors the W3
 * WASTE_QUADRANT_HHI_MIN_OUTLETS rationale).
 */
export const WASTE_RATE_LEAGUE_MIN_OUTLETS = 5;

/**
 * MAD → σ consistency constant: Φ⁻¹(0.75) ≈ 1.4826. Scaling MAD
 * by this makes the robust-z comparable to a classical z under
 * normality (the textbook robust standard-error convention),
 * while the median/MAD core keeps it outlier-resistant.
 */
export const WASTE_RATE_LEAGUE_MAD_SCALE = 1.4826;

// ------------------------------------------------------------
// Types — SQL round-trip shapes (module-private pre-builder,
// exported for the sibling test file like waste-top-items/types.ts)
// ------------------------------------------------------------

/** Round 1 — per-item aggregate row (top-N selection + context). */
export interface WasteRateItemRawRow {
  itemId: number;
  itemName: string;
  satuan: string | null;
  /** Σ|nominalWaste| over the window — the Pareto door-in ranking key. */
  totalWaste: number | bigint;
  /** Σ|qtyWaste| over the window (item total, satuan-aware). */
  wasteQty: number | bigint;
  /** Σ|qtyBom| over the window — theoretical usage (the rate denominator). */
  bomQty: number | bigint;
  /** Σ|totalWaste| over ALL items in scope via SUM() OVER () — the 100% of the Pareto. */
  populationTotal: number | bigint;
}

/** Round 2 — per-(item, outlet) aggregate row (the league grain). */
export interface WasteRateOutletRawRow {
  itemId: number;
  outletCode: string;
  outletName: string;
  /**
   * Area from the Outlet MASTER (stable per outlet — FIX AUDIT-D
   * F1). The denormalized per-record InventoryRecord.area label must
   * never re-enter the league grain: it splits outlets that moved
   * area mid-window into two population rows.
   */
  area: string;
  /** Σ|qtyWaste| over the window for this (item, outlet). */
  wasteQty: number | bigint;
  /** Σ|qtyBom| over the window for this (item, outlet). */
  bomQty: number | bigint;
}

/** One ranked league row: an outlet with waste > 0 AND BOM > 0. */
export interface WasteRateLeagueRow {
  /** 1 = highest rate (ranked DESC over league rows only). */
  rank: number;
  outletCode: string;
  outletName: string;
  area: string;
  /** Σ|qtyWaste| window (display context — the numerator). */
  wasteQty: number;
  /** Σ|qtyBom| window (display context — the denominator). */
  bomQty: number;
  /** Σ|qtyWaste| / Σ|qtyBom| — unitless share of theoretical usage wasted. */
  rate: number;
  /** (rate − median) / (1.4826·MAD) — null when MAD = 0 (documented guard). */
  robustZ: number | null;
}

/**
 * Why a league is absent for an item (guard disclosure — the item
 * stays listed so the omission is visible, never silent):
 *   - 'MIN_OUTLETS'   — population (BOM>0 outlets) < 5;
 *   - 'NO_BOM_BASIS'  — no outlet in scope recorded BOM for the
 *                       item at all (orphaned waste only).
 */
export type WasteRateLeagueOmittedReason = 'MIN_OUTLETS' | 'NO_BOM_BASIS';

/** Per-item league block. */
export interface WasteRateLeagueItem {
  itemId: number;
  itemName: string;
  satuan: string | null;
  /** Σ|nominalWaste| window — Pareto context (door-in ranking key). */
  totalWaste: number;
  /** Σ|qtyWaste| window — item total (satuan units). */
  wasteQty: number;
  /** Σ|qtyBom| window — item total theoretical usage. */
  bomQty: number;
  /** League population: #outlets in scope with BOM > 0 for the item. */
  outletsWithBom: number;
  /**
   * Ranked league (waste > 0 outlets only), rate DESC — null when
   * the min-outlet guard fires (see leagueOmittedReason).
   */
  league: WasteRateLeagueRow[] | null;
  /** Guard reason when league is null (null when the league exists). */
  leagueOmittedReason: WasteRateLeagueOmittedReason | null;
  /**
   * #population outlets with waste = 0 — zero-inflation honesty:
   * they sit at rate 0 INSIDE the median/MAD population but are
   * NOT displayed as league rows (see module header).
   */
  zeroWasteOutlets: number;
  /** zeroWasteOutlets / outletsWithBom (null when the population is empty). */
  zeroWasteShare: number | null;
  /**
   * #outlets with waste > 0 but BOM = 0 (orphaned waste — no
   * usage basis, rate null, never ranked; disclosed count only).
   */
  orphanWasteOutlets: number;
  /** Median rate over the BOM>0 population (null when empty). */
  medianRate: number | null;
  /** Raw MAD over the BOM>0 population (NOT ×1.4826 — null when empty). */
  madRate: number | null;
}

/**
 * Output metadata: the satuan + BOM-basis + guard disclosure the
 * spec requires to ride on the response (the UI renders it as the
 * card's methodology footnote instead of hardcoding it).
 */
export interface WasteRateLeagueMeta {
  /** Actual window size the leagues ran on (≤ the 12-month cap). */
  windowMonths: number;
  /** Mirror of WASTE_RATE_LEAGUE_MIN_OUTLETS (the guard). */
  minOutlets: number;
  /** Mirror of WASTE_RATE_LEAGUE_MAD_SCALE (the consistency constant). */
  madScale: number;
  /** Machine-readable rate definition (displayed verbatim by the card). */
  rateDefinition: string;
  /** BOM-basis caveat: BOM = theoretical usage proxy, same-week window. */
  bomBasis: string;
  /** Zero-waste reporting policy (displayed verbatim by the card). */
  zeroWastePolicy: string;
  /** Epistemic label (house convention: the league is a PATTERN, INDIKASI). */
  epistemicLabel: 'INDIKASI';
}

export interface WasteRateLeagueResult {
  items: WasteRateLeagueItem[];
  /** Σ|nominalWaste| across ALL items in scope (the Pareto's 100%). */
  populationTotal: number;
  /** Latest monthKey of the window (filled by the query edge). */
  lastMonthKey: string | null;
  /** ACTUAL months in the window (≤ cap — mirrors FIX 2 disclosure). */
  windowMonths: number;
  /** Disclosure block (guards + basis + epistemics). */
  meta: WasteRateLeagueMeta;
}

// ------------------------------------------------------------
// Pure helpers (exported for vitest)
// ------------------------------------------------------------

const toNum = (v: number | bigint | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Median of a numeric array (mean of the middle pair when n is even). Null on empty input. */
export function medianOf(values: number[]): number | null {
  const n = values.length;
  if (n === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/**
 * MAD = median of |x − median| over the SAME population.
 * Null on empty input. NOT scaled by 1.4826 (the scale is applied
 * once, inside robustZ — one place, one constant).
 */
export function madOf(values: number[], medianValue: number): number | null {
  if (values.length === 0) return null;
  return medianOf(values.map((x) => Math.abs(x - medianValue)));
}

/**
 * Robust z = (rate − median) / (madScale · MAD).
 * Null when MAD ≤ 0: a degenerate scale (more than half the
 * population exactly on the median — heavy zero-inflation makes
 * this common) leaves z undefined; reporting 0 would fabricate
 * "exactly typical". Documented rule, pinned by test.
 */
export function robustZ(rate: number, medianValue: number, madValue: number): number | null {
  if (!(madValue > 0)) return null;
  return (rate - medianValue) / (WASTE_RATE_LEAGUE_MAD_SCALE * madValue);
}

/**
 * Clamp the top-N limit to 1..MAX (house pattern — same rule the
 * waste-top-items query applies inline; extracted as a PURE
 * function so the clamp itself is unit-testable without a DB,
 * and so the route clamps BEFORE the cache key). Non-finite input
 * (NaN/±Infinity) falls back to the DEFAULT — the route's
 * bogus-value semantics baked into the pure function so direct
 * callers cannot smuggle a NaN limit into SQL.
 */
export function clampRateLeagueLimit(limit: number): number {
  if (!Number.isFinite(limit)) return WASTE_RATE_LEAGUE_DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit)), WASTE_RATE_LEAGUE_MAX_LIMIT);
}

// ------------------------------------------------------------
// Pure builder (exported for vitest)
// ------------------------------------------------------------

/**
 * Merge the per-item rows + per-(item, outlet) rows into the
 * per-item leagues: rate per outlet, rank by rate DESC, median +
 * MAD over the BOM>0 population, robust-z, zero-waste share,
 * min-outlet guard. Pure — no DB, no mutation of inputs.
 *
 * Partition per (item, outlet) row:
 *   bomQty > 0             → population (rate defined; waste > 0
 *                             → league row, else zero-waste —
 *                             still inside the population at
 *                             rate 0, feeding the median/MAD);
 *   bomQty = 0, waste > 0  → orphaned waste (count only);
 *   bomQty = 0, waste = 0  → nothing to say on either axis
 *                             (neither counted nor ranked).
 */
export function buildRateLeague(
  itemRows: WasteRateItemRawRow[],
  outletRows: WasteRateOutletRawRow[],
  windowMonths: number = WASTE_RATE_LEAGUE_WINDOW_MONTHS,
): WasteRateLeagueResult {
  const meta: WasteRateLeagueMeta = {
    windowMonths,
    minOutlets: WASTE_RATE_LEAGUE_MIN_OUTLETS,
    madScale: WASTE_RATE_LEAGUE_MAD_SCALE,
    rateDefinition:
      'rate = Σ|qtyWaste| / Σ|qtyBom| per (item, outlet) pada window same-week — unitless (pemakaian teoretis terbuang)',
    bomBasis:
      'Basis BOM = pemakaian teoretis (proxy resep) pada minggu yang sama — bukan pemakaian aktual (POS)',
    zeroWastePolicy:
      'Outlet tanpa waste tercatat TIDAK dipaksa masuk liga sebagai 0% — dilaporkan terpisah sebagai share; mereka tetap masuk populasi median/MAD dengan rate 0',
    epistemicLabel: 'INDIKASI',
  };

  if (itemRows.length === 0) {
    return {
      items: [],
      populationTotal: 0,
      // Filled by the caller (queryWasteRateLeague) from the month
      // round — the raw rows don't carry it (single source: FIX 9).
      lastMonthKey: null,
      windowMonths,
      meta,
    };
  }
  const populationTotal = toNum(itemRows[0].populationTotal);

  // Group the league grain by item ONCE.
  //
  // FIX (AUDIT-D F1 — defensive belt): raw rows sharing
  // (itemId, outletCode) are MERGED — wasteQty + bomQty summed,
  // name/area labels taken from the FIRST occurrence (they are
  // Outlet-master fields, constant per outletCode, so any
  // occurrence is correct). The fixed round-2 SQL can no longer
  // produce such duplicates (one row per (item, outlet)), but this
  // keeps the median/MAD/min-outlet-guard population honest even
  // if a future SQL regression re-introduces a record-level area
  // split or another caller hands in unmerged rows: one physical
  // outlet = ONE population slot, always (pinned by test).
  const byItemOutlets = new Map<number, Map<string, WasteRateOutletRawRow>>();
  for (const r of outletRows) {
    let byOutlet = byItemOutlets.get(r.itemId);
    if (!byOutlet) {
      byOutlet = new Map<string, WasteRateOutletRawRow>();
      byItemOutlets.set(r.itemId, byOutlet);
    }
    const prev = byOutlet.get(r.outletCode);
    if (!prev) {
      byOutlet.set(r.outletCode, { ...r });
    } else {
      byOutlet.set(r.outletCode, {
        ...prev,
        wasteQty: toNum(prev.wasteQty) + toNum(r.wasteQty),
        bomQty: toNum(prev.bomQty) + toNum(r.bomQty),
      });
    }
  }

  const items: WasteRateLeagueItem[] = itemRows.map((r) => {
    const wasteQty = toNum(r.wasteQty);
    const bomQty = toNum(r.bomQty);
    const rows = [...(byItemOutlets.get(r.itemId)?.values() ?? [])];

    // Partition the (item, outlet) grain.
    const population: Array<{ row: WasteRateOutletRawRow; rate: number; wasting: boolean }> = [];
    let zeroWasteOutlets = 0;
    let orphanWasteOutlets = 0;
    for (const row of rows) {
      const w = toNum(row.wasteQty);
      const b = toNum(row.bomQty);
      if (b > 0) {
        // Usage basis exists → population. Zero-waste outlets ride
        // at rate 0 INSIDE the population — they feed the median/MAD
        // (task spec: "median + MAD over outlets with BOM>0"; a
        // zero-wasting outlet is a real observation of the item's
        // rate distribution) but are never RANKED (league rows =
        // wasting outlets only — zero-inflation honesty, see module
        // header).
        population.push({ row, rate: w > 0 ? w / b : 0, wasting: w > 0 });
        if (w === 0) zeroWasteOutlets += 1;
      } else if (w > 0) {
        // Orphaned waste: no BOM basis → rate null, never ranked.
        orphanWasteOutlets += 1;
      }
      // b = 0 ∧ w = 0 → neither used nor wasted: not counted.
    }

    const outletsWithBom = population.length;
    const rates = population.map((p) => p.rate);
    const medianRate = medianOf(rates);
    const madValue = medianRate != null ? madOf(rates, medianRate) : null;

    // Min-outlet guard — the item stays listed with the reason.
    if (outletsWithBom === 0) {
      return {
        itemId: r.itemId,
        itemName: r.itemName,
        satuan: r.satuan,
        totalWaste: toNum(r.totalWaste),
        wasteQty,
        bomQty,
        outletsWithBom: 0,
        league: null,
        leagueOmittedReason: 'NO_BOM_BASIS',
        zeroWasteOutlets: 0,
        zeroWasteShare: null,
        orphanWasteOutlets,
        medianRate: null,
        madRate: null,
      };
    }
    if (outletsWithBom < WASTE_RATE_LEAGUE_MIN_OUTLETS) {
      return {
        itemId: r.itemId,
        itemName: r.itemName,
        satuan: r.satuan,
        totalWaste: toNum(r.totalWaste),
        wasteQty,
        bomQty,
        outletsWithBom,
        league: null,
        leagueOmittedReason: 'MIN_OUTLETS',
        zeroWasteOutlets,
        zeroWasteShare: zeroWasteOutlets / outletsWithBom,
        orphanWasteOutlets,
        medianRate,
        madRate: madValue,
      };
    }

    // League rows: wasting outlets only (zero-waste outlets are
    // reported separately), rate DESC, outletCode ASC
    // (deterministic tie-break — same convention as the Pareto
    // breakdown sort).
    const league: WasteRateLeagueRow[] = population
      .filter((p) => p.wasting)
      .sort((a, b) => b.rate - a.rate || a.row.outletCode.localeCompare(b.row.outletCode))
      .map((p, i) => ({
        rank: i + 1,
        outletCode: p.row.outletCode,
        outletName: p.row.outletName,
        area: p.row.area,
        wasteQty: toNum(p.row.wasteQty),
        bomQty: toNum(p.row.bomQty),
        rate: p.rate,
        // MAD = 0 (or null) → z null for the whole item (documented guard).
        robustZ:
          medianRate != null && madValue != null
            ? robustZ(p.rate, medianRate, madValue)
            : null,
      }));

    return {
      itemId: r.itemId,
      itemName: r.itemName,
      satuan: r.satuan,
      totalWaste: toNum(r.totalWaste),
      wasteQty,
      bomQty,
      outletsWithBom,
      league,
      leagueOmittedReason: null,
      zeroWasteOutlets,
      zeroWasteShare: zeroWasteOutlets / outletsWithBom,
      orphanWasteOutlets,
      medianRate,
      madRate: madValue,
    };
  });

  return { items, populationTotal, lastMonthKey: null, windowMonths, meta };
}

// ------------------------------------------------------------
// queryWasteRateLeague
// ------------------------------------------------------------

/**
 * Top-N Pareto items (by Σ|nominalWaste| window) with each item's
 * per-outlet waste-rate league; or — when `item` (exact item
 * name) is given — that ONE item's full league regardless of its
 * Pareto rank. Scope follows the active filters (see module
 * header's PEER-AREA note).
 */
export async function queryWasteRateLeague(
  week: string,
  currentMonthKey: string | null,
  filters: SqlFilterOpts,
  limit: number = WASTE_RATE_LEAGUE_DEFAULT_LIMIT,
  item: string | null = null,
): Promise<WasteRateLeagueResult> {
  const f = buildSqlFilters(filters);
  const boundedLimit = clampRateLeagueLimit(limit);
  const monthBound = currentMonthKey
    ? Prisma.sql`AND sf."monthKey" <= ${currentMonthKey}`
    : Prisma.empty;

  // Round trip 0 — month derivation FIRST (BUGHUNT-R1 FIX 9):
  // identical to the waste-top-items round 0 (cheapest query
  // yields the window monthKeys once; rounds 1-2 filter on the
  // materialized IN list instead of rebuilding a months CTE).
  const monthRows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ monthKey: string }>>`
    SELECT sf."monthKey"
    FROM "InventoryRecord" ir
    JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
    WHERE ir."weekLabel" = ${week}
      ${monthBound}
      ${f}
    GROUP BY sf."monthKey"
    ORDER BY sf."monthKey" DESC
    LIMIT ${WASTE_RATE_LEAGUE_WINDOW_MONTHS}
  `);
  const monthKeys = monthRows.map((r) => r.monthKey);
  const windowMonths = monthKeys.length;
  if (monthKeys.length === 0) {
    // Empty scope — empty result carrying the meta block (guards
    // stay disclosed even on the empty path).
    const { meta } = buildRateLeague([], [], 0);
    return { items: [], populationTotal: 0, lastMonthKey: null, windowMonths: 0, meta };
  }
  // Prisma.join requires ≥ 1 element — guaranteed by the early return above.
  const monthInList = Prisma.join(monthKeys);
  const lastMonthKey = monthKeys[0] ?? null;

  // Round trip 1 — per-item aggregates: the Pareto door-in
  // (ORDER BY totalWaste DESC) + the rate context columns. The
  // optional `item` param pins the slice to ONE item by EXACT
  // name (case-sensitive; the card passes names straight from
  // this response, and an exact match keeps the cache key 1:1
  // with the response — no LIKE wildcards on the wire).
  //
  // FIX (AUDIT-D F2): the pin used to be applied BEFORE the
  // population window (`WHERE i.name = ...` under
  // `SUM(ia."totalWaste") OVER ()`), so in `?item=` mode
  // populationTotal degenerated to the pinned item's OWN
  // totalWaste — the documented "Pareto 100%" field lied
  // (share-of-network read 100% for every single-item response).
  // Restructured: the window is computed inside the `populated`
  // CTE over ALL in-scope items (pre-filter, pre-LIMIT), and the
  // pin moves to the OUTER wrapper, referencing the OUTPUT alias
  // `"itemName"`. Default mode (no item) is semantically
  // unchanged: window over all rows, then ORDER BY + LIMIT.
  // `runItemRound` is reused by the no-match branch below so the
  // population total always comes from the SAME SQL (single
  // source of truth).
  const itemFilter = item ? Prisma.sql`WHERE "itemName" = ${item}` : Prisma.empty;
  const runItemRound = (filter: Prisma.Sql, limit: number) =>
    withStatementTimeout((tx) => tx.$queryRaw<WasteRateItemRawRow[]>`
      WITH item_agg AS (
        SELECT
          ir."itemId",
          COALESCE(SUM(ABS(ir."nominalWaste")), 0) as "totalWaste",
          COALESCE(SUM(ABS(ir."qtyWaste")), 0) as "wasteQty",
          COALESCE(SUM(ABS(ir."qtyBom")), 0) as "bomQty"
        FROM "InventoryRecord" ir
        JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
        WHERE ir."weekLabel" = ${week}
          AND sf."monthKey" IN (${monthInList})
          ${f}
        GROUP BY ir."itemId"
      ),
      populated AS (
        SELECT
          ia."itemId",
          i.name as "itemName",
          i.satuan,
          ia."totalWaste",
          ia."wasteQty",
          ia."bomQty",
          SUM(ia."totalWaste") OVER () as "populationTotal"
        FROM item_agg ia
        JOIN "Item" i ON ia."itemId" = i.id
      )
      SELECT * FROM populated
      ${filter}
      ORDER BY "totalWaste" DESC, "itemName" ASC
      LIMIT ${limit}
    `);
  const itemRows = await runItemRound(itemFilter, boundedLimit);

  if (itemRows.length === 0) {
    // Default mode: the population itself is empty — populationTotal
    // 0 is the honest value.
    //
    // FIX (AUDIT-D F2) — item-pin mode: an empty round 1 means "item
    // name not found in scope", NOT "empty population". The window
    // total of the FULL population is still the honest Pareto 100%,
    // so read it from the population's first row (same round-1 SQL,
    // no item filter, LIMIT 1 — `SUM() OVER ()` yields the SAME value
    // on every populated row) and keep the no-match response shaped
    // exactly like the match case instead of collapsing the network
    // total to 0. When the population itself is empty the fallback
    // row is absent and populationTotal stays 0 (consistent with the
    // pre-fix behavior for that sub-case).
    let populationTotal = 0;
    if (item != null) {
      const popRows = await runItemRound(Prisma.empty, 1);
      populationTotal = toNum(popRows[0]?.populationTotal);
    }
    const { meta } = buildRateLeague([], [], windowMonths);
    return { items: [], populationTotal, lastMonthKey, windowMonths, meta };
  }

  // Round trip 2 — per-(item, outlet) breakdown for the selected
  // item ids (Prisma.join IN list — same pattern as waste-top-items
  // round 2, with the outlet JOIN for code/name/area and the BOM
  // column added). NO cap: the league needs the FULL outlet tail
  // (the median/MAD population + zero-waste counts — capping at a
  // top-N slice would bias the median upward, exactly the bias
  // this feature exists to remove).
  //
  // FIX (AUDIT-D F1 — CRITICAL): the grain used to be
  //   GROUP BY ir."itemId", o.code, o.name, ir.area
  // with ir.area — the DENORMALIZED per-record area label — as a
  // group key. InventoryRecord.area carries whatever label the
  // record had at ingest, so an outlet that moved area mid-window
  // (re-org JAWA TENGAH 1↔2, MLGSOE→WCR in the live data) split
  // into TWO league rows and every population statistic ran over
  // the duplicated population: 19/20 items carried duplicate
  // outlet rows (146 extra rows live), KULIT PANGSIT's rank #1 AND
  // #2 were the SAME outlet (1209.MLGSOE, z 15.87 vs 13.07 per
  // area segment), outletsWithBom read 352 against 343 distinct
  // outlets (network total 344), zero-waste claims counted area
  // segments of wasting outlets, and the min-5-outlet guard could
  // be bypassed (3 outlets × 2 labels = 6 population rows). The
  // area now comes from the Outlet MASTER: grouping by
  // ir."itemId" + o.code/o.name/o.area yields exactly ONE row per
  // (item, outlet) because o.code is UNIQUE and the o.* columns
  // are constant per outlet — a record-level label can no longer
  // split an outlet, and distinct outlets never merge (unique
  // code). (buildRateLeague's (itemId, outletCode) merge is the
  // defensive belt; the pin + negative-ir.area test seals the
  // SQL.) NOTE: waste-top-items round 2 still groups by ir.area —
  // pre-existing there, display-only (top-8 breakdown), separate
  // backlog item; THIS round feeds median/MAD/z/guard, so it must
  // be outlet-grained.
  const itemIds = itemRows.map((r) => r.itemId);
  const outletRows = await withStatementTimeout((tx) => tx.$queryRaw<WasteRateOutletRawRow[]>`
    SELECT
      ir."itemId",
      o.code as "outletCode",
      o.name as "outletName",
      o.area as "area",
      COALESCE(SUM(ABS(ir."qtyWaste")), 0) as "wasteQty",
      COALESCE(SUM(ABS(ir."qtyBom")), 0) as "bomQty"
    FROM "InventoryRecord" ir
    JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
    JOIN "Outlet" o ON ir."outletId" = o.id
    WHERE ir."weekLabel" = ${week}
      AND sf."monthKey" IN (${monthInList})
      AND ir."itemId" IN (${Prisma.join(itemIds)})
      ${f}
    GROUP BY ir."itemId", o.code, o.name, o.area
  `);

  const result = buildRateLeague(itemRows, outletRows, windowMonths);
  result.lastMonthKey = lastMonthKey;
  return result;
}
