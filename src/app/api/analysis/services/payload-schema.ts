// ============================================================
//  payload-schema — analysis payload shape versioning
//  --------------------------------------------------------
//  FIX (TASK H-3 — "Top Growth: cache lama meskipun sudah refresh"):
//  the DB-level AggregationCache served PRE-DEPLOY rows as fresh hits
//  after a payload-shape change. The serve-path guard
//  (looksLikeAnalysisEnvelope) only checked '"success":', so a row
//  written by the OLD code (no `topGrowth` field) was served for the
//  full 30-min TTL with NO recompute triggered at all — and the
//  client-side refresh (TanStack query invalidation only) kept
//  re-requesting the SAME row. Result: users saw the TopGrowthCard
//  "cache lama" empty state for up to 30 minutes no matter how many
//  times they refreshed.
//
//  Two-layer defense:
//    1. ANALYSIS_PAYLOAD_SCHEMA_VERSION participates in the cache KEY
//       (buildCacheKey `extra`) — a version bump orphans every
//       pre-version row instantly (different key → guaranteed cache
//       MISS → synchronous recompute with the NEW code on the first
//       request after deploy).
//    2. hasCurrentPayloadShape marker guard on the SERVE path — even
//       if a future change forgets to bump the version, a cached row
//       missing the required top-level markers is treated as a MISS
//       (falls through to compute) instead of being served.
//
//  MAINTENANCE RULE (bump protocol):
//    - Whenever the AnalysisResponse shape changes (field added /
//      removed / renamed), bump ANALYSIS_PAYLOAD_SCHEMA_VERSION AND add
//      the new field's JSON key marker to REQUIRED_PAYLOAD_MARKERS.
//    - Old-key rows are never read again (different cache key) and are
//      aged out by cleanupExpiredCache (90 min) or the next
//      invalidateAnalysisCache() mutation hook.
// ============================================================

/**
 * v1 (implicit) = pre-Top-Growth payload (no `topGrowth` field).
 * v2 = + `topGrowth` { byOutlet, byItem } (Task H-2c).
 * v3 = + topGrowth drill-down (`contributors` per row + `contributorLimit`)
 *      + period provenance (`comparisonAuto`, `weekRange`,
 *      `comparisonWeekRange`) (Task H-5).
 * v4 = Task H-6 correctness rework — topGrowth values changed semantics:
 *      byOutlet is now ΔSales from OutletPeriodSales.salesMode (was
 *      SUM(nominalSales) × rowCount — the "drill down salah" bug),
 *      byItem is now Δ pemakaian BOM (qtyBom) with `unit` (satuan) per
 *      row/contributor, and the wrapper carries `byOutletMetric`/
 *      `byItemMetric` descriptors. Old v3 rows must never be served.
 * v5 = Task H-7 metric switch — BOTH grains now rank Δ SUM(nominalDeviasi)
 *      (signed net Rp: negative = LOSS, positive = SURPLUS — same source
 *      as the exec-summary Nominal Deviasi KPI); drill-down contributors
 *      are ranked by Δ SUM(qtyDeviasi) (kuantiti deviasi, satuan) and
 *      carry Δ nominal alongside (`qtyCurr/qtyPrev/qtyDelta` +
 *      `nominalCurr/nominalPrev/nominalDelta`). Rows no longer carry
 *      `unit` (both grains are Rp); the wrapper carries the new
 *      `contributorRankMetric` descriptor. A v4 row (ΔSales per resto /
 *      ΔBOM per barang) must never be served as if it were the new
 *      metric — bump + marker below guarantee that.
 * v6 = H-11 (#4a — UI dedup): payload sections `topOutlets` +
 *      `topOutletsBySales` REMOVED (the Dashboard's TopOutlets card —
 *      their only renderer — was deleted; it duplicated the Pareto tab's
 *      byOutlet quadrant card, and topOutletsBySales never had a renderer
 *      at all). A v5 row carrying those dead sections must never be
 *      served — the version bump orphans it.
 */
export const ANALYSIS_PAYLOAD_SCHEMA_VERSION = 6;

/**
 * Top-level JSON key markers that MUST exist in a cached row for the
 * CURRENT code to serve it. Each entry is a '"fieldName":' substring —
 * keep in sync with assembleResponse's return literal (a field that is
 * ALWAYS serialized; never conditionally omitted, or JSON.stringify
 * would drop the key and falsely mark fresh rows as shape-mismatched).
 */
export const REQUIRED_PAYLOAD_MARKERS: readonly string[] = [
  '"topGrowth":',
  // TASK H-5: topGrowth-level scalar — ALWAYS serialized (even when both
  // lists are empty), unlike a per-row field which would vanish from a
  // payload whose lists are empty (empty arrays serialize as [] with no
  // row objects inside → '"contributors":' would be ABSENT from a perfectly
  // fresh row → infinite recompute loop). Never add a per-row field as a
  // marker; anchor markers on always-serialized scalars or the wrapper.
  '"contributorLimit":',
  // TASK H-5: period.comparisonAuto — boolean, always serialized.
  '"comparisonAuto":',
  // TASK H-6: grain → metric descriptors — topGrowth-level scalars,
  // always serialized. A v3 row (drill-down with the WRONG numbers:
  // byOutlet = Sales × rowCount, byItem = fake per-barang "sales") carries
  // neither marker → never served → guaranteed recompute with the fix.
  '"byItemMetric":',
  '"byOutletMetric":',
  // TASK H-7: the drill-down's ranking metric descriptor — topGrowth-level
  // scalar, always serialized. A v4 row (byOutlet = ΔSales / byItem = ΔBOM
  // — the OLD mixed metrics) carries `byItemMetric`/`byOutletMetric` but
  // NOT this key → never served → guaranteed recompute onto the nominal-
  // deviation metric. (Per-row markers like '"qtyDelta":' are FORBIDDEN —
  // empty contributor lists serialize as [] with no row objects inside,
  // which would falsely mark a fresh row as shape-mismatched → infinite
  // recompute loop. Anchor markers on always-serialized scalars only.)
  '"contributorRankMetric":',
];

/**
 * Cheap shape guard over the RAW cached JSON string — no JSON.parse.
 * A 1MB substring scan is ~µs in V8 (same approach as
 * looksLikeAnalysisEnvelope, P3-HYG-1: zero parse cost on the hot
 * cache-hit path). Returns true only when every required marker is
 * present, i.e. the row was written by code that emits the CURRENT
 * payload shape.
 */
export function hasCurrentPayloadShape(raw: string): boolean {
  return REQUIRED_PAYLOAD_MARKERS.every((marker) => raw.includes(marker));
}
