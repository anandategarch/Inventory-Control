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

    for (const line of lines) {
      const parts = line.includes(';') ? line.split(';') : line.split(',');
      const outletCode = parts[0]?.trim().replace(/"/g, '');
      const pic = parts[1]?.trim().replace(/"/g, '');

      if (!outletCode || !pic) {
        // Skip blank cells
        continue;
      }
      // Skip header rows (common in PIC.csv: "RESTO;PIC")
      if (outletCode.toUpperCase() === 'RESTO' || pic.toUpperCase() === 'PIC') {
        continue;
      }
      if (outletCode.length > 50 || pic.length > 100) {
        errors.push(`${outletCode}: panjang melebihi batas (max 50/100)`);
        continue;
      }

      try {
        await db.outletPIC.upsert({
          where: { outletCode },
          update: { pic },
          create: { outletCode, pic },
        });
        imported++;
      } catch (e: any) {
        errors.push(`${outletCode}: ${e?.message || 'gagal upsert'}`);
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
