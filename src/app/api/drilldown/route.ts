// ============================================================
//  /api/drilldown — raw records for traceability
//  Query: ?outletCode=&itemName=&weekLabel=&monthLabel=&limit=&cursor=
//  Also supports multi-period via comma-separated weekLabel/monthLabel
//  (for cross-month compare drilldown)
//
//  FIX Medium #2: cursor-based pagination. Pass `cursor` (record ID) to fetch
//  the next page. Response includes `nextCursor` for the next page.
//  Default limit 50, max 500. Frontend can implement "Load More" button.
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';

export const dynamic = 'force-dynamic';
export const maxDuration = 30; // FIX Phase 1: prevent Vercel timeout

export async function GET(req: NextRequest) {
  try {
    // FIX (BUG 8): Add rate limiting — was missing, DoS vector
    const ip = getClientIP(req);
    const rl = rateLimit(`drilldown:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);
    const outletCode = url.searchParams.get('outletCode');
    const itemName = url.searchParams.get('itemName');
    const weekLabel = url.searchParams.get('weekLabel');
    const monthLabel = url.searchParams.get('monthLabel');
    const parsedLimit = parseInt(url.searchParams.get('limit') || '50', 10);
    const limit = Math.min(Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50, 500);
    // FIX Medium #2: cursor-based pagination.
    // cursor = record ID (int). When provided, fetch records AFTER this ID
    // (ordered by absNominalDeviasi DESC, then id DESC for stable tie-break).
    const cursorParam = url.searchParams.get('cursor');
    const cursor = cursorParam ? parseInt(cursorParam, 10) : null;

    // FIX-DEEP-1 (DEEP-AUDIT-API-2): Resolve monthLabel case to actual DB case.
    // monthLabel may be a single value or comma-separated list (multi-period compare).
    // DB may have "AGUSTUS 2026" (upload-data.ts) or "Agustus 2026" (dashboard import).
    // Without this, `where.monthLabel = months[0]` returns 0 records on case mismatch.
    const monthResolver = await getMonthResolver();
    // Resolve each comma-separated label to its actual DB case.
    const resolvedMonths = monthLabel
      ? monthLabel.split(',').map((m) => m.trim()).filter(Boolean).map((m) => resolveMonthLabel(m, monthResolver) || m)
      : [];

    const where: any = {};
    if (outletCode) where.outlet = { code: outletCode };
    // FIX H4 (AUDIT-4): itemName was case-sensitive — `itemName=bumbu pasta kuah` returned 0
    // while `BUMBU PASTA KUAH (V.20)` existed. Use mode:'insensitive' (PostgreSQL-native).
    if (itemName) where.item = { name: { equals: itemName, mode: 'insensitive' } };
    // Support comma-separated values for multi-period drilldown
    if (weekLabel) {
      const weeks = weekLabel.split(',').map((w) => w.trim()).filter(Boolean);
      if (weeks.length === 1) where.weekLabel = weeks[0];
      else if (weeks.length > 1) where.weekLabel = { in: weeks };
    }
    if (resolvedMonths.length === 1) where.monthLabel = resolvedMonths[0];
    else if (resolvedMonths.length > 1) where.monthLabel = { in: resolvedMonths };

    const records = await db.inventoryRecord.findMany({
      where,
      include: { outlet: true, item: true, week: true, sourceFile: true },
      orderBy: [
        { absNominalDeviasi: 'desc' },
        { id: 'desc' }, // FIX Medium #2: stable tie-break for cursor pagination
      ],
      // FIX Medium #2: cursor-based pagination.
      // When cursor is provided, skip 1 record (the cursor record itself) and
      // take `limit` records after it. This gives stable pagination even when
      // new records are inserted between requests.
      ...(cursor != null && Number.isFinite(cursor)
        ? { cursor: { id: cursor }, skip: 1, take: limit }
        : { take: limit }),
    });

    // Determine nextCursor for the next page (last record's ID, if we got a full page)
    const nextCursor = records.length === limit && records.length > 0
      ? records[records.length - 1].id
      : null;

    return NextResponse.json({
      success: true,
      count: records.length,
      // FIX Medium #2: pagination metadata. Frontend can use nextCursor to fetch
      // the next page via `?cursor=${nextCursor}`. hasMore=false means last page.
      nextCursor,
      hasMore: nextCursor != null,
      records: records.map((r) => ({
        id: r.id,
        // FIX H5 (AUDIT-4): null guards on nested relations — soft-deleted Outlet/Item
        // or null sourceFile would crash the drawer/modal. Fallback to '—' / 0.
        outlet: { code: r.outlet?.code ?? '—', name: r.outlet?.name ?? '—', area: r.area ?? '—' },
        item: { name: r.item?.name ?? '—', satuan: r.satuan ?? null },
        period: { monthLabel: r.monthLabel ?? '—', weekLabel: r.weekLabel ?? '—' },
        source: { fileName: r.sourceFile?.fileName ?? '—' },
        qty: {
          bom: r.qtyBom,
          com: r.qtyCom,
          deviasi: r.qtyDeviasi,
          waste: r.qtyWaste,
          susut: r.qtySusut,
          trial: r.qtyTrial,
          lossSurplus: r.qtyLossSurplus,
          wasteSusut: r.pctWasteSusut,
        },
        nominal: {
          deviasi: r.nominalDeviasi,
          waste: r.nominalWaste,
          susut: r.nominalSusut,
          trial: r.nominalTrial,
          lossSurplus: r.nominalLossSurplus,
          sales: r.nominalSales,
        },
        derived: {
          // FIX CALC-1 + VERIFY3-4: compute direction from nominalLossSurplus sign with qtyDeviasi fallback
          // (not stored r.direction which may be inverted for un-migrated data)
          direction: (() => {
            if (r.nominalLossSurplus != null) {
              if (r.nominalLossSurplus < 0) return 'LOSS';
              if (r.nominalLossSurplus > 0) return 'SURPLUS';
              return 'NEUTRAL';
            }
            if (r.qtyDeviasi != null) {
              if (r.qtyDeviasi < 0) return 'LOSS';
              if (r.qtyDeviasi > 0) return 'SURPLUS';
              return 'NEUTRAL';
            }
            return r.direction; // last resort fallback
          })(),
          residualQty: r.residualQty,
          residualRatio: r.residualRatio,
          absQtyDeviasi: r.absQtyDeviasi,
          absNominalDeviasi: r.absNominalDeviasi,
          pctQtyDeviasiToBom: r.pctQtyDeviasiToBom,
          pctWasteSusut: r.pctWasteSusut,
          tolerancePct: r.tolerancePct,
          toleranceRaw: r.toleranceRaw,
          avgPrice: r.avgPrice,
        },
        bulan: r.bulan,
        bulan2: r.bulan2,
      })),
    });
  } catch (e: unknown) {
    return NextResponse.json({ success: false, error: (e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}
