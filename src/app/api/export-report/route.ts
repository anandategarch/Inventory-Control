// ============================================================
//  /api/export-report — Export analysis data to Word (.docx)
//  GET: ?month=&week=&compareWeek=&compareMonth=&area=&outlet=&item=&pic=
//  Fetches analysis data server-side, generates .docx, returns as download.
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, WidthType,
} from 'docx';
import { db } from '@/lib/db';
import { getRuntimeThresholds } from '@/lib/settings';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import {
  buildWorklistFromFlags,
  computePrioritiesFromFlags,
  buildRuleContext,
  computeVarianceAnalysis,
  computeOutletHealthRanking,
  computeHistoricalAnalysis,
} from '@/engine/analysis/analysis';
import { evaluateRules } from '@/engine/rules/evaluator';
import { generateNarrative, buildRecommendations } from '@/engine/narrative/narrative';
import { calcGrowth, computePriceEffect, computeNominalDeviationGrowth } from '@/lib/metrics';
import {
  queryTrendAgg,
  queryExecSummary,
  queryTopItemsByNominal,
  queryTopItemsByDevBom,
  queryTopItemsByCategory,
  queryTopOutlets,
  queryTopOutletsBySales,
  queryDeviationBreakdown,
  queryLossVsSurplus,
  queryAreaAnalysis,
  queryCostImpact,
  queryPareto,
  queryItemConsistency,
  queryHistoricalStats,
} from '@/lib/queries';
import type { InventoryRecord, Outlet, Item, Week } from '@prisma/client';
import type { ExecutiveSummary } from '@/types/inventory';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type RecWithRels = InventoryRecord & { outlet: Outlet; item: Item; week: Week };

// ============================================================
//  Helpers (same as analysis route)
// ============================================================
function buildExecSummaryFromSql(
  curr: any, prev: any | null,
  monthLabel: string, weekLabel: string, prevWeekLabel: string | null,
): ExecutiveSummary {
  const c = curr ?? { sales: 0, nominalDeviasi: 0, qtyBom: 0, qtyDeviasi: 0, qtyWaste: 0, qtySusut: 0, qtyTrial: 0, qtyLossSurplus: 0, totalLoss: 0, totalSurplus: 0, residualLossQty: 0, residualLossNominal: 0, qtyDeviasiLoss: 0 };
  const salesPrev = prev?.sales ?? null;
  return {
    period: { monthLabel, weekLabel, comparisonWeek: prevWeekLabel },
    sales: { current: c.sales, previous: salesPrev, growth: calcGrowth(c.sales, salesPrev) },
    nominalDeviasi: { current: c.nominalDeviasi, previous: prev?.nominalDeviasi ?? null, growth: calcGrowth(c.nominalDeviasi, prev?.nominalDeviasi ?? null) },
    qtyBom: { current: c.qtyBom, previous: prev?.qtyBom ?? null, growth: calcGrowth(c.qtyBom, prev?.qtyBom ?? null) },
    qtyDeviasi: { current: c.qtyDeviasi, previous: prev?.qtyDeviasi ?? null, growth: calcGrowth(c.qtyDeviasi, prev?.qtyDeviasi ?? null) },
    qtyWaste: { current: c.qtyWaste, previous: prev?.qtyWaste ?? null, growth: calcGrowth(c.qtyWaste, prev?.qtyWaste ?? null) },
    qtySusut: { current: c.qtySusut, previous: prev?.qtySusut ?? null, growth: calcGrowth(c.qtySusut, prev?.qtySusut ?? null) },
    qtyTrial: { current: c.qtyTrial, previous: prev?.qtyTrial ?? null, growth: calcGrowth(c.qtyTrial, prev?.qtyTrial ?? null) },
    qtyLossSurplus: { current: c.qtyLossSurplus, previous: prev?.qtyLossSurplus ?? null, growth: calcGrowth(c.qtyLossSurplus, prev?.qtyLossSurplus ?? null) },
    totalLoss: c.totalLoss, totalSurplus: c.totalSurplus,
    lossToSales: c.sales > 0 ? c.totalLoss / c.sales : null,
    surplusToSales: c.sales > 0 ? c.totalSurplus / c.sales : null,
    deviationToBom: c.qtyBom !== 0 ? c.qtyDeviasi / Math.abs(c.qtyBom) : null,
    residualLossQty: c.residualLossQty,
    residualLossPct: c.qtyDeviasiLoss > 0 ? c.residualLossQty / c.qtyDeviasiLoss : null,
  };
}

// ============================================================
//  Formatting helpers
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

function heading(text: string): Paragraph {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_1, spacing: { before: 200, after: 100 } });
}

function paragraph(text: string, bold = false, size = 20): Paragraph {
  return new Paragraph({ children: [new TextRun({ text, bold, size })], spacing: { after: 60 } });
}

function divider(): Paragraph {
  return new Paragraph({ children: [new TextRun({ text: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', color: 'CCCCCC', size: 16 })], spacing: { before: 100, after: 100 } });
}

function tableCell(text: string, bold = false, align: 'left' | 'right' = 'left'): TableCell {
  return new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text, bold, size: 18 })], alignment: align === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT })],
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
  });
}

function makeTable(headers: string[], rows: string[][]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((l, i) => tableCell(l, true, i > 0 ? 'right' : 'left')) }),
      ...rows.map(r => new TableRow({ children: r.map((v, i) => tableCell(v, false, i > 0 ? 'right' : 'left')) })),
    ],
  });
}

// ============================================================
//  Main handler — GET with query params, fetches data server-side
// ============================================================
export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`export-report:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });
    }

    const url = new URL(req.url);
    const month = url.searchParams.get('month');
    const week = url.searchParams.get('week');
    const area = url.searchParams.get('area');
    const outletCode = url.searchParams.get('outlet');
    const itemName = url.searchParams.get('item');
    const pic = url.searchParams.get('pic');

    if (!month || !week) {
      return NextResponse.json({ success: false, error: 'month and week required' }, { status: 400 });
    }

    // Load thresholds
    const thresholds = await getRuntimeThresholds();

    // Resolve PIC outlets
    let picOutletCodes: string[] | null = null;
    if (pic) {
      const pics = await db.outletPIC.findMany({ where: { pic }, select: { outletCode: true } }).catch(() => []);
      picOutletCodes = pics.map(p => p.outletCode);
    }

    // Build where clause
    const buildWhere = (wk: string, mLabel: string) => {
      const w: any = { monthLabel: mLabel, weekLabel: wk };
      if (area && area !== 'all') w.area = area;
      if (outletCode && outletCode !== 'all') w.outlet = { code: outletCode };
      if (itemName) w.item = { name: { contains: itemName } };
      if (picOutletCodes && picOutletCodes.length > 0) w.outlet = { ...(w.outlet || {}), code: { in: picOutletCodes } };
      return w;
    };

    const filterOpts = { area: area === 'all' ? null : area, outletCode: outletCode === 'all' ? null : outletCode, itemName, picOutletCodes };

    // Fetch current + prev records
    const [weeksRaw, fileMonthKeys] = await Promise.all([
      db.week.findMany({ select: { weekLabel: true, monthKey: true }, distinct: ['monthKey', 'weekLabel'] }),
      db.sourceFile.findMany({ select: { monthLabel: true, monthKey: true } }),
    ]);
    const monthLabelByKey = new Map(fileMonthKeys.map(f => [f.monthKey, f.monthLabel]));
    const allPeriods = weeksRaw.map(w => ({
      monthLabel: monthLabelByKey.get(w.monthKey) || 'Unknown',
      weekLabel: w.weekLabel,
      sortKey: `${w.monthKey}|${String(parseInt(w.weekLabel.replace(/\D/g, '')) || 0).padStart(2, '0')}`,
    })).sort((a, b) => a.sortKey.localeCompare(b.sortKey));

    // Auto-compare: same weekLabel in previous month
    const currentPeriodIdx = allPeriods.findIndex(p => p.monthLabel === month && p.weekLabel === week);
    let prevWeek = week;
    let prevMonth: string | null = null;
    if (currentPeriodIdx >= 0) {
      for (let i = currentPeriodIdx - 1; i >= 0; i--) {
        if (allPeriods[i].weekLabel === week && allPeriods[i].monthLabel !== month) {
          prevMonth = allPeriods[i].monthLabel;
          break;
        }
      }
      if (!prevMonth && currentPeriodIdx > 0) {
        prevWeek = allPeriods[currentPeriodIdx - 1].weekLabel;
        prevMonth = allPeriods[currentPeriodIdx - 1].monthLabel;
      }
    }

    // Historical periods (same weekLabel only)
    const historicalPeriods = allPeriods.filter(p => p.weekLabel === week && p.monthLabel !== month)
      .filter(p => { const cur = allPeriods.find(ap => ap.monthLabel === month && ap.weekLabel === week); return !cur || p.sortKey < cur.sortKey; });

    // Fetch records + historical stats in parallel
    const [currentRecs, prevRecs, historicalByOutletItem] = await Promise.all([
      db.inventoryRecord.findMany({
        where: buildWhere(week, month),
        include: { outlet: { select: { code: true, name: true, area: true } }, item: { select: { name: true } } },
      }) as Promise<RecWithRels[]>,
      prevMonth ? db.inventoryRecord.findMany({
        where: buildWhere(prevWeek, prevMonth),
        include: { outlet: { select: { code: true, name: true, area: true } }, item: { select: { name: true } } },
      }) as Promise<RecWithRels[]> : Promise.resolve([] as RecWithRels[]),
      historicalPeriods.length > 0
        ? queryHistoricalStats(historicalPeriods, filterOpts)
        : Promise.resolve(new Map<string, { mean: number; stdDev: number; n: number }>()),
    ]);

    if (currentRecs.length === 0) {
      return NextResponse.json({ success: false, error: 'No records found' }, { status: 404 });
    }

    // Rule evaluation
    const prevByOutletItem = new Map<string, RecWithRels>();
    for (const r of prevRecs) {
      prevByOutletItem.set(`${r.outletId}|${r.itemId}|${r.akunPenyesuaian ?? ''}`, r);
    }

    let normal = 0, warning = 0, abnormal = 0;
    const ruleCategoryCounts = new Map<string, number>();
    const ruleCodeCounts = new Map<string, number>();
    const topAnomaliesForNarrative: any[] = [];
    const recsWithFlags: Array<{ curr: RecWithRels; flags: ReturnType<typeof evaluateRules> }> = [];
    const zeroDevByOutlet = new Map<number, number>();

    for (const curr of currentRecs) {
      if ((curr.qtyDeviasi === null || curr.qtyDeviasi === 0) && (curr.absNominalDeviasi === null || curr.absNominalDeviasi === 0)) {
        normal++; zeroDevByOutlet.set(curr.outletId, (zeroDevByOutlet.get(curr.outletId) ?? 0) + 1); continue;
      }
      const key = `${curr.outletId}|${curr.itemId}|${curr.akunPenyesuaian ?? ''}`;
      const prev = prevByOutletItem.get(key) ?? null;
      const historicalStats = historicalByOutletItem.get(`${curr.outletId}|${curr.itemId}`) ?? null;
      const ctx = buildRuleContext(curr, prev, historicalStats, thresholds);
      const flags = evaluateRules(ctx);
      recsWithFlags.push({ curr, flags });
      if (flags.length === 0) { normal++; }
      else {
        const top = flags[0];
        if (top.severity === 'ABNORMAL') abnormal++;
        else if (top.severity === 'WARNING') warning++;
        else normal++;
        ruleCategoryCounts.set(top.category, (ruleCategoryCounts.get(top.category) || 0) + 1);
        ruleCodeCounts.set(top.ruleCode, (ruleCodeCounts.get(top.ruleCode) || 0) + 1);
        if (topAnomaliesForNarrative.length < 5 && top.severity !== 'NORMAL') {
          topAnomaliesForNarrative.push({ itemName: curr.item.name, outletCode: curr.outlet.code, area: curr.area, issue: top.ruleName, absNominal: curr.absNominalDeviasi ?? 0, devBom: curr.pctQtyDeviasiToBom, direction: curr.direction || 'NEUTRAL' });
        }
      }
    }

    const ruleBreakdown = { byCategory: Object.fromEntries(ruleCategoryCounts), byRule: Object.fromEntries(ruleCodeCounts) };

    // SQL queries
    const [currSummary, prevSummary] = await Promise.all([
      queryExecSummary(week, month, filterOpts),
      prevMonth ? queryExecSummary(prevWeek, prevMonth, filterOpts) : Promise.resolve(null),
    ]);
    const execSummary = buildExecSummaryFromSql(currSummary, prevSummary, month, week, prevWeek);

    const topNItems = thresholds.TOP_N_ITEMS || 10;
    const topNOutlets = thresholds.TOP_N_OUTLETS || 10;
    const [topNominal, topDevBom, topWasteRows, topSusutRows, topTrialRows, topLossSurplusRows, areaAnalysisRaw, topOutletsRaw, breakdown, lvs, trendAggRows, paretoSql, costImpactSql, consistencyItems, dqIssuesRaw] = await Promise.all([
      queryTopItemsByNominal(week, month, filterOpts, topNItems),
      queryTopItemsByDevBom(week, month, filterOpts, topNItems),
      queryTopItemsByCategory(week, month, filterOpts, 'waste', topNItems),
      queryTopItemsByCategory(week, month, filterOpts, 'susut', topNItems),
      queryTopItemsByCategory(week, month, filterOpts, 'trial', topNItems),
      queryTopItemsByCategory(week, month, filterOpts, 'lossSurplus', topNItems),
      queryAreaAnalysis(week, month, filterOpts),
      queryTopOutlets(week, month, filterOpts, topNOutlets),
      queryDeviationBreakdown(week, month, filterOpts),
      queryLossVsSurplus(week, month, filterOpts),
      queryTrendAgg({ ...filterOpts, weekLabel: week }),
      queryPareto(week, month, filterOpts, 50),
      queryCostImpact(week, month, execSummary.sales.current, filterOpts),
      queryItemConsistency(week, month, filterOpts),
      db.dQIssue.groupBy({ by: ['code', 'severity', 'message'], where: { sourceFile: { monthLabel: month } }, _count: { _all: true } }),
    ]);

    const topWaste = topWasteRows.map(r => ({ itemName: r.itemName, outletCode: r.outletCode, qtyWaste: r.qty, nominalWaste: r.nominal }));
    const topSusut = topSusutRows.map(r => ({ itemName: r.itemName, outletCode: r.outletCode, qtySusut: r.qty, nominalSusut: r.nominal }));
    const topTrial = topTrialRows.map(r => ({ itemName: r.itemName, outletCode: r.outletCode, qtyTrial: r.qty, nominalTrial: r.nominal }));
    const topLossSurplus = topLossSurplusRows.map(r => ({ itemName: r.itemName, outletCode: r.outletCode, qtyLossSurplus: r.qty, nominalLossSurplus: r.nominal, direction: r.direction }));

    const explainedTotal = (breakdown.waste ?? 0) + (breakdown.susut ?? 0) + (breakdown.trial ?? 0);
    const breakdownEnriched = { ...breakdown, explained: explainedTotal, explainedPct: breakdown.total > 0 ? explainedTotal / breakdown.total : null, netPct: breakdown.total > 0 ? (breakdown.residual ?? 0) / breakdown.total : null };

    const areaAvgMap = new Map(areaAnalysisRaw.map(a => [a.area, a.avgDevBom ?? 0]));
    const topOut = topOutletsRaw.map(o => ({ outletCode: o.outletCode, outletName: o.outletName, area: o.area, absNominal: o.absNominal, devBom: o.devBom, areaAvg: areaAvgMap.get(o.area) ?? 0, sales: o.sales, lossAmount: o.lossAmount, surplusAmount: o.surplusAmount, direction: o.direction }));

    const worklist = buildWorklistFromFlags(recsWithFlags, thresholds);
    const priorities = computePrioritiesFromFlags(recsWithFlags, thresholds).slice(0, 20);

    // Growth metrics
    const currAvgPrice = execSummary.qtyDeviasi.current != null && Math.abs(execSummary.qtyDeviasi.current) > 0 ? execSummary.nominalDeviasi.current / execSummary.qtyDeviasi.current : null;
    const prevQtyDev = execSummary.qtyDeviasi.previous;
    const prevAvgPrice = (prevQtyDev != null && Math.abs(prevQtyDev) > 0 && execSummary.nominalDeviasi.previous != null) ? execSummary.nominalDeviasi.previous / prevQtyDev : null;
    const nominalDeviasiGrowthMagnitude = computeNominalDeviationGrowth(execSummary.nominalDeviasi.current, execSummary.nominalDeviasi.previous ?? null);
    const priceEffectResult = computePriceEffect(nominalDeviasiGrowthMagnitude, execSummary.qtyBom.growth, currAvgPrice, prevAvgPrice);
    const growthMetrics = {
      salesGrowth: execSummary.sales.growth, bomGrowth: execSummary.qtyBom.growth,
      qtyDeviasiGrowth: execSummary.qtyDeviasi.growth, nominalDeviasiGrowth: nominalDeviasiGrowthMagnitude,
      priceGrowth: priceEffectResult.priceGrowth,
      deviationToSalesRatio: execSummary.sales.current > 0 ? execSummary.nominalDeviasi.current / execSummary.sales.current : null,
      deviationToBomRatio: execSummary.deviationToBom,
      volumeEffect: priceEffectResult.volumeEffect, priceEffect: priceEffectResult.priceEffect, operationalEffect: priceEffectResult.operationalEffect,
      multiPeriodComparison: [] as any[],
    };

    const multiPeriodComparison = trendAggRows.map(r => {
      const mk = monthLabelByKey.get(r.monthLabel) || '0000-00';
      return { period: `${r.weekLabel} ${r.monthLabel.split(' ')[0].slice(0, 3)}`, sortKey: `${mk}|${String(parseInt(r.weekLabel.replace(/\D/g, '')) || 0).padStart(2, '0')}`, sales: r.sales, deviation: r.nominal, devBomRatio: r.devBom, growthPct: null as number | null };
    }).sort((a, b) => a.sortKey.localeCompare(b.sortKey)).map((row, i, arr) => { if (i > 0 && arr[i - 1].deviation > 0) row.growthPct = (row.deviation - arr[i - 1].deviation) / Math.abs(arr[i - 1].deviation); const { sortKey, ...rest } = row; return rest; });
    (growthMetrics as any).multiPeriodComparison = multiPeriodComparison;

    const trend = trendAggRows.map(r => {
      const mk = monthLabelByKey.get(r.monthLabel) || '0000-00';
      return { weekLabel: `${r.weekLabel} ${r.monthLabel.split(' ')[0].slice(0, 3)}`, sortKey: `${mk}|${String(parseInt(r.weekLabel.replace(/\D/g, '')) || 0).padStart(2, '0')}`, devBom: r.devBom, sales: r.sales, nominal: r.nominal };
    }).sort((a, b) => a.sortKey.localeCompare(b.sortKey)).map(({ sortKey, ...rest }) => rest);

    // Narrative
    const narrativeInput = { period: { monthLabel: month, weekLabel: week, comparisonWeek: prevWeek, comparisonMonth: prevMonth }, executiveSummary: execSummary, growthMetrics, healthStatus: { normal, warning, abnormal }, topAnomalies: topAnomaliesForNarrative, deviationBreakdown: breakdownEnriched, investigationCount: worklist.length };
    const narrativePromise = generateNarrative(narrativeInput);
    const recommendations = buildRecommendations(worklist);
    const varianceAnalysis = computeVarianceAnalysis(currentRecs, prevByOutletItem);
    const outletHealthRanking = computeOutletHealthRanking(recsWithFlags, zeroDevByOutlet);
    const paretoItems = paretoSql.items.map(it => ({ itemName: it.itemName, outletCode: it.outletCode, absNominal: it.absNominal, cumPct: it.cumulativePct / 100 }));
    const pareto = { classACount: paretoSql.classACountFull, classAPctOfCost: paretoSql.classAPctFull, totalItems: paretoSql.totalItems, totalAbsNominal: paretoSql.totalAbsNominal, items: paretoItems.slice(0, 20) };
    const costImpact = { totalCost: costImpactSql.totalCost, pctOfSales: execSummary.sales.current > 0 ? costImpactSql.totalCost / execSummary.sales.current : null, lossNominal: lvs.lossNominal, surplusNominal: lvs.surplusNominal, wasteCost: costImpactSql.wasteCost, susutCost: costImpactSql.susutCost, trialCost: costImpactSql.trialCost, residualCost: costImpactSql.residualCost, wastePct: costImpactSql.wastePct, susutPct: costImpactSql.susutPct, trialPct: costImpactSql.trialPct, residualPct: costImpactSql.residualPct };
    const itemConsistencyAnalysis = { systemic: consistencyItems.filter(i => i.consistency === 'SYSTEMIC').map(i => ({ itemName: i.itemName, outletCode: '', area: '', occurrences: i.outletCount, avgDevBom: i.avgDevBom, absNominal: i.totalAbsNominal })), episodic: consistencyItems.filter(i => i.consistency !== 'SYSTEMIC').map(i => ({ itemName: i.itemName, outletCode: '', area: '', absNominal: i.totalAbsNominal, devBom: i.avgDevBom })), items: consistencyItems.map(i => ({ itemName: i.itemName, outletCount: i.outletCount, lossOutlets: i.lossOutlets, surplusOutlets: i.surplusOutlets, totalAbsNominal: i.totalAbsNominal, avgDevBom: i.avgDevBom, consistency: i.consistency })) };
    const historicalAnalysis = computeHistoricalAnalysis(recsWithFlags, historicalByOutletItem);
    const growthComparisonWithHist = { ...growthMetrics, historicalAnalysis };
    const { narrative, source: narrativeSource } = await narrativePromise;

    // Build data object for document
    const data = {
      period: { monthLabel: month, weekLabel: week, comparisonWeek: prevWeek, comparisonMonth: prevMonth },
      filters: { area, outletCode, itemName },
      executiveSummary: execSummary,
      healthStatus: { normal, warning, abnormal, breakdown: ruleBreakdown },
      growthComparison: growthComparisonWithHist,
      topItemsByNominal: topNominal, topItemsByDevBom: topDevBom,
      topItemsByWaste: topWaste, topItemsBySusut: topSusut, topItemsByTrial: topTrial, topItemsByLossSurplus: topLossSurplus,
      topOutlets: topOut,
      deviationBreakdown: breakdownEnriched,
      lossVsSurplus: lvs,
      areaAnalysis: areaAnalysisRaw.map(a => ({ area: a.area, outletCount: a.outletCount, totalSales: a.totalSales, totalAbsNominal: a.totalAbsNominal, avgDevBom: a.avgDevBom, lossToSales: a.lossToSales })),
      outletHealthRanking,
      costImpact,
      pareto,
      varianceAnalysis,
      investigationWorklist: worklist,
      itemConsistencyAnalysis,
      trend,
      narrative,
      narrativeSource,
      recommendation: recommendations,
      priorities,
      durationMs: Date.now() - startedAt,
    };

    // ============================================================
    //  Build Word document
    // ============================================================
    const children: any[] = [];

    // Title
    children.push(
      new Paragraph({ children: [new TextRun({ text: 'LAPORAN ANALISIS INVENTORY CONTROL', bold: true, size: 32 })], alignment: AlignmentType.CENTER, spacing: { before: 400, after: 200 } }),
      new Paragraph({ children: [new TextRun({ text: `Periode: ${data.period.weekLabel} ${data.period.monthLabel}`, size: 24 })], alignment: AlignmentType.CENTER, spacing: { after: 100 } }),
      new Paragraph({ children: [new TextRun({ text: `${outletCode && outletCode !== 'all' ? `Outlet: ${outletCode}` : 'Network'} | ${area && area !== 'all' ? `Area: ${area}` : 'Semua Area'}`, size: 22, color: '666666' })], alignment: AlignmentType.CENTER, spacing: { after: 100 } }),
      new Paragraph({ children: [new TextRun({ text: data.period.comparisonWeek ? `Perbandingan: ${data.period.comparisonWeek} ${data.period.comparisonMonth || ''}` : 'Perbandingan: Otomatis', size: 20, color: '999999' })], alignment: AlignmentType.CENTER, spacing: { after: 300 } }),
      divider(),
    );

    // 1. Executive Summary
    const s = data.executiveSummary;
    children.push(heading('1. EXECUTIVE SUMMARY'));
    children.push(makeTable(['Metric', 'Current', 'Growth', 'Previous'], [
      ['Sales', fmtIDR(s.sales.current), s.sales.growth != null ? fmtPct(s.sales.growth, true) : '—', fmtIDR(s.sales.previous)],
      ['Nominal Deviasi', fmtIDR(s.nominalDeviasi.current), s.nominalDeviasi.growth != null ? fmtPct(s.nominalDeviasi.growth, true) : '—', fmtIDR(s.nominalDeviasi.previous)],
      ['QTY BOM', fmtNum(s.qtyBom.current), s.qtyBom.growth != null ? fmtPct(s.qtyBom.growth, true) : '—', fmtNum(s.qtyBom.previous)],
      ['QTY Deviasi', fmtNum(s.qtyDeviasi.current), s.qtyDeviasi.growth != null ? fmtPct(s.qtyDeviasi.growth, true) : '—', fmtNum(s.qtyDeviasi.previous)],
      ['QTY Waste', fmtNum(s.qtyWaste.current), s.qtyWaste.growth != null ? fmtPct(s.qtyWaste.growth, true) : '—', fmtNum(s.qtyWaste.previous)],
      ['QTY Susut', fmtNum(s.qtySusut.current), s.qtySusut.growth != null ? fmtPct(s.qtySusut.growth, true) : '—', fmtNum(s.qtySusut.previous)],
      ['QTY Trial', fmtNum(s.qtyTrial.current), s.qtyTrial.growth != null ? fmtPct(s.qtyTrial.growth, true) : '—', fmtNum(s.qtyTrial.previous)],
      ['QTY Loss/Surplus', fmtNum(s.qtyLossSurplus.current), s.qtyLossSurplus.growth != null ? fmtPct(s.qtyLossSurplus.growth, true) : '—', fmtNum(s.qtyLossSurplus.previous)],
      ['Deviation/BOM', fmtPct(s.deviationToBom, false), '—', '—'],
      ['Loss/Sales', fmtPct(s.lossToSales, false), '—', '—'],
      ['Total LOSS', fmtIDR(s.totalLoss), '—', '—'],
      ['Total SURPLUS', fmtIDR(s.totalSurplus), '—', '—'],
      ['Residual Loss Qty', fmtNum(s.residualLossQty), '—', '—'],
      ['Residual Loss %', fmtPct(s.residualLossPct, false), '—', '—'],
    ]));

    // 2. Health Status
    const hs = data.healthStatus;
    const total = (hs.normal || 0) + (hs.warning || 0) + (hs.abnormal || 0);
    children.push(heading('2. HEALTH STATUS'));
    children.push(paragraph(`Total: ${total.toLocaleString('id-ID')} | Normal: ${hs.normal} | Warning: ${hs.warning} | Abnormal: ${hs.abnormal} (${total > 0 ? ((hs.abnormal / total) * 100).toFixed(1) : 0}%)`));
    const rules = Object.entries(hs.breakdown?.byRule || {}).map(([k, v]: [string, any]) => `${k} (${v})`).join(', ');
    children.push(paragraph(`Rules: ${rules || 'None'}`));
    children.push(divider());

    // 3. Growth Analysis
    const g = data.growthComparison || {};
    children.push(heading('3. ANALISIS PERTUMBUHAN'));
    children.push(makeTable(['Metric', 'Value'], [
      ['Sales Growth', fmtPct(g.salesGrowth, true)],
      ['BOM Growth', fmtPct(g.bomGrowth, true)],
      ['QTY Deviasi Growth', fmtPct(g.qtyDeviasiGrowth, true)],
      ['Nominal Deviasi Growth', fmtPct(g.nominalDeviasiGrowth, true)],
      ['Price Growth', fmtPct(g.priceGrowth, true)],
      ['Volume Effect', fmtPct(g.volumeEffect, true)],
      ['Price Effect', fmtPct(g.priceEffect, true)],
      ['Operational Effect', fmtPct(g.operationalEffect, true)],
    ]));
    children.push(divider());

    // 4. Top Items
    children.push(heading('4. TOP ITEMS'));
    const topSections = [
      { title: '4.1 Top by Nominal', items: data.topItemsByNominal, cols: ['#', 'Item', 'Outlet', 'Nominal', 'Dir'], map: (it: any, i: number) => [String(i + 1), it.itemName, it.outletCode, fmtIDR(it.absNominal), it.direction] },
      { title: '4.2 Top by Dev/BOM', items: data.topItemsByDevBom, cols: ['#', 'Item', 'Outlet', 'Dev/BOM', 'Tol'], map: (it: any, i: number) => [String(i + 1), it.itemName, it.outletCode, fmtPct(it.devBom, false), it.tolerance != null ? fmtPct(it.tolerance, false) : '—'] },
      { title: '4.3 Top by Waste', items: data.topItemsByWaste, cols: ['#', 'Item', 'Outlet', 'QTY', 'Nominal'], map: (it: any, i: number) => [String(i + 1), it.itemName, it.outletCode, fmtNum(it.qtyWaste), fmtIDR(it.nominalWaste)] },
      { title: '4.4 Top by Susut', items: data.topItemsBySusut, cols: ['#', 'Item', 'Outlet', 'QTY', 'Nominal'], map: (it: any, i: number) => [String(i + 1), it.itemName, it.outletCode, fmtNum(it.qtySusut), fmtIDR(it.nominalSusut)] },
      { title: '4.5 Top by Trial', items: data.topItemsByTrial, cols: ['#', 'Item', 'Outlet', 'QTY', 'Nominal'], map: (it: any, i: number) => [String(i + 1), it.itemName, it.outletCode, fmtNum(it.qtyTrial), fmtIDR(it.nominalTrial)] },
      { title: '4.6 Top by Loss/Surplus', items: data.topItemsByLossSurplus, cols: ['#', 'Item', 'Outlet', 'QTY', 'Nominal', 'Dir'], map: (it: any, i: number) => [String(i + 1), it.itemName, it.outletCode, fmtNum(it.qtyLossSurplus), fmtIDR(it.nominalLossSurplus), it.direction] },
    ];
    for (const sec of topSections) {
      if (sec.items && sec.items.length > 0) {
        children.push(paragraph(sec.title, true));
        children.push(makeTable(sec.cols, sec.items.map(sec.map)));
        children.push(paragraph(''));
      }
    }
    children.push(divider());

    // 5. Deviation Breakdown
    const b = data.deviationBreakdown || {};
    const bdTotal = b.total || 0;
    children.push(heading('5. DEVIATION BREAKDOWN'));
    children.push(makeTable(['Component', 'QTY', '% of Total'], [
      ['Waste', fmtNum(b.waste), bdTotal > 0 ? `${((b.waste / bdTotal) * 100).toFixed(1)}%` : '—'],
      ['Susut', fmtNum(b.susut), bdTotal > 0 ? `${((b.susut / bdTotal) * 100).toFixed(1)}%` : '—'],
      ['Trial', fmtNum(b.trial), bdTotal > 0 ? `${((b.trial / bdTotal) * 100).toFixed(1)}%` : '—'],
      ['Residual', fmtNum(b.residual), bdTotal > 0 ? `${((b.residual / bdTotal) * 100).toFixed(1)}%` : '—'],
      ['TOTAL', fmtNum(bdTotal), '100%'],
    ]));
    children.push(divider());

    // 6. Loss vs Surplus
    const lvsData = data.lossVsSurplus || {};
    children.push(heading('6. LOSS VS SURPLUS'));
    children.push(makeTable(['Category', 'Count', 'Nominal'], [['LOSS', String(lvsData.loss || 0), fmtIDR(lvsData.lossNominal)], ['SURPLUS', String(lvsData.surplus || 0), fmtIDR(lvsData.surplusNominal)]]));
    children.push(divider());

    // 7. Area Analysis
    if (data.areaAnalysis && data.areaAnalysis.length > 0) {
      children.push(heading('7. PERBANDINGAN AREA'));
      children.push(makeTable(['Area', 'Outlets', 'Sales', 'Abs Nominal', 'Dev/BOM', 'Loss/Sales'],
        data.areaAnalysis.map((a: any) => [a.area, String(a.outletCount || 0), fmtIDR(a.totalSales), fmtIDR(a.totalAbsNominal), fmtPct(a.avgDevBom, false), fmtPct(a.lossToSales, false)])));
      children.push(divider());
    }

    // 8. Outlet Ranking
    if (data.outletHealthRanking && data.outletHealthRanking.length > 0) {
      children.push(heading('8. OUTLET HEALTH RANKING'));
      children.push(makeTable(['#', 'Outlet', 'Area', 'Skor', 'Dev/BOM', 'Abn', 'Nominal', 'Sales'],
        data.outletHealthRanking.slice(0, 30).map((o: any, i: number) => [String(i + 1), `${o.outletName} (${o.outletCode})`, o.area, String(o.healthScore ?? '—'), fmtPct(o.devBom, false), String(o.abnormal || 0), fmtIDR(o.absNominal), fmtIDR(o.sales)])));
      children.push(divider());
    }

    // 9. Cost Impact
    const ci = data.costImpact || {};
    if (ci.totalCost) {
      children.push(heading('9. COST IMPACT'));
      children.push(makeTable(['Component', 'Nominal', '% of Cost'], [
        ['Waste', fmtIDR(ci.wasteCost), ci.wastePct != null ? fmtPct(ci.wastePct, false) : '—'],
        ['Susut', fmtIDR(ci.susutCost), ci.susutPct != null ? fmtPct(ci.susutPct, false) : '—'],
        ['Trial', fmtIDR(ci.trialCost), ci.trialPct != null ? fmtPct(ci.trialPct, false) : '—'],
        ['Residual', fmtIDR(ci.residualCost), ci.residualPct != null ? fmtPct(ci.residualPct, false) : '—'],
        ['TOTAL', fmtIDR(ci.totalCost), '100%'],
        ['% of Sales', fmtPct(ci.pctOfSales, false), '—'],
      ]));
      children.push(divider());
    }

    // 10. Pareto
    const paretoData = data.pareto || {};
    if (paretoData.items && paretoData.items.length > 0) {
      children.push(heading('10. PARETO (ABC)'));
      children.push(paragraph(`Class A: ${paretoData.classACount || 0} items (${((paretoData.classAPctOfCost || 0) * 100).toFixed(1)}% of cost) | Total: ${paretoData.totalItems || 0}`));
      children.push(makeTable(['#', 'Item', 'Outlet', 'Nominal', 'Cum %'],
        (paretoData.items || []).slice(0, 20).map((it: any, i: number) => [String(i + 1), it.itemName, it.outletCode, fmtIDR(it.absNominal), `${((it.cumPct || 0) * 100).toFixed(1)}%`])));
      children.push(divider());
    }

    // 11. Variance Analysis
    const va = data.varianceAnalysis || {};
    if ((va.topWorsened || []).length > 0 || (va.topImproved || []).length > 0) {
      children.push(heading('11. VARIANCE ANALYSIS'));
      if ((va.topWorsened || []).length > 0) {
        children.push(paragraph('11.1 Memburuk', true));
        children.push(makeTable(['Item', 'Outlet', 'Current', 'Previous', 'Delta'], va.topWorsened.map((it: any) => [it.itemName, it.outletCode, fmtIDR(it.currentAbsNominal), fmtIDR(it.previousAbsNominal), fmtIDR(it.delta)])));
        children.push(paragraph(''));
      }
      if ((va.topImproved || []).length > 0) {
        children.push(paragraph('11.2 Membaik', true));
        children.push(makeTable(['Item', 'Outlet', 'Current', 'Previous', 'Delta'], va.topImproved.map((it: any) => [it.itemName, it.outletCode, fmtIDR(it.currentAbsNominal), fmtIDR(it.previousAbsNominal), fmtIDR(it.delta)])));
      }
      children.push(divider());
    }

    // 12. Worklist
    if (data.investigationWorklist && data.investigationWorklist.length > 0) {
      const wl = data.investigationWorklist;
      const p1 = wl.filter((w: any) => w.priority === 'P1');
      children.push(heading('12. INVESTIGATION WORKLIST'));
      children.push(paragraph(`P1: ${p1.length} | P2: ${wl.filter((w: any) => w.priority === 'P2').length} | P3: ${wl.filter((w: any) => w.priority === 'P3').length} | Total: ${wl.length}`));
      children.push(makeTable(['Pri', 'Outlet', 'Item', 'Issue', 'Nominal', 'Dev/BOM', 'Dir'],
        wl.slice(0, 50).map((w: any) => [w.priority, w.outletCode, w.itemName, w.issue, fmtIDR(w.absNominalDeviasi), w.deviationToBom != null ? fmtPct(w.deviationToBom, false) : '—', w.direction])));
      if (p1.length > 0) {
        children.push(paragraph(''));
        children.push(paragraph('Recommended Actions (P1):', true));
        p1.slice(0, 10).forEach((w: any) => { if (w.recommendedAction) children.push(paragraph(`• [${w.outletCode}] ${w.itemName}: ${w.recommendedAction}`)); });
      }
      children.push(divider());
    }

    // 13. Item Consistency
    const ic = data.itemConsistencyAnalysis || {};
    if (ic.items && ic.items.length > 0) {
      children.push(heading('13. ITEM CONSISTENCY'));
      children.push(makeTable(['Item', 'Outlets', 'LOSS', 'SURPLUS', 'Nominal', 'Dev/BOM', 'Type'],
        ic.items.slice(0, 20).map((it: any) => [it.itemName, String(it.outletCount || 0), String(it.lossOutlets || 0), String(it.surplusOutlets || 0), fmtIDR(it.totalAbsNominal), fmtPct(it.avgDevBom, false), it.consistency])));
      children.push(divider());
    }

    // 14. Trend
    if (data.trend && data.trend.length > 0) {
      children.push(heading('14. TREND MULTI-PERIODE'));
      children.push(makeTable(['Period', 'Sales', 'Nominal', 'Dev/BOM'],
        data.trend.map((t: any) => [t.weekLabel, fmtIDR(t.sales), fmtIDR(t.nominal), fmtPct(t.devBom, false)])));
      children.push(divider());
    }

    // 15. Narrative
    if (data.narrative) {
      children.push(heading('15. NARASI ANALISIS'));
      for (const line of data.narrative.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') { children.push(new Paragraph({ text: '', spacing: { after: 40 } })); }
        else if (trimmed.startsWith('**') && trimmed.endsWith('**')) { children.push(new Paragraph({ children: [new TextRun({ text: trimmed.replace(/\*\*/g, ''), bold: true, size: 22 })], spacing: { before: 100, after: 60 } })); }
        else { children.push(new Paragraph({ children: [new TextRun({ text: trimmed, size: 20 })], spacing: { after: 60 } })); }
      }
      children.push(divider());
    }

    // 16. Recommendations
    if (data.recommendation && data.recommendation.length > 0) {
      children.push(heading('16. REKOMENDASI TINDAK LANJUT'));
      data.recommendation.forEach((rec: any, i: number) => {
        children.push(new Paragraph({ children: [new TextRun({ text: `${i + 1}. ${rec.why}`, bold: true, size: 22 })], spacing: { before: 120, after: 40 } }));
        if (rec.what) for (const action of rec.what) children.push(new Paragraph({ children: [new TextRun({ text: `   • ${action}`, size: 20 })], spacing: { after: 30 } }));
      });
      children.push(divider());
    }

    // Footer
    children.push(new Paragraph({ text: '', spacing: { before: 400 } }));
    children.push(divider());
    children.push(new Paragraph({ children: [new TextRun({ text: 'Inventory Control Intelligence Platform', size: 16, color: '999999', italics: true })], alignment: AlignmentType.CENTER }));
    children.push(new Paragraph({ children: [new TextRun({ text: `Generated: ${new Date().toLocaleString('id-ID')} | Duration: ${data.durationMs}ms`, size: 16, color: '999999' })], alignment: AlignmentType.CENTER }));

    // Generate document
    const doc = new Document({
      creator: 'Inventory Control Intelligence Platform',
      title: `Laporan Analisis ${data.period.weekLabel} ${data.period.monthLabel}`,
      sections: [{ properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } }, children }],
    });

    const buffer = await Packer.toBuffer(doc);
    const fileName = `Laporan_Analisis_${(data.period.monthLabel || 'unknown').replace(/\s+/g, '_')}_${data.period.weekLabel || ''}.docx`;

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
