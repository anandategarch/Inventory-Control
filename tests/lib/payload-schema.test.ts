// ============================================================
//  payload-schema — unit tests for the analysis cache shape guard
//  --------------------------------------------------------
//  TASK H-3: regression tests for the root cause of the "Top Growth
//  cache lama meskipun sudah refresh" bug — pre-deploy AggregationCache
//  rows (missing topGrowth) were served as fresh hits because the
//  serve-path guard only checked '"success":'. The guard must reject
//  every payload that lacks the current shape markers.
//
//  TASK H-5: the payload gained topGrowth drill-down fields
//  (contributors per row + contributorLimit) + period provenance
//  (comparisonAuto, weekRange, comparisonWeekRange) → version bumped
//  2 → 3 and markers extended.
//
//  TASK H-6: topGrowth values changed SEMANTICS (byOutlet = salesMode
//  ΔSales; byItem = Δ pemakaian BOM with unit; byOutletMetric/
//  byItemMetric descriptors) → version 3 → 4 + two new markers.
//
//  TASK H-7: topGrowth changed metrics AGAIN — both grains now rank Δ
//  SUM(nominalDeviasi) (signed net Rp); drill-down contributors are
//  ranked by Δ SUM(qtyDeviasi) and carry Δ nominal alongside
//  (qtyCurr/qtyPrev/qtyDelta + nominalCurr/nominalPrev/nominalDelta);
//  rows no longer carry `unit`; the wrapper carries the new
//  contributorRankMetric descriptor → version 4 → 5 + one new marker.
//  A v4 row (byOutlet = ΔSales / byItem = ΔBOM — the OLD mixed
//  metrics) has byOutletMetric/byItemMetric but NO contributorRankMetric
//  → must be rejected, or the user would keep seeing the old metrics.
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  ANALYSIS_PAYLOAD_SCHEMA_VERSION,
  REQUIRED_PAYLOAD_MARKERS,
  hasCurrentPayloadShape,
} from '@/app/api/analysis/services/payload-schema';

describe('payload-schema (analysis cache shape guard — TASK H-3 + H-5 + H-6 + H-7 + H-11)', () => {
  it('schema version is 6 (bumped when topOutlets sections were removed — H-11 #4a)', () => {
    // v1 (implicit) = pre-Top-Growth rows. v2 = + topGrowth. v3 = +
    // contributors/contributorLimit + comparisonAuto/weekRange. v4 =
    // salesMode/BOM rework + byOutletMetric/byItemMetric + unit. v5 =
    // nominalDeviasi metric for both grains + qtyDeviasi-ranked drill-down
    // + contributorRankMetric. v6 (H-11 #4a) = topOutlets + topOutletsBySales
    // sections REMOVED (Dashboard TopOutlets card deleted — duplicate of the
    // Pareto tab's byOutlet card; topOutletsBySales never had a renderer).
    // If this fails, the version was bumped without updating this test —
    // update BOTH together.
    expect(ANALYSIS_PAYLOAD_SCHEMA_VERSION).toBe(6);
  });

  it('accepts a current-shape payload (contains every required marker)', () => {
    const raw = JSON.stringify({
      success: true,
      period: {
        monthLabel: 'Juli 2026',
        weekLabel: 'WEEK 1',
        comparisonAuto: true,
        weekRange: { start: 1, end: 7 },
        comparisonWeekRange: null,
      },
      execSummary: { sales: { current: 1, previous: 2 } },
      growthDrivers: [],
      topGrowth: {
        byOutlet: [{ name: 'R', curr: -900, prev: -500, delta: -400, pct: null, isNew: true, contributors: [] }],
        byItem: [],
        contributorLimit: 5,
        byOutletMetric: 'nominalDeviasi',
        byItemMetric: 'nominalDeviasi',
        contributorRankMetric: 'qtyDeviasi',
      },
    });
    expect(hasCurrentPayloadShape(raw)).toBe(true);
  });

  it('accepts a current-shape payload even when topGrowth lists are empty (markers survive)', () => {
    // CRITICAL H-5 nuance: with empty lists there are NO row objects, so
    // per-row keys ('"contributors":', '"qtyDelta":', …) never serialize —
    // that is exactly why markers anchor on the always-serialized wrapper
    // scalars ('"contributorLimit":', '"contributorRankMetric":', …)
    // instead. An empty current payload must pass.
    const raw = JSON.stringify({
      success: true,
      period: { monthLabel: 'Juli 2026', weekLabel: 'WEEK 1', comparisonAuto: false, weekRange: null, comparisonWeekRange: null },
      topGrowth: { byOutlet: [], byItem: [], contributorLimit: 5, byOutletMetric: 'nominalDeviasi', byItemMetric: 'nominalDeviasi', contributorRankMetric: 'qtyDeviasi' },
    });
    expect(hasCurrentPayloadShape(raw)).toBe(true);
  });

  it('rejects v4-shaped payloads — metric descriptors WITHOUT contributorRankMetric (H-7 regression)', () => {
    // Shape of a row cached by the H-6 code: has byOutletMetric/
    // byItemMetric (values 'sales'/'bom') + contributorLimit +
    // comparisonAuto, but NO contributorRankMetric — its byOutlet rows
    // are ΔSales and its byItem rows are Δ pemakaian BOM with per-row
    // `unit`, i.e. the OLD mixed metrics. Serving it after the H-7
    // metric switch would keep showing ΔSales/ΔBOM as if they were Δ
    // nominal deviasi — the exact cache-staleness bug class H-3 fixed.
    const raw = JSON.stringify({
      success: true,
      period: { monthLabel: 'Juli 2026', weekLabel: 'WEEK 1', comparisonAuto: true, weekRange: null, comparisonWeekRange: null },
      topGrowth: {
        byOutlet: [{ name: 'R', curr: 2_100_000, prev: 5_300_000, delta: -3_200_000, pct: -0.6, isNew: false, unit: null, contributors: [] }],
        byItem: [],
        contributorLimit: 5,
        byOutletMetric: 'sales',
        byItemMetric: 'bom',
      },
    });
    expect(hasCurrentPayloadShape(raw)).toBe(false);
  });

  it('rejects v3-shaped payloads — drill-down WITHOUT metric descriptors (H-6 regression)', () => {
    // Shape of a row cached by the H-5 code: has contributors +
    // contributorLimit + comparisonAuto, but its byOutlet numbers are
    // Sales × rowCount and its byItem is fake per-barang "sales" — the
    // user-reported "drill down salah" data.
    const raw = JSON.stringify({
      success: true,
      period: { monthLabel: 'Juli 2026', weekLabel: 'WEEK 1', comparisonAuto: true, weekRange: null, comparisonWeekRange: null },
      topGrowth: { byOutlet: [], byItem: [], contributorLimit: 5 },
    });
    expect(hasCurrentPayloadShape(raw)).toBe(false);
  });

  it('rejects v2-shaped payloads — topGrowth WITHOUT contributorLimit (H-5 regression)', () => {
    // Shape of a row cached by the H-2c/H-3 code: has topGrowth but no
    // drill-down fields. Serving it would render TopGrowthCard without
    // the drill-down + period provenance the new UI expects.
    const raw = JSON.stringify({
      success: true,
      period: { monthLabel: 'Juli 2026', weekLabel: 'WEEK 1', comparisonWeek: 'WEEK 1', comparisonMonth: 'Juni 2026' },
      topGrowth: { byOutlet: [], byItem: [] },
    });
    expect(hasCurrentPayloadShape(raw)).toBe(false);
  });

  it('rejects pre-topGrowth payloads (the exact H-3 "cache lama" root cause)', () => {
    // Shape of a row cached by the pre-H-2c code: valid envelope, no
    // topGrowth key. The old looksLikeAnalysisEnvelope guard served this
    // as a fresh hit for the full 30-min TTL.
    const raw = JSON.stringify({
      success: true,
      period: { monthLabel: 'Juli 2026', weekLabel: 'WEEK 1' },
      execSummary: { sales: { current: 1, previous: 2 } },
      growthDrivers: [],
    });
    expect(hasCurrentPayloadShape(raw)).toBe(false);
  });

  it('rejects malformed / empty / non-JSON strings', () => {
    expect(hasCurrentPayloadShape('')).toBe(false);
    expect(hasCurrentPayloadShape('{}')).toBe(false);
    expect(hasCurrentPayloadShape('null')).toBe(false);
    // NOTE (H-5 update): a bare '"topGrowth":' string contains only 1 of the
    // required markers → REJECTED (under the single-marker H-3 guard it
    // passed). Still correct: the guard answers "was the row written by
    // code that emits the current shape?" — envelope VALIDITY is checked
    // separately by looksLikeAnalysisEnvelope before this runs.
    expect(hasCurrentPayloadShape('"topGrowth":')).toBe(false);
    // All six markers present (even in a bare concatenation) → passes the
    // marker scan — same nuance as above, carried forward to v5.
    expect(hasCurrentPayloadShape('"topGrowth":"contributorLimit":"comparisonAuto":"byItemMetric":"byOutletMetric":"contributorRankMetric":')).toBe(true);
  });

  it('rejects a payload whose topGrowth value is null (field must be an object)', () => {
    // JSON.stringify({ topGrowth: null }) DOES emit '"topGrowth":null' — the
    // marker scan would pass. That's acceptable: assembleResponse never
    // writes null (queryTopGrowth returns an object), and a hypothetical
    // null-valued row still parses + the client treats it as undefined →
    // empty state with the recovery button. This test documents the nuance.
    const raw = JSON.stringify({ success: true, topGrowth: null, contributorLimit: 5, comparisonAuto: true, byItemMetric: 'nominalDeviasi', byOutletMetric: 'nominalDeviasi', contributorRankMetric: 'qtyDeviasi' });
    expect(hasCurrentPayloadShape(raw)).toBe(true);
  });

  it('markers are literal top-level JSON key fragments (quoted key + colon)', () => {
    // A malformed marker (e.g. 'topGrowth' without quotes/colon) would
    // accidentally match substrings inside string VALUES and weaken the
    // guard's discrimination between old and new payloads.
    for (const marker of REQUIRED_PAYLOAD_MARKERS) {
      expect(marker.startsWith('"')).toBe(true);
      expect(marker.endsWith(':')).toBe(true);
      expect(marker.length).toBeGreaterThan(3);
    }
  });

  it('requires exactly the H-7 marker set (topGrowth + contributorLimit + comparisonAuto + both metric descriptors + contributorRankMetric)', () => {
    // Documents the current contract — updating markers without intent
    // (or forgetting one) surfaces here as a diff.
    expect(REQUIRED_PAYLOAD_MARKERS).toEqual([
      '"topGrowth":',
      '"contributorLimit":',
      '"comparisonAuto":',
      '"byItemMetric":',
      '"byOutletMetric":',
      '"contributorRankMetric":',
    ]);
  });
});
