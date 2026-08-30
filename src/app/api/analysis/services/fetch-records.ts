// ============================================================
//  fetch-records — Stage 2 of /api/analysis GET pipeline
//  --------------------------------------------------------
//  Extracted from the original 910-line god function (route.ts:232-398).
//
//  Responsibilities:
//    1. Parallel metadata fetch (weeks, sourceFiles, PIC outlets, thresholds)
//    2. Month re-resolution (idempotent — already resolved in stage 1)
//    3. allPeriods + historicalPeriods construction
//    4. Compare-period resolution (prevWeek + prevMonth) via shared helper
//    5. Kelompok outlet-code resolution
//    6. buildWhere closure + filterOpts object construction
//    7. currSlim + historicalByOutletItem parallel fetch
//
//  PERF-OPT: currSlim ∥ historicalByOutletItem run together so the 404
//  check + main Promise.all see the smaller of (currSlim, histStats).
//  See original comment block (lines 341-375) for the full rationale.
// ============================================================
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getRuntimeThresholds } from '@/lib/settings';
import { withStatementTimeout } from '@/lib/queries/shared';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { resolveKelompokOutletCodes } from '@/lib/kelompok-resolver';
import { buildInventoryWhere } from '@/lib/build-where';
import { resolveComparePeriod } from '@/lib/period-resolver';
import { queryHistoricalStats, queryHistoricalStatsMultiMetric, type MultiMetricHistoricalStats } from '@/lib/queries/historical';
import { logger } from '@/lib/logger';
import type { ResolvedParams } from './validate-and-resolve';

// OPTIMIZE-ANALYSIS: RecWithRels is the slim record shape declared in
// src/engine/analysis/types.ts. Both findMany queries below use `select`
// (not `include`) so Prisma only transfers the columns the engine reads —
// ~10 fewer columns × ~35K rows = meaningful payload + memory reduction.
type RecWithRels = import('@/engine/analysis/types').RecWithRels;

// Shape of a single row in currSlim — 5-column slim projection.
// (declared here so run-queries + post-process can reference it)
export interface CurrSlimRow {
  outletId: number;
  itemId: number;
  akunPenyesuaian: string | null;
  nominalLossSurplus: number | null;
  pctQtyDeviasiToBom: number | null;
}

// Shared filter options for SQL aggregate queries
export interface FilterOpts {
  area: string | null;
  kelompok: string | null;
  outletCode: string | null;
  itemName: string | null;
  // FIX FILTER-2: sentinel for empty PIC list (buildSqlFilters skips empty arrays)
  picOutletCodes: string[] | ['__NO_MATCH__'] | null;
}

// Stage-2 output — everything needed by run-queries + post-process.
export interface FetchedRecords {
  currSlim: CurrSlimRow[];
  historicalByOutletItem: Map<string, MultiMetricHistoricalStats>;
  weeksRaw: Array<{ weekLabel: string; monthKey: string }>;
  monthKeyByLabel: Map<string, string>;
  monthLabelByKey: Map<string, string>;
  allPeriods: Array<{ monthLabel: string; weekLabel: string; monthKey: string; sortKey: string }>;
  picOutletCodes: string[] | null;
  thresholds: Awaited<ReturnType<typeof getRuntimeThresholds>>;
  prevWeek: string | null;
  prevMonth: string | null;
  kelompokOutletCodes: string[];
  filterOpts: FilterOpts;
  buildWhere: (wk: string, mLabel: string) => Prisma.InventoryRecordWhereInput;
}

/**
 * Stage 2 — fetch all metadata + slim record batches.
 * Mutates `params` in place to fill prevWeek + prevMonth (resolved from
 * the allPeriods array — requires weeksRaw which is fetched here).
 */
export async function fetchRecords(params: ResolvedParams): Promise<FetchedRecords> {
  const { week, month, area, kelompok, outletCode, itemName, pic, compareWeek, compareMonthExplicit } = params;

  // ===== P1 fix: Pre-SQL metadata queries — ALL PARALLEL =====
  // weeks + sourceFiles + picOutlets (if pic) + thresholds — all independent
  const [weeksRaw, fileMonthKeys, picOutletCodesRaw, thresholds] = await Promise.all([
    db.week.findMany({
      select: { weekLabel: true, monthKey: true },
      distinct: ['monthKey', 'weekLabel'],
    }),
    db.sourceFile.findMany({
      select: { monthLabel: true, monthKey: true },
    }),
    pic
      // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout
      // so a hung PIC lookup doesn't block the whole Promise.all batch.
      ? withStatementTimeout((tx) => tx.$queryRaw<Array<{ outletCode: string }>>`SELECT "outletCode" FROM "OutletPIC" WHERE LOWER(pic) = LOWER(${pic})`)
          .then((r) => r.map((p) => p.outletCode))
          .catch((e) => {
            logger.error("OutletPIC query failed (table may not exist)", { error: e instanceof Error ? e.message : String(e) });
            return null;
          })
      : Promise.resolve(null),
    getRuntimeThresholds(),
  ]);
  const picOutletCodes = picOutletCodesRaw;
  const monthKeyByLabel = new Map(fileMonthKeys.map((f) => [f.monthLabel, f.monthKey]));
  const monthLabelByKey = new Map(fileMonthKeys.map((f) => [f.monthKey, f.monthLabel]));
  // BUG FIX (BUG-NORECORDS-4/5 / FIX-DEEP-1): Case-insensitive monthLabel resolution
  // NOTE: month resolution already done above (FIX M4) before cache key construction.
  // The call below is idempotent (re-resolving an already-resolved label is a no-op).
  const monthResolver = await getMonthResolver();
  // Resolve current + compare month labels to actual DB case (idempotent — already done above)
  const resolvedMonth = resolveMonthLabel(month, monthResolver) || month;
  const resolvedCompareMonth = compareMonthExplicit
    ? (resolveMonthLabel(compareMonthExplicit, monthResolver) || compareMonthExplicit)
    : null;
  // Note: prevMonth is computed later from allPeriods (which uses DB case) — no resolution needed.
  params.month = resolvedMonth;
  params.compareMonthExplicit = resolvedCompareMonth;
  const allPeriods = weeksRaw
    .map((w) => {
      const ml = monthLabelByKey.get(w.monthKey) || 'Unknown';
      return {
        monthLabel: ml,
        weekLabel: w.weekLabel,
        monthKey: w.monthKey,
        sortKey: `${w.monthKey}|${String(parseInt(w.weekLabel.replace(/\D/g, '')) || 0).padStart(2, '0')}`,
      };
    })
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  // ===== FIX: Auto-previous = SAME weekLabel in chronologically previous month =====
  // Weeks are CUMULATIVE (W1=1-7, W2=1-14, W4=1-25). Comparing W4 vs W2 is NOT
  // apples-to-apples (25 days vs 14 days → always positive growth). Must compare
  // same weekLabel: W4 Juli vs W4 Juni, W2 Juli vs W2 Juni, etc.
  //
  // FIX (RESTORE-BACKEND-2): the inline ~60-line period-resolution block has been
  // extracted to `@/lib/period-resolver.ts` as `resolveComparePeriod`. It handles
  // 3 cases: (1) compareWeek=null → auto-previous, (2) compareWeek+compareMonthExplicit
  // both set → use them directly, (3) compareWeek only → find same weekLabel in
  // most recent month before current (fallback: after current, then current month).
  // The helper does its own db.week + db.sourceFile fetch (~3ms — small tables);
  // allPeriods above is still needed below for historicalPeriods filtering.
  const { prevWeek, prevMonth } = await resolveComparePeriod(
    week,
    resolvedMonth,
    compareWeek,
    resolvedCompareMonth,
  );
  params.prevWeek = prevWeek;
  params.prevMonth = prevMonth;

  // FIX (BUG-KELOMPOK-EMPTY): resolve kelompok → outlet codes ONCE for buildWhere.
  // The raw SQL path (buildSqlFilters) uses an inline sub-select, but Prisma's
  // WhereInput can't easily express LEFT(SUBSTRING(code, '[^.]+$'),3) = X.
  //
  // FIX (BUG-PERF-4 / BUG-BE-2): Replaced inline "fetch ALL outlets + JS filter"
  // with the shared resolveKelompokOutletCodes helper, which does a single DB-level
  // SQL filter (same LEFT(SUBSTRING(...)) expression as buildSqlFilters). This is
  // ~5x faster (1 SQL query vs fetch-all + JS loop) and deduplicates the logic
  // that was copy-pasted in export-report/route.ts.
  //
  // FIX (RESTORE-BACKEND-2): the inline `buildWhere` closure that lived here
  // (50 lines) has been extracted to @/lib/build-where.ts as `buildInventoryWhere`
  // and is shared with /api/export-report. The closure depended on `kelompokOutletCodes`
  // via JS hoisting (resolved below); the extracted helper takes it as an explicit
  // parameter, so we resolve kelompokOutletCodes BEFORE constructing buildWhere.
  const kelompokOutletCodes = await resolveKelompokOutletCodes(kelompok);

  // FIX (RESTORE-BACKEND-2): buildWhere now delegates to the shared
  // `buildInventoryWhere` helper. The helper handles area/itemName/kelompok
  // /PIC/outletCode + all intersections. Sentinel for empty PIC list is
  // applied inside the helper (idempotent if caller already sentineled).
  const buildWhere = (wk: string, mLabel: string): Prisma.InventoryRecordWhereInput =>
    buildInventoryWhere({
      week: wk,
      month: mLabel,
      area,
      itemName,
      kelompok,
      kelompokOutletCodes,
      picOutletCodes,
      outletCode,
    });

  // Shared filter options for SQL aggregate queries
  // FIX FILTER-2: apply sentinel for empty PIC list (buildSqlFilters skips empty arrays)
  const filterOpts: FilterOpts = {
    area,
    kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
    outletCode,
    itemName,
    picOutletCodes: picOutletCodes !== null
      ? (picOutletCodes.length > 0 ? picOutletCodes : ['__NO_MATCH__'])
      : null,
  };

  // ============================================================
  //  P1 fix: HISTORICAL STATS + SLIM CURRENT RECS — ALL PARALLEL
  //  --------------------------------------------------------
  //  SQL-OPTIMIZE: Eliminated the 35K-record load (currentRecs +
  //  prevRecs were each ~25 columns × 35K rows = ~3MB JSON each).
  //  Now fetching only:
  //    1. currSlim — 5 columns × 35K rows (~700KB) for
  //       evaluateHistoricalRulesJs (zScore-based rules still need
  //       per-record nominalLossSurplus + pctQtyDeviasiToBom).
  //    2. historicalByOutletItem — Map of {mean, stdDev, n} per
  //       outlet+item (already a SQL aggregate, ~5K rows).
  //
  //  The heavy per-record computations are pushed to SQL:
  //    - queryOutletHealthRanking (per-outlet aggregate)
  //    - queryVarianceAnalysis (curr+prev JOIN)
  //    - queryGrowthDrivers (per-metric aggregation)
  //    - queryHistoricalCriticalItems (per-record fields for
  //      items flagged by HISTORICAL_* rules)
  //  These run in parallel with the existing 15 SQL aggregate queries.
  //
  //  FIX: Historical periods now filter by SAME weekLabel only.
  //  Weeks are cumulative (W1=1-7, W2=1-14, W4=1-25). Z-Score baseline
  //  must compare W4 vs W4 (prev months), NOT W4 vs W1+W2+W4 (mixed).
  //  Mixed weeks inflate mean (W1 is smaller) → false positive Z-Score.
  //
  //  PERF-OPT (verified): historicalByOutletItem is ALREADY in a
  //  Promise.all with currSlim — they run fully parallel. It CANNOT
  //  be merged into the main Promise.all below because:
  //    (a) the 404 check at line ~380 needs currSlim first, and
  //    (b) moving it after the 404 check would serialize it
  //        (currSlim → 404 check → big Promise.all), losing the
  //        currSlim ∥ historicalByOutletItem overlap.
  //  Current structure: max(currSlim, historicalByOutletItem) → 404
  //  check → big Promise.all. This is the optimal parallel shape.
  // ============================================================
  const historicalPeriods = allPeriods.filter(
    (p) => p.weekLabel === week && p.monthLabel !== resolvedMonth
  ).filter((p) => {
    const current = allPeriods.find(ap => ap.monthLabel === resolvedMonth && ap.weekLabel === week);
    return !current || p.sortKey < current.sortKey;
  });

  const [currSlimRaw, historicalByOutletItem] = await Promise.all([
    // SQL-OPTIMIZE: 5-column slim projection (was 25-column full select).
    // evaluateHistoricalRulesJs is the only consumer — it reads just
    // (outletId, itemId, akunPenyesuaian, nominalLossSurplus,
    // pctQtyDeviasiToBom) per record.
    db.inventoryRecord.findMany({
      where: buildWhere(week, resolvedMonth),
      select: {
        outletId: true, itemId: true, akunPenyesuaian: true,
        nominalLossSurplus: true, pctQtyDeviasiToBom: true,
      },
    }),
    historicalPeriods.length > 0
      ? queryHistoricalStatsMultiMetric(historicalPeriods, filterOpts)
      : Promise.resolve(new Map<string, MultiMetricHistoricalStats>()),
  ]);

  return {
    currSlim: currSlimRaw as CurrSlimRow[],
    historicalByOutletItem,
    weeksRaw,
    monthKeyByLabel,
    monthLabelByKey,
    allPeriods,
    picOutletCodes,
    thresholds,
    prevWeek,
    prevMonth,
    kelompokOutletCodes,
    filterOpts,
    buildWhere,
  };
}

// Avoid unused-import lint (RecWithRels kept as a type-level import for clarity
// — it documents the engine's expected record shape even though currSlim is now
// a narrower projection. See OPTIMIZE-ANALYSIS comment above.)
export type { RecWithRels };
