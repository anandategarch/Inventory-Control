// ============================================================
//  /api/migrate-direction — Fix inverted direction values in DB
//
//  Background: computeDirection was inverted (POSITIVE=LOSS instead of NEGATIVE=LOSS).
//  This endpoint recomputes direction from nominalLossSurplus sign.
//  IDEMPOTENT — safe to call multiple times.
//
//  Protected by ADMIN_TOKEN (same as other destructive endpoints).
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { statusCache } from '@/lib/cache';
import { invalidateAnalysisCache } from '@/lib/aggregation-cache';
import { clearMonthResolverCache } from '@/lib/month-resolver';
import { validateQuery, migrateDirectionQuerySchema } from '@/lib/validation';
import { withStatementTimeout } from '@/lib/queries/shared';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // may take time on large DBs

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`migrate-direction:POST:${ip}`, 5, 60_000); // 5 req/min POST
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);

    // Sprint 1: Zod input validation (no params expected)
    const validation = validateQuery(migrateDirectionQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    // Count before
    const total = await db.inventoryRecord.count();
    if (total === 0) {
      return NextResponse.json({ success: true, message: 'No records in DB — nothing to migrate.', updated: 0 });
    }

    const beforeLoss = await db.inventoryRecord.count({ where: { direction: 'LOSS' } });
    const beforeSurplus = await db.inventoryRecord.count({ where: { direction: 'SURPLUS' } });

    // DA-02 FIX: Wrap all 5 UPDATEs in a single transaction — prevents partial
    // migration if one fails (e.g., DB timeout, connection drop). Without this,
    // a failure midway leaves the DB with inconsistent direction values.
    const [lossUpdated, surplusUpdated, neutralUpdated, lossFallback, surplusFallback] = await db.$transaction([
      db.$executeRaw`
        UPDATE "InventoryRecord"
        SET direction = 'LOSS'
        WHERE "nominalLossSurplus" IS NOT NULL
          AND "nominalLossSurplus" < 0
          AND direction != 'LOSS'
      `,
      db.$executeRaw`
        UPDATE "InventoryRecord"
        SET direction = 'SURPLUS'
        WHERE "nominalLossSurplus" IS NOT NULL
          AND "nominalLossSurplus" > 0
          AND direction != 'SURPLUS'
      `,
      db.$executeRaw`
        UPDATE "InventoryRecord"
        SET direction = 'NEUTRAL'
        WHERE "nominalLossSurplus" IS NOT NULL
          AND "nominalLossSurplus" = 0
          AND direction != 'NEUTRAL'
      `,
      // FIX SIGN-2: Fallback for rows with NULL nominalLossSurplus — use qtyDeviasi sign
      db.$executeRaw`
        UPDATE "InventoryRecord"
        SET direction = 'LOSS'
        WHERE "nominalLossSurplus" IS NULL
          AND "qtyDeviasi" IS NOT NULL
          AND "qtyDeviasi" < 0
          AND direction != 'LOSS'
      `,
      db.$executeRaw`
        UPDATE "InventoryRecord"
        SET direction = 'SURPLUS'
        WHERE "nominalLossSurplus" IS NULL
          AND "qtyDeviasi" IS NOT NULL
          AND "qtyDeviasi" > 0
          AND direction != 'SURPLUS'
      `,
    ]);

    // Count after
    const afterLoss = await db.inventoryRecord.count({ where: { direction: 'LOSS' } });
    const afterSurplus = await db.inventoryRecord.count({ where: { direction: 'SURPLUS' } });

    // FIX API2-5: Clear caches after migration so stale direction data doesn't persist
    statusCache.clear();
    // FIX Medium #1: invalidate DB-level AggregationCache too.
    invalidateAnalysisCache().catch((e) => logger.error("[cache] invalidate failed", { error: e instanceof Error ? e.message : String(e) }));
    clearMonthResolverCache();

    // FIX (AUDIT-SECURITY-PERF D5): add audit log — this mutates up to 100% of
    // InventoryRecord rows but wrote no audit trail. Every other mutation route logs.
    const totalUpdated = lossUpdated + surplusUpdated + neutralUpdated + lossFallback + surplusFallback;
    db.auditLog.create({
      data: {
        action: 'MIGRATE_DIRECTION',
        detail: `Migrated ${totalUpdated}/${total} records. Before: LOSS=${beforeLoss}, SURPLUS=${beforeSurplus}. After: LOSS=${afterLoss}, SURPLUS=${afterSurplus}.`,
        duration: 0,
      },
    }).catch((e) => {
      logger.error('Audit log write failed (non-blocking)', { error: e instanceof Error ? e.message : String(e) });
    });

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
  } catch (e: unknown) {
    logger.error("[migrate-direction] error", { error: e });
    return NextResponse.json(
      { success: false, error: process.env.NODE_ENV === "development" ? (e instanceof Error ? e.message : String(e)) : "Internal server error" },
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

    const url = new URL(req.url);

    // Sprint 1: Zod input validation (no params expected)
    const validation = validateQuery(migrateDirectionQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    const total = await db.inventoryRecord.count();
    if (total === 0) {
      return NextResponse.json({ success: true, totalRecords: 0, needsMigration: false });
    }

    // Check if migration needed: count rows where direction doesn't match nominalLossSurplus sign
    // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout
    // (full-table COUNT(*) on InventoryRecord can be slow on large DBs).
    const inverted = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count FROM "InventoryRecord"
      WHERE "nominalLossSurplus" IS NOT NULL
        AND (
          ("nominalLossSurplus" < 0 AND direction != 'LOSS')
          OR ("nominalLossSurplus" > 0 AND direction != 'SURPLUS')
          OR ("nominalLossSurplus" = 0 AND direction != 'NEUTRAL')
        )
    `);

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
  } catch (e: unknown) {
    logger.error("[migrate-direction] GET error", { error: e });
    return NextResponse.json(
      { success: false, error: process.env.NODE_ENV === "development" ? (e instanceof Error ? e.message : String(e)) : "Internal server error" },
      { status: 500 }
    );
  }
}
