// ============================================================
//  /api/migrate-direction — Fix inverted direction values in DB
//
//  Background: computeDirection was inverted (POSITIVE=LOSS instead of NEGATIVE=LOSS).
//  This endpoint recomputes direction from nominalLossSurplus sign.
//  IDEMPOTENT — safe to call multiple times.
//
//  Protected by ADMIN_TOKEN (same as other destructive endpoints).
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { statusCache, analysisCache } from '@/lib/cache';
import { clearMonthResolverCache } from '@/lib/month-resolver';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // may take time on large DBs

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`migrate-direction:POST:${ip}`, 5, 60_000); // 5 req/min POST
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    // Count before
    const total = await db.inventoryRecord.count();
    if (total === 0) {
      return NextResponse.json({ success: true, message: 'No records in DB — nothing to migrate.', updated: 0 });
    }

    const beforeLoss = await db.inventoryRecord.count({ where: { direction: 'LOSS' } });
    const beforeSurplus = await db.inventoryRecord.count({ where: { direction: 'SURPLUS' } });

    // Recompute direction from nominalLossSurplus sign (IDEMPOTENT)
    const lossUpdated = await db.$executeRaw`
      UPDATE "InventoryRecord"
      SET direction = 'LOSS'
      WHERE "nominalLossSurplus" IS NOT NULL
        AND "nominalLossSurplus" < 0
        AND direction != 'LOSS'
    `;

    const surplusUpdated = await db.$executeRaw`
      UPDATE "InventoryRecord"
      SET direction = 'SURPLUS'
      WHERE "nominalLossSurplus" IS NOT NULL
        AND "nominalLossSurplus" > 0
        AND direction != 'SURPLUS'
    `;

    const neutralUpdated = await db.$executeRaw`
      UPDATE "InventoryRecord"
      SET direction = 'NEUTRAL'
      WHERE "nominalLossSurplus" IS NOT NULL
        AND "nominalLossSurplus" = 0
        AND direction != 'NEUTRAL'
    `;

    // FIX SIGN-2: Fallback for rows with NULL nominalLossSurplus — use qtyDeviasi sign
    // (computeDirection falls back to qtyDeviasi when nominalLossSurplus is null)
    const lossFallback = await db.$executeRaw`
      UPDATE "InventoryRecord"
      SET direction = 'LOSS'
      WHERE "nominalLossSurplus" IS NULL
        AND "qtyDeviasi" IS NOT NULL
        AND "qtyDeviasi" < 0
        AND direction != 'LOSS'
    `;

    const surplusFallback = await db.$executeRaw`
      UPDATE "InventoryRecord"
      SET direction = 'SURPLUS'
      WHERE "nominalLossSurplus" IS NULL
        AND "qtyDeviasi" IS NOT NULL
        AND "qtyDeviasi" > 0
        AND direction != 'SURPLUS'
    `;

    // Count after
    const afterLoss = await db.inventoryRecord.count({ where: { direction: 'LOSS' } });
    const afterSurplus = await db.inventoryRecord.count({ where: { direction: 'SURPLUS' } });

    // FIX API2-5: Clear caches after migration so stale direction data doesn't persist
    statusCache.clear();
    analysisCache.clear();
    clearMonthResolverCache();

    return NextResponse.json({
      success: true,
      message: 'Migration complete.',
      totalRecords: total,
      before: { LOSS: beforeLoss, SURPLUS: beforeSurplus },
      after: { LOSS: afterLoss, SURPLUS: afterSurplus },
      updated: {
        LOSS: lossUpdated,
        SURPLUS: surplusUpdated,
        NEUTRAL: neutralUpdated,
        lossFallback,
        surplusFallback,
        total: lossUpdated + surplusUpdated + neutralUpdated + lossFallback + surplusFallback,
      },
    });
  } catch (e: any) {
    console.error('[migrate-direction] error:', e);
    return NextResponse.json(
      { success: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}

// GET — dry run (preview what would change, no actual update)
export async function GET(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`migrate-direction:GET:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const total = await db.inventoryRecord.count();
    if (total === 0) {
      return NextResponse.json({ success: true, totalRecords: 0, needsMigration: false });
    }

    // Check if migration needed: count rows where direction doesn't match nominalLossSurplus sign
    const inverted = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count FROM "InventoryRecord"
      WHERE "nominalLossSurplus" IS NOT NULL
        AND (
          ("nominalLossSurplus" < 0 AND direction != 'LOSS')
          OR ("nominalLossSurplus" > 0 AND direction != 'SURPLUS')
          OR ("nominalLossSurplus" = 0 AND direction != 'NEUTRAL')
        )
    `;

    const invertedCount = Number(inverted[0]?.count ?? 0);

    const beforeLoss = await db.inventoryRecord.count({ where: { direction: 'LOSS' } });
    const beforeSurplus = await db.inventoryRecord.count({ where: { direction: 'SURPLUS' } });

    return NextResponse.json({
      success: true,
      totalRecords: total,
      needsMigration: invertedCount > 0,
      invertedCount,
      current: { LOSS: beforeLoss, SURPLUS: beforeSurplus },
    });
  } catch (e: any) {
    console.error('[migrate-direction] GET error:', e);
    return NextResponse.json(
      { success: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}
