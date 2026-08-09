// ============================================================
//  GET /api/health/db
//  Diagnostic endpoint — verifies that Prisma can reach the
//  configured database and reports which env vars are seen at
//  runtime. NEVER echoes secret values.
// ============================================================
import { NextResponse } from 'next/server';
import { db, getDbEnvStatus } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const env = getDbEnvStatus();

  let connectionOk = false;
  let connectionError: string | null = null;
  let sampleCount: number | null = null;

  try {
    // @ts-ignore
    const rows = (await db.$queryRawUnsafe('SELECT 1 as ok')) as Array<{ ok: number }>;
    connectionOk = Array.isArray(rows) && rows[0]?.ok === 1;

    try {
      // @ts-ignore
      sampleCount = await db.inventoryRecord.count();
    } catch {
      sampleCount = null;
    }
  } catch (e) {
    connectionError = e instanceof Error ? e.message : String(e);
  }

  const status = connectionOk ? 200 : 500;

  return NextResponse.json(
    {
      ok: connectionOk,
      env: {
        NODE_ENV: process.env.NODE_ENV ?? null,
        VERCEL_ENV: process.env.VERCEL_ENV ?? null,
        hasDatabaseUrl: env.hasDatabaseUrl,
        databaseUrlScheme: env.databaseUrlScheme,
        hasAuthToken: env.hasAuthToken,
        mode: env.mode,
        warnings: env.warnings,
      },
      inventoryRecordCount: sampleCount,
      connectionError,
      hint: connectionOk
        ? 'DB reachable. If dashboard still empty, data was likely imported to a different DB.'
        : !env.hasDatabaseUrl
          ? 'DATABASE_URL is missing at runtime. Set it in Vercel → Settings → Environment Variables → enable for Production/Preview/Development → redeploy.'
          : !env.hasAuthToken && env.databaseUrlScheme !== 'file'
            ? 'DATABASE_AUTH_TOKEN is missing. Turso remote DBs require it. Add it in Vercel and redeploy.'
            : 'DB unreachable. Verify the Turso URL/token pair and that the DB is not paused.',
    },
    { status },
  );
}
