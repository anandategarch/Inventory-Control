// ============================================================
//  /api/drilldown — raw records for traceability
//  Query: ?outletCode=&itemName=&weekLabel=&monthLabel=&limit=&cursor=
//  Also supports multi-period via comma-separated weekLabel/monthLabel
//  (for cross-month compare drilldown)
//
//  FIX Medium #2: cursor-based pagination. Pass `cursor` (record ID) to fetch
//  the next page. Response includes `nextCursor` for the next page.
//  Default limit 50, max 500. Frontend can implement "Load More" button.
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { validateQuery, drilldownQuerySchema } from '@/lib/validation';
import { db } from '@/lib/db';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { resolveKelompokOutletCodes } from '@/lib/kelompok-resolver';
import { resolvePICOutletCodes } from '@/lib/pic-resolver';
import { withStatementTimeout } from '@/lib/queries/shared';
import { CACHE_INTERACTIVE } from '@/lib/cache-headers';
import { errorResponse } from '@/lib/error-response';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';

export const dynamic = 'force-dynamic';
export const maxDuration = 30; // FIX Phase 1: prevent Vercel timeout

export async function GET(req: NextRequest) {
  try {
    // FIX (BUG 8): Add rate limiting — was missing, DoS vector
    const ip = getClientIP(req);
    const rl = rateLimit(`drilldown:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);

    // Sprint 1: Zod input validation
    const validation = validateQuery(drilldownQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    const outletCode = url.searchParams.get('outletCode');
    const itemName = url.searchParams.get('itemName');
    const weekLabel = url.searchParams.get('weekLabel');
    const monthLabel = url.searchParams.get('monthLabel');
    // FIX (BUG-2-b / BUG-1-c #9): area/kelompok/pic now come from the Zod-parsed
    // result (drilldownQuerySchema validates + length-bounds them) instead of
    // raw searchParams — a 1000-char kelompok used to pass straight into
    // resolveKelompokOutletCodes' SQL. The other params keep their existing
    // raw reads (already validated by the same schema; empty-string
    // falsy-handling preserved exactly as before).
    // FIX (BUG-2-b): 'all' (case-insensitive) = no filter, normalized BEFORE
    // the cache key AND the query — the key builder folds 'all' into the
    // no-filter sentinel, so the query must drop it too or an empty filtered
    // result would be cached under the no-filter key (same poisoning class
    // as BUG-1-c #3). Mirrors the build-where.ts / peer-comparison convention.
    // pic stays raw — it is free text, not an 'all'-marker field.
    const normalizeAll = (v: string | null): string | null =>
      v && v.trim().toLowerCase() !== 'all' ? v : null;
    const areaFilter = normalizeAll(validation.data.area ?? null);
    const kelompokFilter = normalizeAll(validation.data.kelompok ?? null);
    const picFilter = validation.data.pic ?? null;
    const parsedLimit = parseInt(url.searchParams.get('limit') || '50', 10);
    const limit = Math.min(Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50, 500);
    // FIX Medium #2: cursor-based pagination.
    // cursor = record ID (int). When provided, fetch records AFTER this ID
    // (ordered by absNominalDeviasi DESC, then id DESC for stable tie-break).
    const cursorParam = url.searchParams.get('cursor');
    const cursor = cursorParam ? parseInt(cursorParam, 10) : null;

    // PERF-API-03 (Task PERF-API): DB-level AggregationCache for /api/drilldown.
    // Before: every request re-fetched raw InventoryRecord rows + 4 relations
    // (outlet/item/week/sourceFile). Benchmark: cold 0.42s → warm 0.21s.
    // After: cache the paginated response (5-min TTL) keyed by all filter +
    // pagination params (outletCode + itemName + weekLabel + monthLabel +
    // limit + cursor + area + kelompok + pic). Same page re-requested within 5 min hits cache in ~30ms.
    // Mutations (ingest/settings/pic/data) clear this via invalidateAnalysisCache.
    //
    // PERF (TAHAP-2 / P2-11 + P2-12): cache-key hygiene —
    //   1. monthLabel is RESOLVED to actual DB case BEFORE the key is built
    //      (getMonthResolver is process-cached ~0ms). Previously "juli 2026"
    //      and "Juli 2026" built two different cache rows for the same data.
    //   2. Comma-separated multi-period values (weekLabel/monthLabel) are
    //      split → trimmed → deduped → SORTED before keying, so "W1,W2" and
    //      "W2,W1" (same WHERE IN set) share ONE cache row instead of two.
    const DRILLDOWN_CACHE_TTL = 5 * 60 * 1000; // 5 min
    // P2-12: normalize a comma-separated multi-value param for the cache key
    // (order-insensitive — the query uses WHERE IN, so the set is what matters).
    const normalizeMulti = (raw: string | null): string | null => {
      if (!raw) return null;
      const vals = [...new Set(raw.split(',').map((v) => v.trim()).filter(Boolean))].sort();
      return vals.length > 0 ? vals.join(',') : null;
    };
    // P2-11: resolve every month in the list to DB case BEFORE the cache key.
    const monthResolverEarly = await getMonthResolver();
    const resolveMonthList = (raw: string | null): string | null => {
      const normalized = normalizeMulti(raw);
      if (!normalized) return null;
      return normalized
        .split(',')
        .map((m) => resolveMonthLabel(m, monthResolverEarly) || m)
        .join(',');
    };
    const resolvedMonthLabel = resolveMonthList(monthLabel);
    const normalizedWeekLabel = normalizeMulti(weekLabel);
    const cacheKey = buildCacheKey({
      route: 'drilldown',
      month: resolvedMonthLabel, week: normalizedWeekLabel,
      outletCode, itemName,
      area: areaFilter, kelompok: kelompokFilter, pic: picFilter,
      extra: { limit, cursor: cursor != null ? String(cursor) : null },
    });

    const { data: cachedOrFresh, cached, stale } = await withCacheAndDedup<Record<string, unknown>>(
      cacheKey,
      DRILLDOWN_CACHE_TTL,
      async () => {
        // FIX-DEEP-1 (DEEP-AUDIT-API-2): Resolve monthLabel case to actual DB case.
        // monthLabel may be a single value or comma-separated list (multi-period compare).
        // DB may have "AGUSTUS 2026" (upload-data.ts) or "Agustus 2026" (dashboard import).
        // Without this, `where.monthLabel = months[0]` returns 0 records on case mismatch.
        // PERF (TAHAP-2 / P2-11): resolution now happens BEFORE the cache key —
        // the values here arrive already normalized + resolved; re-resolving an
        // already-resolved label is a no-op fast path, so this stays idempotent.
        const monthResolver = await getMonthResolver();
        // Resolve each comma-separated label to its actual DB case.
        const resolvedMonths = resolvedMonthLabel
          ? resolvedMonthLabel.split(',').map((m) => resolveMonthLabel(m, monthResolver) || m)
          : [];
        // P2-12: weeks arrive normalized (sorted + deduped) from the key builder.
        const weeks = normalizedWeekLabel ? normalizedWeekLabel.split(',') : [];

        const where: Prisma.InventoryRecordWhereInput = {};
        if (outletCode) where.outlet = { code: outletCode };
        // FIX H4 (AUDIT-4): itemName was case-sensitive — `itemName=bumbu pasta kuah` returned 0
        // while "BUMBU PASTA KUAH (V.20)" existed. Use mode:'insensitive' (PostgreSQL-native).
        if (itemName) where.item = { name: { equals: itemName, mode: 'insensitive' } };
        // Support comma-separated values for multi-period drilldown
        if (weeks.length === 1) where.weekLabel = weeks[0];
        else if (weeks.length > 1) where.weekLabel = { in: weeks };
        if (resolvedMonths.length === 1) where.monthLabel = resolvedMonths[0];
        else if (resolvedMonths.length > 1) where.monthLabel = { in: resolvedMonths };

        // P2-12: unified early-exit shape — the success path returns
        // { success, count, nextCursor, hasMore, records } (DrilldownData in
        // useDrilldown.ts), but these early exits used to return a `total`
        // field instead of `count` + omit `hasMore` — any consumer reading
        // data.count got undefined. Same shape everywhere now.
        const emptyResult = { success: true, records: [], nextCursor: null, count: 0, hasMore: false };

        // Apply dashboard filters (area, kelompok, pic) so drill-down respects active filter
        if (areaFilter) where.area = areaFilter;

        // Resolve kelompok → outlet codes (parallel with PIC resolve)
        const [kelompokOutletCodes, picOutletCodes] = await Promise.all([
          kelompokFilter ? resolveKelompokOutletCodes(kelompokFilter) : Promise.resolve(null),
          picFilter ? resolvePICOutletCodes(picFilter) : Promise.resolve(null),
        ]);

        // Build outlet code filter from kelompok + PIC
        // resolveKelompokOutletCodes + resolvePICOutletCodes return outlet CODES (strings)
        // We filter via the outlet relation: outlet: { code: { in: [...] } }
        const outletCodeSets: string[][] = [];
        if (kelompokOutletCodes && kelompokOutletCodes.length > 0) {
          if (kelompokOutletCodes[0] === '__NO_MATCH__') {
            return emptyResult;
          }
          outletCodeSets.push(kelompokOutletCodes);
        }
        if (picOutletCodes && picOutletCodes.length > 0) {
          if (picOutletCodes[0] === '__NO_MATCH__') {
            return emptyResult;
          }
          outletCodeSets.push(picOutletCodes);
        }
        if (outletCodeSets.length === 1) {
          // Single filter (kelompok OR pic) — use outlet.code IN
          if (outletCode) {
            // Intersect with explicit outletCode if also set
            if (!outletCodeSets[0].includes(outletCode)) {
              return emptyResult;
            }
            // outletCode already in where.outlet — keep it
          } else {
            where.outlet = { code: { in: outletCodeSets[0] } };
          }
        } else if (outletCodeSets.length > 1) {
          // Both kelompok AND pic — intersect outlet codes
          const intersection = outletCodeSets[0].filter(c => outletCodeSets[1].includes(c));
          if (intersection.length === 0) {
            return emptyResult;
          }
          if (outletCode && !intersection.includes(outletCode)) {
            return emptyResult;
          }
          if (!outletCode) {
            where.outlet = { code: { in: intersection } };
          }
        }

        // P2-12: wrap the findMany in withStatementTimeout — this was the only
        // heavy query in the app without one (H-8 audit finding). A hung plan
        // (e.g. unindexed cursor pagination) now aborts at 30s instead of
        // blocking the connection until the route's maxDuration kills it.
        const records = await withStatementTimeout(
          (tx) => tx.inventoryRecord.findMany({
            where,
            // PERF-API-06 (Task PERF-API): use `select` on nested relations instead of
            // `include: ... true` — drops unused relation columns (Outlet.area/.pic/.id,
            // Item.satuan/.categoryId/.id, SourceFile.monthKey/.fileSize/.createdAt).
            // Also drops the `week` relation entirely (was joined but never read).
            include: {
              outlet: { select: { code: true, name: true } },
              item: { select: { name: true } },
              sourceFile: { select: { fileName: true } },
            },
            orderBy: [
              { absNominalDeviasi: 'desc' },
              { id: 'desc' }, // FIX Medium #2: stable tie-break for cursor pagination
            ],
            // FIX Medium #2: cursor-based pagination.
            // When cursor is provided, skip 1 record (the cursor record itself) and
            // take `limit` records after it. This gives stable pagination even when
            // new records are inserted between requests.
            ...(cursor != null && Number.isFinite(cursor)
              ? { cursor: { id: cursor }, skip: 1, take: limit }
              : { take: limit }),
          }),
          30_000,
        );

        // Determine nextCursor for the next page (last record's ID, if we got a full page)
        const nextCursor = records.length === limit && records.length > 0
          ? records[records.length - 1].id
          : null;

        // PERF-API-03: return a plain object so withCacheAndDedup can store it.
        return {
          success: true,
          count: records.length,
          // FIX Medium #2: pagination metadata. Frontend can use nextCursor to fetch
          // the next page via `?cursor=${nextCursor}`. hasMore=false means last page.
          nextCursor,
          hasMore: nextCursor != null,
          records: records.map((r) => ({
            id: r.id,
            // FIX H5 (AUDIT-4): null guards on nested relations — soft-deleted Outlet/Item
            // or null sourceFile would crash the drawer/modal. Fallback to '—' / 0.
            outlet: { code: r.outlet?.code ?? '—', name: r.outlet?.name ?? '—', area: r.area ?? '—' },
            item: { name: r.item?.name ?? '—', satuan: r.satuan ?? null },
            period: { monthLabel: r.monthLabel ?? '—', weekLabel: r.weekLabel ?? '—' },
            source: { fileName: r.sourceFile?.fileName ?? '—' },
            qty: {
              bom: r.qtyBom,
              com: r.qtyCom,
              deviasi: r.qtyDeviasi,
              waste: r.qtyWaste,
              susut: r.qtySusut,
              trial: r.qtyTrial,
              lossSurplus: r.qtyLossSurplus,
              wasteSusut: r.pctWasteSusut,
            },
            nominal: {
              deviasi: r.nominalDeviasi,
              waste: r.nominalWaste,
              susut: r.nominalSusut,
              trial: r.nominalTrial,
              lossSurplus: r.nominalLossSurplus,
              sales: r.nominalSales,
            },
            derived: {
              // FIX CALC-1 + VERIFY3-4: compute direction from nominalLossSurplus sign with qtyDeviasi fallback
              // (not stored r.direction which may be inverted for un-migrated data)
              direction: (() => {
                if (r.nominalLossSurplus != null) {
                  if (r.nominalLossSurplus < 0) return 'LOSS';
                  if (r.nominalLossSurplus > 0) return 'SURPLUS';
                  return 'NEUTRAL';
                }
                if (r.qtyDeviasi != null) {
                  if (r.qtyDeviasi < 0) return 'LOSS';
                  if (r.qtyDeviasi > 0) return 'SURPLUS';
                  return 'NEUTRAL';
                }
                return r.direction; // last resort fallback
              })(),
              residualQty: r.residualQty,
              residualRatio: r.residualRatio,
              absQtyDeviasi: r.absQtyDeviasi,
              absNominalDeviasi: r.absNominalDeviasi,
              pctQtyDeviasiToBom: r.pctQtyDeviasiToBom,
              pctWasteSusut: r.pctWasteSusut,
              tolerancePct: r.tolerancePct,
              toleranceRaw: r.toleranceRaw,
              avgPrice: r.avgPrice,
            },
            bulan: r.bulan,
            bulan2: r.bulan2,
          })),
        } as Record<string, unknown>;
      }, // end withCacheAndDedup computeFn
    );

    // PERF-API-03: rebuild NextResponse from cached/fresh payload + add cached flag.
    const responsePayload = cached
      ? { ...cachedOrFresh, cached: true, ...(stale ? { stale: true } : {}) }
      : cachedOrFresh;
    return NextResponse.json(responsePayload, { headers: CACHE_INTERACTIVE });
  } catch (e: unknown) {
    return errorResponse(e, "drilldown");
  }
}
