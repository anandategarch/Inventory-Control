// ============================================================
//  post-process-patterns — Sub-step 6: buildPatterns
//  --------------------------------------------------------
//  Extracted from src/app/api/analysis/services/post-process.ts (Task 3-b).
//
//  Responsibilities:
//    Pattern detection (systemic / area-level / network-wide).
//    No extra DB query — runs entirely on already-computed in-memory data.
//
//  totalOutlets = outletHealthRanking.length (universe of outlets
//  with at least one evaluated item this period). Slight under-count
//  for outlets where ALL items are zero-dev, but those are rare and
//  irrelevant for systemic-pattern detection.
// ============================================================
import { detectPatterns } from '@/engine/analysis/analysis';
import type { AnalysisOutlet, AnalysisArea } from '@/engine/analysis';

/**
 * Sub-step 6 — pattern detection (systemic/area-level/network-wide).
 * No extra DB query — runs entirely on already-computed in-memory data.
 */
export function buildPatterns(
  outletHealthRanking: AnalysisOutlet[],
  itemConsistencyAnalysis: { items: Array<Record<string, unknown>> },
  areaAnalysis: AnalysisArea[],
): ReturnType<typeof detectPatterns> {
  // ============================================================
  //  Pattern Detection (ANALYZE-BACKEND-2 — Feature 5)
  //  --------------------------------------------------------
  //  totalOutlets = outletHealthRanking.length (universe of outlets
  //  with at least one evaluated item this period). Slight under-count
  //  for outlets where ALL items are zero-dev, but those are rare and
  //  irrelevant for systemic-pattern detection.
  // ============================================================
  const items = itemConsistencyAnalysis.items ?? [];
  return detectPatterns({
    outletHealthRanking,
    itemConsistency: items.map((i) => ({
      itemName: i.itemName as string,
      outletCount: i.outletCount as number,
      totalAbsNominal: i.totalAbsNominal as number,
      avgDevBom: i.avgDevBom as number,
      consistency: i.consistency as 'SYSTEMIC' | 'WIDESPREAD' | 'ISOLATED' | undefined,
    })),
    areaAnalysis,
    totalOutlets: outletHealthRanking.length,
  });
}
