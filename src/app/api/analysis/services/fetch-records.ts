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
//    7. currRecordCount (404 probe) + historicalByOutletItem parallel fetch
//
//  PERF (TAHAP-2 / P2-7): the old stage-2 also fetched `currSlim` — 5 columns
//  × ~35K rows (~700KB) whose ONLY consumer was evaluateHistoricalRulesJs's
//  JS loop. The 3 zScore rules now run as evaluateHistoricalRulesSql (SQL
//  push-down, fired in stage 3), so the current period only needs a COUNT
//  here: the 404 short-circuit + the payload's evaluatedCount meta read the
//  number, and the count rides an index-only scan (monthLabel, weekLabel).
// ============================================================
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getRuntimeThresholds } from '@/lib/settings';
import { withStatementTimeout } from '@/lib/queries/shared';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { resolveKelompokOutletCodes } from '@/lib/kelompok-resolver';
import { buildInventoryWhere } from '@/lib/build-where';
import { resolveComparePeriod } from '@/lib/period-resolver';
import { queryHistoricalStatsMultiMetric, type MultiMetricHistoricalStats } from '@/lib/queries/historical';
import { cachedSharedQueryMap, histPeriodsKeyParts } from '@/lib/queries/query-cache';
import { DASHBOARD_LOOKBACK_MONTHS } from '@/lib/queries/window-config';
import { logger } from '@/lib/logger';
import type { ResolvedParams, WeekDayRange } from './validate-and-resolve';

// OPTIMIZE-ANALYSIS: RecWithRels is the slim record shape declared in
// src/engine/analysis/types.ts. Kept as a type-level export for clarity —
// it documents the engine's expected record shape even though the pipeline
// no longer materializes current-period records (PERF TAHAP-2 / P2-7).
type RecWithRels = import('@/engine/analysis/types').RecWithRels;

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
  // PERF (TAHAP-2 / P2-7): replaced the 35K-row currSlim array with a COUNT —
  // consumed by the 404 short-circuit + the historical-analysis meta's
  // evaluatedCount. Per-record data is no longer needed in JS (zScore rules
  // are SQL now).
  currRecordCount: number;
  historicalByOutletItem: Map<string, MultiMetricHistoricalStats>;
  // (monthLabel, weekLabel) baseline periods — consumed by
  // evaluateHistoricalRulesSql (fired in stage 3) + the export pipeline.
  historicalPeriods: Array<{ monthLabel: string; weekLabel: string }>;
  historicalPeriodsCount: number; // number of (monthLabel,weekLabel) pairs used as historical baseline
  // TASK H-5: + periodStart/periodEnd (day-of-month bounds) — consumed here
  // for the payload's period ranges; downstream consumers that only read
  // weekLabel/monthKey are unaffected (structural typing).
  weeksRaw: Array<{ weekLabel: string; monthKey: string; periodStart: number; periodEnd: number }>;
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
 * the allPeriods array — requires weeksRaw which is fetched here) and, since
 * TASK H-5, the current/compare week day-ranges (weekRange/compareWeekRange).
 */
export async function fetchRecords(params: ResolvedParams): Promise<FetchedRecords> {
  const { week, month, area, kelompok, outletCode, itemName, pic, compareWeek, compareMonthExplicit } = params;

  // ===== P1 fix: Pre-SQL metadata queries — ALL PARALLEL =====
  // weeks + sourceFiles + picOutlets (if pic) + thresholds — all independent
  // TASK H-5: week select now also carries periodStart/periodEnd (day-of-month
  // bounds, cumulative: W2 = 1–14) — same single query, two extra columns,
  // used to give the payload's period block concrete date ranges.
  // PERF (PERF-FILTER1 D): resolveKelompokOutletCodes joined the metadata
  // wave — it previously ran as a SERIAL query after resolveComparePeriod
  // (buildWhere construction needs it, but nothing in the wave above does),
  // costing one extra ~200ms cross-region round-trip wave on every cold
  // request. It is independent of every other wave member.
  const [weeksRaw, fileMonthKeys, picOutletCodesRaw, thresholds, kelompokOutletCodes] = await Promise.all([
    db.week.findMany({
      select: { weekLabel: true, monthKey: true, periodStart: true, periodEnd: true },
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
    // PERF (PERF-FILTER1 D): rides the wave (was serial after
    // resolveComparePeriod) — kelompok filter resolution is independent
    // of every other wave member.
    resolveKelompokOutletCodes(kelompok),
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
      // P23 D5: 'Unknown' fallback label → 'Tidak diketahui' (display-only).
      const ml = monthLabelByKey.get(w.monthKey) || 'Tidak diketahui';
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
  // PERF (PAKET B / F4): pass the ALREADY-fetched weeksRaw + fileMonthKeys
  // into resolveComparePeriod — previously it re-fetched both tables (2 extra
  // round-trips + a serial barrier) right after this same data had just been
  // loaded by the parallel metadata batch above.
  const { prevWeek, prevMonth } = await resolveComparePeriod(
    week,
    resolvedMonth,
    compareWeek,
    resolvedCompareMonth,
    { weeksRaw, fileMonthKeys },
  );
  params.prevWeek = prevWeek;
  params.prevMonth = prevMonth;

  // TASK H-5 (period clarity): resolve concrete day-of-month ranges for the
  // current + compare week from the ALREADY-fetched weeksRaw (zero extra
  // queries). Weeks are CUMULATIVE — W2 covers tgl 1–14, so "WEEK 2 Mei"
  // alone is opaque; the range makes the compared periods self-explanatory.
  // Null-safe by design: an unresolvable pair just omits the range (the UI
  // falls back to week+month labels only).
  const weekRangeOf = (wk: string | null, mLabel: string | null): WeekDayRange | null => {
    if (!wk || !mLabel) return null;
    const monthKey = monthKeyByLabel.get(mLabel);
    if (!monthKey) return null;
    const w = weeksRaw.find((row) => row.monthKey === monthKey && row.weekLabel === wk);
    if (!w) return null;
    return { start: w.periodStart, end: w.periodEnd };
  };
  params.weekRange = weekRangeOf(week, resolvedMonth);
  params.compareWeekRange = weekRangeOf(prevWeek, prevMonth);

  // FIX (BUG-KELOMPOK-EMPTY / BUG-PERF-4 / BUG-BE-2, kept): kelompok → outlet
  // codes via the shared resolveKelompokOutletCodes helper (single DB-level
  // SQL filter, same LEFT(SUBSTRING(...)) expression as buildSqlFilters).
  // FIX (RESTORE-BACKEND-2): the inline `buildWhere` closure that lived here
  // (50 lines) has been extracted to @/lib/build-where.ts as `buildInventoryWhere`
  // and is shared with /api/export-report; the helper takes the resolved codes
  // as an explicit parameter.
  // PERF (PERF-FILTER1 D): the resolution now rides the metadata wave above
  // (was a serial query at this position — one extra round-trip wave).

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
  //  P1 fix: HISTORICAL STATS + CURRENT-PERIOD COUNT — ALL PARALLEL
  //  --------------------------------------------------------
  //  PERF (TAHAP-2 / P2-7): currSlim (5 columns × ~35K rows, ~700KB) was
  //  fetched here solely to feed evaluateHistoricalRulesJs's JS loop. The
  //  3 zScore rules now run as ONE SQL query (evaluateHistoricalRulesSql,
  //  fired in stage 3) with an inline historical-baseline CTE, so the
  //  current period only needs a COUNT for the 404 short-circuit —
  //  index-driven, 1 row egress. historicalByOutletItem stays:
  //  buildHistoricalAnalysis still merges its 5-metric stats into the
  //  critical-items payload.
  //
  //  PERF (H-11 / #3): q-hist-stats — this multi-week baseline scan is
  //  wrapped in the shared per-query cache with the SAME queryId + key
  //  parts (histPeriodsKeyParts) as the export pipeline's identical call,
  //  so "view dashboard → export report" skips recomputing it. Map-safe
  //  wrapper (cachedSharedQueryMap) — AggregationCache stores JSON.
  //
  //  FIX: Historical periods now filter by SAME weekLabel only.
  //  Weeks are cumulative (W1=1-7, W2=1-14, W4=1-25). Z-Score baseline
  //  must compare W4 vs W4 (prev months), NOT W4 vs W1+W2+W4 (mixed).
  //  Mixed weeks inflate mean (W1 is smaller) → false positive Z-Score.
  // ============================================================
  const historicalPeriods = allPeriods
    .filter((p) => p.weekLabel === week && p.monthLabel !== resolvedMonth)
    .filter((p) => {
      const current = allPeriods.find(ap => ap.monthLabel === resolvedMonth && ap.weekLabel === week);
      return !current || p.sortKey < current.sortKey;
    })
    // Window policy: keep only the MOST RECENT (DASHBOARD_LOOKBACK_MONTHS − 1)
    // prior same-week months (= 4 sejak HIST-WINDOW-5, 29 Okt 2026, opsi B
    // user — see window-config.ts) → the analysis wave's historical baseline
    // (q-hist-stats / q-hist-rules / q-waste-rules) spans the selected month
    // + 4 prior months — tepat memenuhi HISTORICAL_MIN_WEEKS=4 untuk z-score
    // tab Historical. [RIWAYAT: PERF-FILTER3 (22 Okt 2026) memangkas jendela
    // dari tanpa-batas ke 2 bulan pembanding per user request "hanya tarik
    // data 3 bulan terakhir agar ringan" saat insiden 500; HIST-WINDOW-5
    // melonggarkan ke 4 pembanding karena DB kini us-east-1 (MIGRASI-REGION)
    // + heatmap terhapus (HEATMAP-REMOVE) + gate stagger PERF-FILTER4 aktif.]
    // allPeriods is sortKey-ascending, so slice(-N) keeps the
    // NEWEST N. q-hist-stats' cache key derives from the period LIST
    // (histPeriodsKeyParts) → auto-forked; q-hist-rules/q-waste-rules carry
    // an explicit `lb` extra for the same reason. Unchanged semantics when
    // fewer prior months exist (slice is a no-op then).
    .slice(-(DASHBOARD_LOOKBACK_MONTHS - 1));

  const [currRecordCount, historicalByOutletItem] = await Promise.all([
    // PERF (TAHAP-2 / P2-7): COUNT replaces the 35K-row slim findMany —
    // the 404 probe + the payload's evaluatedCount meta only need the number.
    db.inventoryRecord.count({ where: buildWhere(week, resolvedMonth) }),
    historicalPeriods.length > 0
      ? cachedSharedQueryMap(
          'q-hist-stats',
          { ...histPeriodsKeyParts(historicalPeriods), filters: filterOpts },
          () => queryHistoricalStatsMultiMetric(historicalPeriods, filterOpts),
        )
      : Promise.resolve(new Map<string, MultiMetricHistoricalStats>()),
  ]);

  return {
    currRecordCount,
    historicalByOutletItem,
    historicalPeriods,
    historicalPeriodsCount: historicalPeriods.length,
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
// — it documents the engine's expected record shape. See OPTIMIZE-ANALYSIS
// comment above.)
export type { RecWithRels };
