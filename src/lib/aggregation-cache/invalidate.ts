// ============================================================
//  invalidate — cache invalidation paths
//  --------------------------------------------------------
//  Extracted from the former src/lib/aggregation-cache.ts monolith
//  (REFACTOR-1-a pure-move split). Both invalidation entry points
//  bump the generation counter FIRST (via ./generation.ts
//  bumpCacheGeneration) so in-flight computations refuse their
//  write-backs (FIX BUG-2-b), then delete the DB rows.
// ============================================================
import { db } from '../db';
import { logger } from '../logger';
import { bumpCacheGeneration } from './generation';

/**
 * Invalidate cache entries matching a pattern.
 * Use after data mutations (ingest, settings change, direction migration).
 * Pass a prefix to invalidate all entries for a route (e.g. "analysis|").
 *
 * FIX (BUG2-PERF-1): The old `invalidateCache('analysis|')` calls used the
 * literal `|` character, but buildCacheKey was changed to use `\x1f` (ASCII
 * Unit Separator) in the BUG-EDGE-4 fix. This caused `startsWith('analysis|')`
 * to return false for ALL cache keys → zero entries invalidated → stale cache
 * for the full 5-min TTL after every mutation (ingest, settings, pic, etc.).
 *
 * Fix: export dedicated `invalidateAnalysisCache()` helper that uses the
 * correct delimiter. All callers should use this helper instead of passing
 * raw prefix strings.
 */
export async function invalidateCache(prefix?: string): Promise<void> {
  // FIX (BUG-2-b): bump the generation FIRST (synchronously) so every
  // computation that finishes from this point on — including ones still
  // holding PRE-mutation results — skips its cache write-back (see
  // withCacheAndDedup's generation guard + background-recompute's guard).
  bumpCacheGeneration();
  try {
    if (prefix) {
      // Delete all entries where cacheKey starts with prefix
      const result = await db.aggregationCache.deleteMany({
        where: { cacheKey: { startsWith: prefix } },
      });
      logger.info(`[cache] invalidated ${result.count} entries with prefix "${prefix}"`);
    } else {
      // Delete all entries
      const result = await db.aggregationCache.deleteMany({});
      logger.info(`[cache] invalidated ${result.count} entries (all)`);
    }
  } catch (e) {
    logger.error('[cache] invalidateCache error', { error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * FIX (BUG2-PERF-1): Dedicated helper to invalidate all analysis cache entries.
 * Uses the SAME delimiter (\x1f) as buildCacheKey — do NOT pass raw 'analysis|'
 * to invalidateCache (it won't match any keys).
 *
 * Usage: `await invalidateAnalysisCache();` after any mutation that affects
 * analysis data (ingest, import-drive, settings change, pic change, data delete,
 * migrate-direction).
 */
export async function invalidateAnalysisCache(): Promise<void> {
  // FIX (BUG-2-b): bump the generation IMMEDIATELY — before the awaited
  // deleteMany batch — so in-flight computations observe the invalidation
  // even while the DB rows are still being deleted. (Each per-route
  // invalidateCache call below also bumps; the counter is monotonic.)
  bumpCacheGeneration();
  // CACHE-01 FIX: Invalidate ALL cached routes — not just analysis.
  // Mutations (ingest, settings, pic, data delete, migrate-direction) affect
  // ALL cached data, not just /api/analysis. Without this, pareto/recommendations/
  // export-report serve stale data for 5 min after mutation.
  //
  // PERF-CACHE-08: also invalidate `heatmap` (added in this task — Area × Item
  // matrix reads from the same InventoryRecord table that mutations affect).
  // PERF-API-01/02/03 (Task PERF-API): added `outlet-items`, `item-history`,
  // and `drilldown` to the invalidation list — these routes now use
  // AggregationCache (5-min TTL via withCacheAndDedup) and must be cleared
  // on any mutation alongside the existing 6 routes.
  // TREND-BACKEND: added `item-trend` (per-item QTY fluctuation timeline —
  // reads from InventoryRecord across ALL periods, so mutations affect it).
  // P2-BE: added `item-peer-comparison` (per-item peer outlets scoped to one
  // period — reads from InventoryRecord, so mutations affect it).
  // P3-BE: added `item-trend-rank` (per-item national rank per period —
  // reads from InventoryRecord across ALL periods for ALL items via RANK()
  // window function, so mutations affect the ranking distribution).
  // FLIP-BE: added `flip-ranking` (cross-period flip pattern risk ranking —
  // reads SIGNED SUM(qtyDeviasi) per (period, item) across ALL items + ALL
  // periods, so mutations affect the per-item pair analysis + risk score).
  // FLIP-DRILL: added `flip-ranking-drilldown` (per-outlet breakdown for ONE
  // flip pair — reads per-outlet SIGNED SUM(qtyDeviasi) for the (item, week,
  // month) tuple in both P1 + P2, so mutations affect which outlets
  // contributed to the balanced reversal).
  // ANOMALI-OUTLETS: added `item-anomali-outlets` (per-outlet drill-down
  // for the MINORITY direction of an item — reads per-outlet SIGNED
  // SUM(qtyDeviasi/nominalDeviasi) for the (item, month, week, direction)
  // tuple, so mutations affect which outlets are surfaced as anomali).
  // P3-HYG-3: added the 3 peer-comparison routes (main / items / trend —
  // each reads InventoryRecord + OutletPeriodSales for its period scope,
  // so ingest/settings/pic/migrate mutations affect them; they were
  // previously uncached AND un-invalidated).
  // H-2b: removed the two Kepatuhan-tab routes (tab deleted with its APIs).
  // PRICE-EFFECT (Task W): added `price-effect` (AVG Price Effect Bennet
  // decomposition — reads per-item Σ|qtyDeviasi|/Σ|nominalDeviasi| for the
  // current + compare periods from InventoryRecord, so ingest/settings/
  // pic/delete mutations affect the decomposition).
  // ANA-1-E: added `benchmark-opportunity` ("Peluang Perbaikan (Rp)" vs
  // area-median loss — reads per-outlet loss/devBom from InventoryRecord for
  // the running period, so ingest/settings/pic/delete mutations affect it).
  // H-8 QUICK WIN 6a: added `item-search` (autocomplete LIKE over the current
  // period's records — mutations change item names/records, and the 60s TTL
  // cache must not outlive a mutation).
  // H-8 QUICK WIN 6b: added `heatmap-cell-detail` (per-outlet drill-down for
  // one area × item cell — reads the same InventoryRecord rows the parent
  // heatmap route reads, so mutations affect it identically).
  // TAHAP-2 / P2-9: added the shared per-query cache routes used by BOTH the
  // analysis + export pipelines (q-rules = evaluateRulesSql, q-hist-rules =
  // evaluateHistoricalRulesSql, q-variance, q-kpis, q-topcat, q-trend). A
  // mutation that invalidates the analysis payload must invalidate these too
  // — otherwise export could read a pre-mutation query row.
  // H-10 (G1): added q-outlet-agg — the shared per-outlet aggregate scan fed by
  // BOTH queryOutletHealthRanking (analysis payload) and queryRestoRecommendations
  // (/api/recommendations). Same invalidation rule as the q-* above.
  // ANA-1-E: added `benchmark-opportunity` ("Peluang Perbaikan (Rp)" vs
  // area-median loss). CHANGE-1: added the 2 change-analysis routes
  // ("Rata-rata Perubahan" — reads per-(outlet|item, month) same-week
  // deviation sums up to the running month, so every mutation affects
  // the Δ chain).
  const routes = [
    'analysis', 'pareto', 'recommendations',
    'export-report', 'heatmap', 'outlet-items', 'item-history', 'drilldown',
    'item-trend', 'item-peer-comparison', 'item-trend-rank', 'flip-ranking',
    'flip-ranking-drilldown', 'item-anomali-outlets',
    'peer-comparison', 'peer-comparison-items', 'peer-comparison-trend',
    'price-effect', 'item-search', 'heatmap-cell-detail',
    'benchmark-opportunity', 'change-analysis', 'change-analysis-items',
    'q-rules', 'q-hist-rules', 'q-variance', 'q-kpis', 'q-topcat', 'q-trend',
    'q-outlet-agg',
    // H-11 (#3): the remaining export-shared queries — every heavy query the
    // analysis + export-report pipelines both compute is now behind a q-* row.
    'q-exec-summary', 'q-top-nominal', 'q-top-devbom', 'q-area',
    'q-hist-stats', 'q-hist-critical', 'q-hist-catavg',
    // EXPORT-PDF: export-report's 4 new sections (PDF pipeline) — same
    // invalidation rule as the q-* above: a mutation that invalidates the
    // analysis payload must invalidate these query rows too, otherwise
    // export could serve a pre-mutation Pareto / trend-matrix / flip /
    // peer row for up to 30 min.
    'q-pareto-item', 'q-pareto-outlet', 'q-item-trend-matrix',
    'q-flip-rank', 'q-peer-cmp',
  ];
  await Promise.all(routes.map(r => invalidateCache(`${r}\x1f`)));
}
