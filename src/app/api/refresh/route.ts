// ============================================================
//  /api/refresh — Invalidate all analysis caches
//  POST: clears AggregationCache + statusCache
//  --------------------------------------------------------
//  Used by client components (e.g. DriveImportDialog) that need
//  to invalidate server-side caches after data mutations, but
//  cannot directly import @/lib/aggregation-cache (server-only)
//  without pulling pg + dns into the client bundle.
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { invalidateAnalysisCache } from '@/lib/aggregation-cache';
import { statusCache } from '@/lib/cache';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { errorResponse } from '@/lib/error-response';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`refresh:${ip}`, RATE_LIMITS.status.maxRequests, RATE_LIMITS.status.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded.' },
        { status: 429 }
      );
    }

    // Clear both caches
    await invalidateAnalysisCache();
    statusCache.clear();

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return errorResponse(e, 'refresh');
  }
}
