// ============================================================
//  /api/export-report — Export analysis data to Word (.docx)
//  GET: ?month=&week=&compareWeek=&compareMonth=&area=&outlet=&item=&pic=
//  Fetches analysis data server-side, generates .docx, returns as download.
//
//  PERF-FASE3-BE04: Migrated from legacy JS rule evaluator (35K-record loop
//  calling evaluateRules per record) to SQL-pushed evaluators (evaluateRulesSql
//  + queryVarianceAnalysis + queryHistoricalCriticalItems). Matches the
//  dashboard's /api/analysis route — 3-5s faster per export.
// ============================================================
import { logger } from '@/lib/logger';
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, WidthType, BorderStyle, ShadingType,
} from 'docx';
import { db } from '@/lib/db';
import { getRuntimeThresholds } from '@/lib/settings';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { calcGrowth, computeNominalDeviationGrowth, calcZScoreFromStats } from '@/lib/metrics';
import {
  queryTrendAgg,
  queryExecSummary,
  queryTopItemsByNominal,
  queryTopItemsByDevBom,
  queryTopItemsByCategory,
  queryTopItemsByDeviasiRank,
  queryHistoricalCategoryAvg,
  queryDeviationBreakdown,
  queryAreaAnalysis,
  queryHistoricalStats,
  queryOutletHealthRanking,
  queryGlobalItemSearch,
} from '@/lib/queries';
import { queryVarianceAnalysis, queryHistoricalCriticalItems } from '@/lib/queries/health-ranking';
import { evaluateRulesSql, evaluateHistoricalRulesJs, type SqlRuleFlag } from '@/lib/queries/rule-evaluation';
import { queryHistoricalStatsMultiMetric, type MultiMetricHistoricalStats } from '@/lib/queries/historical';
import { getMonthResolver, resolveMonthLabel } from '@/lib/month-resolver';
// FIX (BUG-PERF-4): use shared kelompok resolver instead of inline fetch-all + JS filter
import { resolveKelompokOutletCodes } from '@/lib/kelompok-resolver';
// FIX (RESTORE-BACKEND-2): use shared buildInventoryWhere instead of inline closure
import { buildInventoryWhere } from '@/lib/build-where';
// FIX (RESTORE-BACKEND-2): use shared resolveComparePeriod instead of inline ~15-line block
import { resolveComparePeriod } from '@/lib/period-resolver';
import type { ExecutiveSummary } from '@/types/inventory';
import { validateQuery, exportReportQuerySchema } from '@/lib/validation';
import { withStatementTimeout } from '@/lib/queries/shared';
import type { ExecSummaryRow } from '@/lib/queries/dashboard';
import { errorResponse } from '@/lib/error-response';
import { buildCacheKey, getCached, setCached } from '@/lib/aggregation-cache';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// ============================================================
//  Helpers (same as analysis route)
// ============================================================
function buildExecSummaryFromSql(
  curr: ExecSummaryRow | null,
  prev: ExecSummaryRow | null,
  monthLabel: string,
  weekLabel: string,
  prevWeekLabel: string | null,
): ExecutiveSummary & { _prevMetrics: PrevMetrics | null } {
  const c = curr ?? { sales: 0, nominalDeviasi: 0, qtyBom: 0, qtyDeviasi: 0, qtyWaste: 0, qtySusut: 0, qtyTrial: 0, qtyLossSurplus: 0, totalLoss: 0, totalSurplus: 0, residualLossQty: 0, residualLossNominal: 0, qtyDeviasiLoss: 0 };
  const salesPrev = prev?.sales ?? null;
  return {
    period: { monthLabel, weekLabel, comparisonWeek: prevWeekLabel },
    sales: { current: c.sales, previous: salesPrev, growth: calcGrowth(c.sales, salesPrev) },
    nominalDeviasi: { current: c.nominalDeviasi, previous: prev?.nominalDeviasi ?? null, growth: computeNominalDeviationGrowth(c.nominalDeviasi, prev?.nominalDeviasi ?? null) },
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
    // FIX: store prev values for the 6 metrics that previously showed '—' in the prev column.
    // These are computed from the same `prev` SQL row that already has sales, qtyBom, etc.
    _prevMetrics: prev ? {
      totalLoss: prev.totalLoss ?? null,
      totalSurplus: prev.totalSurplus ?? null,
      lossToSales: prev.sales > 0 ? (prev.totalLoss ?? 0) / prev.sales : null,
      surplusToSales: prev.sales > 0 ? (prev.totalSurplus ?? 0) / prev.sales : null,
      deviationToBom: prev.qtyBom !== 0 ? (prev.qtyDeviasi ?? 0) / Math.abs(prev.qtyBom) : null,
      residualLossQty: prev.residualLossQty ?? null,
      residualLossPct: prev.qtyDeviasiLoss > 0 ? (prev.residualLossQty ?? 0) / prev.qtyDeviasiLoss : null,
    } : null,
  };
}

/**
 * Shape of the 6 prev-period metrics attached to ExecutiveSummary for the
 * Word export's growth column (FIX: was `as any` cast at every access site).
 */
interface PrevMetrics {
  totalLoss: number | null;
  totalSurplus: number | null;
  lossToSales: number | null;
  surplusToSales: number | null;
  deviationToBom: number | null;
  residualLossQty: number | null;
  residualLossPct: number | null;
}

/** Executive summary shape used by the export route (extends base type with _prevMetrics). */
type ExecSummaryWithPrev = ExecutiveSummary & { _prevMetrics: PrevMetrics | null };

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
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: COLOR.PRIMARY, space: 4 } },
  });
}

function paragraph(text: string, bold = false, size = 20): Paragraph {
  const safeText = text == null ? '' : String(text);
  return new Paragraph({ children: [new TextRun({ text: safeText, bold, size, color: COLOR.BODY_TEXT })], spacing: { after: 80 } });
}

function divider(): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text: '', size: 8 })],
    spacing: { before: 80, after: 80 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: COLOR.BORDER, space: 1 } },
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
  // FIX #3: Detect "↑" (increase vs historical = warning/red) and "↓" (decrease = good/green)
  const isIncrease = safeText.startsWith('↑');
  const isDecrease = safeText.startsWith('↓');

  // Header: white text on primary bg
  // Zebra row: light blue bg
  // Normal: white bg
  const shadingFill = isHeader
    ? { fill: COLOR.PRIMARY, type: ShadingType.CLEAR, color: 'auto' }
    : isZebra
      ? { fill: COLOR.PRIMARY_LIGHT, type: ShadingType.CLEAR, color: 'auto' }
      : undefined;

  const textColor = isHeader
    ? COLOR.PRIMARY_TEXT
    : isNegative
      ? COLOR.NEGATIVE
      : isIncrease
        ? COLOR.NEGATIVE   // red for increase (warning)
        : isDecrease
          ? COLOR.POSITIVE  // green for decrease (good)
          : COLOR.BODY_TEXT;

  return new TableCell({
    children: [new Paragraph({
      children: [new TextRun({ text: safeText, bold: bold || isHeader || isIncrease || isDecrease, size: 18, color: textColor })],
      alignment: align === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT,
      spacing: { before: 20, after: 20 },
    })],
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    shading: shadingFill,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: COLOR.BORDER },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: COLOR.BORDER },
      left: { style: BorderStyle.SINGLE, size: 4, color: COLOR.BORDER },
      right: { style: BorderStyle.SINGLE, size: 4, color: COLOR.BORDER },
    },
  });
}

// FIX #3: Format "vs Hist" column — compares current vs historical average.
// Returns "↑ X%" (red, increase = warning) or "↓ X%" (green, decrease = good) or "—".
function fmtVsHist(current: number | null, histAvg: number | null): string {
  if (current == null || histAvg == null || histAvg === 0) return '—';
  const pctChange = (current - histAvg) / Math.abs(histAvg);
  const pctStr = `${(Math.abs(pctChange) * 100).toFixed(1)}%`;
  if (pctChange > 0) return `↑ ${pctStr}`;
  if (pctChange < 0) return `↓ ${pctStr}`;
  return '= 0%';
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

    // Sprint 1: Zod input validation
    const validation = validateQuery(exportReportQuerySchema, url.searchParams);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    // BUG FIX (BUG-NORECORDS-4/5): use `let` for month so we can reassign after
    // case-insensitive resolution (DB may have different case than URL param).
    let month = url.searchParams.get('month');
    const week = url.searchParams.get('week');
    const area = url.searchParams.get('area');
    const outletCode = url.searchParams.get('outlet');
    const itemName = url.searchParams.get('item');
    const pic = url.searchParams.get('pic');
    // FIX (BUG-KELOMPOK-GLOBAL): read kelompok so Word export respects the
    // global kelompok filter (was missing → exported report included outlets
    // from ALL kelompok even when user filtered to one).
    const kelompok = url.searchParams.get('kelompok');
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

    // PERF: DB-level cache check — export-report is the heaviest route (7-12s).
    // Cache the generated .docx buffer for 5 min. Same filter params = same report.
    const cacheKey = buildCacheKey({
      route: 'export-report', month, week,
      compareWeek: userCompareWeek, compareMonth: userCompareMonth,
      area: area && area !== 'all' ? area : null,
      kelompok: kelompok && kelompok !== 'all' ? kelompok : null,
      outletCode: outletCode && outletCode !== 'all' ? outletCode : null,
      itemName: itemName || null, pic: pic || null,
    });
    const EXPORT_CACHE_TTL = 5 * 60 * 1000; // 5 min
    const cachedExport = await getCached<{ buffer: number[]; fileName: string } | null>(cacheKey, EXPORT_CACHE_TTL);
    if (cachedExport && cachedExport.buffer && cachedExport.fileName) {
      const buffer = Buffer.from(cachedExport.buffer);
      return new NextResponse(new Uint8Array(buffer) as BodyInit, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'Content-Disposition': `attachment; filename="${cachedExport.fileName}"`,
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600, must-revalidate',
        },
      });
    }

    // Load thresholds
    const thresholds = await getRuntimeThresholds();

    // Resolve PIC outlets — FIX FILTER-3: case-insensitive via raw SQL LOWER()
    // FIX (AUDIT8-ROLLBACK-1, Item 8): wrap raw SQL in withStatementTimeout.
    let picOutletCodes: string[] | null = null;
    if (pic) {
      try {
        const pics = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ outletCode: string }>>`SELECT "outletCode" FROM "OutletPIC" WHERE LOWER(pic) = LOWER(${pic})`);
        picOutletCodes = pics.map(p => p.outletCode);
      } catch (e) {
        logger.error("[export-report] OutletPIC query failed:", { error: e instanceof Error ? e.message : String(e) });
        picOutletCodes = [];
      }
      // FIX FILTER-4: sentinel for empty list (was: skipped filter → showed ALL outlets)
      if (picOutletCodes.length === 0) {
        picOutletCodes = ['__NO_MATCH__'];
      }
    }

    // FIX (BUG-PERF-4 / BUG-BE-2): Replaced inline "fetch ALL outlets + JS filter"
    // with the shared resolveKelompokOutletCodes helper. Same DB-level SQL filter
    // as buildSqlFilters, ~5x faster, and deduplicates the logic.
    const kelompokOutletCodes = await resolveKelompokOutletCodes(kelompok);

    // FIX (RESTORE-BACKEND-2): buildWhere now delegates to the shared
    // `buildInventoryWhere` helper from @/lib/build-where.ts. The helper
    // handles area/itemName/kelompok/PIC/outletCode + all intersections,
    // including sentinel for empty PIC list (idempotent — export-report
    // pre-sentineled at line 300; helper passes it through unchanged).
    const buildWhere = (wk: string, mLabel: string): Prisma.InventoryRecordWhereInput =>
      buildInventoryWhere({
        week: wk,
        month: mLabel,
        area,
        itemName,
        kelompok,
        kelompokOutletCodes,
        picOutletCodes,
        outletCode,
      });

    const filterOpts = {
      area: area === 'all' ? null : area,
      kelompok: kelompok === 'all' ? null : kelompok,
      outletCode: outletCode === 'all' ? null : outletCode,
      itemName,
      picOutletCodes, // already has sentinel applied
    };

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
    // BUG FIX (BUG-NORECORDS-4/5 / FIX-DEEP-1): Case-insensitive monthLabel resolution
    // via shared util `@/lib/month-resolver`. DB may have "AGUSTUS 2026" (upload-data.ts)
    // or "Agustus 2026" (dashboard import). Resolve user-sent month to actual DB case
    // to avoid "No records found".
    const monthResolver = await getMonthResolver();
    // Resolve current + compare month labels to actual DB case
    month = resolveMonthLabel(month, monthResolver) || month;
    const resolvedCompareMonth = userCompareMonth ? resolveMonthLabel(userCompareMonth, monthResolver) : null;
    const allPeriods = weeksRaw.map(w => ({
      monthLabel: monthLabelByKey.get(w.monthKey) || 'Unknown',
      weekLabel: w.weekLabel,
      sortKey: `${w.monthKey}|${String(parseInt(w.weekLabel.replace(/\D/g, '')) || 0).padStart(2, '0')}`,
    })).sort((a, b) => a.sortKey.localeCompare(b.sortKey));

    // BUG FIX (AUDIT-EXPORT-AI-2): use user's compareWeek/compareMonth if provided.
    // Fall back to auto-compute (same weekLabel in previous month) only when user didn't specify.
    //
    // FIX (RESTORE-BACKEND-2): the inline ~15-line period-resolution block has been
    // extracted to `@/lib/period-resolver.ts` as `resolveComparePeriod`. This also
    // fixes a subtle bug in the old logic: when the user set compareWeek WITHOUT
    // compareMonth, the old code searched for the CURRENT week (not compareWeek) in
    // the previous month — so setting compareWeek alone had no effect. The new
    // helper correctly searches for `compareWeek` in the previous month.
    const { prevWeek, prevMonth } = await resolveComparePeriod(
      week,
      month,
      userCompareWeek,
      resolvedCompareMonth,
    );

    // Historical periods (same weekLabel only)
    const historicalPeriods = allPeriods.filter(p => p.weekLabel === week && p.monthLabel !== month)
      .filter(p => { const cur = allPeriods.find(ap => ap.monthLabel === month && ap.weekLabel === week); return !cur || p.sortKey < cur.sortKey; });

    // PERF-FASE3-BE04: Slim projection (5 columns × 35K rows = ~700KB) instead of
    // full 25-column include. evaluateHistoricalRulesJs is the only consumer.
    // Also fire evaluateRulesSql + queryVarianceAnalysis in parallel (they were
    // previously sequential 35K-record JS loops).
    const [currSlim, historicalByOutletItem, sqlFlags, varianceAnalysis] = await Promise.all([
      db.inventoryRecord.findMany({
        where: buildWhere(week, month),
        select: {
          outletId: true, itemId: true, akunPenyesuaian: true,
          nominalLossSurplus: true, pctQtyDeviasiToBom: true,
        },
      }),
      historicalPeriods.length > 0
        ? queryHistoricalStatsMultiMetric(historicalPeriods, filterOpts)
        : Promise.resolve(new Map<string, MultiMetricHistoricalStats>()),
      evaluateRulesSql(week, month, prevWeek, prevMonth, filterOpts, thresholds),
      queryVarianceAnalysis(week, month, prevWeek, prevMonth, filterOpts),
    ]);

    if (currSlim.length === 0) {
      // BUG FIX (BUG-NORECORDS-11): include filter context in error message for debugging
      const filterSummary = [
        `month="${month}"`, `week="${week}"`,
        area && area !== 'all' ? `area="${area}"` : null,
        outletCode && outletCode !== 'all' ? `outlet="${outletCode}"` : null,
        itemName ? `item="${itemName}"` : null,
        pic ? `pic="${pic}"` : null,
      ].filter(Boolean).join(', ');
      return NextResponse.json({ success: false, error: `No records found for ${filterSummary}. Coba cek filter atau import data ulang.` }, { status: 404 });
    }

    // PERF-FASE3-BE04: Historical zScore rules in JS (reads slim 5-col projection).
    // Replaces the 35K-record evaluateRules loop — same logic, batch-processed.
    const histFlags = evaluateHistoricalRulesJs(
      currSlim,
      historicalByOutletItem,
      thresholds,
    );

    // Build topFlagByKey — one entry per (outletId, itemId, akunPenyesuaian)
    // that fired at least one rule. Keeps the highest-priority flag.
    const allFlags = [...sqlFlags, ...histFlags];
    const topFlagByKey = new Map<string, SqlRuleFlag>();
    for (const flag of allFlags) {
      const key = `${flag.outletId}|${flag.itemId}|${flag.akunPenyesuaian ?? ''}`;
      const existing = topFlagByKey.get(key);
      if (!existing || flag.priority > existing.priority) {
        topFlagByKey.set(key, flag);
      }
    }
    // SQL queries
    const [currSummary, prevSummary] = await Promise.all([
      queryExecSummary(week, month, filterOpts),
      prevMonth && prevWeek ? queryExecSummary(prevWeek, prevMonth, filterOpts) : Promise.resolve(null),
    ]);
    const execSummary = buildExecSummaryFromSql(currSummary, prevSummary, month, week, prevWeek);

    const topNItems = thresholds.TOP_N_ITEMS || 10;

    // Rev 2: Fetch previous period + historical category data for comparison
    const historicalPeriodsList = historicalPeriods.map(p => ({ monthLabel: p.monthLabel, weekLabel: p.weekLabel }));
    const [topNominal, topDevBom, topWasteRows, topSusutRows, topTrialRows, topLossSurplusRows, areaAnalysisRaw, breakdown, trendAggRows,
      // Previous period category data (Rev 2)
      prevWasteRows, prevSusutRows, prevTrialRows, prevLossSurplusRows,
      // Historical category averages (Rev 2)
      histWasteMap, histSusutMap, histTrialMap, histLossSurplusMap,
      // Top Items by Deviasi Rank (Section 13 replacement)
      topDeviasiRank,
    ] = await Promise.all([
      queryTopItemsByNominal(week, month, filterOpts, topNItems),
      queryTopItemsByDevBom(week, month, filterOpts, topNItems),
      queryTopItemsByCategory(week, month, filterOpts, 'waste', topNItems),
      queryTopItemsByCategory(week, month, filterOpts, 'susut', topNItems),
      queryTopItemsByCategory(week, month, filterOpts, 'trial', topNItems),
      queryTopItemsByCategory(week, month, filterOpts, 'lossSurplus', topNItems),
      queryAreaAnalysis(week, month, filterOpts),
      queryDeviationBreakdown(week, month, filterOpts),
      queryTrendAgg({ ...filterOpts, weekLabel: week }),
      // Rev 2: Previous period category data
      prevMonth && prevWeek ? queryTopItemsByCategory(prevWeek, prevMonth, filterOpts, 'waste', 100) : Promise.resolve([]),
      prevMonth && prevWeek ? queryTopItemsByCategory(prevWeek, prevMonth, filterOpts, 'susut', 100) : Promise.resolve([]),
      prevMonth && prevWeek ? queryTopItemsByCategory(prevWeek, prevMonth, filterOpts, 'trial', 100) : Promise.resolve([]),
      prevMonth && prevWeek ? queryTopItemsByCategory(prevWeek, prevMonth, filterOpts, 'lossSurplus', 100) : Promise.resolve([]),
      // Rev 2: Historical category averages
      queryHistoricalCategoryAvg(historicalPeriodsList, filterOpts, 'waste'),
      queryHistoricalCategoryAvg(historicalPeriodsList, filterOpts, 'susut'),
      queryHistoricalCategoryAvg(historicalPeriodsList, filterOpts, 'trial'),
      queryHistoricalCategoryAvg(historicalPeriodsList, filterOpts, 'lossSurplus'),
      // Section 13: Top Items by Deviasi Rank (national ranking)
      queryTopItemsByDeviasiRank(week, month, filterOpts, 500),
    ]);

    // Build prev + historical lookup maps keyed by "itemName|outletCode"
    const prevCatMap = (rows: Array<{ itemName: string; outletCode: string; qty: number; nominal: number }>, _qtyKey: string, _nomKey: string) => {
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

    // Growth metrics
    const nominalDeviasiGrowthMagnitude = computeNominalDeviationGrowth(execSummary.nominalDeviasi.current, execSummary.nominalDeviasi.previous ?? null);
    const growthMetrics = {
      salesGrowth: execSummary.sales.growth, bomGrowth: execSummary.qtyBom.growth,
      qtyDeviasiGrowth: execSummary.qtyDeviasi.growth, nominalDeviasiGrowth: nominalDeviasiGrowthMagnitude,
      deviationToSalesRatio: execSummary.sales.current > 0 ? execSummary.nominalDeviasi.current / execSummary.sales.current : null,
      deviationToBomRatio: execSummary.deviationToBom,
      multiPeriodComparison: [] as Array<Record<string, unknown>>,
    };

    const multiPeriodComparison = trendAggRows.map(r => {
      const mk = monthKeyByLabel.get(r.monthLabel) || '0000-00';
      return { period: `${r.weekLabel} ${r.monthLabel?.split(' ')[0].slice(0, 3)}`, sortKey: `${mk}|${String(parseInt(r.weekLabel?.replace(/\D/g, '')) || 0).padStart(2, '0')}`, sales: r.sales, deviation: r.nominal, devBomRatio: r.devBom, growthPct: null as number | null };
    }).sort((a, b) => a.sortKey.localeCompare(b.sortKey)).map((row, i, arr) => { if (i > 0) row.growthPct = computeNominalDeviationGrowth(row.deviation, arr[i - 1].deviation); const { sortKey, ...rest } = row; return rest; });
    growthMetrics.multiPeriodComparison = multiPeriodComparison;

    const trend = trendAggRows.map(r => {
      const mk = monthKeyByLabel.get(r.monthLabel) || '0000-00';
      return { weekLabel: `${r.weekLabel} ${r.monthLabel?.split(' ')[0].slice(0, 3)}`, sortKey: `${mk}|${String(parseInt(r.weekLabel?.replace(/\D/g, '')) || 0).padStart(2, '0')}`, devBom: r.devBom, sales: r.sales, nominal: r.nominal };
    }).sort((a, b) => a.sortKey.localeCompare(b.sortKey)).map(({ sortKey, ...rest }) => rest);

    // PERF-FASE3-BE04: varianceAnalysis already computed via SQL in the
    // Promise.all block above (queryVarianceAnalysis). Historical analysis
    // now uses queryHistoricalCriticalItems SQL instead of 35K-record JS loop.
    const histCriticalKeys = [...topFlagByKey.values()]
      .filter((f) => f.ruleCode === 'HISTORICAL_ABNORMAL' || f.ruleCode === 'HISTORICAL_WARNING')
      .map(f => ({ outletId: f.outletId, itemId: f.itemId, akunPenyesuaian: f.akunPenyesuaian }));
    const histCriticalRows = await queryHistoricalCriticalItems(week, month, filterOpts, histCriticalKeys);
    const histCriticalItems = histCriticalRows.map(row => {
      const key = `${row.outletId}|${row.itemId}`;
      const stats = historicalByOutletItem.get(key);
      if (!stats || stats.devBom.stdDev <= 0) return null;
      // ZS-03 FIX: Don't coerce null to 0 — pass raw value to calcZScoreFromStats
      const zScore = calcZScoreFromStats(row.pctQtyDeviasiToBom, stats.devBom.mean, stats.devBom.stdDev);
      return {
        itemName: row.itemName,
        outletCode: row.outletCode,
        area: row.area,
        currentDevBom: row.pctQtyDeviasiToBom ?? 0,
        historicalAvg: stats.devBom.mean,
        zScore: zScore ?? 0,
        absNominal: row.absNominalDeviasi ?? 0,
        currentWaste: Math.abs(row.qtyWaste ?? 0),
        currentSusut: Math.abs(row.qtySusut ?? 0),
        currentTrial: Math.abs(row.qtyTrial ?? 0),
      };
    }).filter((x): x is NonNullable<typeof x> => x !== null);
    histCriticalItems.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
    const historicalAnalysis = { criticalItems: histCriticalItems.slice(0, 200) };
    const growthComparisonWithHist = { ...growthMetrics, historicalAnalysis };

    // FIX: fetch additional data for new export sections (restoPriority + itemCrossOutlet)
    const [outletHealthRanking, topItemForCrossOutlet] = await Promise.all([
      queryOutletHealthRanking(week, month, filterOpts),
      // For itemCrossOutlet: find the top item by total abs nominal, then query its cross-outlet data
      (async () => {
        const topNom = topNominal[0];
        if (!topNom) return [];
        // FIX (BUG-KELOMPOK-GLOBAL): pass kelompok to cross-outlet query in export
        return queryGlobalItemSearch(week, month, topNom.itemName, {
          area: filterOpts.area,
          kelompok: filterOpts.kelompok,
          picOutletCodes: filterOpts.picOutletCodes,
        }, 50);
      })(),
    ]);

    // Build data object for document
    const data = {
      period: { monthLabel: month, weekLabel: week, comparisonWeek: prevWeek, comparisonMonth: prevMonth },
      // FIX (BUG-KELOMPOK-GLOBAL): include kelompok in response filters
      // FIX (BUG-PERF-11): include pic too — was missing, inconsistent with pareto route.
      filters: { area, kelompok, outletCode, itemName, pic },
      executiveSummary: execSummary,
      growthComparison: growthComparisonWithHist,
      topItemsByNominal: topNominal, topItemsByDevBom: topDevBom,
      topItemsByWaste: topWaste, topItemsBySusut: topSusut, topItemsByTrial: topTrial, topItemsByLossSurplus: topLossSurplus,
      deviationBreakdown: breakdownEnriched,
      areaAnalysis: areaAnalysisRaw.map(a => ({ area: a.area, outletCount: a.outletCount, totalSales: a.totalSales, totalAbsNominal: a.totalAbsNominal, avgDevBom: a.avgDevBom, lossToSales: a.lossToSales })),
      varianceAnalysis,
      topDeviasiRank,
      trend,
      durationMs: Date.now() - startedAt,
    };

    // ============================================================
    //  Build Word document
    // ============================================================
    const children: Array<Paragraph | Table> = [];

    // Build dynamic period labels — short format (no week, month abbreviated to 3 chars + 2-digit year)
    // e.g., "MEI 2026" → "MEI 26", "WEEK 4 MEI 2026" → "MEI 26" (week removed per user request)
    const shortMonth = (label: string): string => {
      if (!label) return '—';
      const parts = label.trim().split(/\s+/);
      if (parts.length >= 2) {
        const month = parts[0].substring(0, 3).toUpperCase();
        const year = parts[1].length === 4 ? parts[1].substring(2) : parts[1];
        return `${month} ${year}`;
      }
      return label.substring(0, 10);
    };
    const currLabel = shortMonth(data.period.monthLabel);
    const prevLabel = data.period.comparisonMonth
      ? shortMonth(data.period.comparisonMonth)
      : '—';
    // Historical periods: show range "Jan-Jul 26" (earliest to latest)
    const histMonths = historicalPeriods.map(p => shortMonth(p.monthLabel)).filter(m => m !== '—');
    const histLabel = histMonths.length === 0
      ? 'Hist (—)'
      : histMonths.length === 1
        ? `Hist (${histMonths[0]})`
        : `Hist (${histMonths[histMonths.length - 1]}-${histMonths[0]})`;

    // Title — simplified header per user request
    const restoName = outletCode && outletCode !== 'all' ? outletCode : 'Semua Resto';
    const compareText = data.period.comparisonMonth
      ? ` vs ${prevLabel}`
      : '';
    // History range label (e.g., "Jan-Jul 26") for header
    const histRange = histMonths.length >= 2
      ? `${histMonths[histMonths.length - 1]}-${histMonths[0]}`
      : histMonths.length === 1
        ? histMonths[0]
        : currLabel;
    children.push(
      new Paragraph({
        children: [new TextRun({ text: 'Ringkasan Laporan Deviasi', bold: true, size: 36, color: COLOR.PRIMARY })],
        alignment: AlignmentType.CENTER, spacing: { before: 400, after: 80 },
      }),
      new Paragraph({
        children: [new TextRun({ text: `${restoName}  |  ${histRange}${compareText}`, size: 22, color: COLOR.MUTED })],
        alignment: AlignmentType.CENTER, spacing: { after: 200 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 18, color: COLOR.PRIMARY, space: 6 } },
      }),
      divider(),
    );

    if (hasSection('exec')) {
    const s = data.executiveSummary;
    children.push(heading('1. Rangkuman'));
    children.push(makeTable(['Metrik', currLabel, 'Perubahan', prevLabel], [
      ['Nominal Deviasi', fmtIDR(s.nominalDeviasi.current), s.nominalDeviasi.growth != null ? fmtPct(s.nominalDeviasi.growth, true) : '—', fmtIDR(s.nominalDeviasi.previous)],
      ['QTY BOM', fmtNum(s.qtyBom.current), s.qtyBom.growth != null ? fmtPct(s.qtyBom.growth, true) : '—', fmtNum(s.qtyBom.previous)],
      ['QTY Deviasi', fmtNum(s.qtyDeviasi.current), s.qtyDeviasi.growth != null ? fmtPct(s.qtyDeviasi.growth, true) : '—', fmtNum(s.qtyDeviasi.previous)],
      ['QTY Waste', fmtNum(s.qtyWaste.current), s.qtyWaste.growth != null ? fmtPct(s.qtyWaste.growth, true) : '—', fmtNum(s.qtyWaste.previous)],
      ['QTY Susut', fmtNum(s.qtySusut.current), s.qtySusut.growth != null ? fmtPct(s.qtySusut.growth, true) : '—', fmtNum(s.qtySusut.previous)],
      ['QTY Trial', fmtNum(s.qtyTrial.current), s.qtyTrial.growth != null ? fmtPct(s.qtyTrial.growth, true) : '—', fmtNum(s.qtyTrial.previous)],
      ['QTY Loss/Surplus', fmtNum(s.qtyLossSurplus.current), s.qtyLossSurplus.growth != null ? fmtPct(s.qtyLossSurplus.growth, true) : '—', fmtNum(s.qtyLossSurplus.previous)],
      ['% Deviasi To BOM', fmtPct(s.deviationToBom, false), s._prevMetrics?.deviationToBom != null ? fmtPct(calcGrowth(s.deviationToBom, s._prevMetrics.deviationToBom), true) : '—', s._prevMetrics?.deviationToBom != null ? fmtPct(s._prevMetrics.deviationToBom, false) : '—'],
      ['Loss To Sales', fmtPct(s.lossToSales, false), s._prevMetrics?.lossToSales != null ? fmtPct(calcGrowth(s.lossToSales, s._prevMetrics.lossToSales), true) : '—', s._prevMetrics?.lossToSales != null ? fmtPct(s._prevMetrics.lossToSales, false) : '—'],
      ['Total LOSS', fmtIDR(s.totalLoss), s._prevMetrics?.totalLoss != null ? fmtPct(calcGrowth(s.totalLoss, s._prevMetrics.totalLoss), true) : '—', s._prevMetrics?.totalLoss != null ? fmtIDR(s._prevMetrics.totalLoss) : '—'],
      ['Total SURPLUS', fmtIDR(s.totalSurplus), s._prevMetrics?.totalSurplus != null ? fmtPct(calcGrowth(s.totalSurplus, s._prevMetrics.totalSurplus), true) : '—', s._prevMetrics?.totalSurplus != null ? fmtIDR(s._prevMetrics.totalSurplus) : '—'],
      ['Loss/Surplus Qty', fmtNum(s.residualLossQty), s._prevMetrics?.residualLossQty != null ? fmtPct(calcGrowth(s.residualLossQty, s._prevMetrics.residualLossQty), true) : '—', s._prevMetrics?.residualLossQty != null ? fmtNum(s._prevMetrics.residualLossQty) : '—'],
      ['Loss/Surplus %', fmtPct(s.residualLossPct, false), s._prevMetrics?.residualLossPct != null ? fmtPct(calcGrowth(s.residualLossPct, s._prevMetrics.residualLossPct), true) : '—', s._prevMetrics?.residualLossPct != null ? fmtPct(s._prevMetrics.residualLossPct, false) : '—'],
    ]));

    }
    if (hasSection('growth')) {
    const g = data.growthComparison || {};
    children.push(heading('2. Perubahan (Growth)'));
    children.push(makeTable(['Metric', 'Value'], [
      ['Penjualan Growth', fmtPct(g.salesGrowth, true)],
      ['QTY BOM Growth', fmtPct(g.bomGrowth, true)],
      ['QTY Deviasi Growth', fmtPct(g.qtyDeviasiGrowth, true)],
      ['Nominal Deviasi Growth', fmtPct(g.nominalDeviasiGrowth, true)],
    ]));
    children.push(divider());

    }
    if (hasSection('topItems')) {
    children.push(heading('3. Item Prioritas (Top Items)'));
    children.push(paragraph('Item-item dengan kontribusi terbesar berdasarkan berbagai kategori. Angka negatif = LOSS/rugi (ditandai merah).'));
    const topSections = [
      // Rev 3: Sort by absNominalDeviasi (done in query), display signed nominalDeviasi
      { title: `4.1 Nominal Deviasi Terbesar (${currLabel})`, items: data.topItemsByNominal, cols: ['#', 'Item', 'Resto', `Nominal Deviasi ${currLabel}`], map: (it, i) => [String(i + 1), it.itemName, it.outletCode, fmtIDR(it.nominalDeviasi)] },
      // Rev 4: Sort by abs(devBom) (done in query), display signed devBom
      { title: `4.2 % Deviasi To BOM Terbesar (${currLabel})`, items: data.topItemsByDevBom, cols: ['#', 'Item', 'Resto', `% Deviasi To BOM ${currLabel}`, '% Toleransi'], map: (it, i) => [String(i + 1), it.itemName, it.outletCode, fmtPct(it.devBom, false), it.tolerance != null ? fmtPct(it.tolerance, false) : '—'] },
      // Rev 2: Add QTY Prev + QTY Hist Avg columns for Waste/Susut/Trial/LossSurplus
      { title: `4.3 QTY Waste Terbesar (${currLabel})`, items: data.topItemsByWaste, cols: ['#', 'Item', 'Resto', `QTY Waste ${currLabel}`, `QTY ${prevLabel}`, histLabel, 'vs Hist', `Nominal Waste ${currLabel}`], map: (it, i) => [String(i + 1), it.itemName, it.outletCode, fmtNum(it.qtyWaste), it.prevQty != null ? fmtNum(it.prevQty) : '—', it.histAvgQty != null ? fmtNum(it.histAvgQty) : '—', fmtVsHist(it.qtyWaste, it.histAvgQty), fmtIDR(it.nominalWaste)] },
      { title: `4.4 QTY Susut Terbesar (${currLabel})`, items: data.topItemsBySusut, cols: ['#', 'Item', 'Resto', `QTY Susut ${currLabel}`, `QTY ${prevLabel}`, histLabel, 'vs Hist', `Nominal Susut ${currLabel}`], map: (it, i) => [String(i + 1), it.itemName, it.outletCode, fmtNum(it.qtySusut), it.prevQty != null ? fmtNum(it.prevQty) : '—', it.histAvgQty != null ? fmtNum(it.histAvgQty) : '—', fmtVsHist(it.qtySusut, it.histAvgQty), fmtIDR(it.nominalSusut)] },
      { title: `4.5 QTY Trial Terbesar (${currLabel})`, items: data.topItemsByTrial, cols: ['#', 'Item', 'Resto', `QTY Trial ${currLabel}`, `QTY ${prevLabel}`, histLabel, 'vs Hist', `Nominal Trial ${currLabel}`], map: (it, i) => [String(i + 1), it.itemName, it.outletCode, fmtNum(it.qtyTrial), it.prevQty != null ? fmtNum(it.prevQty) : '—', it.histAvgQty != null ? fmtNum(it.histAvgQty) : '—', fmtVsHist(it.qtyTrial, it.histAvgQty), fmtIDR(it.nominalTrial)] },
      { title: `4.6 QTY Loss/Surplus Terbesar (${currLabel})`, items: data.topItemsByLossSurplus, cols: ['#', 'Item', 'Resto', `QTY Loss/Surplus ${currLabel}`, `QTY ${prevLabel}`, histLabel, 'vs Hist', `Nominal Loss/Surplus ${currLabel}`], map: (it, i) => [String(i + 1), it.itemName, it.outletCode, fmtNum(it.qtyLossSurplus), it.prevQty != null ? fmtNum(it.prevQty) : '—', it.histAvgQty != null ? fmtNum(it.histAvgQty) : '—', fmtVsHist(it.qtyLossSurplus, it.histAvgQty), fmtIDR(it.nominalLossSurplus)] },
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
    children.push(heading('4. Rincian Komposisi Selisih'));
    children.push(makeTable(['Component', 'QTY', '% of Total'], [
      ['QTY Waste', fmtNum(b.waste), bdTotal > 0 ? `${((b.waste / bdTotal) * 100).toFixed(1)}%` : '—'],
      ['QTY Susut', fmtNum(b.susut), bdTotal > 0 ? `${((b.susut / bdTotal) * 100).toFixed(1)}%` : '—'],
      ['QTY Trial', fmtNum(b.trial), bdTotal > 0 ? `${((b.trial / bdTotal) * 100).toFixed(1)}%` : '—'],
      ['Loss/Surplus Qty', fmtNum(b.residual), bdTotal > 0 ? `${((b.residual / bdTotal) * 100).toFixed(1)}%` : '—'],
      ['TOTAL', fmtNum(bdTotal), '100%'],
    ]));
    children.push(divider());

    }
    // Section 7 (PERBANDINGAN ANTAR AREA) removed per user request
    if (hasSection('variance')) {
    const va = data.varianceAnalysis || {};
    if ((va.topWorsened || []).length > 0) {
      children.push(heading('5. Perubahan Item (Selisih Terbesar)'));
      children.push(makeTable(['Item', 'Resto', `Nominal ${currLabel}`, `Nominal ${prevLabel}`, 'Selisih'],
        va.topWorsened.slice(0, 10).map((it) => [it.itemName, it.outletCode, fmtIDR(it.currentNominal), fmtIDR(it.previousNominal), fmtIDR(it.selisih)])));
      children.push(divider());
    }

    }
    // Section 13 (RANKING ITEM NASIONAL) removed per user request
    if (hasSection('trend')) {
    if (data.trend && data.trend.length > 0) {
      children.push(heading('6. Trend Antar Periode'));
      // Hapus Penjualan, tambah % Nominal Deviasi to Sales = |nominal| / sales * 100
      children.push(makeTable(['Period', 'Nominal Deviasi', '% Deviasi To BOM', '% Nominal to Sales'],
        data.trend.map((t) => [
          t.weekLabel,
          fmtIDR(t.nominal),
          fmtPct(t.devBom, false),
          t.sales && t.sales > 0 ? fmtPct(Math.abs(t.nominal) / t.sales, false) : '—',
        ])));
      children.push(divider());
    }

    }

    // ============================================================
    // NEW SECTIONS — additional analyses
    // ============================================================

    // Sections 19 (HISTORICAL ANOMALY), 2 (RESTO PRIORITAS), 14 (ITEM CROSS-OUTLET) removed per user request

    // Footer — simple closing (no date per user request)
    children.push(new Paragraph({ text: '', spacing: { before: 400 } }));
    children.push(new Paragraph({
      children: [new TextRun({ text: '', size: 8 })],
      spacing: { before: 60, after: 60 },
      border: { top: { style: BorderStyle.SINGLE, size: 12, color: COLOR.PRIMARY, space: 2 } },
    }));

    // Generate document — creator metadata neutral (no AI/platform mention)
    const doc = new Document({
      creator: 'Inventory Analyst',
      title: `Ringkasan Laporan Deviasi ${currLabel}`,
      sections: [{ properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } }, children }],
    });

    const buffer = await Packer.toBuffer(doc);
    const fileName = `Laporan_Deviasi_${currLabel.replace(/\s+/g, '_')}.docx`;

    // PERF: Cache the docx buffer for 5 min — next request with same params gets instant response
    // awaitWrite=true because export buffer is large (91KB) — need to ensure write completes
    await setCached(cacheKey, { buffer: Array.from(buffer), fileName }, true);

    return new NextResponse(new Uint8Array(buffer) as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        // PERF-FASE1-BE01: CDN cache for 5 min, stale grace 10 min. Same report
        // for same period+filters won't change until underlying data changes.
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600, must-revalidate',
      },
    });
  } catch (e: unknown) {
    logger.error("[export-report] error:", { error: e });
    return errorResponse(e, "export-report");
  }
}
