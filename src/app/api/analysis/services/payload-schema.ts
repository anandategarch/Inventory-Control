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
 */
export const ANALYSIS_PAYLOAD_SCHEMA_VERSION = 3;

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
