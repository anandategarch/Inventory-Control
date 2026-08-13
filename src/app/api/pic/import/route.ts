// ============================================================
//  /api/pic/import — bulk import PIC assignments from CSV paste
//  POST body: { csvContent: "RESTO;PIC\n1030.BDGSET;Budi\n..." }
//
//  Supports both semicolon (;) and comma (,) delimiters.
//  Skips header row where first column equals "RESTO" (case-insensitive).
//
//  Returns: { success: true, imported: N, errors: [...] }
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { analysisCache, statusCache } from '@/lib/cache';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const importSchema = z
  .object({
    csvContent: z.string().min(1),
  })
  .strict();

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const parsed = importSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.message },
        { status: 400 }
      );
    }
    const { csvContent } = parsed.data;

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
          const result = await db.outletPIC.createMany({
            data: toCreate,
            skipDuplicates: true,
          });
          actuallyCreated = result.count;
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
      } catch (e: any) {
        errors.push(`Batch error: ${e?.message || 'gagal batch insert'}`);
      }
    }

    // Clear caches — bulk PIC change affects status + analysis filters
    analysisCache.clear();
    statusCache.clear();

    await db.auditLog.create({
      data: {
        action: 'PIC_IMPORT',
        detail: `${imported} PIC entries imported (${errors.length} errors)`,
      },
    });

    return NextResponse.json({
      success: true,
      imported,
      errors: errors.slice(0, 10),
      errorCount: errors.length,
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
