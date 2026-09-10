// ============================================================
//  /api/compliance — "Kontrol & Kepatuhan" analysis
//  GET: ?month=&week=&area=&kelompok=&outlet=&pic=
//
//  Returns six analytical lenses for the selected period in ONE
//  response (single scan — see queries/compliance.ts):
//    summary             — grand totals + headline rates
//    toleranceItems      — per-item tolerance breach ranking
//    tolerancePriority   — items WITHOUT tolerance, ranked by
//                          un-toleranced nominal deviation
//                          (action list: "set tolerance on these first")
//    residualOutlets     — outlets ranked by UNEXPLAINED deviation
//                          (residual = deviasi - waste - susut - trial)
//    salesOutlets        — outlets ranked by |deviasi| / penjualan
//    categories          — BAHAN vs PACKAGING split
//    transferSignals     — item×area with BOTH loss outlets AND
//                          surplus outlets in the same week
//                          (cross-outlet stock-transfer indicator)
//    crossAreaPairs      — same item, DIFFERENT areas: loss
//                          concentrated in one area while surplus
//                          appears in another (cross-area mismatch
//                          pairs — derived from the same transfer
//                          rows, zero extra scanning)
//
//  Pattern (per CONVENTIONS.md — flip-ranking / pareto precedent):
//    - force-dynamic + maxDuration=60 (single scan + aggregates)
//    - Rate limiting (30 req/min per IP)
//    - Zod validation (inline schema)
//    - DB cache via withCacheAndDedup (5-min TTL; handleRefresh
//      invalidates the FE ['compliance'] queryKey, ingest TTL
//      expiry covers server-side freshness)
//    - Threshold parity: RuntimeThresholds loaded via
//      getRuntimeThresholds() so breach semantics can never drift
//      from the rule engine (rule-evaluation.ts)
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '@/lib/logger';
import { rateLimit, getClientIP } from '@/lib/rate-limit';
import { resolvePICOutletCodes } from '@/lib/pic-resolver';
import { resolveKelompokOutletCodes } from '@/lib/kelompok-resolver';
import { getRuntimeThresholds } from '@/lib/settings';
import {
  queryComplianceDashboard,
  type ComplianceResult,
} from '@/lib/queries/compliance';
import { validateQuery } from '@/lib/validation';
import { CACHE_ANALYSIS } from '@/lib/cache-headers';
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';
import { errorResponse } from '@/lib/error-response';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const COMPLIANCE_CACHE_TTL = 5 * 60 * 1000; // 5 min — matches analysis / peer routes

// Zod schema — month + week REQUIRED (single-period analysis),
// area/kelompok/outlet/pic optional filters. Same regexes as
// flip-ranking / analysis family.
const complianceQuerySchema = z.object({
  month: z.string().regex(/^[A-Za-z]+\s+20\d{2}$/),
  week: z.string().regex(/^WEEK\s+[0-9]+$/i),
  area: z.string().min(1).max(50).optional(),
  kelompok: z.string().min(1).max(50).optional(),
  outlet: z.string().min(1).max(50).optional(),
  pic: z.string().min(1).max(100).optional(),
}).strict();

/**
 * Resolve kelompok + PIC filters into a single combined outletCodes array.
 * Same pattern as /api/flip-ranking (resolveOutletCodeFilters):
 *   - { codes: null, noMatch: false } when no filter applied
 *   - { codes: string[], noMatch: false } when filters resolve
 *   - { codes: null, noMatch: true } when a filter matches zero outlets
 *     (sentinel ['__NO_MATCH__']) or the kelompok∩PIC intersection is empty
 */
async function resolveOutletCodeFilters(
  kelompok: string | null,
  pic: string | null,
): Promise<{ codes: string[] | null; noMatch: boolean }> {
  const [kelompokCodes, picCodes] = await Promise.all([
    kelompok ? resolveKelompokOutletCodes(kelompok) : Promise.resolve<string[]>([]),
    resolvePICOutletCodes(pic),
  ]);

  const k = kelompokCodes && kelompokCodes.length > 0 ? kelompokCodes : null;
  const p = picCodes && picCodes.length > 0 ? picCodes : null;

  if (k && k.length === 1 && k[0] === '__NO_MATCH__') {
    return { codes: null, noMatch: true };
  }
  if (p && p.length === 1 && p[0] === '__NO_MATCH__') {
    return { codes: null, noMatch: true };
  }

  if (k && p) {
    const pSet = new Set(p);
    const intersection = k.filter((c) => pSet.has(c));
    if (intersection.length === 0) {
      return { codes: null, noMatch: true };
    }
    return { codes: intersection, noMatch: false };
  }

  if (k) return { codes: k, noMatch: false };
  if (p) return { codes: p, noMatch: false };

  return { codes: null, noMatch: false };
}

/** Empty result with the full response shape (filters matched no outlets). */
function emptyComplianceResult(): ComplianceResult {
  return {
    summary: {
      nRecords: 0, nOutlets: 0, nItems: 0, nWithTolerance: 0, nEval: 0,
      nBreach: 0, nBreachHigh: 0, nNotSetHigh: 0, nNoTolerance: 0,
      breachRatePct: 0, noTolerancePct: 0, residualSharePct: 0,
      residualNominalAbs: 0, absNominalDev: 0,
      transferSignalCount: 0, transferMatchNominalTotal: 0,
      crossAreaSignalCount: 0, crossAreaMatchNominalTotal: 0,
    },
    toleranceItems: [],
    tolerancePriority: [],
    residualOutlets: [],
    salesOutlets: [],
    categories: [],
    transferSignals: [],
    crossAreaPairs: [],
  };
}

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    // 1. Rate limit (per-IP + per-route namespace) — 30 req/min
    const ip = getClientIP(req);
    const rl = rateLimit(`compliance:${ip}`, 30, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded.' },
        { status: 429 },
      );
    }

    const url = new URL(req.url);

    // 2. Zod validation (strict — rejects unknown query params)
    const validation = validateQuery(complianceQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 },
      );
    }
    const params = validation.data;

    const month = params.month;
    const week = params.week;
    const area = params.area ?? null;
    const kelompok = params.kelompok ?? null;
    const outletCode = params.outlet ?? null;
    const pic = params.pic ?? null;

    // 3. DB cache key — includes ALL response-affecting params
    const cacheKey = buildCacheKey({
      route: 'compliance',
      month,
      week,
      area: area && area !== 'all' ? area : null,
      kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
      outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
      pic,
    });

    // 4. Compute (or return cached/stale)
    const { data: result, cached, stale } = await withCacheAndDedup<ComplianceResult>(
      cacheKey,
      COMPLIANCE_CACHE_TTL,
      async () => {
        // Parallel resolve kelompok + PIC → combined outletCodes
        const { codes: outletCodes, noMatch } = await resolveOutletCodeFilters(
          kelompok && kelompok !== 'all' ? kelompok : null,
          pic,
        );
        if (noMatch) {
          return emptyComplianceResult();
        }

        // Threshold parity with the rule engine (rule-evaluation.ts)
        const thresholds = await getRuntimeThresholds();

        return queryComplianceDashboard(
          week,
          month,
          {
            area: area && area !== 'all' ? area : null,
            kelompok: null, // already resolved to outletCodes above
            outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
            itemName: null, // cross-item analysis — never item-filtered
            picOutletCodes: outletCodes,
          },
          {
            stdDevBomPct: thresholds.STD_DEVIASI_BOM_PCT,
            residualWarnPct: thresholds.RESIDUAL_LOSS_WARN_PCT,
            residualHighPct: thresholds.RESIDUAL_LOSS_HIGH_PCT,
          },
        );
      },
    );

    // 5. Response with cache flags (CONVENTIONS §2)
    const responsePayload = {
      success: true,
      ...result,
      durationMs: Date.now() - startedAt,
      ...(cached ? { cached: true } : {}),
      ...(stale ? { stale: true } : {}),
    };

    return NextResponse.json(responsePayload, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    logger.error('[compliance] error:', {
      error: e instanceof Error ? e.message : String(e),
    });
    return errorResponse(e, 'compliance', 500);
  }
}
