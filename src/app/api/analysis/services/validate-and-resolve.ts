// ============================================================
//  validate-and-resolve — Stage 1 of /api/analysis GET pipeline
//  --------------------------------------------------------
//  Extracted from the original 910-line god function (route.ts:82-216).
//
//  Responsibilities:
//    1. Rate-limit check
//    2. Zod input validation
//    3. Compare-week format parsing (supports "WEEK N|||MonthLabel Year")
//    4. Default period resolution (latest month/week if unspecified)
//    5. Month case normalization (before cache key build — see FIX M4)
//    6. Cache key build + DB cache lookup
//    7. In-flight Promise dedup setup (prevents cache stampede)
//
//  Returns either:
//    - { kind: 'response', response } — short-circuit response (rate limit,
//      validation error, 404 no data, cache hit)
//    - { kind: 'continue', ... } — resolved params + cache plumbing for
//      the downstream stages (fetch-records, run-queries, post-process)
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { buildCacheKey, getCachedWithMeta, getInflight, setInflight } from '@/lib/aggregation-cache';
import { validateQuery, analysisQuerySchema } from '@/lib/validation';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { triggerBackgroundRecompute } from './background-recompute';

// FIX Medium #1: DB-level caching via AggregationCache table.
// Cache hit skips all 16 parallel SQL queries (~7s → <100ms).
// Cache invalidated on: ingest, settings change, direction migration (see those routes).
//
// FIX (AUDIT-PERF-5): TTL raised 5min → 30min (default, env-overridable via
// ANALYSIS_CACHE_TTL_MINUTES). Analysis data is IMMUTABLE between mutations —
// it only changes on ingest/settings/pic/data changes, and every one of those
// routes already calls invalidateAnalysisCache() (which deletes these rows),
// so a long TTL is safe. The TTL only bounds how long a row survives when no
// request re-reads it. The stale-while-revalidate path below covers the tail:
// a hit past TTL serves the stale row in <100ms and triggers ONE guarded
// background recompute that upserts the fresh row (see background-recompute.ts).
const ANALYSIS_TTL_MINUTES = Number(process.env.ANALYSIS_CACHE_TTL_MINUTES || 30);
export const ANALYSIS_CACHE_TTL_MS =
  (Number.isFinite(ANALYSIS_TTL_MINUTES) && ANALYSIS_TTL_MINUTES > 0 ? ANALYSIS_TTL_MINUTES : 30) * 60 * 1000;

// Resolved input parameters carried forward to stages 2-5.
// prevWeek + prevMonth are `string | null` (null when no comparison period exists).
export interface ResolvedParams {
  month: string;
  week: string;
  prevWeek: string | null;
  prevMonth: string | null;
  compareWeek: string | null;
  compareMonthExplicit: string | null;
  area: string | null;
  kelompok: string | null;
  outletCode: string | null;
  itemName: string | null;
  pic: string | null;
  startedAt: number;
}

// Stage-1 outcome — discriminated union so the orchestrator can short-circuit.
export type ValidateAndResolveOutcome =
  | { kind: 'response'; response: NextResponse }
  | {
      kind: 'continue';
      params: ResolvedParams;
      cacheKey: string;
      // FIX (DEEP-AUDIT-ZEROS): reject is captured so a thrown error in stages 2-5
      // rejects the in-flight Promise, preventing concurrent requests from hanging.
      resolveComputation: (v: unknown) => void;
      rejectComputation: (e: unknown) => void;
    };

/**
 * Stage 1 — validate input + resolve period + check cache.
 * Returns either a short-circuit response (cache hit, 400, 404, 429)
 * or the resolved params + cache plumbing for downstream stages.
 */
export async function validateAndResolve(req: NextRequest): Promise<ValidateAndResolveOutcome> {
  const startedAt = Date.now();

  // Bug #10 fix: Rate limiting
  const ip = getClientIP(req);
  const rl = rateLimit(`analysis:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
  if (!rl.allowed) {
    return {
      kind: 'response',
      response: NextResponse.json(
        { success: false, error: 'Rate limit exceeded. Coba lagi dalam beberapa detik.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } }
      ),
    };
  }

  const url = new URL(req.url);

  // Sprint 1: Zod input validation
  const validation = validateQuery(analysisQuerySchema, url.searchParams);
  if (!validation.success) {
    return {
      kind: 'response',
      response: NextResponse.json({ success: false, error: validation.error }, { status: 400 }),
    };
  }

  const monthLabel = url.searchParams.get('month');
  const currentWeek = url.searchParams.get('week');
  const compareWeekRaw = url.searchParams.get('compareWeek');
  const area = url.searchParams.get('area');
  const kelompok = url.searchParams.get('kelompok');
  const outletCode = url.searchParams.get('outlet');
  const itemName = url.searchParams.get('item');
  const pic = url.searchParams.get('pic');

  // ===== BUG FIX #1/#2: Parse cross-month compare format "WEEK X|||MonthLabel" =====
  let compareWeek: string | null = null;
  let compareMonthExplicit: string | null = null;
  if (compareWeekRaw && compareWeekRaw.includes('|||')) {
    // FIX (AUDIT8-ROLLBACK-1, Item 14): format validation for compareWeek.
    // A value like "WEEK 1|||" (trailing separator, empty month) used to pass
    // Zod (length-only check) and silently destructure to `wk="WEEK 1"` +
    // `ml=undefined` → compareMonthExplicit became undefined → caller treated
    // it as "no explicit compare month" and ran the auto-previous path, which
    // might pick a DIFFERENT month than the user intended. Now we reject any
    // `|||`-separated value that doesn't have BOTH a non-empty week AND a
    // non-empty month label after the separator. Also reject values with more
    // than one `|||` (e.g. "WEEK 1|||Juli|||2026") — destructure takes only
    // the first 2 segments, silently dropping the rest.
    const parts = compareWeekRaw.split('|||');
    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
      return {
        kind: 'response',
        response: NextResponse.json(
          { success: false, error: 'Invalid compareWeek format. Expected "WEEK N" or "WEEK N|||MonthLabel Year" (e.g. "WEEK 1|||Juli 2026").' },
          { status: 400 },
        ),
      };
    }
    const [wk, ml] = parts as [string, string];
    compareWeek = wk.trim();
    compareMonthExplicit = ml.trim();
  } else if (compareWeekRaw) {
    compareWeek = compareWeekRaw;
  }

  // DB-level AggregationCache is checked below (FIX Medium #1).
  // No thresholdsVersion needed in cache key — settings invalidation clears all entries.

  // Determine available months/weeks if not specified
  let month = monthLabel;
  let week = currentWeek;
  if (!month || !week) {
    // FIX-A-5 (BUG-5-2): Order by Week.monthKey (YYYY-MM, chronologically sortable)
    // and Week.periodEnd (cumulative day-end: 7 < 14 < 21 < 25), NOT by
    // InventoryRecord.monthLabel which sorts Indonesian month names alphabetically
    // (SEPTEMBER > OKTOBER > NOVEMBER > MEI > ...). The old sort returned the
    // wrong "latest" period (e.g., September instead of December) when no query
    // params were supplied — dashboard showed stale month by default.
    const latest = await db.inventoryRecord.findFirst({
      orderBy: [
        { week: { monthKey: 'desc' } },
        { week: { periodEnd: 'desc' } },
      ],
      select: { monthLabel: true, weekLabel: true },
    });
    if (!latest) {
      return {
        kind: 'response',
        response: NextResponse.json({
          success: false,
          message: 'No data ingested yet. Please run /api/ingest first.',
        }, { status: 404 }),
      };
    }
    month = month || latest.monthLabel;
    week = week || latest.weekLabel;
  }

  // FIX M4 (AUDIT-5): Resolve month case BEFORE building cache key.
  // Previously, cache key was built with raw user input (e.g., "AGUSTUS 2026"),
  // then month was resolved to DB case (e.g., "Agustus 2026"). This caused
  // different cache keys for the same logical data → cache miss.
  // Now resolve first, then build key. getMonthResolver() is cached (~1ms).
  const monthResolverEarly = await getMonthResolver();
  if (month) month = resolveMonthLabel(month, monthResolverEarly) || month;
  if (compareMonthExplicit) compareMonthExplicit = resolveMonthLabel(compareMonthExplicit, monthResolverEarly) || compareMonthExplicit;

  // FIX Medium #1: DB-level cache check.
  // Try to read cached result BEFORE running the 16 parallel SQL queries.
  // Cache hit: <100ms response (vs 6-8s cold). TTL 30 min by default
  // (FIX AUDIT-PERF-5 — see ANALYSIS_CACHE_TTL_MS above).
  // FIX (BUG-KELOMPOK-CACHE): kelompok is now part of the cache key — without it,
  // requests with different kelompok filters would share a cache entry (cache poisoning).
  const cacheKey = buildCacheKey({
    route: 'analysis',
    month, week,
    compareWeek: compareWeek ?? compareMonthExplicit,
    compareMonth: compareMonthExplicit,
    area, kelompok, outletCode, itemName, pic,
  });

  // FIX M3 (AUDIT-5): Check in-flight Promise map (prevents cache stampede).
  // If another request for the same key is already computing, await its result.
  const inflight = getInflight<unknown>(cacheKey);
  if (inflight) {
    const inflightResult = await inflight;
    if (inflightResult && typeof inflightResult === 'object' && 'success' in inflightResult) {
      const r = inflightResult as Record<string, unknown>;
      r.cached = true;
      r.durationMs = Date.now() - startedAt;
      return { kind: 'response', response: NextResponse.json(r, { headers: CACHE_ANALYSIS }) };
    }
  }

  // ============================================================
  //  FIX (AUDIT-PERF-6): Register the in-flight Promise BEFORE the cache-read
  //  await below — mirrors withCacheAndDedup step 2 (aggregation-cache.ts).
  //  Previously, setInflight ran AFTER `await getCachedWithMeta`, leaving a
  //  check-then-act race window: two concurrent requests could both observe
  //  getInflight=null while the first was still awaiting the cache read, then
  //  BOTH fall through and run the full 20-50-query pipeline (cache stampede,
  //  amplified by the frontend's 3x retry). Now any request that arrives while
  //  we're awaiting the cache read sees this Promise via getInflight (step 1
  //  above on its pass) and awaits it. On a cache HIT we resolve it below with
  //  the cached payload; on a MISS route.ts resolves/rejects it (see
  //  ValidateAndResolveOutcome).
  //  FIX (DEEP-AUDIT-ZEROS): reject is captured too — if stages 2-5 throw, the
  //  in-flight Promise rejects so concurrent requests don't hang forever
  //  (previously only resolve was captured, so errors left the Promise pending
  //  indefinitely → concurrent requests waited forever → dashboard stuck/0s).
  // ============================================================
  let resolveComputation!: (v: unknown) => void;
  let rejectComputation!: (e: unknown) => void;
  const computationPromise = new Promise<unknown>((resolve, reject) => {
    resolveComputation = resolve;
    rejectComputation = reject;
  });
  setInflight(cacheKey, computationPromise);

  // PERF-CACHE-01 (SWR): Use getCachedWithMeta instead of getCached.
  // getCached deletes expired rows → first user after TTL pays full recompute.
  // getCachedWithMeta returns stale data → user gets response in <100ms.
  // FIX (AUDIT-PERF-5): the stale row is NO LONGER deleted — a background
  // recompute (triggerBackgroundRecompute) refreshes it in place instead.
  const cachedWithMeta = await getCachedWithMeta<unknown>(cacheKey, ANALYSIS_CACHE_TTL_MS);
  if (cachedWithMeta && cachedWithMeta.data && typeof cachedWithMeta.data === 'object' && 'success' in cachedWithMeta.data) {
    // Cache hit (fresh or stale) — return immediately
    const cachedResult = cachedWithMeta.data as Record<string, unknown>;
    cachedResult.cached = true;
    cachedResult.durationMs = Date.now() - startedAt;
    if (cachedWithMeta.stale) {
      // SWR: serve stale data + flag for client + background refresh
      cachedResult.stale = true;
    }
    // FIX (AUDIT-PERF-6): resolve the in-flight Promise (registered above)
    // with the cached payload so concurrent requests that arrived during the
    // cache-read await get this response instead of hanging or re-computing.
    resolveComputation(cachedResult);
    if (cachedWithMeta.stale) {
      // FIX (AUDIT-PERF-5): true SWR — serve stale, then recompute in the
      // background and UPSERT the fresh row (setCached). The next request
      // reads fresh data from the DB cache. The old behavior fire-and-forgot
      // DELETED the stale row, so the very next user paid the full cold
      // recompute (20-50 SQL queries, 6-8s) even though the data was still
      // valid — mutations already invalidate this cache explicitly, so
      // keeping + refreshing the row is safe.
      // paramsForRecompute mirrors the miss-path params (prevWeek/prevMonth
      // are null — fetch-records resolves them during its own run).
      const paramsForRecompute: ResolvedParams = {
        month: month!,
        week: week!,
        prevWeek: null,
        prevMonth: null,
        compareWeek,
        compareMonthExplicit,
        area,
        kelompok,
        outletCode,
        itemName,
        pic,
        startedAt,
      };
      triggerBackgroundRecompute(cacheKey, paramsForRecompute);
    }
    return { kind: 'response', response: NextResponse.json(cachedResult, { headers: CACHE_ANALYSIS }) };
  }
  // Cache MISS (or the row's payload failed the response-shape guard): fall
  // through to compute. The in-flight Promise registered above stays PENDING
  // until route.ts resolves it with the fresh result — do NOT resolve it here,
  // the route owns resolution on both the success and the 404 short-circuit
  // paths (concurrent awaiters must get the fresh data, not a miss).

  return {
    kind: 'continue',
    params: {
      // prevWeek + prevMonth are null until stage 2 (fetch-records) calls
      // resolveComparePeriod — that helper needs allPeriods (built from
      // weeksRaw) which isn't available until stage 2.
      month: month!,
      week: week!,
      prevWeek: null,
      prevMonth: null,
      compareWeek,
      compareMonthExplicit,
      area,
      kelompok,
      outletCode,
      itemName,
      pic,
      startedAt,
    },
    cacheKey,
    resolveComputation,
    rejectComputation,
  };
}
