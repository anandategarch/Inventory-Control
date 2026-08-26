// ============================================================
//  /api/pic — Outlet PIC (Person in Charge) CRUD
//  GET    : list all PIC assignments
//  POST   : upsert PIC { outletCode, pic }
//  DELETE : remove PIC assignment ?outletCode=...
//
//  OutletPIC.outletCode is a string (NOT FK to Outlet.code), so
//  assignment can exist for outlets not yet in Outlet table.
//
//  After mutation: clear statusCache (PIC affects /api/status)
//  + invalidateCache (analysis filters may change) + audit log
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { statusCache } from '@/lib/cache';
import { invalidateAnalysisCache } from '@/lib/aggregation-cache';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { validateQuery, validateBody, picQuerySchema, picPostBodySchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';
export const maxDuration = 30; // FIX Phase 1: prevent Vercel timeout

// ------------------------------------------------------------
//  GET /api/pic — list all PIC assignments
// ------------------------------------------------------------
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);

    // Sprint 1: Zod input validation (outletCode optional — allows filtering)
    const validation = validateQuery(picQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    const pics = await db.outletPIC.findMany({
      orderBy: [{ outletCode: 'asc' }],
      select: { id: true, outletCode: true, pic: true, updatedAt: true },
    });
    return NextResponse.json({ success: true, pics });
  } catch (e: unknown) {
    return NextResponse.json({ success: false, error: (e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}

// ------------------------------------------------------------
//  POST /api/pic — upsert PIC for an outlet
// ------------------------------------------------------------
export async function POST(req: NextRequest) {
  try {
    // FIX (DEEP-AUDIT-API-5): Rate limit PIC mutation endpoint
    const ip = getClientIP(req);
    const rl = rateLimit(`pic:${ip}`, RATE_LIMITS.ingest.maxRequests, RATE_LIMITS.ingest.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded. Tunggu beberapa menit sebelum mencoba lagi.' },
        { status: 429 }
      );
    }

    const body = await req.json().catch(() => ({}));

    // Sprint 1: Zod input validation (replaces inline picPostSchema)
    const validation = validateBody(picPostBodySchema, body);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }
    const { outletCode, pic } = validation.data;

    const result = await db.outletPIC.upsert({
      where: { outletCode },
      update: { pic },
      create: { outletCode, pic },
    });

    // Clear caches — PIC affects /api/status response and analysis filters
    statusCache.clear();
    // FIX H2 (AUDIT-P1): invalidate DB-level AggregationCache after single PIC mutation.
    invalidateAnalysisCache().catch((e) => logger.error("[cache] invalidate failed", { error: e instanceof Error ? e.message : String(e) }));

    await db.auditLog.create({
      data: {
        action: 'PIC_UPDATE',
        detail: `${outletCode} → ${pic}`,
      },
    });

    return NextResponse.json({ success: true, pic: result });
  } catch (e: unknown) {
    return NextResponse.json({ success: false, error: (e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}

// ------------------------------------------------------------
//  DELETE /api/pic?outletCode=... — remove PIC assignment
// ------------------------------------------------------------
export async function DELETE(req: NextRequest) {
  try {
    // FIX (DEEP-AUDIT-API-5): Rate limit PIC delete endpoint
    const ip = getClientIP(req);
    const rl = rateLimit(`pic:${ip}`, RATE_LIMITS.ingest.maxRequests, RATE_LIMITS.ingest.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded. Tunggu beberapa menit sebelum mencoba lagi.' },
        { status: 429 }
      );
    }

    const url = new URL(req.url);

    // Sprint 1: Zod input validation (outletCode required by route logic)
    const validation = validateQuery(picQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    const outletCode = url.searchParams.get('outletCode');
    if (!outletCode || outletCode.length > 50) {
      return NextResponse.json(
        { success: false, error: 'outletCode diperlukan (max 50 karakter)' },
        { status: 400 }
      );
    }

    await db.outletPIC.deleteMany({ where: { outletCode } });

    statusCache.clear();
    // FIX H2 (AUDIT-P1): invalidate DB-level AggregationCache after PIC delete.
    invalidateAnalysisCache().catch((e) => logger.error("[cache] invalidate failed", { error: e instanceof Error ? e.message : String(e) }));

    await db.auditLog.create({
      data: {
        action: 'PIC_DELETE',
        detail: `Outlet ${outletCode}`,
      },
    });

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json({ success: false, error: (e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}
