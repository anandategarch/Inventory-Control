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
//  + analysisCache (filters may change) + audit log
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { analysisCache, statusCache } from '@/lib/cache';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const picPostSchema = z
  .object({
    outletCode: z.string().trim().min(1).max(50),
    pic: z.string().trim().min(1, 'PIC tidak boleh kosong').max(100),
  })
  .strict();

// ------------------------------------------------------------
//  GET /api/pic — list all PIC assignments
// ------------------------------------------------------------
export async function GET() {
  try {
    const pics = await db.outletPIC.findMany({
      orderBy: [{ outletCode: 'asc' }],
      select: { id: true, outletCode: true, pic: true, updatedAt: true },
    });
    return NextResponse.json({ success: true, pics });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
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
    const parsed = picPostSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.message },
        { status: 400 }
      );
    }
    const { outletCode, pic } = parsed.data;

    const result = await db.outletPIC.upsert({
      where: { outletCode },
      update: { pic },
      create: { outletCode, pic },
    });

    // Clear caches — PIC affects /api/status response and analysis filters
    analysisCache.clear();
    statusCache.clear();

    await db.auditLog.create({
      data: {
        action: 'PIC_UPDATE',
        detail: `${outletCode} → ${pic}`,
      },
    });

    return NextResponse.json({ success: true, pic: result });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
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
    const outletCode = url.searchParams.get('outletCode');
    if (!outletCode || outletCode.length > 50) {
      return NextResponse.json(
        { success: false, error: 'outletCode diperlukan (max 50 karakter)' },
        { status: 400 }
      );
    }

    await db.outletPIC.deleteMany({ where: { outletCode } });

    analysisCache.clear();
    statusCache.clear();

    await db.auditLog.create({
      data: {
        action: 'PIC_DELETE',
        detail: `Outlet ${outletCode}`,
      },
    });

    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
