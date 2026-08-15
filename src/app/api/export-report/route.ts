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
import { generateNarrative, buildRecommendations, generateAIExecutiveSummary, generateAIPatternInsight } from '@/engine/narrative/narrative';
import { calcGrowth, computePriceEffect, computeNominalDeviationGrowth } from '@/lib/metrics';
import {
  queryTrendAgg,
  queryExecSummary,
  queryTopItemsByNominal,
  queryTopItemsByDevBom,
  queryTopItemsByCategory,
  queryHistoricalCategoryAvg,
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

// ============================================================
//  Document styling — color palette for eye-catching tables
// ============================================================
const COLOR = {
  PRIMARY: '1F4E79',      // deep blue — header background
  PRIMARY_LIGHT: 'D6E4F0', // light blue — zebra stripe
  PRIMARY_TEXT: 'FFFFFF',  // white — header text
  BORDER: 'B4C6E7',        // soft blue border
  BODY_TEXT: '1F2937',     // dark slate — body text
  MUTED: '6B7280',         // gray — secondary text
  NEGATIVE: 'DC2626',      // red — negative numbers
  POSITIVE: '059669',      // green — positive numbers
};

function heading(text: string): Paragraph {
  const safeText = text == null ? '' : String(text);
  return new Paragraph({
    text: safeText,
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 280, after: 120 },
    border: { bottom: { style: 'single' as any, size: 12, color: COLOR.PRIMARY, space: 4 } },
  });
}

function paragraph(text: string, bold = false, size = 20): Paragraph {
  const safeText = text == null ? '' : String(text);
  return new Paragraph({ children: [new TextRun({ text: safeText, bold, size, color: COLOR.BODY_TEXT })], spacing: { after: 80 } });
}

// BUG FIX (AUDIT-EXPORT-AI-4): render inline **bold** markdown within a line.
// Previously only whole-line bold was detected. Now splits on **...** and emits multiple TextRuns.
function renderMarkdownLine(line: string, baseSize = 20, baseColor = COLOR.BODY_TEXT): Paragraph {
  const trimmed = line.trim();
  if (trimmed === '') return new Paragraph({ text: '', spacing: { after: 40 } });
  // Split on **bold** segments — keep the delimiters to detect bold
  const parts = trimmed.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  const runs: any[] = [];
  for (const part of parts) {
    if (part.startsWith('**') && part.endsWith('**')) {
      runs.push(new TextRun({ text: part.slice(2, -2), bold: true, size: baseSize, color: baseColor }));
    } else if (part.startsWith('- ') || part.startsWith('• ')) {
      runs.push(new TextRun({ text: `  ${part}`, size: baseSize, color: baseColor }));
    } else {
      runs.push(new TextRun({ text: part, size: baseSize, color: baseColor }));
    }
  }
  return new Paragraph({ children: runs, spacing: { after: 60 } });
}

function divider(): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text: '', size: 8 })],
    spacing: { before: 80, after: 80 },
    border: { bottom: { style: 'single' as any, size: 6, color: COLOR.BORDER, space: 1 } },
  });
}

// ============================================================
//  Table helpers — styled with header bg, zebra rows, borders
// ============================================================

interface CellOpts {
  bold?: boolean;
  align?: 'left' | 'right';
  isHeader?: boolean;
  isZebra?: boolean;
}

function tableCell(text: string, opts: CellOpts = {}): TableCell {
  const { bold = false, align = 'left', isHeader = false, isZebra = false } = opts;
  const safeText = text == null ? '' : String(text);
  // Negative numbers in red (but not em-dash null indicator)
  const isNegative = safeText.startsWith('-') && safeText !== '—' && !safeText.startsWith('—');

  // Header: white text on primary bg
  // Zebra row: light blue bg
  // Normal: white bg
  const shadingFill = isHeader
    ? { fill: COLOR.PRIMARY, type: 'clear' as any, color: 'auto' }
    : isZebra
      ? { fill: COLOR.PRIMARY_LIGHT, type: 'clear' as any, color: 'auto' }
      : undefined;

  const textColor = isHeader
    ? COLOR.PRIMARY_TEXT
    : isNegative
      ? COLOR.NEGATIVE
      : COLOR.BODY_TEXT;

  return new TableCell({
    children: [new Paragraph({
      children: [new TextRun({ text: safeText, bold: bold || isHeader, size: 18, color: textColor })],
      alignment: align === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT,
      spacing: { before: 20, after: 20 },
    })],
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    shading: shadingFill,
    borders: {
      top: { style: 'single' as any, size: 4, color: COLOR.BORDER },
      bottom: { style: 'single' as any, size: 4, color: COLOR.BORDER },
      left: { style: 'single' as any, size: 4, color: COLOR.BORDER },
      right: { style: 'single' as any, size: 4, color: COLOR.BORDER },
    },
  });
}

function makeTable(headers: string[], rows: string[][]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map((l, i) => tableCell(l, { bold: true, align: i > 0 ? 'right' : 'left', isHeader: true })),
      }),
      ...rows.map((r, idx) => new TableRow({
        children: r.map((v, i) => tableCell(v, { align: i > 0 ? 'right' : 'left', isZebra: idx % 2 === 1 })),
      })),
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
    // BUG FIX (AUDIT-EXPORT-AI-2): read compareWeek/compareMonth from URL params.
    // Previously export ignored user's comparison selection — always auto-computed.
    const userCompareWeek = url.searchParams.get('compareWeek');
    const userCompareMonth = url.searchParams.get('compareMonth');
    const sectionsParam = url.searchParams.get('sections');
    const sections = sectionsParam ? sectionsParam.split(',').filter(Boolean) : null;
    const hasSection = (key: string) => !sections || sections.includes(key);

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
    // BUG FIX (AUDIT-EXPORT-AI-1): monthKeyByLabel — reverse lookup for trend sort.
    // Previously trendAggRows used monthLabelByKey.get(r.monthLabel) which always returned
    // undefined (map is keyed by monthKey, not monthLabel) → sortKey collapsed → sort broken.
    const monthKeyByLabel = new Map(fileMonthKeys.map(f => [f.monthLabel, f.monthKey]));
    const allPeriods = weeksRaw.map(w => ({
      monthLabel: monthLabelByKey.get(w.monthKey) || 'Unknown',
      weekLabel: w.weekLabel,
      sortKey: `${w.monthKey}|${String(parseInt(w.weekLabel.replace(/\D/g, '')) || 0).padStart(2, '0')}`,
    })).sort((a, b) => a.sortKey.localeCompare(b.sortKey));

    // BUG FIX (AUDIT-EXPORT-AI-2): use user's compareWeek/compareMonth if provided.
    // Fall back to auto-compute (same weekLabel in previous month) only when user didn't specify.
    const currentPeriodIdx = allPeriods.findIndex(p => p.monthLabel === month && p.weekLabel === week);
    let prevWeek = userCompareWeek || week;
    let prevMonth: string | null = userCompareMonth || null;
    if (!prevMonth && currentPeriodIdx >= 0) {
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

    // Rev 2: Fetch previous period + historical category data for comparison
    const historicalPeriodsList = historicalPeriods.map(p => ({ monthLabel: p.monthLabel, weekLabel: p.weekLabel }));
    const [topNominal, topDevBom, topWasteRows, topSusutRows, topTrialRows, topLossSurplusRows, areaAnalysisRaw, topOutletsRaw, breakdown, lvs, trendAggRows, paretoSql, costImpactSql, consistencyItems, dqIssuesRaw,
      // Previous period category data (Rev 2)
      prevWasteRows, prevSusutRows, prevTrialRows, prevLossSurplusRows,
      // Historical category averages (Rev 2)
      histWasteMap, histSusutMap, histTrialMap, histLossSurplusMap,
    ] = await Promise.all([
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
      // Rev 2: Previous period category data
      prevMonth ? queryTopItemsByCategory(prevWeek, prevMonth, filterOpts, 'waste', 100) : Promise.resolve([]),
      prevMonth ? queryTopItemsByCategory(prevWeek, prevMonth, filterOpts, 'susut', 100) : Promise.resolve([]),
      prevMonth ? queryTopItemsByCategory(prevWeek, prevMonth, filterOpts, 'trial', 100) : Promise.resolve([]),
      prevMonth ? queryTopItemsByCategory(prevWeek, prevMonth, filterOpts, 'lossSurplus', 100) : Promise.resolve([]),
      // Rev 2: Historical category averages
      queryHistoricalCategoryAvg(historicalPeriodsList, filterOpts, 'waste'),
      queryHistoricalCategoryAvg(historicalPeriodsList, filterOpts, 'susut'),
      queryHistoricalCategoryAvg(historicalPeriodsList, filterOpts, 'trial'),
      queryHistoricalCategoryAvg(historicalPeriodsList, filterOpts, 'lossSurplus'),
    ]);

    // Build prev + historical lookup maps keyed by "itemName|outletCode"
    const prevCatMap = (rows: any[], qtyKey: string, nomKey: string) => {
      const m = new Map<string, { qty: number; nominal: number }>();
      for (const r of rows) m.set(`${r.itemName}|${r.outletCode}`, { qty: r.qty, nominal: r.nominal });
      return m;
    };
    const prevWasteMap = prevCatMap(prevWasteRows, 'qty', 'nominal');
    const prevSusutMap = prevCatMap(prevSusutRows, 'qty', 'nominal');
    const prevTrialMap = prevCatMap(prevTrialRows, 'qty', 'nominal');
    const prevLossSurplusMap = prevCatMap(prevLossSurplusRows, 'qty', 'nominal');

    const topWaste = topWasteRows.map(r => {
      const key = `${r.itemName}|${r.outletCode}`;
      const prev = prevWasteMap.get(key);
      const hist = histWasteMap.get(key);
      return { itemName: r.itemName, outletCode: r.outletCode, qtyWaste: r.qty, nominalWaste: r.nominal, prevQty: prev?.qty ?? null, histAvgQty: hist?.avgQty ?? null };
    });
    const topSusut = topSusutRows.map(r => {
      const key = `${r.itemName}|${r.outletCode}`;
      const prev = prevSusutMap.get(key);
      const hist = histSusutMap.get(key);
      return { itemName: r.itemName, outletCode: r.outletCode, qtySusut: r.qty, nominalSusut: r.nominal, prevQty: prev?.qty ?? null, histAvgQty: hist?.avgQty ?? null };
    });
    const topTrial = topTrialRows.map(r => {
      const key = `${r.itemName}|${r.outletCode}`;
      const prev = prevTrialMap.get(key);
      const hist = histTrialMap.get(key);
      return { itemName: r.itemName, outletCode: r.outletCode, qtyTrial: r.qty, nominalTrial: r.nominal, prevQty: prev?.qty ?? null, histAvgQty: hist?.avgQty ?? null };
    });
    const topLossSurplus = topLossSurplusRows.map(r => {
      const key = `${r.itemName}|${r.outletCode}`;
      const prev = prevLossSurplusMap.get(key);
      const hist = histLossSurplusMap.get(key);
      return { itemName: r.itemName, outletCode: r.outletCode, qtyLossSurplus: r.qty, nominalLossSurplus: r.nominal, direction: r.direction, prevQty: prev?.qty ?? null, histAvgQty: hist?.avgQty ?? null };
    });

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
      const mk = monthKeyByLabel.get(r.monthLabel) || '0000-00';
      return { period: `${r.weekLabel} ${r.monthLabel?.split(' ')[0].slice(0, 3)}`, sortKey: `${mk}|${String(parseInt(r.weekLabel?.replace(/\D/g, '')) || 0).padStart(2, '0')}`, sales: r.sales, deviation: r.nominal, devBomRatio: r.devBom, growthPct: null as number | null };
    }).sort((a, b) => a.sortKey.localeCompare(b.sortKey)).map((row, i, arr) => { if (i > 0 && arr[i - 1].deviation > 0) row.growthPct = (row.deviation - arr[i - 1].deviation) / Math.abs(arr[i - 1].deviation); const { sortKey, ...rest } = row; return rest; });
    (growthMetrics as any).multiPeriodComparison = multiPeriodComparison;

    const trend = trendAggRows.map(r => {
      const mk = monthKeyByLabel.get(r.monthLabel) || '0000-00';
      return { weekLabel: `${r.weekLabel} ${r.monthLabel?.split(' ')[0].slice(0, 3)}`, sortKey: `${mk}|${String(parseInt(r.weekLabel?.replace(/\D/g, '')) || 0).padStart(2, '0')}`, devBom: r.devBom, sales: r.sales, nominal: r.nominal };
    }).sort((a, b) => a.sortKey.localeCompare(b.sortKey)).map(({ sortKey, ...rest }) => rest);

    // Narrative + AI Executive Summary + AI Pattern Insight (parallel)
    const narrativeInput = { period: { monthLabel: month, weekLabel: week, comparisonWeek: prevWeek, comparisonMonth: prevMonth }, executiveSummary: execSummary, growthMetrics, healthStatus: { normal, warning, abnormal }, topAnomalies: topAnomaliesForNarrative, deviationBreakdown: breakdownEnriched, investigationCount: worklist.length };
    const narrativePromise = generateNarrative(narrativeInput);
    // AI Exec Summary: only generate if user selected 'aiSummary' section
    const aiSummaryPromise = hasSection('aiSummary') ? generateAIExecutiveSummary(narrativeInput) : Promise.resolve(null);
    // AI Pattern Insight: only generate if user selected 'aiInsight' section
    const aiInsightPromise = hasSection('aiInsight') ? generateAIPatternInsight(narrativeInput) : Promise.resolve(null);
    const recommendations = buildRecommendations(worklist);
    const varianceAnalysis = computeVarianceAnalysis(currentRecs, prevByOutletItem);
    const outletHealthRanking = computeOutletHealthRanking(recsWithFlags, zeroDevByOutlet);
    const paretoItems = paretoSql.items.map(it => ({ itemName: it.itemName, outletCode: it.outletCode, absNominal: it.absNominal, cumPct: it.cumulativePct / 100 }));
    const pareto = { classACount: paretoSql.classACountFull, classAPctOfCost: paretoSql.classAPctFull, totalItems: paretoSql.totalItems, totalAbsNominal: paretoSql.totalAbsNominal, items: paretoItems.slice(0, 20) };
    const costImpact = { totalCost: costImpactSql.totalCost, pctOfSales: execSummary.sales.current > 0 ? costImpactSql.totalCost / execSummary.sales.current : null, lossNominal: lvs.lossNominal, surplusNominal: lvs.surplusNominal, wasteCost: costImpactSql.wasteCost, susutCost: costImpactSql.susutCost, trialCost: costImpactSql.trialCost, residualCost: costImpactSql.residualCost, wastePct: costImpactSql.wastePct, susutPct: costImpactSql.susutPct, trialPct: costImpactSql.trialPct, residualPct: costImpactSql.residualPct };
    const itemConsistencyAnalysis = { systemic: consistencyItems.filter(i => i.consistency === 'SYSTEMIC').map(i => ({ itemName: i.itemName, outletCode: '', area: '', occurrences: i.outletCount, avgDevBom: i.avgDevBom, absNominal: i.totalAbsNominal })), episodic: consistencyItems.filter(i => i.consistency !== 'SYSTEMIC').map(i => ({ itemName: i.itemName, outletCode: '', area: '', absNominal: i.totalAbsNominal, devBom: i.avgDevBom })), items: consistencyItems.map(i => ({ itemName: i.itemName, outletCount: i.outletCount, lossOutlets: i.lossOutlets, surplusOutlets: i.surplusOutlets, totalAbsNominal: i.totalAbsNominal, avgDevBom: i.avgDevBom, consistency: i.consistency })) };
    const historicalAnalysis = computeHistoricalAnalysis(recsWithFlags, historicalByOutletItem);
    const growthComparisonWithHist = { ...growthMetrics, historicalAnalysis };
    const [narrativeResult, aiSummary, aiInsight] = await Promise.all([narrativePromise, aiSummaryPromise, aiInsightPromise]);
    const { narrative, source: narrativeSource } = narrativeResult;

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
      aiSummary,
      aiInsight,
      // NEW: expose dqIssues for Section 18
      dqIssues: dqIssuesRaw.map(d => ({ code: d.code, severity: d.severity, count: d._count._all, message: d.message })),
      recommendation: recommendations,
      priorities,
      durationMs: Date.now() - startedAt,
    };

    // ============================================================
    //  Build Word document
    // ============================================================
    const children: any[] = [];

    // Build dynamic period labels for column headers (replace static Current/Prev/Hist)
    // Current period: e.g., "WEEK 4 MEI 2026"
    const currLabel = `${data.period.weekLabel} ${data.period.monthLabel}`;
    // Previous period: e.g., "WEEK 4 APR 2026" (or "—" if no comparison)
    const prevLabel = data.period.comparisonWeek
      ? `${data.period.comparisonWeek} ${data.period.comparisonMonth || ''}`
      : '—';
    // Historical periods: list of months/weeks the avg comes from
    // All historical periods share the same weekLabel (filtered), so list the months
    // BUG FIX (AUDIT-EXPORT-AI-5): cap to 3 months + "+N lainnya" to avoid overly long column headers
    const histMonths = historicalPeriods.map(p => p.monthLabel).filter(Boolean);
    const histLabel = histMonths.length === 0
      ? 'Hist Avg (—)'
      : histMonths.length <= 3
        ? `Hist Avg (${histMonths.join(', ')})`
        : `Hist Avg (${histMonths.slice(0, 3).join(', ')} +${histMonths.length - 3} lainnya)`;

    // Title — branded header with color band
    children.push(
      new Paragraph({
        children: [new TextRun({ text: 'INVENTORY CONTROL INTELLIGENCE', bold: true, size: 36, color: COLOR.PRIMARY })],
        alignment: AlignmentType.CENTER, spacing: { before: 400, after: 80 },
      }),
      new Paragraph({
        children: [new TextRun({ text: 'LAPORAN ANALISIS DEVIASI PEMAKAIAN BAHAN', bold: true, size: 22, color: COLOR.MUTED })],
        alignment: AlignmentType.CENTER, spacing: { after: 200 },
        border: { bottom: { style: 'single' as any, size: 18, color: COLOR.PRIMARY, space: 6 } },
      }),
      new Paragraph({ children: [new TextRun({ text: `Periode: ${currLabel}`, bold: true, size: 26, color: COLOR.BODY_TEXT })], alignment: AlignmentType.CENTER, spacing: { before: 200, after: 80 } }),
      new Paragraph({ children: [new TextRun({ text: `${outletCode && outletCode !== 'all' ? `Resto: ${outletCode}` : 'Network (Semua Resto)'}  |  ${area && area !== 'all' ? `Area: ${area}` : 'Semua Area'}`, size: 20, color: COLOR.MUTED })], alignment: AlignmentType.CENTER, spacing: { after: 60 } }),
      new Paragraph({ children: [new TextRun({ text: data.period.comparisonWeek ? `Perbandingan: ${prevLabel}` : 'Perbandingan: Otomatis', size: 18, color: COLOR.MUTED, italics: true })], alignment: AlignmentType.CENTER, spacing: { after: 300 } }),
      divider(),
    );

    // AI Executive Summary — Opsi A (di awal, sebelum section detail)
    if (hasSection('aiSummary') && data.aiSummary) {
      children.push(heading('🤖 AI ANALYST SUMMARY'));
      children.push(paragraph('Ringkasan opini AI berdasarkan data periode ini. Baca section ini dulu sebelum lihat tabel detail.'));
      // BUG FIX (AUDIT-EXPORT-AI-4): use renderMarkdownLine for inline **bold** support
      for (const line of data.aiSummary.split('\n')) {
        children.push(renderMarkdownLine(line));
      }
      children.push(divider());
    }

    if (hasSection('exec')) {
    const s = data.executiveSummary;
    children.push(heading('1. RINGKASAN UTAMA (Executive Summary)'));
    children.push(paragraph('Ringkasan KPI utama periode ini dibandingkan periode sebelumnya. Growth = persentase perubahan.'));
    children.push(makeTable(['Metrik', currLabel, 'Perubahan', prevLabel], [
      ['Penjualan', fmtIDR(s.sales.current), s.sales.growth != null ? fmtPct(s.sales.growth, true) : '—', fmtIDR(s.sales.previous)],
      ['Nominal Deviasi', fmtIDR(s.nominalDeviasi.current), s.nominalDeviasi.growth != null ? fmtPct(s.nominalDeviasi.growth, true) : '—', fmtIDR(s.nominalDeviasi.previous)],
      ['QTY BOM', fmtNum(s.qtyBom.current), s.qtyBom.growth != null ? fmtPct(s.qtyBom.growth, true) : '—', fmtNum(s.qtyBom.previous)],
      ['QTY Deviasi', fmtNum(s.qtyDeviasi.current), s.qtyDeviasi.growth != null ? fmtPct(s.qtyDeviasi.growth, true) : '—', fmtNum(s.qtyDeviasi.previous)],
      ['QTY Waste', fmtNum(s.qtyWaste.current), s.qtyWaste.growth != null ? fmtPct(s.qtyWaste.growth, true) : '—', fmtNum(s.qtyWaste.previous)],
      ['QTY Susut', fmtNum(s.qtySusut.current), s.qtySusut.growth != null ? fmtPct(s.qtySusut.growth, true) : '—', fmtNum(s.qtySusut.previous)],
      ['QTY Trial', fmtNum(s.qtyTrial.current), s.qtyTrial.growth != null ? fmtPct(s.qtyTrial.growth, true) : '—', fmtNum(s.qtyTrial.previous)],
      ['QTY Loss/Surplus', fmtNum(s.qtyLossSurplus.current), s.qtyLossSurplus.growth != null ? fmtPct(s.qtyLossSurplus.growth, true) : '—', fmtNum(s.qtyLossSurplus.previous)],
      ['% Deviasi To BOM', fmtPct(s.deviationToBom, false), '—', '—'],
      ['Loss To Sales', fmtPct(s.lossToSales, false), '—', '—'],
      ['Total LOSS', fmtIDR(s.totalLoss), '—', '—'],
      ['Total SURPLUS', fmtIDR(s.totalSurplus), '—', '—'],
      ['Loss/Surplus Qty', fmtNum(s.residualLossQty), '—', '—'],
      ['Loss/Surplus %', fmtPct(s.residualLossPct, false), '—', '—'],
    ]));

    }
    if (hasSection('health')) {
    const hs = data.healthStatus;
    const total = (hs.normal || 0) + (hs.warning || 0) + (hs.abnormal || 0);
    children.push(heading('2. STATUS KESEHATAN INVENTORY'));
    children.push(paragraph('Jumlah item normal, perlu perhatian, dan bermasalah. Sertakan aturan deteksi anomali yang terpicu.'));
    children.push(paragraph(`Total: ${total.toLocaleString('id-ID')} | Normal: ${hs.normal} | Warning: ${hs.warning} | Abnormal: ${hs.abnormal} (${total > 0 ? ((hs.abnormal / total) * 100).toFixed(1) : 0}%)`));
    const rules = Object.entries(hs.breakdown?.byRule || {}).map(([k, v]: [string, any]) => `${k} (${v})`).join(', ');
    children.push(paragraph(`Rules: ${rules || 'None'}`));
    children.push(divider());

    }
    if (hasSection('growth')) {
    const g = data.growthComparison || {};
    children.push(heading('3. ANALISIS PERUBAHAN (GROWTH)'));
    children.push(paragraph('Perubahan antar periode. Pengaruh Volume = perubahan karena kenaikan volume penjualan. Pengaruh Harga = perubahan karena harga naik/turun. Pengaruh Operasional = sisa perubahan setelah volume dan harga dijelaskan.'));
    children.push(makeTable(['Metric', 'Value'], [
      ['Penjualan Growth', fmtPct(g.salesGrowth, true)],
      ['QTY BOM Growth', fmtPct(g.bomGrowth, true)],
      ['QTY Deviasi Growth', fmtPct(g.qtyDeviasiGrowth, true)],
      ['Nominal Deviasi Growth', fmtPct(g.nominalDeviasiGrowth, true)],
      ['Price Growth', fmtPct(g.priceGrowth, true)],
      ['Volume Effect', fmtPct(g.volumeEffect, true)],
      ['Price Effect', fmtPct(g.priceEffect, true)],
      ['Operational Effect', fmtPct(g.operationalEffect, true)],
    ]));
    children.push(divider());

    }
    if (hasSection('topItems')) {
    children.push(heading('4. ITEM PRIORITAS (TOP ITEMS)'));
    children.push(paragraph('Item-item dengan kontribusi terbesar berdasarkan berbagai kategori. Angka negatif = SURPLUS (ditandai merah).'));
    const topSections = [
      // Rev 3: Sort by absNominalDeviasi (done in query), display signed nominalDeviasi
      { title: `4.1 Nominal Deviasi Terbesar (${currLabel})`, items: data.topItemsByNominal, cols: ['#', 'Item', 'Resto', `Nominal Deviasi ${currLabel}`, 'Direction'], map: (it: any, i: number) => [String(i + 1), it.itemName, it.outletCode, fmtIDR(it.nominalDeviasi), it.direction] },
      // Rev 4: Sort by abs(devBom) (done in query), display signed devBom
      { title: `4.2 % Deviasi To BOM Terbesar (${currLabel})`, items: data.topItemsByDevBom, cols: ['#', 'Item', 'Resto', `% Deviasi To BOM ${currLabel}`, '% Toleransi'], map: (it: any, i: number) => [String(i + 1), it.itemName, it.outletCode, fmtPct(it.devBom, false), it.tolerance != null ? fmtPct(it.tolerance, false) : '—'] },
      // Rev 2: Add QTY Prev + QTY Hist Avg columns for Waste/Susut/Trial/LossSurplus
      { title: `4.3 QTY Waste Terbesar (${currLabel})`, items: data.topItemsByWaste, cols: ['#', 'Item', 'Resto', `QTY Waste ${currLabel}`, `QTY ${prevLabel}`, histLabel, `Nominal Waste ${currLabel}`], map: (it: any, i: number) => [String(i + 1), it.itemName, it.outletCode, fmtNum(it.qtyWaste), it.prevQty != null ? fmtNum(it.prevQty) : '—', it.histAvgQty != null ? fmtNum(it.histAvgQty) : '—', fmtIDR(it.nominalWaste)] },
      { title: `4.4 QTY Susut Terbesar (${currLabel})`, items: data.topItemsBySusut, cols: ['#', 'Item', 'Resto', `QTY Susut ${currLabel}`, `QTY ${prevLabel}`, histLabel, `Nominal Susut ${currLabel}`], map: (it: any, i: number) => [String(i + 1), it.itemName, it.outletCode, fmtNum(it.qtySusut), it.prevQty != null ? fmtNum(it.prevQty) : '—', it.histAvgQty != null ? fmtNum(it.histAvgQty) : '—', fmtIDR(it.nominalSusut)] },
      { title: `4.5 QTY Trial Terbesar (${currLabel})`, items: data.topItemsByTrial, cols: ['#', 'Item', 'Resto', `QTY Trial ${currLabel}`, `QTY ${prevLabel}`, histLabel, `Nominal Trial ${currLabel}`], map: (it: any, i: number) => [String(i + 1), it.itemName, it.outletCode, fmtNum(it.qtyTrial), it.prevQty != null ? fmtNum(it.prevQty) : '—', it.histAvgQty != null ? fmtNum(it.histAvgQty) : '—', fmtIDR(it.nominalTrial)] },
      { title: `4.6 QTY Loss/Surplus Terbesar (${currLabel})`, items: data.topItemsByLossSurplus, cols: ['#', 'Item', 'Resto', `QTY Loss/Surplus ${currLabel}`, `QTY ${prevLabel}`, histLabel, `Nominal Loss/Surplus ${currLabel}`, 'Direction'], map: (it: any, i: number) => [String(i + 1), it.itemName, it.outletCode, fmtNum(it.qtyLossSurplus), it.prevQty != null ? fmtNum(it.prevQty) : '—', it.histAvgQty != null ? fmtNum(it.histAvgQty) : '—', fmtIDR(it.nominalLossSurplus), it.direction] },
    ];
    for (const sec of topSections) {
      if (sec.items && sec.items.length > 0) {
        children.push(paragraph(sec.title, true));
        children.push(makeTable(sec.cols, sec.items.map(sec.map)));
        children.push(paragraph(''));
      }
    }
    children.push(divider());

    }
    if (hasSection('breakdown')) {
    const b = data.deviationBreakdown || {};
    const bdTotal = b.total || 0;
    children.push(heading('5. RINCIAN KOMPOSISI SELISIH (Deviation Breakdown)'));
    children.push(makeTable(['Component', 'QTY', '% of Total'], [
      ['QTY Waste', fmtNum(b.waste), bdTotal > 0 ? `${((b.waste / bdTotal) * 100).toFixed(1)}%` : '—'],
      ['QTY Susut', fmtNum(b.susut), bdTotal > 0 ? `${((b.susut / bdTotal) * 100).toFixed(1)}%` : '—'],
      ['QTY Trial', fmtNum(b.trial), bdTotal > 0 ? `${((b.trial / bdTotal) * 100).toFixed(1)}%` : '—'],
      ['Loss/Surplus Qty', fmtNum(b.residual), bdTotal > 0 ? `${((b.residual / bdTotal) * 100).toFixed(1)}%` : '—'],
      ['TOTAL', fmtNum(bdTotal), '100%'],
    ]));
    children.push(divider());

    }
    if (hasSection('lossSurplus')) {
    const lvsData = data.lossVsSurplus || {};
    children.push(heading('6. LOSS VS SURPLUS'));
    children.push(paragraph('LOSS = pemakaian aktual melebihi standar (SOC). SURPLUS = pemakaian aktual di bawah standar.'));
    children.push(makeTable(['Category', 'Count', 'Nominal Deviasi'], [['LOSS', String(lvsData.loss || 0), fmtIDR(lvsData.lossNominal)], ['SURPLUS', String(lvsData.surplus || 0), fmtIDR(lvsData.surplusNominal)]]));
    children.push(divider());

    }
    if (hasSection('area')) {
    if (data.areaAnalysis && data.areaAnalysis.length > 0) {
      children.push(heading('7. PERBANDINGAN ANTAR AREA'));
    children.push(paragraph('Perbandingan performa antar area. Loss/Sales = efisiensi area (makin rendah makin baik).'));
      children.push(makeTable(['Area', 'Resto', 'Penjualan', 'Abs Nominal Deviasi', '% Deviasi To BOM', 'Loss/Sales'],
        data.areaAnalysis.map((a: any) => [a.area, String(a.outletCount || 0), fmtIDR(a.totalSales), fmtIDR(a.totalAbsNominal), fmtPct(a.avgDevBom, false), fmtPct(a.lossToSales, false)])));
      children.push(divider());
    }

    }
    if (hasSection('ranking')) {
    if (data.outletHealthRanking && data.outletHealthRanking.length > 0) {
      children.push(heading('8. RANKING KONDISI RESTO'));
      children.push(makeTable(['#', 'Resto', 'Area', 'Health Score', '% Deviasi To BOM', 'Abnormal', 'Abs Nominal Deviasi', 'Penjualan'],
        data.outletHealthRanking.slice(0, 30).map((o: any, i: number) => [String(i + 1), `${o.outletName} (${o.outletCode})`, o.area, String(o.healthScore ?? '—'), fmtPct(o.devBom, false), String(o.abnormal || 0), fmtIDR(o.absNominal), fmtIDR(o.sales)])));
      children.push(divider());
    }

    }
    if (hasSection('cost')) {
    const ci = data.costImpact || {};
    if (ci.totalCost) {
      children.push(heading('9. DAMPAK BIAYA (Cost Impact)'));
    children.push(paragraph('Rincian biaya selisih: Nominal Waste + Nominal Susut + Nominal Trial + Loss/Surplus Nominal. % of Sales = seberapa besar selisih dibanding Penjualan.'));
      children.push(makeTable(['Component', 'Nominal', '% of Cost'], [
        ['Nominal Waste', fmtIDR(ci.wasteCost), ci.wastePct != null ? fmtPct(ci.wastePct, false) : '—'],
        ['Nominal Susut', fmtIDR(ci.susutCost), ci.susutPct != null ? fmtPct(ci.susutPct, false) : '—'],
        ['Nominal Trial', fmtIDR(ci.trialCost), ci.trialPct != null ? fmtPct(ci.trialPct, false) : '—'],
        ['Loss/Surplus Nominal', fmtIDR(ci.residualCost), ci.residualPct != null ? fmtPct(ci.residualPct, false) : '—'],
        ['TOTAL', fmtIDR(ci.totalCost), '100%'],
        ['% of Sales', fmtPct(ci.pctOfSales, false), '—'],
      ]));
      children.push(divider());
    }

    }
    if (hasSection('pareto')) {
    const paretoData = data.pareto || {};
    if (paretoData.items && paretoData.items.length > 0) {
      children.push(heading('10. ANALISIS PARETO (ABC)'));
    children.push(paragraph('Aturan 80/20: sedikit item menyumbang selisih terbesar. Class A = item dengan kontribusi tertinggi (prioritas investigasi).'));
      children.push(paragraph(`Class A: ${paretoData.classACount || 0} items (${((paretoData.classAPctOfCost || 0) * 100).toFixed(1)}% of cost) | Total: ${paretoData.totalItems || 0}`));
      children.push(makeTable(['#', 'Item', 'Resto', 'Abs Nominal Deviasi', 'Cum %'],
        (paretoData.items || []).slice(0, 20).map((it: any, i: number) => [String(i + 1), it.itemName, it.outletCode, fmtIDR(it.absNominal), `${((it.cumPct || 0) * 100).toFixed(1)}%`])));
      children.push(divider());
    }

    }
    if (hasSection('variance')) {
    const va = data.varianceAnalysis || {};
    if ((va.topWorsened || []).length > 0 || (va.topImproved || []).length > 0) {
      children.push(heading('11. ANALISIS PERUBAHAN ITEM (Variance)'));
    children.push(paragraph('Item yang memburuk (selisih naik) dan membaik (selisih turun) dibanding periode sebelumnya. Menampilkan Nominal Deviasi actual (bukan abs). Angka negatif = SURPLUS (merah).'));
      if ((va.topWorsened || []).length > 0) {
        children.push(paragraph('11.1 Item dengan Perubahan Terbesar (Selisih Terbesar)', true));
        // Rev 6: Display actual signed nominalDeviasi (not abs), rename Delta → Selisih
        // Use dynamic period labels (currLabel / prevLabel) instead of Current/Previous
        children.push(makeTable(['Item', 'Resto', `Nominal Deviasi ${currLabel}`, `Nominal Deviasi ${prevLabel}`, 'Selisih'], va.topWorsened.map((it: any) => [it.itemName, it.outletCode, fmtIDR(it.currentNominal), fmtIDR(it.previousNominal), fmtIDR(it.selisih)])));
        children.push(paragraph(''));
      }
      if ((va.topImproved || []).length > 0) {
        children.push(paragraph('11.2 Item dengan Perubahan Terkecil (Selisih Terkecil)', true));
        children.push(makeTable(['Item', 'Resto', `Nominal Deviasi ${currLabel}`, `Nominal Deviasi ${prevLabel}`, 'Selisih'], va.topImproved.map((it: any) => [it.itemName, it.outletCode, fmtIDR(it.currentNominal), fmtIDR(it.previousNominal), fmtIDR(it.selisih)])));
      }
      children.push(divider());
    }

    }
    if (hasSection('worklist')) {
    if (data.investigationWorklist && data.investigationWorklist.length > 0) {
      const wl = data.investigationWorklist;
      const p1 = wl.filter((w: any) => w.priority === 'P1');
      children.push(heading('12. DAFTAR PRIORITAS INVESTIGASI'));
    children.push(paragraph('P1 = prioritas tertinggi (investigasi segera). P2 = menengah. P3 = rendah. Setiap item ada issue, Nominal Deviasi, dan rekomendasi tindakan.'));
      children.push(paragraph(`P1: ${p1.length} | P2: ${wl.filter((w: any) => w.priority === 'P2').length} | P3: ${wl.filter((w: any) => w.priority === 'P3').length} | Total: ${wl.length}`));
      children.push(makeTable(['Pri', 'Resto', 'Item', 'Issue', 'Nominal Deviasi', '% Deviasi To BOM', 'Direction'],
        wl.slice(0, 50).map((w: any) => [w.priority, w.outletCode, w.itemName, w.issue, fmtIDR(w.absNominalDeviasi), w.deviationToBom != null ? fmtPct(w.deviationToBom, false) : '—', w.direction])));
      if (p1.length > 0) {
        children.push(paragraph(''));
        children.push(paragraph('Rekomendasi Tindakan (P1):', true));
        p1.slice(0, 10).forEach((w: any) => { if (w.recommendedAction) children.push(paragraph(`• [${w.outletCode}] ${w.itemName}: ${w.recommendedAction}`)); });
      }
      children.push(divider());
    }

    }
    if (hasSection('consistency')) {
    const ic = data.itemConsistencyAnalysis || {};
    if (ic.items && ic.items.length > 0) {
      children.push(heading('13. POLA ITEM ANTAR RESTO (Consistency)'));
      children.push(makeTable(['Item', 'Resto Count', 'LOSS', 'SURPLUS', 'Abs Nominal Deviasi', '% Deviasi To BOM', 'Type'],
        ic.items.slice(0, 20).map((it: any) => [it.itemName, String(it.outletCount || 0), String(it.lossOutlets || 0), String(it.surplusOutlets || 0), fmtIDR(it.totalAbsNominal), fmtPct(it.avgDevBom, false), it.consistency])));
      children.push(divider());
    }

    }
    if (hasSection('trend')) {
    if (data.trend && data.trend.length > 0) {
      children.push(heading('14. TREND ANTAR PERIODE'));
    children.push(paragraph('Perbandingan periode yang sama di bulan-bulan sebelumnya.'));
      children.push(makeTable(['Period', 'Penjualan', 'Nominal Deviasi', '% Deviasi To BOM'],
        data.trend.map((t: any) => [t.weekLabel, fmtIDR(t.sales), fmtIDR(t.nominal), fmtPct(t.devBom, false)])));
      children.push(divider());
    }

    }
    // AI Pattern Insight — Opsi D (sebelum narrative section 15)
    if (hasSection('aiInsight') && data.aiInsight) {
      children.push(heading('🔍 AI PATTERN INSIGHT'));
      children.push(paragraph('Pola dan insight yang AI temukan dari data — cross-correlation, anomaly pattern, composition insight.'));
      // BUG FIX (AUDIT-EXPORT-AI-4, -10): use renderMarkdownLine for inline **bold** + bullet support
      for (const line of data.aiInsight.split('\n')) {
        children.push(renderMarkdownLine(line));
      }
      children.push(divider());
    }

    if (hasSection('narrative')) {
    if (data.narrative && typeof data.narrative === 'string') {
      children.push(heading('15. NARASI ANALISIS'));
    children.push(paragraph('Analisis otomatis berbasis data oleh AI.'));
      for (const line of data.narrative?.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') { children.push(new Paragraph({ text: '', spacing: { after: 40 } })); }
        else if (trimmed.startsWith('**') && trimmed.endsWith('**')) { children.push(new Paragraph({ children: [new TextRun({ text: trimmed.replace(/\*\*/g, ''), bold: true, size: 22 })], spacing: { before: 100, after: 60 } })); }
        else { children.push(new Paragraph({ children: [new TextRun({ text: trimmed, size: 20 })], spacing: { after: 60 } })); }
      }
      children.push(divider());
    }

    }
    if (hasSection('recommendations')) {
    if (data.recommendation && data.recommendation.length > 0) {
      children.push(heading('16. REKOMENDASI TINDAK LANJUT'));
    children.push(paragraph('Rekomendasi terstruktur berdasarkan temuan analisis.'));
      data.recommendation.forEach((rec: any, i: number) => {
        children.push(new Paragraph({ children: [new TextRun({ text: `${i + 1}. ${rec.why}`, bold: true, size: 22 })], spacing: { before: 120, after: 40 } }));
        if (rec.what) for (const action of rec.what) children.push(new Paragraph({ children: [new TextRun({ text: `   • ${action}`, size: 20 })], spacing: { after: 30 } }));
      });
      children.push(divider());
    }

    }

    // ============================================================
    // NEW SECTIONS — additional analyses
    // ============================================================

    // 17. Top Resto by Sales — highest revenue outlets (already computed: topOutlets)
    if (hasSection('topOutlets')) {
      if (data.topOutlets && data.topOutlets.length > 0) {
        children.push(heading('17. TOP RESTO BY SALES'));
        children.push(paragraph('Resto dengan Penjualan tertinggi. Loss/Surplus menunjukkan net direction. Area Avg = rata-rata Dev/BOM area resto tersebut.'));
        children.push(makeTable(['#', 'Resto', 'Area', 'Penjualan', 'Abs Nominal Deviasi', '% Deviasi To BOM', 'Area Avg', 'Loss', 'Surplus', 'Direction'],
          data.topOutlets.slice(0, 15).map((o: any, i: number) => [String(i + 1), `${o.outletName} (${o.outletCode})`, o.area, fmtIDR(o.sales), fmtIDR(o.absNominal), fmtPct(o.devBom, false), fmtPct(o.areaAvg, false), fmtIDR(o.lossAmount), fmtIDR(o.surplusAmount), o.direction])));
        children.push(divider());
      }
    }

    // 18. Data Quality Issues — DQ validation summary (already fetched: dqIssuesRaw)
    if (hasSection('dqIssues')) {
      const dq = (data as any).dqIssues || [];
      if (dq.length > 0) {
        children.push(heading('18. DATA QUALITY ISSUES'));
        children.push(paragraph('Ringkasan issue kualitas data yang terdeteksi saat import. Severity: ERROR (block), WARNING (review), INFO (informational).'));
        children.push(makeTable(['Code', 'Severity', 'Count', 'Message'],
          dq.slice(0, 30).map((d: any) => [d.code || d.key, d.severity, String(d.count), (d.message || '').slice(0, 80)])));
        children.push(divider());
      } else {
        children.push(heading('18. DATA QUALITY ISSUES'));
        children.push(paragraph('✅ Tidak ada issue kualitas data terdeteksi pada periode ini.'));
        children.push(divider());
      }
    }

    // 19. Historical Anomaly Analysis — items with z-score > threshold (already computed: historicalAnalysis)
    if (hasSection('historical')) {
      const ha = (data as any).historicalAnalysis || data.growthComparison?.historicalAnalysis;
      if (ha && ha.criticalItems && ha.criticalItems.length > 0) {
        children.push(heading('19. HISTORICAL ANOMALY ANALYSIS'));
        children.push(paragraph('Item yang deviation-nya abnormal dibanding perilaku historical (z-score > 1.0). Z-score > 2.0 = sangat abnormal. Historical Avg = rata-rata Dev/BOM periode sama di bulan-bulan sebelumnya.'));
        children.push(makeTable(['#', 'Item', 'Resto', 'Area', 'Current Dev/BOM', 'Historical Avg', 'Z-Score', 'Abs Nominal Deviasi'],
          ha.criticalItems.slice(0, 15).map((it: any, i: number) => [String(i + 1), it.itemName, it.outletCode, it.area, fmtPct(it.currentDevBom, false), fmtPct(it.historicalAvg, false), it.zScore != null ? it.zScore.toFixed(2) : '—', fmtIDR(it.absNominal)])));
        children.push(divider());
      } else {
        children.push(heading('19. HISTORICAL ANOMALY ANALYSIS'));
        children.push(paragraph('✅ Tidak ada item dengan anomali historical signifikan pada periode ini (z-score semua ≤ 1.0).'));
        children.push(divider());
      }
    }

    // Footer — branded closing
    children.push(new Paragraph({ text: '', spacing: { before: 400 } }));
    children.push(new Paragraph({
      children: [new TextRun({ text: '', size: 8 })],
      spacing: { before: 60, after: 60 },
      border: { top: { style: 'single' as any, size: 12, color: COLOR.PRIMARY, space: 2 } },
    }));
    children.push(new Paragraph({ children: [new TextRun({ text: 'Inventory Control Intelligence Platform', size: 18, color: COLOR.PRIMARY, bold: true, italics: true })], alignment: AlignmentType.CENTER, spacing: { after: 40 } }));
    children.push(new Paragraph({ children: [new TextRun({ text: `Generated: ${new Date().toLocaleString('id-ID')}  |  Duration: ${data.durationMs}ms`, size: 14, color: COLOR.MUTED })], alignment: AlignmentType.CENTER }));

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
