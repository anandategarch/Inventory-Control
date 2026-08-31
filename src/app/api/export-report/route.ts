// ============================================================
//  /api/export-report — Export analysis data to Word (.docx)
//  GET: ?month=&week=&compareWeek=&compareMonth=&area=&outlet=&item=&pic=&kelompok=&sections=
//  Fetches analysis data server-side, generates .docx, returns as download.
//
//  PERF-FASE3-BE04: Migrated from legacy JS rule evaluator (35K-record loop
//  calling evaluateRules per record) to SQL-pushed evaluators (evaluateRulesSql
//  + queryVarianceAnalysis + queryHistoricalCriticalItems). Matches the
//  dashboard's /api/analysis route — 3-5s faster per export.
//
//  REFACTOR (Task 4-c): the original 1120-line god function has been split
//  into a slim coordinator (~95 LOC, this file) + 4 service modules under
//  ./services/. The slim handler retains: rate limit, Zod input validation,
//  cache key construction, withCacheAndDedup wrapper, buffer reconstruction,
//  and the EarlyHttpResponse short-circuit catch. All SQL/data-assembly
//  logic moved to data-fetcher.ts; all Word document assembly moved to
//  docx-builder.ts. See each service file for the per-section rationale
//  and inline "FIX (XXX)" comments preserved from the original monolith.
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { validateQuery, exportReportQuerySchema } from '@/lib/validation';
import { errorResponse } from '@/lib/error-response';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';
import { EarlyHttpResponse } from './services/types';
import type { ReportParams } from './services/types';
import { fetchReportData } from './services/data-fetcher';
import { buildDocxReport } from './services/docx-builder';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// ============================================================
//  Main handler — GET with query params, fetches data server-side
// ============================================================
export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`export-report:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);

    // Sprint 1: Zod input validation
    const validation = validateQuery(exportReportQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    // BUG FIX (BUG-NORECORDS-4/5): use `const` for month so TypeScript narrows
    // the type to `string` (not `string | null`) inside the withCacheAndDedup
    // closure below. Previously `let month` was used so the resolveMonthLabel
    // reassignment could update it — but TS doesn't carry narrowing across
    // closures for `let` variables, so the closure saw `string | null` and
    // flagged every downstream `month` use. Now we keep `monthParam` const and
    // introduce a separate `month` const inside the closure for the resolved
    // value.
    const monthParam = url.searchParams.get('month');
    const week = url.searchParams.get('week');
    const area = url.searchParams.get('area');
    const outletCode = url.searchParams.get('outlet');
    const itemName = url.searchParams.get('item');
    const pic = url.searchParams.get('pic');
    // FIX (BUG-KELOMPOK-GLOBAL): read kelompok so Word export respects the
    // global kelompok filter (was missing → exported report included outlets
    // from ALL kelompok even when user filtered to one).
    const kelompok = url.searchParams.get('kelompok');
    // BUG FIX (AUDIT-EXPORT-AI-2): read compareWeek/compareMonth from URL params.
    // Previously export ignored user's comparison selection — always auto-computed.
    const userCompareWeek = url.searchParams.get('compareWeek');
    const userCompareMonth = url.searchParams.get('compareMonth');
    const sectionsParam = url.searchParams.get('sections');
    const sections = sectionsParam ? sectionsParam.split(',').filter(Boolean) : null;

    if (!monthParam || !week) {
      return NextResponse.json({ success: false, error: 'month and week required' }, { status: 400 });
    }

    // PERF: DB-level cache check — export-report is the heaviest route (7-12s).
    // Cache the generated .docx buffer for 5 min. Same filter params = same report.
    //
    // PERF-CACHE-04: cache key now includes `sections` (was missing → two requests
    //   with different `?sections=` values shared one cache entry → wrong sections
    //   in exported report). Sections are sorted for determinism.
    // PERF-CACHE-06: withCacheAndDedup adds in-flight Promise dedup for concurrent
    //   identical requests (was missing — only /api/analysis had it). Critical for
    //   export-report because the compute is ~8s cold; without dedup, two concurrent
    //   identical exports would each compute + write the cache separately.
    const cacheKey = buildCacheKey({
      route: 'export-report', month: monthParam, week,
      compareWeek: userCompareWeek, compareMonth: userCompareMonth,
      area: area && area !== 'all' ? area : null,
      kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
      outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
      itemName: itemName || null, pic: pic || null,
      extra: { sections: sections ? [...sections].sort().join(',') : null },
    });
    const EXPORT_CACHE_TTL = 5 * 60 * 1000; // 5 min

    // PERF-CACHE-06: wrap the heavy compute (thresholds → SQL fetches → docx
    // assembly → Packer.toBuffer) in withCacheAndDedup. On cache hit, returns
    // the stored { buffer, fileName } without re-running any of the ~8s pipeline.
    const { data: exportData } = await withCacheAndDedup<{ buffer: number[]; fileName: string }>(
      cacheKey,
      EXPORT_CACHE_TTL,
      async () => {
        // Stage 1 — fetch all data (thresholds + 18 parallel SQL queries +
        // rule evaluation + historical analysis + variance analysis).
        // Throws EarlyHttpResponse on 404 (no records for the filter).
        const params: ReportParams = {
          monthParam, week, area, outletCode, itemName, pic, kelompok,
          userCompareWeek, userCompareMonth, sections, startedAt,
        };
        const { data, ctx } = await fetchReportData(params);

        // Stage 2 — assemble the Word document (title + 7 sections + footer
        // + Packer.toBuffer). Returns { buffer: number[], fileName } for the
        // cache wrapper (Array.from keeps the binary data JSON-serializable).
        return buildDocxReport(data, ctx);
      },
    );

    // Reconstruct the binary Buffer from the cached/fresh payload + send as
    // Word download. Same response shape for both cache hit and fresh compute.
    const buffer = Buffer.from(exportData.buffer);
    return new NextResponse(new Uint8Array(buffer) as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${exportData.fileName}"`,
        // PERF-FASE1-BE01: CDN cache for 5 min, stale grace 10 min. Same report
        // for same period+filters won't change until underlying data changes.
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600, must-revalidate',
      },
    });
  } catch (e: unknown) {
    // PERF-CACHE-06: handle EarlyHttpResponse thrown from inside withCacheAndDedup's
    // computeFn (404 No records found short-circuit). Return the embedded response
    // directly — don't run it through errorResponse (which would 500 the 404).
    if (e instanceof EarlyHttpResponse) {
      return e.response;
    }
    logger.error("[export-report] error:", { error: e });
    return errorResponse(e, "export-report");
  }
}
