// ============================================================
//  record-guard — ensureRecordsExist (404 short-circuit wave)
//  --------------------------------------------------------
//  SPLIT-A (pure code motion): relocated VERBATIM from
//  fetchReportData's body (data-fetcher.ts:351-389). The FIRST
//  data query for every sections combination: the record COUNT
//  (throws EarlyHttpResponse → 404 when 0) + the q-variance fetch
//  that shares the wave. Writes varianceAnalysis onto the context.
// ============================================================
import { NextResponse } from 'next/server';
import { queryVarianceAnalysis } from '@/lib/queries/health-ranking';
import { cachedSharedQuery } from '@/lib/queries/query-cache';
import { withStatementTimeout } from '@/lib/queries/shared';
import { EarlyHttpResponse } from '@/lib/early-http-response';
import type { FetcherContext } from './context';

export async function ensureRecordsExist(ctx: FetcherContext): Promise<void> {
  const { month, filterOpts, buildWhere, prevWeek, prevMonth } = ctx;
  const { week, area, outletCode, itemName, pic } = ctx.params;
  const { needVariance } = ctx.gates;

  // ============================================================
  //  404 short-circuit wave — the FIRST data query for every sections
  //  combination.
  //  FIX (BUG-3-a P1): this wave used to also carry the 5 dead queries
  //  (q-rules / q-hist-rules / q-hist-stats), so even a filter with 0
  //  records paid seconds of dead compute before the 404 was thrown.
  //  FIX (BUG-3-a P2): q-variance is gated on the variance section (it
  //  renders nothing else — the top-worsened table is its only consumer).
  // ============================================================
  const [currRecordCount, varianceAnalysis] = await Promise.all([
    // FIX (BUG-3-a C3): bound the COUNT with a statement timeout too.
    withStatementTimeout((tx) => tx.inventoryRecord.count({ where: buildWhere(week, month) })),
    needVariance
      ? cachedSharedQuery(
          'q-variance',
          // REFINE-2: sv forks a fresh cache namespace — the row shape gained
          // `satuan` (tables 4.1/4.2's new "Satuan" column); cached rows from
          // the previous deploy lack it and would render '—' for a TTL cycle.
          { month, week, compareWeek: prevWeek, compareMonth: prevMonth, filters: filterOpts, extra: { sv: 2 } },
          () => queryVarianceAnalysis(week, month, prevWeek, prevMonth, filterOpts),
        )
      : Promise.resolve({ topWorsened: [], topImproved: [] }),
  ]);

  if (currRecordCount === 0) {
    // BUG FIX (BUG-NORECORDS-11): include filter context in error message for debugging
    const filterSummary = [
      `month="${month}"`, `week="${week}"`,
      area && area !== 'all' ? `area="${area}"` : null,
      outletCode && outletCode !== 'all' ? `outlet="${outletCode}"` : null,
      itemName ? `item="${itemName}"` : null,
      pic ? `pic="${pic}"` : null,
    ].filter(Boolean).join(', ');
    // PERF-CACHE-06: throw EarlyHttpResponse so the outer try/catch returns
    // the 404 response. Throwing (vs returning) propagates through
    // withCacheAndDedup's rejectComputation so concurrent in-flight awaiters
    // also see the 404. The cache is NOT populated (we don't cache 404s).
    throw new EarlyHttpResponse(NextResponse.json({ success: false, error: `No records found for ${filterSummary}. Coba cek filter atau import data ulang.` }, { status: 404 }));
  }

  ctx.varianceAnalysis = varianceAnalysis;
}
