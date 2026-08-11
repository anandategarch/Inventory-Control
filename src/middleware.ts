// ============================================================
//  Middleware — protect destructive endpoints (/api/setup, /api/ingest, /api/import-drive)
//  Bug #1 fix: Auth middleware
//
//  Auth model: simple token-based via ADMIN_TOKEN env var
//  - Dashboard & GET endpoints (read-only): PUBLIC (no auth)
//  - /api/setup, POST /api/ingest, POST /api/import-drive, POST/DELETE /api/settings: requires ADMIN_TOKEN
//
//  Client sends: Authorization: Bearer <ADMIN_TOKEN>
//  Or: ?admin_token=<ADMIN_TOKEN> (for browser-accessible /api/setup)
//
//  If ADMIN_TOKEN not set in env → endpoints are PUBLIC (dev mode, backward compat)
// ============================================================
import { NextRequest, NextResponse } from 'next/server';

const PROTECTED_PATHS = [
  '/api/setup',
  '/api/ingest',
  '/api/import-drive',
  '/api/settings',
];

const PROTECTED_METHODS = ['POST', 'PUT', 'DELETE', 'PATCH'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const method = req.method;

  // Only protect specific paths
  const isProtectedPath = PROTECTED_PATHS.some(p => pathname.startsWith(p));
  if (!isProtectedPath) return NextResponse.next();

  // GET on /api/settings (read settings) is public; other GETs on protected paths need auth
  // /api/setup is always protected (destructive DDL)
  const isProtectedMethod = pathname === '/api/setup' || PROTECTED_METHODS.includes(method);
  if (!isProtectedMethod) return NextResponse.next();

  const adminToken = process.env.ADMIN_TOKEN;
  // If no ADMIN_TOKEN set → allow (dev mode, backward compat)
  if (!adminToken) {
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

  if (providedToken !== adminToken) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized. Set ADMIN_TOKEN env var and provide via Authorization: Bearer <token> or ?admin_token=<token>.' },
      { status: 401 }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/api/setup/:path*', '/api/ingest/:path*', '/api/import-drive/:path*', '/api/settings/:path*'],
};
