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
import { db } from '@/lib/db';
import { setCached } from '@/lib/aggregation-cache';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { validateAndResolve } from './services/validate-and-resolve';
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
    if (records.currSlim.length === 0) {
      rejectComputation?.(new Error(`No records found for ${params.month} / ${params.week} with given filters.`));
      return NextResponse.json({
        success: false,
        message: `No records found for ${params.month} / ${params.week} with given filters.`,
      }, { status: 404 });
    }

    // Stage 3 — run 4 parallel SQL aggregate batches + early-fired promises.
    const queries = await runQueries(params, records);

    // Stage 4 — post-process (rule flags, variance, historical analysis, patterns).
    const processed = await postProcess(params, records, queries);

    // Stage 5 — assemble the final JSON response.
    const result = assembleResponse(params, records, queries, processed);

    // FIX Medium #1: Store result in DB cache (fire-and-forget, non-blocking).
    // Next request with same filter params will hit cache (<100ms vs 6-8s).
    setCached(cacheKey, result);

    // FIX M3: Resolve the in-flight Promise so concurrent requests get the result.
    resolveComputation(result);

    // ============================================================
    //  P2 fix: Fire-and-forget audit log — don't block response on DB write.
    //  Response is already assembled; audit log is non-critical telemetry.
    //  Saves ~50-100ms (DB round-trip) per request.
    // ============================================================
    db.auditLog.create({
      data: {
        action: 'ANALYSIS',
        // FIX (BUG-BE-10): include kelompok + pic in audit log for traceability
        detail: `${params.month}/${params.week} vs ${params.prevWeek} | area=${params.area || 'ALL'} kelompok=${params.kelompok || 'ALL'} outlet=${params.outletCode || 'ALL'} pic=${params.pic || 'ALL'} | ${records.currSlim.length} records`,
        duration: Date.now() - params.startedAt,
      },
    }).catch((e) => {
      logger.error("Audit log write failed (non-blocking)", { error: e instanceof Error ? e.message : String(e) });
    });

    return NextResponse.json(result, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    // FIX (DEEP-AUDIT-ZEROS): reject the in-flight Promise so concurrent
    // requests awaiting it don't hang forever. Previously only resolve was
    // called (on success), so errors left the Promise pending indefinitely.
    rejectComputation?.(e);
    logger.error('Analysis error', { error: e instanceof Error ? e.message : String(e) });
    return errorResponse(e, "analysis");
  }
}
