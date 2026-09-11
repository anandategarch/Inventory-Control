// ============================================================
//  /api/analysis — main dashboard data endpoint
//  Query: ?month=&week=&compareWeek=&area=&outlet=&item=
//
//  Phase 1-4 egress optimization (Task 15):
//  - Raw record fetching kept ONLY for rule evaluation (currentRecs + prevRecs)
//  - All aggregation pushed to SQL via /lib/queries.ts (PostgreSQL)
//  - Historical stats computed via SQL GROUP BY (avoids 540K row fetch)
//  - Trend, exec summary, top items/outlets, etc. all SQL-aggregated
//  - Rule evaluation loop, worklist, priorities, health ranking, historical
//    analysis, variance analysis still use raw records (per-record logic)
//
//  REFACTOR (FIX-SPLIT): the original 910-line god function has been split
//  into 5 named orchestrator functions under ./services/. The GET handler
//  below is now a thin coordinator (< 100 lines) — see each service for
//  the per-stage rationale and inline "FIX (XXX)" comments preserved from
//  the original monolith.
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { setCachedRaw } from '@/lib/aggregation-cache';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { validateAndResolve } from './services/validate-and-resolve';
import type { RawCacheHit } from './services/validate-and-resolve';
import { fetchRecords } from './services/fetch-records';
import { runQueries } from './services/run-queries';
import { postProcess } from './services/post-process';
import { assembleResponse } from './services/assemble-response';
import { errorResponse } from '@/lib/error-response';

export const dynamic = 'force-dynamic';
export const maxDuration = 120; // FIX: 60→120 — heavy queries with outlet filter can take 40-60s

export async function GET(req: NextRequest) {
  // FIX (DEEP-AUDIT-ZEROS): declare outside try so catch block can access it.
  // If the computation throws, we reject the in-flight Promise so concurrent
  // requests don't hang forever.
  let rejectComputation: ((e: unknown) => void) | undefined;
  try {
    // Stage 1 — validate input + resolve period + check cache (may short-circuit).
    const outcome = await validateAndResolve(req);
    if (outcome.kind === 'response') return outcome.response;
    rejectComputation = outcome.rejectComputation;
    const { params, cacheKey, resolveComputation } = outcome;

    // Stage 2 — fetch slim records + historical stats (parallel with metadata).
    const records = await fetchRecords(params);

    // 404 short-circuit (FIX BUG-PERF-1): MUST reject the in-flight computation
    // Promise before returning 404 — otherwise the Promise stays pending and
    // concurrent requests for the same cache key hang forever.
    // PERF (TAHAP-2 / P2-7): the probe is a COUNT (index-only scan) — the old
    // 35K-row currSlim findMany was only needed for the JS zScore loop, which
    // is now evaluateHistoricalRulesSql.
    if (records.currRecordCount === 0) {
      const notFoundResponse = {
        success: false,
        message: `No records found for ${params.month} / ${params.week} with given filters.`,
      };
      // FIX API-04: Resolve in-flight with the 404 payload (not reject) so concurrent
      // requests awaiting the same key get a clean response, not a 500 error.
      resolveComputation?.(notFoundResponse);
      return NextResponse.json(notFoundResponse, { status: 404 });
    }

    // Stage 3 — run 4 parallel SQL aggregate batches + early-fired promises.
    const queries = await runQueries(params, records);

    // Stage 4 — post-process (rule flags, variance, historical analysis, patterns).
    const processed = await postProcess(params, records, queries);

    // Stage 5 — assemble the final JSON response.
    const result = assembleResponse(params, records, queries, processed);

    // FIX Medium #1: Store result in DB cache.
    // PERF (H-8 QUICK WIN 5 — single stringify): the ~1MB payload is
    // serialized exactly ONCE. Previously setCached() stringified the object
    // (serialize #1) and NextResponse.json() stringified it AGAIN (serialize
    // #2) — ~30-80ms of duplicate CPU per cold compute. The string stored in
    // AggregationCache is byte-identical to what setCached() wrote, so warm
    // hits (getCachedRawWithMeta) behave exactly as before.
    const json = JSON.stringify(result);
    // awaitWrite=true — blocks ~150ms to ensure DB write completes before
    // response returns. Without this, the next request (fire-and-forget
    // write still in-flight) misses cache and recomputes 10s.
    await setCachedRaw(cacheKey, json, true);

    // FIX M3: Resolve the in-flight Promise so concurrent requests get the
    // result. PERF (H-8-5): resolve with the SAME P3-HYG-1 raw marker the
    // cache-hit path uses — concurrent awaiters then serve the string with
    // zero-parse + zero per-awaiter re-serialization (the old object branch
    // in validate-and-resolve re-stringified the ~1MB object for EVERY
    // awaiting request).
    const rawHit: RawCacheHit = { __rawJson: json, stale: false };
    resolveComputation(rawHit);

    // PERF (H-8-5): serve the SAME string we just cached — no second
    // serialization. Bytes are identical to NextResponse.json(result).
    return new NextResponse(json, {
      headers: { ...CACHE_ANALYSIS, 'Content-Type': 'application/json' },
    });
  } catch (e: unknown) {
    // FIX (DEEP-AUDIT-ZEROS): reject the in-flight Promise so concurrent
    // requests awaiting it don't hang forever. Previously only resolve was
    // called (on success), so errors left the Promise pending indefinitely.
    rejectComputation?.(e);
    logger.error('Analysis error', { error: e instanceof Error ? e.message : String(e) });
    return errorResponse(e, "analysis");
  }
}
