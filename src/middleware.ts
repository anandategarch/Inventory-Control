// ============================================================
//  Middleware — protect destructive endpoints
//
//  Auth model: simple token-based via ADMIN_TOKEN env var
//  - Dashboard & GET endpoints (read-only): PUBLIC (no auth)
//  - /api/setup, POST /api/ingest, GET /api/ingest (Refresh Data), POST /api/import-drive,
//    POST/DELETE /api/settings, DELETE /api/data, POST/DELETE /api/pic,
//    POST /api/migrate-direction, POST /api/refresh: requires ADMIN_TOKEN
//
//  Client sends: Authorization: Bearer <ADMIN_TOKEN>
//  Or: ?admin_token=<ADMIN_TOKEN> (for browser-accessible /api/setup)
//
//  FIX (AUDIT-ANIMATION-REVERT): fail-open when ADMIN_TOKEN not set (single-user app, no auth UI).
//  When ADMIN_TOKEN IS set, all mutations require it via Bearer header or ?admin_token= query param.
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';

// FIX: `crypto.timingSafeEqual` is a Node.js module not available in Edge Runtime.
// Implement a runtime-agnostic constant-time string comparison (XOR + accumulate).
// This prevents timing attacks without depending on Node's `crypto` module.
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

const PROTECTED_PATHS = [
  '/api/setup',
  '/api/ingest',
  '/api/ingest-upload',
  '/api/ingest-process',
  '/api/import-drive',
  '/api/settings',
  '/api/data',
  '/api/pic',
  '/api/migrate-direction',
  // FIX (BUG-3-c R-1): POST /api/refresh nukes the whole AggregationCache
  // (invalidateAnalysisCache) — it was the ONLY destructive mutation route
  // missing from this list, so anyone could spam cache flushes and force
  // full cold recomputes (6-8s each) on every dashboard user. Same gating
  // model as the siblings: POST-only + fail-open when ADMIN_TOKEN is unset
  // (single-user mode) — no access is blocked by default.
  '/api/refresh',
];

const PROTECTED_METHODS = ['POST', 'PUT', 'DELETE', 'PATCH'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const method = req.method;

  // Only protect specific paths
  const isProtectedPath = PROTECTED_PATHS.some(p => pathname.startsWith(p));
  if (!isProtectedPath) return NextResponse.next();

  // GET on /api/settings, /api/data, /api/pic (read-only listings) is public;
  // /api/setup is always protected (destructive DDL);
  // FIX (AUDIT-SECURITY-PERF C2): GET /api/ingest (Refresh Data) is now PROTECTED —
  // was public, anyone could trigger bulk re-ingest of 272K records.
  const isProtectedMethod =
    pathname === '/api/setup' ||
    pathname === '/api/ingest' || // protect GET too (Refresh Data)
    PROTECTED_METHODS.includes(method);
  if (!isProtectedMethod) return NextResponse.next();

  const adminToken = process.env.ADMIN_TOKEN;
  // SINGLE-USER MODE: When ADMIN_TOKEN is not set, fail-open (allow all mutations).
  // This is a single-user app with no auth UI — requiring ADMIN_TOKEN would block
  // the user from using the app entirely (no way to send Bearer token from browser).
  //
  // If ADMIN_TOKEN IS set, all mutations require it via Bearer header or ?admin_token=.
  // Set ADMIN_TOKEN in .env if you expose the app publicly (multi-user or internet-facing).
  if (!adminToken) {
    logger.warn(`ADMIN_TOKEN not set — ${pathname} accessible without auth (single-user mode)`);
    return NextResponse.next();
  }

  // Check Authorization header
  const authHeader = req.headers.get('authorization');
  let providedToken: string | null = null;
  if (authHeader?.startsWith('Bearer ')) {
    providedToken = authHeader.slice(7);
  }
  // Fallback: query param (for browser-accessible endpoints like /api/setup)
  if (!providedToken) {
    providedToken = req.nextUrl.searchParams.get('admin_token');
  }

  // FIX (BUG 8): Use constant-time comparison to prevent timing attacks.
  if (!providedToken) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized. Set ADMIN_TOKEN env var and provide via Authorization: Bearer <token> or ?admin_token=<token>.' },
      { status: 401 }
    );
  }
  const tokenValid = constantTimeEqual(providedToken, adminToken);
  if (!tokenValid) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized. Invalid token.' },
      { status: 401 }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/api/setup/:path*',
    '/api/ingest/:path*',
    '/api/ingest-upload/:path*',
    '/api/ingest-process/:path*',
    '/api/import-drive/:path*',
    '/api/settings/:path*',
    '/api/data/:path*',
    '/api/pic/:path*',
    '/api/migrate-direction/:path*',
    // FIX (BUG-3-c R-1): the middleware never ran for /api/refresh, so the
    // PROTECTED_PATHS entry above was unreachable for it.
    '/api/refresh/:path*',
  ],
};
