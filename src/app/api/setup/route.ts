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

export const dynamic = 'force-dynamic';
export const maxDuration = 30; // FIX Phase 1: prevent Vercel timeout

export async function GET(req: NextRequest) {
  const url = new URL(req.url);

  // Sprint 1: Zod input validation (no params expected — reuses empty statusQuerySchema)
  const validation = validateQuery(statusQuerySchema, url.searchParams);
  if (!validation.success) {
    return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
  }

  const results: string[] = [];

  try {
    // Test connection by counting a safe table
    const count = await db.sourceFile.count();
    results.push(`✅ Database connection OK. SourceFile count: ${count}`);
    results.push('All tables are managed by Prisma schema (prisma/schema.prisma).');
    results.push('To reset/recreate schema, run: `bun run db:push` (local) or ensure CI/CD runs `prisma db push` on deploy.');
  } catch (e: unknown) {
    const msg = (e instanceof Error ? e.message : String(e));
    results.push(`❌ Database error: ${msg}`);
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
    success: true,
    message: 'Setup check completed',
    results,
    note: 'Tables are managed by Prisma schema — no raw DDL needed. Use `bun run db:push` to sync schema.',
  });
}
