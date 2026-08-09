// ============================================================
//  /api/drilldown — raw records for traceability
//  Query: ?outletCode=&itemName=&weekLabel=&monthLabel=&limit=
//  Also supports multi-period via comma-separated weekLabel/monthLabel
//  (for cross-month compare drilldown)
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { db, ensureMigrated } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    await ensureMigrated();
    const url = new URL(req.url);
    const outletCode = url.searchParams.get('outletCode');
    const itemName = url.searchParams.get('itemName');
    const weekLabel = url.searchParams.get('weekLabel');
    const monthLabel = url.searchParams.get('monthLabel');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 500);

    const where: any = {};
    if (outletCode) where.outlet = { code: outletCode };
    if (itemName) where.item = { name: itemName };
    // Support comma-separated values for multi-period drilldown
    if (weekLabel) {
      const weeks = weekLabel.split(',').map((w) => w.trim()).filter(Boolean);
      if (weeks.length === 1) where.weekLabel = weeks[0];
      else if (weeks.length > 1) where.weekLabel = { in: weeks };
    }
    if (monthLabel) {
      const months = monthLabel.split(',').map((m) => m.trim()).filter(Boolean);
      if (months.length === 1) where.monthLabel = months[0];
      else if (months.length > 1) where.monthLabel = { in: months };
    }

    const records = await db.inventoryRecord.findMany({
      where,
      include: { outlet: true, item: true, week: true, sourceFile: true },
      orderBy: { absNominalDeviasi: 'desc' },
      take: limit,
    });

    return NextResponse.json({
      success: true,
      count: records.length,
      records: records.map((r) => ({
        id: r.id,
        outlet: { code: r.outlet.code, name: r.outlet.name, area: r.area },
        item: { name: r.item.name, satuan: r.satuan },
        period: { monthLabel: r.monthLabel, weekLabel: r.weekLabel },
        source: { fileName: r.sourceFile.fileName },
        qty: {
          bom: r.qtyBom,
          com: r.qtyCom,
          deviasi: r.qtyDeviasi,
          waste: r.qtyWaste,
          susut: r.qtySusut,
          trial: r.qtyTrial,
          lossSurplus: r.qtyLossSurplus,
          wasteSusut: r.qtyWasteSusut,
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
          direction: r.direction,
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
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
