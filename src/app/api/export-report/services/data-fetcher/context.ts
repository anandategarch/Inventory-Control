// ============================================================
//  context — FetcherContext (the pipeline's shared working state)
//  --------------------------------------------------------
//  SPLIT-A (pure code motion): the intermediate values that
//  fetchReportData used to keep as closure locals, lifted into ONE
//  context object threaded through the phase modules (same pattern
//  as ingest-process/services/shared.ts IngestProcessContext —
//  REFACTOR-1-a). Phase ownership:
//    - resolvePipelineSetup (setup.ts)      fills the SetupFields;
//    - ensureRecordsExist (record-guard.ts) fills varianceAnalysis;
//    - runSectionQueryBatch (query-batch.ts) fills the 16 query
//      result fields;
//  every consumer runs after the phase that fills its inputs (see
//  the phase order in data-fetcher.ts), so the zero-values below
//  are never read before being overwritten — they mirror the exact
//  off-section placeholder literals the original Promise.all used
//  for gated-off entries.
//
//  SQL query return types are imported via `Awaited<ReturnType<typeof
//  import(...).queryX>>` — type-only, no runtime coupling (convention
//  of ../types.ts).
// ============================================================
import { Prisma } from '@prisma/client';
import { buildInventoryWhere } from '@/lib/build-where';
import type { RuntimeThresholds } from '@/lib/settings';
import type { ExecSummaryRow } from '@/lib/queries/dashboard';
import type { AreaCategoryAvg } from '@/lib/queries/items/top-items';
import type {
  queryDashboardKpis,
  queryTopItemsByNominal,
  queryTopItemsByDevBom,
  queryTopItemsByAllCategories,
  queryTrendAgg,
  queryItemTrendMatrix,
} from '@/lib/queries';
import type { queryVarianceAnalysis } from '@/lib/queries/health-ranking';
import type { querySelfHistoryAnomaly } from '@/lib/queries/items/self-history-anomaly';
import type { queryWeeklyComposition } from '@/lib/queries/weekly-composition';
import type { queryFlipRanking } from '@/lib/queries/items/flip-ranking';
import type { ReportParams } from '../types';
import type { SectionGates } from './section-gates';

// ============================================================
//  createBuildWhere — the where-clause factory (FIX RESTORE-BACKEND-2).
//  Returns the `(wk, mLabel) => Prisma.InventoryRecordWhereInput`
//  closure; declared here (not inline in setup.ts) so SetupFields can
//  type the field as ReturnType<typeof createBuildWhere> without
//  re-declaring the param names in a type position (the base
//  no-unused-vars rule false-positives on named function-type params).
// ============================================================
export function createBuildWhere(opts: {
  area: string | null;
  itemName: string | null;
  kelompok: string | null;
  kelompokOutletCodes: string[];
  picOutletCodes: string[] | null;
  outletCode: string | null;
}) {
  return (wk: string, mLabel: string): Prisma.InventoryRecordWhereInput =>
    buildInventoryWhere({
      week: wk,
      month: mLabel,
      area: opts.area,
      itemName: opts.itemName,
      kelompok: opts.kelompok,
      kelompokOutletCodes: opts.kelompokOutletCodes,
      picOutletCodes: opts.picOutletCodes,
      outletCode: opts.outletCode,
    });
}

/**
 * The filter-opts literal built by setup.ts — every field REQUIRED (the
 * exact inferred shape of the original `const filterOpts = { … }` in the
 * monolith; assignable to SqlFilterOpts, whose fields are optional).
 * Kept precise because queryAreaCategoryAvg's `area` param rejects
 * `undefined`.
 */
export interface ExportFilterOpts {
  area: string | null;
  kelompok: string | null;
  outletCode: string | null;
  itemName: string | null;
  picOutletCodes: string[] | null;
}

/** Values resolved by resolvePipelineSetup before any data query runs. */
export interface SetupFields {
  /** Runtime thresholds (getAllSettings' 30s-TTL in-process cache — ~0ms warm). */
  thresholds: RuntimeThresholds;
  /** PIC outlet codes (sentinel '__NO_MATCH__' applied when the PIC matches none). */
  picOutletCodes: string[] | null;
  /** Kelompok outlet codes (shared resolveKelompokOutletCodes helper — returns []). */
  kelompokOutletCodes: string[];
  /** Prisma where-clause factory for the current (week, month) + filters. */
  buildWhere: ReturnType<typeof createBuildWhere>;
  /** SQL filter opts shared by every q-* query below. */
  filterOpts: ExportFilterOpts;
  /** Case-resolved current month label (resolveMonthLabel — DB casing). */
  month: string;
  /** monthLabel → monthKey reverse lookup (trend sort — AUDIT-EXPORT-AI-1). */
  monthKeyByLabel: Map<string, string>;
  /** Compare period (user-specified or auto same-week previous month). */
  prevWeek: string | null;
  prevMonth: string | null;
  /** Same-weekLabel prior months (header "Hist (…)" label + q-hist-catavg). */
  historicalPeriods: Array<{ monthLabel: string; weekLabel: string; sortKey: string }>;
}

/** Working state threaded through the fetch phases (see the file header). */
export interface FetcherContext extends SetupFields {
  /** Parsed URL params (input — never mutated). */
  params: ReportParams;
  /** Section gates (?sections= need-flags). */
  gates: SectionGates;
  // ---- 404 short-circuit wave (ensureRecordsExist) ----
  varianceAnalysis: Awaited<ReturnType<typeof queryVarianceAnalysis>>;
  // ---- the single parallel wave (runSectionQueryBatch) ----
  kpis: Awaited<ReturnType<typeof queryDashboardKpis>>;
  prevSummary: ExecSummaryRow | null;
  topNominal: Awaited<ReturnType<typeof queryTopItemsByNominal>>;
  topDevBom: Awaited<ReturnType<typeof queryTopItemsByDevBom>>;
  topCategories: Awaited<ReturnType<typeof queryTopItemsByAllCategories>>;
  prevTopCategories: Awaited<ReturnType<typeof queryTopItemsByAllCategories>>;
  trendAggRows: Awaited<ReturnType<typeof queryTrendAgg>>;
  histWasteMap: Map<string, { avgQty: number; avgNominal: number }>;
  histSusutMap: Map<string, { avgQty: number; avgNominal: number }>;
  histTrialMap: Map<string, { avgQty: number; avgNominal: number }>;
  histLossSurplusMap: Map<string, { avgQty: number; avgNominal: number }>;
  itemTrendMatrixRes: Awaited<ReturnType<typeof queryItemTrendMatrix>> | null;
  selfAnomalyRes: Awaited<ReturnType<typeof querySelfHistoryAnomaly>> | null;
  weeklyCompRes: Awaited<ReturnType<typeof queryWeeklyComposition>> | null;
  flipRankingRes: Awaited<ReturnType<typeof queryFlipRanking>> | null;
  areaCatAvgMap: Map<string, AreaCategoryAvg>;
}

// ============================================================
//  createFetcherContext — assembles the context after the setup
//  phase resolved the environment. The query-result fields start
//  at their exact off-section placeholder values (the same literals
//  the original Promise.all used for gated-off entries); the guard
//  + batch phases overwrite them in phase order.
// ============================================================
export function createFetcherContext(
  params: ReportParams,
  gates: SectionGates,
  setup: SetupFields,
): FetcherContext {
  return {
    params,
    gates,
    ...setup,
    varianceAnalysis: { topWorsened: [], topImproved: [] },
    kpis: null,
    prevSummary: null,
    topNominal: [],
    topDevBom: [],
    topCategories: { waste: [], susut: [], trial: [], lossSurplus: [] },
    prevTopCategories: { waste: [], susut: [], trial: [], lossSurplus: [] },
    trendAggRows: [],
    histWasteMap: new Map<string, { avgQty: number; avgNominal: number }>(),
    histSusutMap: new Map<string, { avgQty: number; avgNominal: number }>(),
    histTrialMap: new Map<string, { avgQty: number; avgNominal: number }>(),
    histLossSurplusMap: new Map<string, { avgQty: number; avgNominal: number }>(),
    itemTrendMatrixRes: null,
    selfAnomalyRes: { rows: [], flipRows: [] },
    weeklyCompRes: { rows: [] },
    flipRankingRes: null,
    areaCatAvgMap: new Map<string, AreaCategoryAvg>(),
  };
}
