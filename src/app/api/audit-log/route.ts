// ============================================================
//  /api/audit-log
//  GET: ?limit=100&page=1&action=
//  Returns audit log entries (admin/forensic trail).
//  Zombie revival: AuditLog model had 11 write sites, 0 reads — now surfaced.
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { CACHE_METADATA } from '@/lib/cache-headers';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  page: z.coerce.number().int().min(1).optional(),
  // API-05: Enum-validate action — prevents silent empty results on typo
  action: z.enum([
    'ANALYSIS', 'INGEST', 'INGEST_UPLOAD', 'INGEST_WEEK', 'INGEST_ALL_WEEKS',
    'IMPORT_DRIVE', 'DATA_DELETE', 'PIC_UPDATE', 'PIC_DELETE', 'PIC_IMPORT',
    'SETTINGS_UPDATE', 'SETTINGS_RESET', 'MIGRATE_DIRECTION',
  ]).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`audit-log:${ip}`, RATE_LIMITS.status.maxRequests, RATE_LIMITS.status.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);
    const params = Object.fromEntries(url.searchParams.entries());
    const parsed = querySchema.safeParse(params);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: 'Invalid params' }, { status: 400 });
    }

    const limit = parsed.data.limit ?? 100;
    const page = parsed.data.page ?? 1;
    const skip = (page - 1) * limit;

    const where = parsed.data.action ? { action: parsed.data.action } : {};

    const [entries, total] = await Promise.all([
      db.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip,
      }),
      db.auditLog.count({ where }),
    ]);

    return NextResponse.json({
      success: true,
      entries,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    }, { headers: CACHE_METADATA });
  } catch (e: unknown) {
    logger.error('[audit-log] error', { error: e instanceof Error ? e.message : String(e) });
    const isDev = process.env.NODE_ENV === 'development';
    return NextResponse.json(
      { success: false, error: isDev ? (e instanceof Error ? e.message : String(e)) : 'Internal server error' },
      { status: 500 },
    );
  }
}
