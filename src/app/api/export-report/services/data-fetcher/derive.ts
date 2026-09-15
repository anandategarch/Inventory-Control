// ============================================================
//  derive — deriveReportFields (post-batch shaping, pure)
//  --------------------------------------------------------
//  SPLIT-A (pure code motion): relocated VERBATIM from
//  fetchReportData's body (data-fetcher.ts:123-167 —
//  buildExecSummaryFromSql — and 593-671 — the post-batch
//  shaping: top-items enrichment (sections 3.3-3.6), the exec
//  summary (sections 1-2), trend rows + weekly composition
//  slicing (section 7)). No awaits — runs between the batch
//  wave and the peer wave, exactly as before.
// ============================================================
import { calcGrowth, computeNominalDeviationGrowth } from '@/lib/metrics';
import type { ExecSummaryRow } from '@/lib/queries/dashboard';
import type { WeeklyCompositionRow } from '@/lib/queries/weekly-composition';
import type {
  ExecSummaryWithPrev,
  TopCatItemWaste,
  TopCatItemSusut,
  TopCatItemTrial,
  TopCatItemLossSurplus,
  TrendRow,
} from '../types';
import type { FetcherContext } from './context';

// ============================================================
//  buildExecSummaryFromSql (same as analysis route)
//  --------------------------------------------------------
//  Relocated VERBATIM from route.ts:72-109. Builds an ExecutiveSummary
//  object (extended with _prevMetrics) from a (curr, prev) pair of
//  queryExecSummary rows. Used only by this service file.
// ============================================================
function buildExecSummaryFromSql(
  curr: ExecSummaryRow | null,
  prev: ExecSummaryRow | null,
  monthLabel: string,
  weekLabel: string,
  prevWeekLabel: string | null,
): ExecSummaryWithPrev {
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

/** Report fields derived from the batch results (shapes consumed by assemble). */
export interface DerivedReportFields {
  topWaste: TopCatItemWaste[];
  topSusut: TopCatItemSusut[];
  topTrial: TopCatItemTrial[];
  topLossSurplus: TopCatItemLossSurplus[];
  execSummary: ExecSummaryWithPrev;
  trend: TrendRow[];
  weeklyComposition: WeeklyCompositionRow[];
}

export function deriveReportFields(ctx: FetcherContext): DerivedReportFields {
  const {
    month, prevWeek, monthKeyByLabel, kpis, prevSummary,
    topCategories, prevTopCategories, trendAggRows, weeklyCompRes,
    histWasteMap, histSusutMap, histTrialMap, histLossSurplusMap, areaCatAvgMap,
  } = ctx;
  const { week } = ctx.params;

  const topWasteRows = topCategories.waste;
  const topSusutRows = topCategories.susut;
  const topTrialRows = topCategories.trial;
  const topLossSurplusRows = topCategories.lossSurplus;
  // Previous period category data (Rev 2)
  const prevWasteRows = prevTopCategories.waste;
  const prevSusutRows = prevTopCategories.susut;
  const prevTrialRows = prevTopCategories.trial;
  const prevLossSurplusRows = prevTopCategories.lossSurplus;

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
    // REFINE-1: "Rata-rata Area" — per-(item, area) avg across the area's
    // outlets (conditional on having the metric).
    const areaAvg = areaCatAvgMap.get(`${r.itemName}|${r.area}`)?.waste ?? null;
    // H-2b: pass satuan through for the "Satuan" column in the docx table.
    return { itemName: r.itemName, outletCode: r.outletCode, satuan: r.satuan, area: r.area, qtyWaste: r.qty, nominalWaste: r.nominal, prevQty: prev?.qty ?? null, histAvgQty: hist?.avgQty ?? null, areaAvgQty: areaAvg };
  });
  const topSusut = topSusutRows.map(r => {
    const key = `${r.itemName}|${r.outletCode}`;
    const prev = prevSusutMap.get(key);
    const hist = histSusutMap.get(key);
    const areaAvg = areaCatAvgMap.get(`${r.itemName}|${r.area}`)?.susut ?? null;
    return { itemName: r.itemName, outletCode: r.outletCode, satuan: r.satuan, area: r.area, qtySusut: r.qty, nominalSusut: r.nominal, prevQty: prev?.qty ?? null, histAvgQty: hist?.avgQty ?? null, areaAvgQty: areaAvg };
  });
  const topTrial = topTrialRows.map(r => {
    const key = `${r.itemName}|${r.outletCode}`;
    const prev = prevTrialMap.get(key);
    const hist = histTrialMap.get(key);
    const areaAvg = areaCatAvgMap.get(`${r.itemName}|${r.area}`)?.trial ?? null;
    return { itemName: r.itemName, outletCode: r.outletCode, satuan: r.satuan, area: r.area, qtyTrial: r.qty, nominalTrial: r.nominal, prevQty: prev?.qty ?? null, histAvgQty: hist?.avgQty ?? null, areaAvgQty: areaAvg };
  });
  const topLossSurplus = topLossSurplusRows.map(r => {
    const key = `${r.itemName}|${r.outletCode}`;
    const prev = prevLossSurplusMap.get(key);
    const hist = histLossSurplusMap.get(key);
    const areaAvg = areaCatAvgMap.get(`${r.itemName}|${r.area}`)?.lossSurplus ?? null;
    return { itemName: r.itemName, outletCode: r.outletCode, satuan: r.satuan, area: r.area, qtyLossSurplus: r.qty, nominalLossSurplus: r.nominal, direction: r.direction, prevQty: prev?.qty ?? null, histAvgQty: hist?.avgQty ?? null, areaAvgQty: areaAvg };
  });

  // FIX (BUG-3-a P2): kpis/prevSummary are null when the exec/growth
  // sections are both off — buildExecSummaryFromSql degrades to its
  // zero-value shape (never rendered; hasSection gates rendering with the
  // SAME sections list that gated the fetch).
  // EXPORT-TRIM: breakdown/breakdownEnriched + growthMetrics REMOVED —
  // their sections ('breakdown') are gone and pdf-builder reads
  // executiveSummary directly for the growth section (verified 0 reads).
  const execSummary = buildExecSummaryFromSql(kpis, prevSummary, month, week, prevWeek);

  const trend = trendAggRows.map(r => {
    const mk = monthKeyByLabel.get(r.monthLabel) || '0000-00';
    // EXPAND-1: carry lossNominal/surplusNominal through (TrendAggRow already
    // returns them — the old mapping dropped them, so the Trend section had
    // no Loss/Surplus columns).
    return { weekLabel: `${r.weekLabel} ${r.monthLabel?.split(' ')[0].slice(0, 3)}`, sortKey: `${mk}|${String(parseInt(r.weekLabel?.replace(/\D/g, '')) || 0).padStart(2, '0')}`, devBom: r.devBom, sales: r.sales, nominal: r.nominal, lossNominal: r.lossNominal, surplusNominal: r.surplusNominal };
  }).sort((a, b) => a.sortKey.localeCompare(b.sortKey)).map(({ sortKey, ...rest }) => rest);

  // REFINE-3 — weekly composition: keep only the weeks up to (and
  // including) the exported week — weeks after it belong to the upcoming
  // period (the same exclusion rule the itemTrend matrix applies to
  // months). Unparsable/absent week labels (exportedWeekNo = 0) keep the
  // month's full week set.
  const exportedWeekNo = parseInt(week.replace(/\D/g, ''), 10) || 0;
  const weeklyComposition = exportedWeekNo > 0
    ? (weeklyCompRes?.rows ?? []).filter(r => r.weekNo <= exportedWeekNo)
    : (weeklyCompRes?.rows ?? []);

  return { topWaste, topSusut, topTrial, topLossSurplus, execSummary, trend, weeklyComposition };
}
