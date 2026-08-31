// ============================================================
//  post-process-flags — Sub-step 1: evaluateAndMergeFlags
//  --------------------------------------------------------
//  Extracted from src/app/api/analysis/services/post-process.ts (Task 3-b).
//
//  Responsibilities:
//    1. Evaluate 5 zScore-based rules in JS (uses currSlim — 5 cols × 35K rows)
//    2. Merge SQL + JS flags → topFlagByKey (key → highest-priority flag)
//    3. Compute per-outlet + global severity counts from topFlagByKey +
//       healthRankingRows (zeroDev / nonZeroDev counts per outlet)
//
//  Returns topFlagByKey + per-outlet severity counts (SeverityMaps) +
//  global normal/warning/abnormal.
// ============================================================
import { evaluateHistoricalRulesJs, type SqlRuleFlag } from '@/lib/queries/rule-evaluation';
import type { FetchedRecords } from './fetch-records';
import type { QueryResults } from './run-queries';
import type { SeverityMaps } from './post-process-types';

/**
 * Sub-step 1 — evaluate JS historical rules + merge with SQL flags.
 * Returns topFlagByKey + per-outlet severity counts + global normal/warning/abnormal.
 */
export async function evaluateAndMergeFlags(
  currSlim: FetchedRecords['currSlim'],
  historicalByOutletItem: FetchedRecords['historicalByOutletItem'],
  thresholds: FetchedRecords['thresholds'],
  sqlFlagsPromise: Promise<SqlRuleFlag[]>,
  healthRankingRows: QueryResults['healthRankingRows'],
): Promise<{
  topFlagByKey: Map<string, SqlRuleFlag>;
  severityMaps: SeverityMaps;
  normal: number;
  warning: number;
  abnormal: number;
  ruleBreakdown: { byCategory: Record<string, number>; byRule: Record<string, number> };
}> {
  // ============================================================
  //  POST-PROCESS RULE FLAGS (Sprint 3 + SQL-OPTIMIZE)
  //  --------------------------------------------------------
  //  1. Evaluate 5 zScore-based rules in JS (uses currSlim — 5 cols × 35K rows)
  //  2. Merge SQL + JS flags → topFlagByKey (key → highest-priority flag)
  //  3. Compute per-outlet + global severity counts from topFlagByKey +
  //     healthRankingRows (zeroDev / nonZeroDev counts per outlet)
  // ============================================================
  const histFlags = evaluateHistoricalRulesJs(currSlim, historicalByOutletItem, thresholds);

  // PERF-FASE2-BE03: Await sqlFlagsPromise here (not in Group 1) — by now
  // Batches 1-4 have finished, and evaluateRulesSql has been running in
  // parallel the whole time. If it's already resolved, this await is ~0ms.
  const sqlFlags = await sqlFlagsPromise;

  // topFlagByKey — one entry per (outletId, itemId, akunPenyesuaian) record
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

  // Per-outlet severity counts derived from topFlagByKey (small map —
  // ~5K-10K entries, one per flagged record). Much smaller than iterating
  // 35K currentRecs as the old JS code did.
  const warningByOutlet = new Map<number, number>();
  const abnormalByOutlet = new Map<number, number>();
  const recordsWithFlagsByOutlet = new Map<number, number>();
  const ruleCategoryCounts = new Map<string, number>();
  const ruleCodeCounts = new Map<string, number>();
  for (const [, flag] of topFlagByKey) {
    recordsWithFlagsByOutlet.set(flag.outletId, (recordsWithFlagsByOutlet.get(flag.outletId) ?? 0) + 1);
    if (flag.severity === 'ABNORMAL') {
      abnormalByOutlet.set(flag.outletId, (abnormalByOutlet.get(flag.outletId) ?? 0) + 1);
    } else if (flag.severity === 'WARNING') {
      warningByOutlet.set(flag.outletId, (warningByOutlet.get(flag.outletId) ?? 0) + 1);
    }
    ruleCategoryCounts.set(flag.category, (ruleCategoryCounts.get(flag.category) || 0) + 1);
    ruleCodeCounts.set(flag.ruleCode, (ruleCodeCounts.get(flag.ruleCode) || 0) + 1);
  }

  // Global normal/warning/abnormal counts (matches the old JS loop exactly):
  //   normal   = (nonZeroDevCount - recordsWithFlags) + zeroDevCount
  //   warning  = records with top-flag WARNING
  //   abnormal = records with top-flag ABNORMAL
  let normal = 0, warning = 0, abnormal = 0;
  for (const row of healthRankingRows) {
    const recWithFlags = recordsWithFlagsByOutlet.get(row.outletId) ?? 0;
    const w = warningByOutlet.get(row.outletId) ?? 0;
    const ab = abnormalByOutlet.get(row.outletId) ?? 0;
    const n = Math.max(0, row.nonZeroDevCount - recWithFlags) + row.zeroDevCount;
    normal += n;
    warning += w;
    abnormal += ab;
  }

  const ruleBreakdown = {
    byCategory: Object.fromEntries(ruleCategoryCounts) as Record<string, number>,
    byRule: Object.fromEntries(ruleCodeCounts) as Record<string, number>,
  };

  return {
    topFlagByKey,
    severityMaps: { warningByOutlet, abnormalByOutlet, recordsWithFlagsByOutlet },
    normal, warning, abnormal,
    ruleBreakdown,
  };
}
