// ============================================================
//  /api/export-report — Export analysis data to Word (.docx)
//  Receives analysis data as POST body, generates detailed Word document.
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, WidthType,
} from 'docx';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// ============================================================
//  Helpers
// ============================================================

function fmtIDR(v: number | null | undefined): string {
  if (v == null || isNaN(v) || !isFinite(v)) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}Rp ${(abs / 1_000_000_000).toFixed(2)} M`;
  if (abs >= 1_000_000) return `${sign}Rp ${(abs / 1_000_000).toFixed(2)} Jt`;
  if (abs >= 1_000) return `${sign}Rp ${(abs / 1_000).toFixed(0)} Rb`;
  return `${sign}Rp ${abs.toFixed(0)}`;
}

function fmtNum(v: number | null | undefined): string {
  if (v == null || isNaN(v) || !isFinite(v)) return '—';
  return v.toLocaleString('id-ID', { maximumFractionDigits: 2 });
}

function fmtPct(v: number | null | undefined, withSign = false): string {
  if (v == null || isNaN(v) || !isFinite(v)) return '—';
  const pct = v * 100;
  const sign = withSign && pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

function heading(text: string, level: typeof HeadingLevel.HEADING_1 = HeadingLevel.HEADING_1): Paragraph {
  return new Paragraph({ text, heading: level, spacing: { before: 200, after: 100 } });
}

function paragraph(text: string, bold = false, size = 20): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, bold, size })],
    spacing: { after: 60 },
  });
}

function divider(): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', color: 'CCCCCC', size: 16 })],
    spacing: { before: 100, after: 100 },
  });
}

function tableCell(text: string, bold = false, align: 'left' | 'right' | 'center' = 'left'): TableCell {
  return new TableCell({
    children: [new Paragraph({
      children: [new TextRun({ text, bold, size: 18 })],
      alignment: align === 'right' ? AlignmentType.RIGHT : align === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT,
    })],
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
  });
}

function headerRow(labels: string[]): TableRow {
  return new TableRow({
    tableHeader: true,
    children: labels.map((l, i) => tableCell(l, true, i > 0 ? 'right' : 'left')),
  });
}

function dataRow(values: string[]): TableRow {
  return new TableRow({
    children: values.map((v, i) => tableCell(v, false, i > 0 ? 'right' : 'left')),
  });
}

function makeTable(headers: string[], rows: string[][]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow(headers), ...rows.map(r => dataRow(r))],
  });
}

// ============================================================
//  Build document sections
// ============================================================

function buildTitlePage(data: any): Paragraph[] {
  const period = data.period || {};
  const filters = data.filters || {};
  const outletLabel = filters.outletCode ? `Outlet: ${filters.outletCode}` : 'Network (Semua Outlet)';
  const areaLabel = filters.area ? `Area: ${filters.area}` : 'Semua Area';
  return [
    new Paragraph({
      children: [new TextRun({ text: 'LAPORAN ANALISIS INVENTORY CONTROL', bold: true, size: 32 })],
      alignment: AlignmentType.CENTER, spacing: { before: 400, after: 200 },
    }),
    new Paragraph({
      children: [new TextRun({ text: `Periode: ${period.weekLabel || '?'} ${period.monthLabel || '?'}`, size: 24 })],
      alignment: AlignmentType.CENTER, spacing: { after: 100 },
    }),
    new Paragraph({
      children: [new TextRun({ text: `${outletLabel} | ${areaLabel}`, size: 22, color: '666666' })],
      alignment: AlignmentType.CENTER, spacing: { after: 100 },
    }),
    new Paragraph({
      children: [new TextRun({ text: period.comparisonWeek ? `Perbandingan: ${period.comparisonWeek} ${period.comparisonMonth || ''}` : 'Perbandingan: Otomatis', size: 20, color: '999999' })],
      alignment: AlignmentType.CENTER, spacing: { after: 300 },
    }),
    divider(),
  ];
}

function buildExecutiveSummary(data: any): (Paragraph | Table)[] {
  const s = data.executiveSummary || {};
  const kpiRows: string[][] = [
    ['Sales', fmtIDR(s.sales?.current), s.sales?.growth != null ? fmtPct(s.sales.growth, true) : '—', fmtIDR(s.sales?.previous)],
    ['Nominal Deviasi', fmtIDR(s.nominalDeviasi?.current), s.nominalDeviasi?.growth != null ? fmtPct(s.nominalDeviasi.growth, true) : '—', fmtIDR(s.nominalDeviasi?.previous)],
    ['QTY BOM', fmtNum(s.qtyBom?.current), s.qtyBom?.growth != null ? fmtPct(s.qtyBom.growth, true) : '—', fmtNum(s.qtyBom?.previous)],
    ['QTY Deviasi', fmtNum(s.qtyDeviasi?.current), s.qtyDeviasi?.growth != null ? fmtPct(s.qtyDeviasi.growth, true) : '—', fmtNum(s.qtyDeviasi?.previous)],
    ['QTY Waste', fmtNum(s.qtyWaste?.current), s.qtyWaste?.growth != null ? fmtPct(s.qtyWaste.growth, true) : '—', fmtNum(s.qtyWaste?.previous)],
    ['QTY Susut', fmtNum(s.qtySusut?.current), s.qtySusut?.growth != null ? fmtPct(s.qtySusut.growth, true) : '—', fmtNum(s.qtySusut?.previous)],
    ['QTY Trial', fmtNum(s.qtyTrial?.current), s.qtyTrial?.growth != null ? fmtPct(s.qtyTrial.growth, true) : '—', fmtNum(s.qtyTrial?.previous)],
    ['QTY Loss/Surplus', fmtNum(s.qtyLossSurplus?.current), s.qtyLossSurplus?.growth != null ? fmtPct(s.qtyLossSurplus.growth, true) : '—', fmtNum(s.qtyLossSurplus?.previous)],
    ['Deviation/BOM', fmtPct(s.deviationToBom, false), '—', '—'],
    ['Loss/Sales', fmtPct(s.lossToSales, false), '—', '—'],
    ['Total LOSS', fmtIDR(s.totalLoss), '—', '—'],
    ['Total SURPLUS', fmtIDR(s.totalSurplus), '—', '—'],
    ['Residual Loss Qty', fmtNum(s.residualLossQty), '—', '—'],
    ['Residual Loss %', fmtPct(s.residualLossPct, false), '—', '—'],
  ];
  return [heading('1. EXECUTIVE SUMMARY'), makeTable(['Metric', 'Current', 'Growth', 'Previous'], kpiRows)];
}

function buildHealthStatus(data: any): Paragraph[] {
  const hs = data.healthStatus || {};
  const total = (hs.normal || 0) + (hs.warning || 0) + (hs.abnormal || 0);
  const abnormalPct = total > 0 ? ((hs.abnormal / total) * 100).toFixed(1) : '0';
  const rules = Object.entries(hs.breakdown?.byRule || {}).map(([k, v]: [string, any]) => `${k} (${v})`).join(', ') || 'None';
  return [heading('2. HEALTH STATUS'), paragraph(`Total: ${total.toLocaleString('id-ID')} | Normal: ${hs.normal || 0} | Warning: ${hs.warning || 0} | Abnormal: ${hs.abnormal || 0} (${abnormalPct}%)`), paragraph(`Rules: ${rules}`), divider()];
}

function buildGrowthAnalysis(data: any): (Paragraph | Table)[] {
  const g = data.growthComparison || {};
  const rows: string[][] = [
    ['Sales Growth', fmtPct(g.salesGrowth, true)],
    ['BOM Growth', fmtPct(g.bomGrowth, true)],
    ['QTY Deviasi Growth', fmtPct(g.qtyDeviasiGrowth, true)],
    ['Nominal Deviasi Growth', fmtPct(g.nominalDeviasiGrowth, true)],
    ['Price Growth (AVG Price)', fmtPct(g.priceGrowth, true)],
    ['Volume Effect', fmtPct(g.volumeEffect, true)],
    ['Price Effect', fmtPct(g.priceEffect, true)],
    ['Operational Effect', fmtPct(g.operationalEffect, true)],
  ];
  const result: (Paragraph | Table)[] = [heading('3. ANALISIS PERTUMBUHAN'), makeTable(['Metric', 'Value'], rows)];
  const mpc = g.multiPeriodComparison || [];
  if (mpc.length > 0) {
    result.push(paragraph('Multi-Period Comparison:', true));
    result.push(makeTable(['Period', 'Sales', 'Deviasi', 'Dev/BOM', 'Growth'],
      mpc.map((p: any) => [p.period || '—', fmtIDR(p.sales), fmtIDR(p.deviation), fmtPct(p.devBomRatio, false), p.growthPct != null ? fmtPct(p.growthPct, true) : '—'])));
  }
  result.push(divider());
  return result;
}

function buildTopItems(data: any): (Paragraph | Table)[] {
  const result: (Paragraph | Table)[] = [heading('4. TOP ITEMS')];
  const sections = [
    { title: '4.1 Top by Nominal Deviasi', items: data.topItemsByNominal, cols: ['#', 'Item', 'Outlet', 'Nominal', 'Dir'], map: (it: any, i: number) => [String(i + 1), it.itemName, it.outletCode, fmtIDR(it.absNominal), it.direction] },
    { title: '4.2 Top by Deviation/BOM', items: data.topItemsByDevBom, cols: ['#', 'Item', 'Outlet', 'Dev/BOM', 'Tolerance'], map: (it: any, i: number) => [String(i + 1), it.itemName, it.outletCode, fmtPct(it.devBom, false), it.tolerance != null ? fmtPct(it.tolerance, false) : '—'] },
    { title: '4.3 Top by Waste', items: data.topItemsByWaste, cols: ['#', 'Item', 'Outlet', 'QTY', 'Nominal'], map: (it: any, i: number) => [String(i + 1), it.itemName, it.outletCode, fmtNum(it.qtyWaste), fmtIDR(it.nominalWaste)] },
    { title: '4.4 Top by Susut', items: data.topItemsBySusut, cols: ['#', 'Item', 'Outlet', 'QTY', 'Nominal'], map: (it: any, i: number) => [String(i + 1), it.itemName, it.outletCode, fmtNum(it.qtySusut), fmtIDR(it.nominalSusut)] },
    { title: '4.5 Top by Trial', items: data.topItemsByTrial, cols: ['#', 'Item', 'Outlet', 'QTY', 'Nominal'], map: (it: any, i: number) => [String(i + 1), it.itemName, it.outletCode, fmtNum(it.qtyTrial), fmtIDR(it.nominalTrial)] },
    { title: '4.6 Top by Loss/Surplus', items: data.topItemsByLossSurplus, cols: ['#', 'Item', 'Outlet', 'QTY', 'Nominal', 'Dir'], map: (it: any, i: number) => [String(i + 1), it.itemName, it.outletCode, fmtNum(it.qtyLossSurplus), fmtIDR(it.nominalLossSurplus), it.direction] },
  ];
  for (const sec of sections) {
    if (sec.items && sec.items.length > 0) {
      result.push(paragraph(sec.title, true));
      result.push(makeTable(sec.cols, sec.items.map(sec.map)));
      result.push(paragraph(''));
    }
  }
  result.push(divider());
  return result;
}

function buildDeviationBreakdown(data: any): (Paragraph | Table)[] {
  const b = data.deviationBreakdown || {};
  const total = b.total || 0;
  const rows: string[][] = [
    ['Waste', fmtNum(b.waste), total > 0 ? `${((b.waste / total) * 100).toFixed(1)}%` : '—'],
    ['Susut', fmtNum(b.susut), total > 0 ? `${((b.susut / total) * 100).toFixed(1)}%` : '—'],
    ['Trial', fmtNum(b.trial), total > 0 ? `${((b.trial / total) * 100).toFixed(1)}%` : '—'],
    ['Residual', fmtNum(b.residual), total > 0 ? `${((b.residual / total) * 100).toFixed(1)}%` : '—'],
    ['TOTAL', fmtNum(b.total), '100%'],
  ];
  return [heading('5. DEVIATION BREAKDOWN'), paragraph('Three-Layer: Gross → Explained (W+S+T) → Net Residual'), makeTable(['Component', 'QTY', '% of Total'], rows), divider()];
}

function buildLossVsSurplus(data: any): (Paragraph | Table)[] {
  const lvs = data.lossVsSurplus || {};
  return [heading('6. LOSS VS SURPLUS'), makeTable(['Category', 'Count', 'Nominal'], [['LOSS', String(lvs.loss || 0), fmtIDR(lvs.lossNominal)], ['SURPLUS', String(lvs.surplus || 0), fmtIDR(lvs.surplusNominal)]]), divider()];
}

function buildAreaAnalysis(data: any): (Paragraph | Table)[] {
  const areas = data.areaAnalysis || [];
  if (areas.length === 0) return [];
  return [heading('7. PERBANDINGAN AREA'), makeTable(['Area', 'Outlets', 'Sales', 'Abs Nominal', 'Avg Dev/BOM', 'Loss/Sales'],
    areas.map((a: any) => [a.area, String(a.outletCount || 0), fmtIDR(a.totalSales), fmtIDR(a.totalAbsNominal), fmtPct(a.avgDevBom, false), fmtPct(a.lossToSales, false)])), divider()];
}

function buildOutletRanking(data: any): (Paragraph | Table)[] {
  const ranking = data.outletHealthRanking || [];
  if (ranking.length === 0) return [];
  return [heading('8. OUTLET HEALTH RANKING'), paragraph('Skor = 30% Dev/BOM + 25% Residual + 25% Loss/Sales + 20% Abnormal (0=sehat, 100=kritis)'),
    makeTable(['#', 'Outlet', 'Area', 'Skor', 'Dev/BOM', 'Abn', 'Abs Nominal', 'Sales'],
      ranking.slice(0, 30).map((o: any, i: number) => [String(i + 1), `${o.outletName} (${o.outletCode})`, o.area, String(o.healthScore ?? '—'), fmtPct(o.devBom, false), String(o.abnormal || 0), fmtIDR(o.absNominal), fmtIDR(o.sales)])), divider()];
}

function buildCostImpact(data: any): (Paragraph | Table)[] {
  const ci = data.costImpact || {};
  if (!ci.totalCost) return [];
  const rows: string[][] = [
    ['Waste Cost', fmtIDR(ci.wasteCost), ci.wastePct != null ? fmtPct(ci.wastePct, false) : '—'],
    ['Susut Cost', fmtIDR(ci.susutCost), ci.susutPct != null ? fmtPct(ci.susutPct, false) : '—'],
    ['Trial Cost', fmtIDR(ci.trialCost), ci.trialPct != null ? fmtPct(ci.trialPct, false) : '—'],
    ['Residual Cost', fmtIDR(ci.residualCost), ci.residualPct != null ? fmtPct(ci.residualPct, false) : '—'],
    ['TOTAL', fmtIDR(ci.totalCost), '100%'],
    ['% of Sales', fmtPct(ci.pctOfSales, false), '—'],
  ];
  return [heading('9. COST IMPACT'), makeTable(['Component', 'Nominal', '% of Cost'], rows), divider()];
}

function buildPareto(data: any): (Paragraph | Table)[] {
  const pareto = data.pareto || {};
  if (!pareto.items || pareto.items.length === 0) return [];
  return [heading('10. ANALISIS PARETO (ABC)'), paragraph(`Class A: ${pareto.classACount || 0} items (${((pareto.classAPctOfCost || 0) * 100).toFixed(1)}% of cost) | Total: ${pareto.totalItems || 0} items`),
    makeTable(['#', 'Item', 'Outlet', 'Abs Nominal', 'Cum %'],
      (pareto.items || []).slice(0, 20).map((it: any, i: number) => [String(i + 1), it.itemName, it.outletCode, fmtIDR(it.absNominal), `${((it.cumPct || 0) * 100).toFixed(1)}%`])), divider()];
}

function buildVarianceAnalysis(data: any): (Paragraph | Table)[] {
  const va = data.varianceAnalysis || {};
  const worsened = va.topWorsened || [];
  const improved = va.topImproved || [];
  if (worsened.length === 0 && improved.length === 0) return [];
  const result: (Paragraph | Table)[] = [heading('11. VARIANCE ANALYSIS')];
  if (worsened.length > 0) { result.push(paragraph('11.1 Memburuk (Deviasi Naik)', true)); result.push(makeTable(['Item', 'Outlet', 'Current', 'Previous', 'Delta'], worsened.map((it: any) => [it.itemName, it.outletCode, fmtIDR(it.currentAbsNominal), fmtIDR(it.previousAbsNominal), fmtIDR(it.delta)]))); result.push(paragraph('')); }
  if (improved.length > 0) { result.push(paragraph('11.2 Membaik (Deviasi Turun)', true)); result.push(makeTable(['Item', 'Outlet', 'Current', 'Previous', 'Delta'], improved.map((it: any) => [it.itemName, it.outletCode, fmtIDR(it.currentAbsNominal), fmtIDR(it.previousAbsNominal), fmtIDR(it.delta)]))); }
  result.push(divider());
  return result;
}

function buildWorklist(data: any): (Paragraph | Table)[] {
  const worklist = data.investigationWorklist || [];
  if (worklist.length === 0) return [];
  const p1 = worklist.filter((w: any) => w.priority === 'P1');
  const p2 = worklist.filter((w: any) => w.priority === 'P2');
  const p3 = worklist.filter((w: any) => w.priority === 'P3');
  const result: (Paragraph | Table)[] = [heading('12. INVESTIGATION WORKLIST'), paragraph(`P1: ${p1.length} | P2: ${p2.length} | P3: ${p3.length} | Total: ${worklist.length}`), paragraph('')];
  result.push(makeTable(['Pri', 'Outlet', 'Item', 'Issue', 'Nominal', 'Dev/BOM', 'Dir', 'Rules'],
    worklist.slice(0, 50).map((w: any) => [w.priority, w.outletCode, w.itemName, w.issue, fmtIDR(w.absNominalDeviasi), w.deviationToBom != null ? fmtPct(w.deviationToBom, false) : '—', w.direction, (w.ruleCodes || []).join(', ')])));
  if (p1.length > 0) {
    result.push(paragraph(''));
    result.push(paragraph('Recommended Actions (P1):', true));
    p1.slice(0, 10).forEach((w: any) => { if (w.recommendedAction) result.push(paragraph(`• [${w.outletCode}] ${w.itemName}: ${w.recommendedAction}`)); });
  }
  result.push(divider());
  return result;
}

function buildItemConsistency(data: any): (Paragraph | Table)[] {
  const ic = data.itemConsistencyAnalysis || {};
  const items = ic.items || [];
  if (items.length === 0) return [];
  return [heading('13. ITEM CONSISTENCY'), paragraph('SYSTEMIC (≥10 outlet) | WIDESPREAD (5-9) | ISOLATED (2-4)'),
    makeTable(['Item', 'Outlets', 'LOSS', 'SURPLUS', 'Abs Nominal', 'Avg Dev/BOM', 'Type'],
      items.slice(0, 20).map((it: any) => [it.itemName, String(it.outletCount || 0), String(it.lossOutlets || 0), String(it.surplusOutlets || 0), fmtIDR(it.totalAbsNominal), fmtPct(it.avgDevBom, false), it.consistency])), divider()];
}

function buildTrend(data: any): (Paragraph | Table)[] {
  const trend = data.trend || [];
  if (trend.length === 0) return [];
  return [heading('14. TREND MULTI-PERIODE'), makeTable(['Period', 'Sales', 'Nominal Deviasi', 'Dev/BOM'],
    trend.map((t: any) => [t.weekLabel, fmtIDR(t.sales), fmtIDR(t.nominal), fmtPct(t.devBom, false)])), divider()];
}

function buildNarrative(data: any): Paragraph[] {
  const narrative = data.narrative;
  if (!narrative) return [];
  const result: Paragraph[] = [heading('15. NARASI ANALISIS')];
  for (const line of narrative.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') { result.push(new Paragraph({ text: '', spacing: { after: 40 } })); }
    else if (trimmed.startsWith('**') && trimmed.endsWith('**')) { result.push(new Paragraph({ children: [new TextRun({ text: trimmed.replace(/\*\*/g, ''), bold: true, size: 22 })], spacing: { before: 100, after: 60 } })); }
    else { result.push(new Paragraph({ children: [new TextRun({ text: trimmed, size: 20 })], spacing: { after: 60 } })); }
  }
  result.push(divider());
  return result;
}

function buildRecommendations(data: any): Paragraph[] {
  const recs = data.recommendation || [];
  if (recs.length === 0) return [];
  const result: Paragraph[] = [heading('16. REKOMENDASI TINDAK LANJUT')];
  recs.forEach((rec: any, i: number) => {
    result.push(new Paragraph({ children: [new TextRun({ text: `${i + 1}. ${rec.why}`, bold: true, size: 22 })], spacing: { before: 120, after: 40 } }));
    if (rec.what) for (const action of rec.what) result.push(new Paragraph({ children: [new TextRun({ text: `   • ${action}`, size: 20 })], spacing: { after: 30 } }));
    if (rec.priority) result.push(new Paragraph({ children: [new TextRun({ text: `   Priority: ${rec.priority}`, size: 18, color: '999999' })], spacing: { after: 60 } }));
  });
  result.push(divider());
  return result;
}

function buildFooter(): Paragraph[] {
  return [
    new Paragraph({ text: '', spacing: { before: 400 } }),
    divider(),
    new Paragraph({ children: [new TextRun({ text: 'Laporan ini dihasilkan oleh Inventory Control Intelligence Platform', size: 16, color: '999999', italics: true })], alignment: AlignmentType.CENTER }),
    new Paragraph({ children: [new TextRun({ text: `Generated: ${new Date().toLocaleString('id-ID')}`, size: 16, color: '999999' })], alignment: AlignmentType.CENTER }),
  ];
}

// ============================================================
//  Main handler
// ============================================================
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const data = body.data;
    if (!data) {
      return NextResponse.json({ success: false, error: 'No data provided' }, { status: 400 });
    }

    const children: any[] = [
      ...buildTitlePage(data),
      ...buildExecutiveSummary(data),
      ...buildHealthStatus(data),
      ...buildGrowthAnalysis(data),
      ...buildTopItems(data),
      ...buildDeviationBreakdown(data),
      ...buildLossVsSurplus(data),
      ...buildAreaAnalysis(data),
      ...buildOutletRanking(data),
      ...buildCostImpact(data),
      ...buildPareto(data),
      ...buildVarianceAnalysis(data),
      ...buildWorklist(data),
      ...buildItemConsistency(data),
      ...buildTrend(data),
      ...buildNarrative(data),
      ...buildRecommendations(data),
      ...buildFooter(),
    ];

    const doc = new Document({
      creator: 'Inventory Control Intelligence Platform',
      title: `Laporan Analisis ${data.period?.weekLabel || ''} ${data.period?.monthLabel || ''}`,
      description: 'Auto-generated analysis report',
      sections: [{
        properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } },
        children,
      }],
    });

    const buffer = await Packer.toBuffer(doc);
    const fileName = `Laporan_Analisis_${(data.period?.monthLabel || 'unknown').replace(/\s+/g, '_')}_${data.period?.weekLabel || ''}.docx`;

    return new NextResponse(new Uint8Array(buffer) as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${fileName}"`,
      },
    });
  } catch (e: any) {
    console.error('[export-report] error:', e);
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
