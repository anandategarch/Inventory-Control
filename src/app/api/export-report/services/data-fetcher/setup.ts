// ============================================================
//  setup — resolvePipelineSetup (pipeline preamble)
//  --------------------------------------------------------
//  SPLIT-A (pure code motion): relocated VERBATIM from
//  fetchReportData's body (data-fetcher.ts:233-349) — thresholds,
//  PIC/kelompok outlet resolution, the where-clause factory, the
//  period tables (weeks + sourceFiles), case-insensitive month
//  resolution, compare-period resolution and the historical-period
//  list. Returns the assembled FetcherContext; comments preserved.
// ============================================================
import { getRuntimeThresholds } from '@/lib/settings';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { resolveKelompokOutletCodes } from '@/lib/kelompok-resolver';
import { resolveComparePeriod } from '@/lib/period-resolver';
import { withStatementTimeout } from '@/lib/queries/shared';
import { logger } from '@/lib/logger';
import type { ReportParams } from '../types';
import { createFetcherContext, createBuildWhere, type FetcherContext } from './context';
import { computeSectionGates } from './section-gates';

export async function resolvePipelineSetup(params: ReportParams): Promise<FetcherContext> {
  const {
    monthParam, week, area, outletCode, itemName, pic, kelompok,
    userCompareWeek, userCompareMonth,
  } = params;

  // (Section gates — computed first, exactly as in the original body;
  // see section-gates.ts for the verbatim comment block.)
  const gates = computeSectionGates(params.sections);

  // PERF-CACHE-06: monthParam + week are `const` (narrowed to `string` by the
  // outer guard) — TS carries the narrowing into this closure. The resolved
  // `month` (after monthResolver) is declared as a separate const below.
  // Load thresholds.
  // FIX (BUG-3-a P1): after the dead-compute removal the ONLY consumer of
  // thresholds here is TOP_N_ITEMS (the rule-evaluation thresholds went away
  // with q-rules / q-hist-rules). Keep the call — getRuntimeThresholds sits
  // on getAllSettings' 30s-TTL in-process cache, so it is ~0ms when warm.
  const thresholds = await getRuntimeThresholds();

  // Resolve PIC outlets — FIX FILTER-3: case-insensitive via raw SQL LOWER()
  // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout.
  let picOutletCodes: string[] | null = null;
  if (pic) {
    try {
      const pics = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ outletCode: string }>>`SELECT "outletCode" FROM "OutletPIC" WHERE LOWER(pic) = LOWER(${pic})`);
      picOutletCodes = pics.map(p => p.outletCode);
    } catch (e) {
      logger.error("[export-report] OutletPIC query failed:", { error: e instanceof Error ? e.message : String(e) });
      picOutletCodes = [];
    }
    // FIX FILTER-4: sentinel for empty list (was: skipped filter → showed ALL outlets)
    if (picOutletCodes.length === 0) {
      picOutletCodes = ['__NO_MATCH__'];
    }
  }

  // FIX (BUG-PERF-4 / BUG-BE-2): Replaced inline "fetch ALL outlets + JS filter"
  // with the shared resolveKelompokOutletCodes helper. Same DB-level SQL filter
  // as buildSqlFilters, ~5x faster, and deduplicates the logic.
  const kelompokOutletCodes = await resolveKelompokOutletCodes(kelompok);

  // FIX (RESTORE-BACKEND-2): buildWhere now delegates to the shared
  // `buildInventoryWhere` helper from @/lib/build-where.ts. The helper
  // handles area/itemName/kelompok/PIC/outletCode + all intersections,
  // including sentinel for empty PIC list (idempotent — export-report
  // pre-sentineled above; helper passes it through unchanged).
  const buildWhere = createBuildWhere({
    area,
    itemName,
    kelompok,
    kelompokOutletCodes,
    picOutletCodes,
    outletCode,
  });

  const filterOpts = {
    area: area === 'all' ? null : area,
    kelompok: kelompok === 'all' ? null : kelompok,
    outletCode: outletCode === 'all' ? null : outletCode,
    itemName,
    picOutletCodes, // already has sentinel applied
  };

  // Fetch current + prev records
  // FIX (BUG-3-a C3): these metadata reads (and the inventoryRecord COUNT
  // below) were plain db.* calls — the PgBouncer transaction pooler strips
  // the statement_timeout URL param, so a stuck query could hang them
  // unbounded (Vercel maxDuration 60s → 504 → the reported "spinner muter
  // terus"). Wrap in withStatementTimeout so they fail loudly at 30s.
  const [weeksRaw, fileMonthKeys] = await Promise.all([
    withStatementTimeout((tx) => tx.week.findMany({ select: { weekLabel: true, monthKey: true }, distinct: ['monthKey', 'weekLabel'] })),
    withStatementTimeout((tx) => tx.sourceFile.findMany({ select: { monthLabel: true, monthKey: true } })),
  ]);
  const monthLabelByKey = new Map(fileMonthKeys.map(f => [f.monthKey, f.monthLabel]));
  // BUG FIX (AUDIT-EXPORT-AI-1): monthKeyByLabel — reverse lookup for trend sort.
  // Previously trendAggRows used monthLabelByKey.get(r.monthLabel) which always returned
  // undefined (map is keyed by monthKey, not monthLabel) → sortKey collapsed → sort broken.
  const monthKeyByLabel = new Map(fileMonthKeys.map(f => [f.monthLabel, f.monthKey]));
  // BUG FIX (BUG-NORECORDS-4/5 / FIX-DEEP-1): Case-insensitive monthLabel resolution
  // via shared util `@/lib/month-resolver`. DB may have "AGUSTUS 2026" (upload-data.ts)
  // or "Agustus 2026" (dashboard import). Resolve user-sent month to actual DB case
  // to avoid "No records found".
  const monthResolver = await getMonthResolver();
  // Resolve current + compare month labels to actual DB case.
  // PERF-CACHE-06: declare as `const month` (shadowing monthInput) so the rest
  // of the computeFn uses the resolved case. monthInput is the raw URL param.
  const month = resolveMonthLabel(monthParam, monthResolver) || monthParam;
  const resolvedCompareMonth = userCompareMonth ? resolveMonthLabel(userCompareMonth, monthResolver) : null;
  const allPeriods = weeksRaw.map(w => ({
    monthLabel: monthLabelByKey.get(w.monthKey) || 'Unknown',
    weekLabel: w.weekLabel,
    sortKey: `${w.monthKey}|${String(parseInt(w.weekLabel.replace(/\D/g, '')) || 0).padStart(2, '0')}`,
  })).sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  // BUG FIX (AUDIT-EXPORT-AI-2): use user's compareWeek/compareMonth if provided.
  // Fall back to auto-compute (same weekLabel in previous month) only when user didn't specify.
  //
  // FIX (RESTORE-BACKEND-2): the inline ~15-line period-resolution block has been
  // extracted to `@/lib/period-resolver.ts` as `resolveComparePeriod`. This also
  // fixes a subtle bug in the old logic: when the user set compareWeek WITHOUT
  // compareMonth, the old code searched for the CURRENT week (not compareWeek) in
  // the previous month — so setting compareWeek alone had no effect. The new
  // helper correctly searches for `compareWeek` in the previous month.
  //
  // FIX (BUG-3-a P4): pass the ALREADY-fetched weeksRaw + fileMonthKeys into
  // resolveComparePeriod — without this the helper re-fetched both tables
  // (2 extra round-trips right after the same data was loaded above). Same
  // pattern as analysis/services/fetch-records.ts:152-162.
  const { prevWeek, prevMonth } = await resolveComparePeriod(
    week,
    month,
    userCompareWeek,
    resolvedCompareMonth,
    { weeksRaw, fileMonthKeys },
  );

  // Historical periods (same weekLabel only).
  // FIX (BUG-3-a P1): after the dead-compute removal no SQL consumes this
  // list unconditionally anymore — it now feeds (a) the DOCX header's
  // "Hist (Jan-Jul 26)" range label (every section combination) and
  // (b) the topItems section's q-hist-catavg periods. Cheap: metadata only.
  const historicalPeriods = allPeriods.filter(p => p.weekLabel === week && p.monthLabel !== month)
    .filter(p => { const cur = allPeriods.find(ap => ap.monthLabel === month && ap.weekLabel === week); return !cur || p.sortKey < cur.sortKey; });

  return createFetcherContext(params, gates, {
    thresholds,
    picOutletCodes,
    kelompokOutletCodes,
    buildWhere,
    filterOpts,
    month,
    monthKeyByLabel,
    prevWeek,
    prevMonth,
    historicalPeriods,
  });
}
