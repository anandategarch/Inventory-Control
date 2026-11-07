// ============================================================
//  /api/setup — Database setup endpoint (cross-database compatible)
//  ----------------------------------------------------------
//  Bug 4 fix: Previous version used SQLite-specific DDL (AUTOINCREMENT)
//  which crashes on PostgreSQL (Supabase) with "syntax error at or near AUTOINCREMENT".
//
//  Now: redirect users to use Prisma CLI (npx prisma db push) which is
//  database-agnostic and reads schema.prisma. This endpoint only verifies
//  connectivity and returns guidance.
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { validateQuery, statusQuerySchema } from '@/lib/validation';
import { rateLimit, getClientIP } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const maxDuration = 30; // FIX Phase 1: prevent Vercel timeout

export async function GET(req: NextRequest) {
  const url = new URL(req.url);

  // Sprint 1: Zod input validation (no params expected — reuses empty statusQuerySchema)
  const validation = validateQuery(statusQuerySchema, url.searchParams);
  if (!validation.success) {
    return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
  }

  // FIX (AUDIT8-ROLLBACK-1, Item 13): rate-limit GET /api/setup.
  // This endpoint runs `db.sourceFile.count()` (a real DB round-trip) per
  // request — an attacker spamming it could DOS the connection pool. Other
  // destructive endpoints (data DELETE, settings DELETE, ingest-process
  // DELETE) all have rate limits; setup should too. Bucket: 10 req/min/IP.
  const ip = getClientIP(req);
  const rl = rateLimit(`setup:${ip}`, 10, 60_000);
  if (!rl.allowed) {
    return NextResponse.json({ success: false, error: 'Rate limit.' }, { status: 429 });
  }

  const results: string[] = [];
  // FIX (BUG-HUNT-3-b-1): track DB-check failure so the response no longer
  // claims `success: true` (HTTP 200) when the connectivity check threw.
  let dbOk = true;

  try {
    // Test connection by counting a safe table
    const count = await db.sourceFile.count();
    results.push(`✅ Database connection OK. SourceFile count: ${count}`);
    results.push('All tables are managed by Prisma schema (prisma/schema.prisma).');
    results.push('To reset/recreate schema, run: `bun run db:push` (local) or ensure CI/CD runs `prisma db push` on deploy.');
  } catch (e: unknown) {
    dbOk = false;
    // FIX (BUG-HUNT-3-b-1): the raw Prisma/driver error string (e.g.
    // "Can't reach database server at db.<ref>.supabase.co:5432") exposes
    // the internal DB host, port, and tenant reference. In single-user
    // mode (ADMIN_TOKEN unset — the default) any anonymous caller can hit
    // /api/setup, so this leaks internals to anyone. Gate the verbatim
    // message behind NODE_ENV === 'development' and show a friendly,
    // non-revealing message in production.
    const isDev = process.env.NODE_ENV === 'development';
    const rawMsg = (e instanceof Error ? e.message : String(e));
    const shownMsg = isDev
      ? rawMsg
      : 'Database tidak dapat dijangkau. Periksa DATABASE_URL dan koneksi ke server database.';
    results.push(`❌ Database error: ${shownMsg}`);
    results.push('');
    results.push('To fix:');
    results.push('  1. Ensure DATABASE_URL is set in your environment');
    results.push('  2. Run: bun run db:generate');
    results.push('  3. Run: bun run db:push');
    results.push('');
    results.push('For Vercel deploy:');
    results.push('  - Set DATABASE_URL env var in Vercel dashboard');
    results.push('  - vercel.json buildCommand already includes: bunx prisma generate && bun run next build');
    results.push('  - Run `bun run db:push` locally with DATABASE_URL set to provision tables');
  }

  return NextResponse.json({
    success: dbOk,
    dbUnreachable: !dbOk,
    message: dbOk ? 'Setup check completed' : 'Setup check failed — database unreachable',
    results,
    note: 'Tables are managed by Prisma schema — no raw DDL needed. Use `bun run db:push` to sync schema.',
  });
}
