// ============================================================
//  /api/pic/import — bulk import PIC assignments from CSV paste
//  POST body: { csvContent: "RESTO;PIC\n1030.BDGSET;Budi\n..." }
//
//  Supports both semicolon (;) and comma (,) delimiters.
//  Skips header row where first column equals "RESTO" (case-insensitive).
//
//  Returns: { success: true, imported: N, errors: [...] }
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { statusCache } from '@/lib/cache';
import { invalidateAnalysisCache } from '@/lib/aggregation-cache';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { z } from 'zod';
import { validateBody } from '@/lib/validation';
import { errorResponse } from '@/lib/error-response';

export const dynamic = 'force-dynamic';

const importSchema = z
  .object({
    csvContent: z.string().min(1),
  })
  .strict();

export async function POST(req: NextRequest) {
  try {
    // FIX (DEEP-AUDIT-API-5): Rate limit PIC bulk import endpoint
    const ip = getClientIP(req);
    const rl = rateLimit(`pic-import:${ip}`, RATE_LIMITS.ingest.maxRequests, RATE_LIMITS.ingest.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded. Import adalah operasi berat, tunggu beberapa menit.' },
        { status: 429 }
      );
    }

    const body = await req.json().catch(() => ({}));

    // Sprint 1: Zod input validation (uses validateBody helper, keeps existing schema)
    const validation = validateBody(importSchema, body);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }
    const { csvContent } = validation.data;

    // Strip BOM, normalize line endings, drop empty lines
    const lines = csvContent
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    let imported = 0;
    const errors: string[] = [];
    const picRecords: Array<{ outletCode: string; pic: string }> = [];

    for (const line of lines) {
      const parts = line.includes(';') ? line.split(';') : line.split(',');
      const outletCode = parts[0]?.trim().replace(/"/g, '');
      const pic = parts[1]?.trim().replace(/"/g, '');

      if (!outletCode || !pic) continue;
      if (outletCode.toUpperCase() === 'RESTO' || pic.toUpperCase() === 'PIC') continue;
      if (outletCode.length > 50 || pic.length > 100) {
        errors.push(`${outletCode}: panjang melebihi batas (max 50/100)`);
        continue;
      }
      picRecords.push({ outletCode, pic });
    }

    // Batch: delete all existing + create all new (2 queries instead of 339)
    if (picRecords.length > 0) {
      try {
        // Get existing outletCodes to update (not delete all — only update existing + create new)
        const existingCodes = picRecords.map(r => r.outletCode);
        const existingPICs = await db.outletPIC.findMany({
          where: { outletCode: { in: existingCodes } },
          select: { outletCode: true },
        });
        const existingSet = new Set(existingPICs.map(p => p.outletCode));

        // Split into updates and creates
        const toUpdate = picRecords.filter(r => existingSet.has(r.outletCode));
        const toCreate = picRecords.filter(r => !existingSet.has(r.outletCode));

        // Batch create new entries
        let actuallyCreated = 0;
        if (toCreate.length > 0) {
          // FIX DB2-5: skipDuplicates is PostgreSQL-only — try/catch fallback for SQLite
          try {
            const result = await db.outletPIC.createMany({
              data: toCreate,
              skipDuplicates: true,
            });
            actuallyCreated = result.count;
          } catch {
            // SQLite fallback: insert one by one, skip duplicates manually
            for (const rec of toCreate) {
              try {
                await db.outletPIC.create({ data: rec });
                actuallyCreated++;
              } catch {}
            }
          }
        }

        // Batch update existing entries (use raw SQL for batch upsert)
        if (toUpdate.length > 0) {
          // Prisma doesn't support batch update, use transaction
          await db.$transaction(
            toUpdate.map(r =>
              db.outletPIC.update({
                where: { outletCode: r.outletCode },
                data: { pic: r.pic },
              })
            )
          );
        }

        // FIX (BUG 10): Use actual created count, not picRecords.length
        // (skipDuplicates may silently drop race-condition collisions)
        imported = actuallyCreated + toUpdate.length;
      } catch (e: unknown) {
        errors.push(`Batch error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Clear caches — bulk PIC change affects status + analysis filters
    statusCache.clear();
    // FIX H2 (AUDIT-5/8): invalidate DB-level AggregationCache after PIC bulk import.
    // Analysis route filters by `pic` param → cached response would reflect old PIC
    // assignments for up to 5 min (TTL) without this invalidation.
    invalidateAnalysisCache().catch((e) => logger.error("[cache] invalidate failed", { error: e instanceof Error ? e.message : String(e) }));

    // FIX (AUDIT8-ROLLBACK-1, Item 11): fire-and-forget — never await audit log writes.
    db.auditLog.create({
      data: {
        action: 'PIC_IMPORT',
        detail: `${imported} PIC entries imported (${errors.length} errors)`,
      },
    }).catch(() => {});

    return NextResponse.json({
      success: true,
      imported,
      errors: errors.slice(0, 10),
      errorCount: errors.length,
    });
  } catch (e: unknown) {
    return errorResponse(e, "pic-import");
  }
}
