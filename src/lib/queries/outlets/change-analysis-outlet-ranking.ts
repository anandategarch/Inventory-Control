// ============================================================
//  Change Analysis — outlet-level ranking (CHANGE-1 / DESIGN-1)
//  --------------------------------------------------------
//  queryOutletChangeAnalysis — ONE scan, all outlets, all
//  same-week months; ranking + counts reduced in JS.
//  Semantics doc: see ./change-analysis.ts header.
//
//  Split from ./change-analysis.ts (SPLIT-E — pure code motion;
//  SQL, comments and behavior preserved verbatim). Public
//  symbols stay re-exported from ./change-analysis.ts.
// ============================================================
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../shared';
import {
  computeChangeStats,
  classifyChange,
  type ChangeSeriesPoint,
  type ChangeStats,
  type ChangeStatus,
  type ChangeThresholds,
} from './change-analysis-stats';

// ------------------------------------------------------------
//  Outlet-level ranking (ONE scan, all outlets, all same-week months).
// ------------------------------------------------------------
/** One outlet row of the change ranking (ChangeStats flattened + identity + status). */
export interface OutletChangeRow extends ChangeStats {
  outletCode: string;
  outletName: string;
  area: string | null;
  status: ChangeStatus;
}

/** Response of queryOutletChangeAnalysis (also the /api/change-analysis data payload). */
export interface ChangeAnalysisResult {
  month: string;
  week: string;
  currentMonthKey: string;
  thresholds: ChangeThresholds;
  counts: { ranked: number; anomali: number; baruBergerak: number; dataKurang: number };
  outlets: OutletChangeRow[];
}

interface OutletScanRow {
  outletCode: string;
  outletName: string;
  area: string | null;
  monthKey: string;
  nd: number | bigint | null;
  qd: number | bigint | null;
}

/**
 * Rank outlets by how far the CURRENT deviation move strays from their own
 * average move. ONE query returns the per-(outlet, month) same-week sums for
 * every month up to and including the running one — the Δ chain, averages and
 * ratios are reduced in JS (same precedent as evaluateHistoricalRulesSql's
 * caller-side shaping; no N+1 for 333 outlets).
 */
export async function queryOutletChangeAnalysis(opts: {
  month: string;
  week: string;
  currentMonthKey: string;
  filters: SqlFilterOpts;
  thresholds: ChangeThresholds;
}): Promise<ChangeAnalysisResult> {
  const f = buildSqlFilters(opts.filters);
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<OutletScanRow[]>`
    SELECT
      o.code as "outletCode",
      o.name as "outletName",
      MAX(ir.area) as "area",
      sf."monthKey" as "monthKey",
      COALESCE(SUM(ir."nominalDeviasi") FILTER (WHERE ir."nominalDeviasi" IS NOT NULL), 0) as nd,
      COALESCE(SUM(ir."qtyDeviasi") FILTER (WHERE ir."qtyDeviasi" IS NOT NULL), 0) as qd
    FROM "InventoryRecord" ir
    JOIN "Outlet" o ON ir."outletId" = o.id
    JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
    WHERE ir."weekLabel" = ${opts.week}
      AND sf."monthKey" <= ${opts.currentMonthKey}
      ${f}
    GROUP BY o.id, sf."monthKey"
    ORDER BY o.code, sf."monthKey"
  `);

  const series = new Map<string, { code: string; name: string; area: string | null; points: ChangeSeriesPoint[] }>();
  for (const r of rows) {
    let entry = series.get(r.outletCode);
    if (!entry) {
      entry = { code: r.outletCode, name: r.outletName, area: r.area ?? null, points: [] };
      series.set(r.outletCode, entry);
    }
    entry.points.push({
      monthKey: r.monthKey,
      nominal: Number(r.nd) || 0,
      qty: Number(r.qd) || 0,
    });
  }

  const outlets: OutletChangeRow[] = [];
  for (const { code, name, area, points } of series.values()) {
    const stats = computeChangeStats(points, opts.currentMonthKey);
    outlets.push({ outletCode: code, outletName: name, area, ...stats, status: classifyChange(stats, opts.thresholds) });
  }

  // Ranking: BARU_BERGERAK first (a flat-history outlet starting to move is
  // the loudest "out of character" signal), then ratio desc, then swing desc.
  // DATA_KURANG rows trail at the end (the UI hides them; counts report them).
  const groupRank = (s: ChangeStatus) => (s === 'BARU_BERGERAK' ? 0 : s === 'ANOMALI' ? 1 : s === 'NORMAL' ? 2 : 3);
  const ratioRank = (r: OutletChangeRow) => (r.ratioNominal ?? (r.status === 'BARU_BERGERAK' ? Number.POSITIVE_INFINITY : 0));
  outlets.sort((a, b) => {
    const ga = groupRank(a.status);
    const gb = groupRank(b.status);
    if (ga !== gb) return ga - gb;
    if (ga === 3) return a.outletCode.localeCompare(b.outletCode);
    const ra = ratioRank(a);
    const rb = ratioRank(b);
    if (ra !== rb) return rb - ra;
    return (b.swingNominal ?? 0) - (a.swingNominal ?? 0);
  });

  const counts = {
    ranked: outlets.filter((o) => o.status !== 'DATA_KURANG').length,
    anomali: outlets.filter((o) => o.status === 'ANOMALI').length,
    baruBergerak: outlets.filter((o) => o.status === 'BARU_BERGERAK').length,
    dataKurang: outlets.filter((o) => o.status === 'DATA_KURANG').length,
  };

  return {
    month: opts.month,
    week: opts.week,
    currentMonthKey: opts.currentMonthKey,
    thresholds: opts.thresholds,
    counts,
    outlets,
  };
}
