// ============================================================
//  /api/drilldown — raw records for traceability
//  Query: ?outletCode=&itemName=&weekLabel=&monthLabel=
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const outletCode = url.searchParams.get('outletCode');
    const itemName = url.searchParams.get('itemName');
    const weekLabel = url.searchParams.get('weekLabel');
    const monthLabel = url.searchParams.get('monthLabel');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 500);

    const where: any = {};
    if (outletCode) where.outlet = { code: outletCode };
    if (itemName) where.item = { name: itemName };
    if (weekLabel) where.weekLabel = weekLabel;
    if (monthLabel) where.monthLabel = monthLabel;

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
        source: { fileName: r.sourceFile.fileName, rowNumber: undefined },
        qty: {
          bom: r.qtyBom, com: r.qtyCom, deviasi: r.qtyDeviasi,
          waste: r.qtyWaste, susut: r.qtySusut, trial: r.qtyTrial,
          lossSurplus: r.qtyLossSurplus, wasteSusut: undefined,
        },
        nominal: {
          deviasi: r.nominalDeviasi, waste: r.nominalWaste, susut: r.nominalSusut,
          trial: r.nominalTrial, lossSurplus: r.nominalLossSurplus, sales: r.nominalSales,
        },
        derived: {
          direction: r.direction,
          residualQty: r.residualQty,
          residualRatio: r.residualRatio,
          absQtyDeviasi: r.absQtyDeviasi,
          absNominalDeviasi: r.absNominalDeviasi,
          pctQtyDeviasiToBom: r.pctQtyDeviasiToBom,
          tolerancePct: r.tolerancePct,
          avgPrice: r.avgPrice,
        },
        bulan: r.bulan, bulan2: r.bulan2,
      })),
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
