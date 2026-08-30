// ============================================================
//  /api/report-pdf — Generate outlet analysis PDF on-demand
//  GET: ?outletCode=1187.SBRTUP&month=Agustus%202026&week=WEEK%204
//  Returns: PDF file (application/pdf)
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';
import * as fs from 'fs';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { rateLimit, getClientIP } from '@/lib/rate-limit';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`report-pdf:${ip}`, 10, 60_000);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);
    const outletCode = url.searchParams.get('outletCode') || '';
    const rawMonth = url.searchParams.get('month') || '';
    const rawWeek = url.searchParams.get('week') || 'WEEK 4';

    if (!outletCode || !rawMonth) {
      return NextResponse.json({ success: false, error: 'outletCode and month required' }, { status: 400 });
    }

    const resolver = await getMonthResolver();
    const month = resolveMonthLabel(rawMonth, resolver) || rawMonth;
    const week = rawWeek;

    // Fetch outlet info
    const outlet = await db.outlet.findFirst({
      where: { code: outletCode },
      select: { id: true, code: true, name: true, area: true },
    });

    if (!outlet) {
      return NextResponse.json({ success: false, error: 'Outlet not found' }, { status: 404 });
    }

    // Fetch current period records
    const currRecords = await db.inventoryRecord.findMany({
      where: {
        outletId: outlet.id,
        monthLabel: month,
        weekLabel: week,
      },
      include: { item: { select: { name: true } } },
      orderBy: { absNominalDeviasi: 'desc' },
      take: 20,
    });

    // Fetch previous period (same week, previous month)
    const allSourceFiles = await db.sourceFile.findMany({
      select: { monthLabel: true, monthKey: true },
      distinct: ['monthLabel'],
      orderBy: { monthKey: 'asc' },
    });

    // Find previous month with same week
    const monthIndex = allSourceFiles.findIndex(m => m.monthLabel === month);
    let prevMonth: string | null = null;
    if (monthIndex > 0) {
      prevMonth = allSourceFiles[monthIndex - 1].monthLabel;
    }

    let prevRecords: typeof currRecords = [];
    if (prevMonth) {
      prevRecords = await db.inventoryRecord.findMany({
        where: {
          outletId: outlet.id,
          monthLabel: prevMonth,
          weekLabel: week,
        },
        include: { item: { select: { name: true } } },
      });
    }

    // Compute aggregates
    const sumAbs = (records: Array<Record<string, unknown>>, field: string) =>
      records.reduce((s, r) => s + Math.abs(Number(r[field]) || 0), 0);

    const sumSigned = (records: Array<Record<string, unknown>>, field: string) =>
      records.reduce((s, r) => s + (Number(r[field]) || 0), 0);

    const curr = {
      sales: sumSigned(currRecords, 'nominalSales'),
      qtyBom: sumAbs(currRecords, 'qtyBom'),
      qtyDeviasi: sumAbs(currRecords, 'qtyDeviasi'),
      qtyWaste: sumAbs(currRecords, 'qtyWaste'),
      qtySusut: sumAbs(currRecords, 'qtySusut'),
      qtyTrial: sumAbs(currRecords, 'qtyTrial'),
      nominalDeviasi: sumAbs(currRecords, 'nominalDeviasi'),
      totalLoss: currRecords.reduce((s, r) => s + ((r.nominalLossSurplus ?? 0) < 0 ? Math.abs(r.nominalLossSurplus ?? 0) : 0), 0),
      totalSurplus: currRecords.reduce((s, r) => s + ((r.nominalLossSurplus ?? 0) > 0 ? (r.nominalLossSurplus ?? 0) : 0), 0),
      netLoss: sumSigned(currRecords, 'nominalLossSurplus'),
      records: currRecords.length,
    };

    const prev = prevRecords.length > 0 ? {
      sales: sumSigned(prevRecords, 'nominalSales'),
      qtyBom: sumAbs(prevRecords, 'qtyBom'),
      qtyDeviasi: sumAbs(prevRecords, 'qtyDeviasi'),
      qtyWaste: sumAbs(prevRecords, 'qtyWaste'),
      qtySusut: sumAbs(prevRecords, 'qtySusut'),
      qtyTrial: sumAbs(prevRecords, 'qtyTrial'),
      nominalDeviasi: sumAbs(prevRecords, 'nominalDeviasi'),
      totalLoss: prevRecords.reduce((s, r) => s + ((r.nominalLossSurplus ?? 0) < 0 ? Math.abs(r.nominalLossSurplus ?? 0) : 0), 0),
      totalSurplus: prevRecords.reduce((s, r) => s + ((r.nominalLossSurplus ?? 0) > 0 ? (r.nominalLossSurplus ?? 0) : 0), 0),
      netLoss: sumSigned(prevRecords, 'nominalLossSurplus'),
    } : null;

    // Get ALL records (not just top 20) for full aggregates
    const allCurrRecords = await db.inventoryRecord.findMany({
      where: { outletId: outlet.id, monthLabel: month, weekLabel: week },
      select: {
        qtyBom: true, qtyDeviasi: true, qtyWaste: true, qtySusut: true, qtyTrial: true,
        nominalDeviasi: true, nominalLossSurplus: true, nominalSales: true,
        pctQtyDeviasiToBom: true, direction: true, akunPenyesuaian: true,
        item: { select: { name: true } },
      },
      orderBy: { absNominalDeviasi: 'desc' },
    });

    const topItems = allCurrRecords.slice(0, 10).map(r => ({
      name: r.item.name,
      qtyBom: Number(r.qtyBom) || 0,
      qtyDeviasi: Number(r.qtyDeviasi) || 0,
      qtyWaste: Number(r.qtyWaste) || 0,
      qtySusut: Number(r.qtySusut) || 0,
      qtyTrial: Number(r.qtyTrial) || 0,
      nominal: Number(r.nominalDeviasi) || 0,
      nominalLoss: Number(r.nominalLossSurplus) || 0,
      devBom: Number(r.pctQtyDeviasiToBom) || 0,
      direction: r.direction || 'NEUTRAL',
    }));

    // Build PDF using ReportLab via Python subprocess
    // (imports at top of file)

    // Write data to temp JSON
    const reportData = {
      outlet: { code: outlet.code, name: outlet.name, area: outlet.area },
      period: { month, week },
      compareMonth: prevMonth,
      curr: {
        ...curr,
        qtyBom: sumAbs(allCurrRecords, 'qtyBom'),
        qtyDeviasi: sumAbs(allCurrRecords, 'qtyDeviasi'),
        qtyWaste: sumAbs(allCurrRecords, 'qtyWaste'),
        qtySusut: sumAbs(allCurrRecords, 'qtySusut'),
        qtyTrial: sumAbs(allCurrRecords, 'qtyTrial'),
        nominalDeviasi: sumAbs(allCurrRecords, 'nominalDeviasi'),
        totalLoss: allCurrRecords.reduce((s, r) => s + ((r.nominalLossSurplus ?? 0) < 0 ? Math.abs(r.nominalLossSurplus ?? 0) : 0), 0),
        totalSurplus: allCurrRecords.reduce((s, r) => s + ((r.nominalLossSurplus ?? 0) > 0 ? (r.nominalLossSurplus ?? 0) : 0), 0),
        netLoss: allCurrRecords.reduce((s, r) => s + (Number(r.nominalLossSurplus) || 0), 0),
        sales: allCurrRecords.reduce((s, r) => s + (Number(r.nominalSales) || 0), 0),
        records: allCurrRecords.length,
      },
      prev,
      topItems,
    };

    const dataPath = `/tmp/report-data-${outlet.code.replace(/\./g, '')}.json`;
    fs.writeFileSync(dataPath, JSON.stringify(reportData));

    // Generate PDF via Python script
    const outputPath = `/tmp/Laporan_${outlet.code.replace(/\./g, '')}_${month.replace(/\s/g, '_')}_${week.replace(/\s/g, '_')}.pdf`;

    const pythonScript = `
import json, sys, os
sys.path.insert(0, '/home/z/my-project/skills/pdf/scripts')

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT, TA_JUSTIFY
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

try:
    pdfmetrics.registerFont(TTFont('NotoSans', '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf'))
    pdfmetrics.registerFont(TTFont('NotoSans-Bold', '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf'))
    BASE_FONT = 'NotoSans'
    BOLD_FONT = 'NotoSans-Bold'
except:
    BASE_FONT = 'Helvetica'
    BOLD_FONT = 'Helvetica-Bold'

HEADER_FILL = colors.HexColor('#6e654b')
ACCENT = colors.HexColor('#897129')
TEXT_PRIMARY = colors.HexColor('#21201e')
TEXT_MUTED = colors.HexColor('#8e8c85')
BORDER = colors.HexColor('#cfc9b6')
TABLE_STRIPE = colors.HexColor('#efefec')
SEM_SUCCESS = colors.HexColor('#4c8b61')
SEM_WARNING = colors.HexColor('#a4884f')
SEM_ERROR = colors.HexColor('#a6524a')

data = json.load(open('${dataPath}'))
c = data['curr']
p = data.get('prev')
o = data['outlet']
period = data['period']

def fmt_idr(v):
    if v is None or v == 0: return '-'
    sign = '-' if v < 0 else ''
    av = abs(v)
    if av >= 1e9: return f'{sign}Rp {av/1e9:.2f}M'
    if av >= 1e6: return f'{sign}Rp {av/1e6:.1f}Jt'
    if av >= 1e3: return f'{sign}Rp {av/1e3:.0f}Rb'
    return f'{sign}Rp {av:.0f}'

def fmt_num(v):
    if v is None or v == 0: return '-'
    return f'{v:,.0f}'

def fmt_pct(v):
    if v is None or v == 0: return '-'
    return f'{v*100:.1f}%'

def fmt_pct_s(v):
    if v is None or v == 0: return '-'
    return f'{'+'if v>0 else ''}{v*100:.1f}%'

styles = getSampleStyleSheet()
def mk(name, **kw):
    d = {'fontName': BASE_FONT, 'fontSize': 10, 'leading': 14, 'textColor': TEXT_PRIMARY}
    d.update(kw)
    return ParagraphStyle(name, **d)

sTitle = mk('T', fontName=BOLD_FONT, fontSize=18, leading=24, textColor=HEADER_FILL, spaceAfter=4)
sSub = mk('S', fontSize=11, leading=14, textColor=TEXT_MUTED, spaceAfter=16)
sH1 = mk('H1', fontName=BOLD_FONT, fontSize=13, leading=17, textColor=HEADER_FILL, spaceBefore=16, spaceAfter=6)
sBody = mk('B', fontSize=10, leading=14, alignment=TA_JUSTIFY, spaceAfter=5)
sBullet = mk('Bu', fontSize=10, leading=13, leftIndent=15, bulletIndent=5, spaceAfter=3)
sCH = mk('CH', fontName=BOLD_FONT, fontSize=7.5, leading=10, textColor=colors.white, alignment=TA_CENTER)
sC = mk('C', fontSize=7.5, leading=10)
sCR = mk('CR', fontSize=7.5, leading=10, alignment=TA_RIGHT)
sCL = mk('CL', fontSize=7.5, leading=10, textColor=SEM_ERROR, alignment=TA_RIGHT)
sCS = mk('CS', fontSize=7.5, leading=10, textColor=SEM_SUCCESS, alignment=TA_RIGHT)

story = []
story.append(Paragraph('LAPORAN ANALISIS RESTO', sSub))
story.append(Paragraph(f'{o["name"]} ({o["code"]})', sTitle))
story.append(Paragraph(f'Periode: {period["month"]} {period["week"]}' + (f' vs {data.get("compareMonth","")} {period["week"]}' if data.get("compareMonth") else ''), sSub))
story.append(HRFlowable(width='100%', thickness=2, color=ACCENT, spaceBefore=2, spaceAfter=14))

# 1. Executive Summary
story.append(Paragraph('1. Ringkasan Eksekutif', sH1))
dev_bom = c['qtyDeviasi']/c['qtyBom'] if c['qtyBom']>0 else 0
loss_sales = c['totalLoss']/c['sales'] if c['sales']>0 else 0
residual = abs(c['qtyDeviasi']) - abs(c['qtyWaste']) - abs(c['qtySusut']) - abs(c['qtyTrial'])
res_pct = residual/abs(c['qtyDeviasi']) if abs(c['qtyDeviasi'])>0 else 0
growth = (c['netLoss']-p['netLoss'])/abs(p['netLoss']) if p and p['netLoss']!=0 else 0
sales_g = (c['sales']-p['sales'])/p['sales'] if p and p['sales']>0 else 0

story.append(Paragraph(f'Resto <b>{o["name"]}</b> (area {o["area"]}) menunjukkan {"peningkatan" if growth>0 else "penurunan"} deviasi nominal pada periode {period["month"]} {period["week"]}. Net loss/surplus {"naik" if growth>0 else "turun"} {fmt_pct_s(growth)} dari {fmt_idr(p["netLoss"] if p else 0)} menjadi {fmt_idr(c["netLoss"])}. Penjualan {"turun" if sales_g<0 else "naik"} {fmt_pct_s(sales_g)}. Rasio Dev/BOM: {fmt_pct(dev_bom)}, Loss/Sales: {fmt_pct(loss_sales)}. Residual (unexplained): {fmt_pct(res_pct)}.', sBody))

# KPI Table
hdr = [Paragraph(f'<b>{h}</b>', sCH) for h in ['Metrik','Periode Ini','Periode Lalu','Perubahan']]
rows = [hdr]
def add_row(label, cv, pv, calc_g=True):
    g = ''
    if p and pv and pv != 0 and calc_g:
        g = fmt_pct_s((cv-pv)/abs(pv))
    rows.append([label, fmt_idr(cv) if isinstance(cv, (int,float)) and abs(cv)>1000 else fmt_num(cv), fmt_idr(pv) if p and isinstance(pv,(int,float)) and abs(pv)>1000 else (fmt_num(pv) if p else '-'), g])

add_row('Penjualan', c['sales'], p['sales'] if p else 0)
add_row('QTY BOM', c['qtyBom'], p['qtyBom'] if p else 0)
add_row('QTY Deviasi', c['qtyDeviasi'], p['qtyDeviasi'] if p else 0)
add_row('QTY Waste', c['qtyWaste'], p['qtyWaste'] if p else 0)
add_row('QTY Susut', c['qtySusut'], p['qtySusut'] if p else 0)
add_row('QTY Trial', c['qtyTrial'], p['qtyTrial'] if p else 0)
add_row('Nominal Deviasi', c['nominalDeviasi'], p['nominalDeviasi'] if p else 0)
add_row('Total LOSS', c['totalLoss'], p['totalLoss'] if p else 0)
add_row('Total SURPLUS', c['totalSurplus'], p['totalSurplus'] if p else 0)
add_row('Net Loss/Surplus', c['netLoss'], p['netLoss'] if p else 0)

t = Table(rows, colWidths=[40*mm, 42*mm, 42*mm, 28*mm])
t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),HEADER_FILL),('GRID',(0,0),(-1,-1),0.5,BORDER),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,TABLE_STRIPE]),('FONTSIZE',(0,0),(-1,-1),8),('ALIGN',(1,1),(-1,-1),'RIGHT'),('VALIGN',(0,0),(-1,-1),'MIDDLE'),('TOPPADDING',(0,0),(-1,-1),3),('BOTTOMPADDING',(0,0),(-1,-1),3)]))
story.append(t)
story.append(Spacer(1,12))

# 2. Top Items
story.append(Paragraph('2. Analisis Deviasi per Item (Top 10)', sH1))
ihdr = [Paragraph(f'<b>{h}</b>', sCH) for h in ['Item','QTY BOM','QTY Dev','Waste','Susut','Trial','Nominal','Dev/BOM','Dir']]
irows = [ihdr]
for it in data['topItems']:
    ds = sCL if it['direction']=='LOSS' else sCS
    irows.append([Paragraph(it['name'],sC),Paragraph(fmt_num(abs(it['qtyBom'])),sCR),Paragraph(fmt_num(it['qtyDeviasi']),sCR),Paragraph(fmt_num(abs(it['qtyWaste'])),sCR),Paragraph(fmt_num(abs(it['qtySusut'])),sCR),Paragraph(fmt_num(abs(it['qtyTrial'])),sCR),Paragraph(fmt_idr(it['nominal']),ds),Paragraph(fmt_pct(it['devBom']),sCR),Paragraph(it['direction'],ds)])
it2 = Table(irows, colWidths=[33*mm,16*mm,16*mm,13*mm,13*mm,11*mm,24*mm,14*mm,12*mm])
it2.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),HEADER_FILL),('GRID',(0,0),(-1,-1),0.5,BORDER),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,TABLE_STRIPE]),('VALIGN',(0,0),(-1,-1),'MIDDLE'),('TOPPADDING',(0,0),(-1,-1),3),('BOTTOMPADDING',(0,0),(-1,-1),3)]))
story.append(it2)
story.append(Spacer(1,12))

# 3. Root Cause
story.append(Paragraph('3. Analisis Root Cause', sH1))
for it in data['topItems'][:3]:
    bom_status = 'BOM=0 (tidak ter-set)' if it['qtyBom']==0 else f'Dev/BOM={fmt_pct(it["devBom"])}'
    story.append(Paragraph(f'<b>{it["name"]}</b>: nominal {fmt_idr(it["nominal"])} ({it["direction"]}), {bom_status}. QTY Waste={fmt_num(abs(it["qtyWaste"]))}, Susut={fmt_num(abs(it["qtySusut"]))}, Trial={fmt_num(abs(it["qtyTrial"]))}.', sBullet, bulletText='\\u2022'))

# 4. Decomposition
story.append(Paragraph('4. Dekomposisi Deviasi', sH1))
story.append(Paragraph(f'|Deviasi|={fmt_num(abs(c["qtyDeviasi"]))} = Waste({fmt_num(abs(c["qtyWaste"]))},{fmt_pct(abs(c["qtyWaste"])/abs(c["qtyDeviasi"]) if c["qtyDeviasi"] else 0)}) + Susut({fmt_num(abs(c["qtySusut"]))},{fmt_pct(abs(c["qtySusut"])/abs(c["qtyDeviasi"]) if c["qtyDeviasi"] else 0)}) + Trial({fmt_num(abs(c["qtyTrial"]))},{fmt_pct(abs(c["qtyTrial"])/abs(c["qtyDeviasi"]) if c["qtyDeviasi"] else 0)}) + <b>Residual({fmt_num(residual)},{fmt_pct(res_pct)})</b>', sBody))
if res_pct > 0.7:
    story.append(Paragraph(f'<b>Residual {fmt_pct(res_pct)} > 70%</b> — RED FLAG. Sebagian besar deviasi tidak dapat dijelaskan. Investigasi: BOM master, audit fisik, pencatatan receiving.', mk('Alert',fontName=BOLD_FONT,fontSize=10,leading=14,textColor=SEM_ERROR)))

# 5. Recommendations
story.append(Paragraph('5. Rekomendasi Action Plan', sH1))
no_bom = [it for it in data['topItems'] if it['qtyBom']==0]
if no_bom:
    story.append(Paragraph(f'<b>[URGENT]</b> Set BOM master untuk: {", ".join(it["name"] for it in no_bom[:5])} — QTY BOM=0 menyebabkan 100% deviasi menjadi residual.', sBullet, bulletText='\\u2022'))
    story.append(Paragraph(f'<b>[URGENT]</b> Audit fisik stok untuk item dengan LOSS terbesar: {data["topItems"][0]["name"]} ({fmt_idr(data["topItems"][0]["nominal"])}).', sBullet, bulletText='\\u2022'))
high_susut = [it for it in data['topItems'] if abs(it['qtySusut']) > abs(it['qtyDeviasi'])*0.3 and it['qtyDeviasi']!=0]
if high_susut:
    story.append(Paragraph(f'<b>[HIGH]</b> Investigasi shrinkage: {", ".join(it["name"] for it in high_susut[:3])} — susut > 30% dari deviasi. Audit proses thawing/penyimpanan.', sBullet, bulletText='\\u2022'))
story.append(Paragraph(f'<b>[HIGH]</b> Review portioning consistency — {c["records"]} record, residual {fmt_pct(res_pct)}.', sBullet, bulletText='\\u2022'))
story.append(Paragraph(f'<b>[MEDIUM]</b> Set tolerance untuk item tanpa tolerance (TOLERANCE_NOT_SET_HIGH_DEV).', sBullet, bulletText='\\u2022'))

# 6. Conclusion
story.append(Paragraph('6. Kesimpulan', sH1))
story.append(Paragraph(f'Resto {o["name"]} menunjukkan kondisi {"memburuk" if growth>0 else "membaik"} pada {period["month"]} {period["week"]}: net loss/surplus {fmt_idr(c["netLoss"])} ({"naik" if growth>0 else "turun"} {fmt_pct_s(growth)}). Residual {fmt_pct(res_pct)} {"adalah red flag" if res_pct>0.7 else "dalam batas wajar"}. Prioritas: {"set BOM master + audit fisik" if no_bom else "monitor trend"}.', sBody))

# Build
doc = SimpleDocTemplate('${outputPath}', pagesize=A4, leftMargin=20*mm, rightMargin=20*mm, topMargin=20*mm, bottomMargin=20*mm, title=f'Laporan Analisis {o["name"]} - {period["month"]} {period["week"]}', author='Inventory Control Intelligence', creator='Z.ai Code')
def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont(BASE_FONT, 7)
    canvas.setFillColor(TEXT_MUTED)
    canvas.drawCentredString(A4[0]/2, 10*mm, f'Halaman {doc.page} · {o["name"]} · {period["month"]} {period["week"]} · Inventory Control Intelligence')
    canvas.restoreState()
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print('PDF_OK')
`;

    fs.writeFileSync('/tmp/gen_report.py', pythonScript);
    execSync(`python3 /tmp/gen_report.py`, { timeout: 30000 });

    // Read PDF
    const pdfBuffer = fs.readFileSync(outputPath);

    // Clean up temp files
    try { fs.unlinkSync(dataPath); } catch {}
    try { fs.unlinkSync('/tmp/gen_report.py'); } catch {}

    return new NextResponse(pdfBuffer, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="Laporan_${outlet.name}_${month.replace(/\s/g, '_')}_${week.replace(/\s/g, '_')}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: unknown) {
    logger.error('[report-pdf] error:', { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ success: false, error: 'Gagal generate PDF' }, { status: 500 });
  }
}
