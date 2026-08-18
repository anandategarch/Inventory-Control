// ============================================================
//  Middleware — protect destructive endpoints
//  Bug #1 fix: Auth middleware
//
//  Auth model: simple token-based via ADMIN_TOKEN env var
//  - Dashboard & GET endpoints (read-only): PUBLIC (no auth)
//  - /api/setup, POST /api/ingest, POST /api/import-drive, POST/DELETE /api/settings,
//    DELETE /api/data, POST/DELETE /api/pic: requires ADMIN_TOKEN
//
//  Client sends: Authorization: Bearer <ADMIN_TOKEN>
//  Or: ?admin_token=<ADMIN_TOKEN> (for browser-accessible /api/setup)
//
//  If ADMIN_TOKEN not set in env → endpoints are PUBLIC (dev mode, backward compat)
// ============================================================
import { NextRequest, NextResponse } from 'next/server';

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
  // GET /api/ingest is also protected (triggers bulk ingestion — DoS / data injection risk).
  const isProtectedMethod =
    pathname === '/api/setup' ||
    PROTECTED_METHODS.includes(method) ||
    (pathname === '/api/ingest' && method === 'GET');
  if (!isProtectedMethod) return NextResponse.next();

  const adminToken = process.env.ADMIN_TOKEN;
  // If no ADMIN_TOKEN set:
  //  - In production: fail-closed — block the destructive endpoint (server misconfigured).
  //  - In dev: allow without auth (backward compat for local dev).
  if (!adminToken) {
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json(
        { success: false, error: 'Server misconfigured: ADMIN_TOKEN not set. Destructive endpoints are blocked in production.' },
        { status: 500 }
      );
    }
    console.warn(`[middleware] ADMIN_TOKEN not set — ${pathname} accessible without auth (dev mode)`);
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
  // Previously: !== short-circuits on first byte mismatch, leaking token info.
  if (!providedToken) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized. Set ADMIN_TOKEN env var and provide via Authorization: Bearer <token> or ?admin_token=<token>.' },
      { status: 401 }
    );
  }
  const tokenValid = constantTimeEqual(providedToken, adminToken);
  if (!tokenValid) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized. Set ADMIN_TOKEN env var and provide via Authorization: Bearer <token> or ?admin_token=<token>.' },
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
  ],
};
