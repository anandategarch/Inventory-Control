// ============================================================
//  /api/export-report — Export analysis data to PDF
//  GET: ?month=&week=&compareWeek=&compareMonth=&area=&outlet=&item=&pic=&kelompok=&sections=
//  Fetches analysis data server-side, generates a .pdf, returns as download.
//
//  EXPORT-PDF: output switched .docx → .pdf (full design + vector charts
//  — services/pdf/*). The old docx-builder.ts was removed; the pipeline
//  shape (cache → fetch → build → base64) is unchanged.
//  EXPORT-TRIM (user request): report trimmed 13 → 6 sections — the removed
//  sections' fetches + builder blocks went with them.
//
//  PERF-FASE3-BE04: Migrated from legacy JS rule evaluator (35K-record loop
//  calling evaluateRules per record) to SQL-pushed evaluators. Matches the
//  dashboard's /api/analysis route — 3-5s faster per export.
//  FIX (BUG-3-a P1): the SQL rule/historical evaluators were later removed
//  from THIS pipeline entirely (their DOCX sections no longer exist) — the
//  dashboard's /api/analysis keeps them; see data-fetcher.ts header.
//
//  REFACTOR (Task 4-c): the original 1120-line god function has been split
//  into a slim coordinator (~95 LOC, this file) + 4 service modules under
//  ./services/. The slim handler retains: rate limit, Zod input validation,
//  cache key construction, withCacheAndDedup wrapper, buffer reconstruction,
//  and the EarlyHttpResponse short-circuit catch. All SQL/data-assembly
//  logic moved to data-fetcher.ts; all PDF document assembly moved to
//  pdf/pdf-builder.ts. See each service file for the per-section rationale
//  and inline "FIX (XXX)" comments preserved from the original monolith.
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { validateQuery, exportReportQuerySchema } from '@/lib/validation';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { errorResponse } from '@/lib/error-response';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';
import { EarlyHttpResponse } from '@/lib/early-http-response';
import type { ReportParams } from './services/types';
import { fetchReportData } from './services/data-fetcher';
import { buildPdfReport } from './services/pdf/pdf-builder';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// ============================================================
//  Main handler — GET with query params, fetches data server-side
// ============================================================
export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const ip = getClientIP(req);
    // FIX (BUG-3-a C7): dedicated export bucket (10/min) — was the shared
    // analysis bucket (60/min), far too loose for the heaviest route in the
    // app (seconds of SQL + docx assembly per call).
    const rl = rateLimit(`export-report:${ip}`, RATE_LIMITS.export.maxRequests, RATE_LIMITS.export.windowMs);
    if (!rl.allowed) {
      // FIX (BUG-3-a C7): Retry-After so a well-behaved client backs off
      // instead of retry-hammering. The limiter is fixed-window, so
      // rl.resetAt is the start of the next window — advertise the seconds
      // remaining (bounded to ≥1s; the window itself is 60s).
      const retryAfterSec = String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000)));
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded.' },
        { status: 429, headers: { 'Retry-After': retryAfterSec } },
      );
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
    // FIX (BUG-3-a C4): `?sections=` (empty string) used to fall through to
    // null = "ALL sections" — inverted semantics. Now an EMPTY param means NO
    // section active (docx-builder renders the header-only document; verified
    // crash-free — every section body is behind hasSection() guards). Param
    // absent (null) still means all sections. The cache key below keeps the
    // two cases distinct.
    const sections = sectionsParam !== null ? sectionsParam.split(',').filter(Boolean) : null;

    if (!monthParam || !week) {
      return NextResponse.json({ success: false, error: 'month and week required' }, { status: 400 });
    }

    // PERF: DB-level cache check — export-report is the heaviest route.
    // Cache the generated .pdf buffer for 5 min. Same filter params = same report.
    //
    // PERF-CACHE-04: cache key now includes `sections` (was missing → two requests
    //   with different `?sections=` values shared one cache entry → wrong sections
    //   in exported report). Sections are sorted for determinism.
    // PERF-CACHE-06: withCacheAndDedup adds in-flight Promise dedup for concurrent
    //   identical requests (was missing — only /api/analysis had it). Critical for
    //   export-report because the compute is still multi-second cold; without
    //   dedup, two concurrent identical exports would each compute + write the
    //   cache separately.
    // FIX (BUG-3-a C4): buildCacheKey SKIPS empty-string extras — with the new
    // "empty sections param = no sections" semantics, `?sections=` must NOT
    // share the null (all-sections) key. Encode the empty list as an explicit
    // '__NONE__' marker (unforgeable: validation.ts 400-rejects any sections
    // token outside the 6 known keys, so '__NONE__' can never be user input).
    // PERF (TAHAP-2 / P2-11): resolve month + compareMonth to actual DB case
    // BEFORE the cache key (getMonthResolver is process-cached ~0ms). The
    // data-fetcher re-resolves internally (idempotent no-op on the resolved
    // value), but the KEY must not fork on input case — previously "juli 2026"
    // vs "Juli 2026" produced two cache rows for the same report.
    const monthResolverEarly = await getMonthResolver();
    const resolvedMonthParam = resolveMonthLabel(monthParam, monthResolverEarly) || monthParam;
    const resolvedCompareMonthParam = userCompareMonth
      ? (resolveMonthLabel(userCompareMonth, monthResolverEarly) || userCompareMonth)
      : userCompareMonth;
    const cacheKey = buildCacheKey({
      route: 'export-report', month: resolvedMonthParam, week,
      compareWeek: userCompareWeek, compareMonth: resolvedCompareMonthParam,
      area: area && area !== 'all' ? area : null,
      kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
      outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
      itemName: itemName || null, pic: pic || null,
      // FIX (MASIH-TERPOTONG): the SWR cache serves STALE entries whose
      // age is unbounded — after a report-design change the user kept
      // downloading the PREVIOUS design's PDF (old truncations included)
      // until a recompute landed. Version the key so every design change
      // instantly forks a fresh cache namespace. Bump together with the
      // `rv` param in useDashboardActions.ts handleExport.
      extra: {
        sections: sections === null ? null : (sections.length > 0 ? [...sections].sort().join(',') : '__NONE__'),
        // REFINE-3: design/content change (heat text fix, section 6 anomali,
        // vs Rata-rata Area column, weekly composition + accumulation charts,
        // section renumbering 6→7/7→8/8→9) — BUG-HUNT: this bump was MISSING
        // when REFINE-3 landed, so users kept downloading the pre-REFINE-3
        // PDF from the 5-min cache after a deploy. Bump together with the
        // `rv` param in useDashboardActions.ts handleExport.
        // REFINE-4: design/content change (Rata-rata Absolute columns +
        // magnitude comparisons, section 6.2 flip detection, section 5
        // signed cells + abs heat, section 9 per-pair grouping, 8.2 resto
        // setara terms, plain-percent Selisih).
        rv: '6',
      },
    });
    const EXPORT_CACHE_TTL = 5 * 60 * 1000; // 5 min

    // PERF-CACHE-06: wrap the heavy compute (thresholds → section-gated SQL
    // fetches → docx assembly → Packer.toBuffer) in withCacheAndDedup. On
    // cache hit, returns the stored { bufferBase64, fileName } without
    // re-running any of the cold pipeline (FIX BUG-3-a P6: was quoted as
    // "~8s" — after the dead-compute removal + sections-aware fetching the
    // cold path depends on how many sections are selected; a warm q-* row
    // from a preceding dashboard view cuts it further).
    const { data: exportData } = await withCacheAndDedup<{ bufferBase64: string; fileName: string }>(
      cacheKey,
      EXPORT_CACHE_TTL,
      async () => {
        // Stage 1 — fetch the data the selected sections need
        // (FIX BUG-3-a P1/P2: the 5 dead queries are gone and ?sections=
        // now gates the FETCHING too — an "exec only" export no longer pays
        // q-trend + the top-items batch. See data-fetcher.ts header for the
        // section → query map). Throws EarlyHttpResponse on 404 (no records
        // for the filter).
        const params: ReportParams = {
          monthParam, week, area, outletCode, itemName, pic, kelompok,
          userCompareWeek, userCompareMonth, sections, startedAt,
        };
        const { data, ctx } = await fetchReportData(params);

        // Stage 2 — assemble the PDF document (cover band + numbered
        // section blocks (filtered by ?sections=) + running header/footer +
        // vector charts). Returns { bufferBase64, fileName } for the cache
        // wrapper — P3-HYG-4: base64 keeps the cache row compact +
        // JSON-serializable (see pdf-builder.ts).
        // EXPORT-TRIM: 6 sections remain (exec/growth/topItems/variance/
        // itemTrend/trend).
        return buildPdfReport(data, ctx);
      },
    );

    // Reconstruct the binary Buffer from the cached/fresh base64 payload +
    // send as PDF download. Same response shape for both cache hit and
    // fresh compute. (P3-HYG-4: Buffer.from(b64) is a single fast decode —
    // was Buffer.from(number[]) which walks a 500K-element JS array.)
    // FIX (BUG-3-a C5): filename is server-generated + sanitized in
    // pdf-builder ([^A-Za-z0-9._-] → '_'), and the header also carries the
    // RFC 5987/6266 filename* form so non-ASCII-safe handling is spec'd for
    // every client — belt-and-braces against header splitting/quoting bugs.
    const buffer = Buffer.from(exportData.bufferBase64, 'base64');
    return new NextResponse(new Uint8Array(buffer) as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${exportData.fileName}"; filename*=UTF-8''${encodeURIComponent(exportData.fileName)}`,
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
