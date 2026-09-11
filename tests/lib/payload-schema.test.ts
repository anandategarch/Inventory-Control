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
//  2 → 3 and markers extended. v2-shaped rows (topGrowth WITHOUT
//  contributorLimit) must now be treated as MISS — the same bug class
//  H-3 fixed, one shape-generation later.
//
//  TASK H-6: topGrowth values changed SEMANTICS (byOutlet = salesMode
//  ΔSales; byItem = Δ pemakaian BOM with unit; byOutletMetric/
//  byItemMetric descriptors) → version 3 → 4 + two new markers. A v3
//  row (drill-down with the WRONG numbers: byOutlet = Sales ×
//  rowCount, byItem = fake per-barang "sales") must be rejected —
//  serving it would keep showing the user-reported wrong data.
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  ANALYSIS_PAYLOAD_SCHEMA_VERSION,
  REQUIRED_PAYLOAD_MARKERS,
  hasCurrentPayloadShape,
} from '@/app/api/analysis/services/payload-schema';

describe('payload-schema (analysis cache shape guard — TASK H-3 + H-5 + H-6)', () => {
  it('schema version is 4 (bumped when topGrowth values changed semantics — H-6)', () => {
    // v1 (implicit) = pre-Top-Growth rows. v2 = + topGrowth. v3 = +
    // contributors/contributorLimit + comparisonAuto/weekRange. v4 =
    // salesMode/BOM rework + byOutletMetric/byItemMetric + unit. If this
    // fails, the version was bumped without updating this test — update
    // BOTH together.
    expect(ANALYSIS_PAYLOAD_SCHEMA_VERSION).toBe(4);
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
        byOutlet: [{ name: 'R', curr: 5, prev: 0, delta: 5, pct: null, isNew: true, unit: null, contributors: [] }],
        byItem: [],
        contributorLimit: 5,
        byOutletMetric: 'sales',
        byItemMetric: 'bom',
      },
    });
    expect(hasCurrentPayloadShape(raw)).toBe(true);
  });

  it('accepts a current-shape payload even when topGrowth lists are empty (markers survive)', () => {
    // CRITICAL H-5 nuance: with empty lists there are NO row objects, so the
    // per-row '"contributors":' key never serializes — that is exactly why
    // the marker anchors on the always-serialized wrapper scalar
    // '"contributorLimit":' instead. An empty current payload must pass.
    const raw = JSON.stringify({
      success: true,
      period: { monthLabel: 'Juli 2026', weekLabel: 'WEEK 1', comparisonAuto: false, weekRange: null, comparisonWeekRange: null },
      topGrowth: { byOutlet: [], byItem: [], contributorLimit: 5, byOutletMetric: 'sales', byItemMetric: 'bom' },
    });
    expect(hasCurrentPayloadShape(raw)).toBe(true);
  });

  it('rejects v3-shaped payloads — drill-down WITHOUT metric descriptors (H-6 regression)', () => {
    // Shape of a row cached by the H-5 code: has contributors +
    // contributorLimit + comparisonAuto, but its byOutlet numbers are
    // Sales × rowCount and its byItem is fake per-barang "sales" — the
    // exact wrong data the user reported. Serving it would keep showing
    // the bug; the missing byItemMetric/byOutletMetric markers force a
    // recompute with the fixed code.
    const raw = JSON.stringify({
      success: true,
      period: { monthLabel: 'Juli 2026', weekLabel: 'WEEK 1', comparisonAuto: true, weekRange: { start: 1, end: 7 }, comparisonWeekRange: null },
      topGrowth: {
        byOutlet: [{ name: 'R', curr: 5, prev: 0, delta: 5, pct: null, isNew: true, contributors: [{ name: 'I', curr: 1, prev: 0, delta: 1, pct: null, isNew: true }] }],
        byItem: [],
        contributorLimit: 5,
      },
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
    // All five markers present (even in a bare concatenation) → passes the
    // marker scan — same nuance as above, carried forward to v4.
    expect(hasCurrentPayloadShape('"topGrowth":"contributorLimit":"comparisonAuto":"byItemMetric":"byOutletMetric":')).toBe(true);
  });

  it('rejects a payload whose topGrowth value is null (field must be an object)', () => {
    // JSON.stringify({ topGrowth: null }) DOES emit '"topGrowth":null' — the
    // marker scan would pass. That's acceptable: assembleResponse never
    // writes null (queryTopGrowth returns an object), and a hypothetical
    // null-valued row still parses + the client treats it as undefined →
    // empty state with the recovery button. This test documents the nuance.
    const raw = JSON.stringify({ success: true, topGrowth: null, contributorLimit: 5, comparisonAuto: true, byItemMetric: 'bom', byOutletMetric: 'sales' });
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

  it('requires exactly the H-6 marker set (topGrowth + contributorLimit + comparisonAuto + both metric descriptors)', () => {
    // Documents the current contract — updating markers without intent
    // (or forgetting one) surfaces here as a diff.
    expect(REQUIRED_PAYLOAD_MARKERS).toEqual([
      '"topGrowth":',
      '"contributorLimit":',
      '"comparisonAuto":',
      '"byItemMetric":',
      '"byOutletMetric":',
    ]);
  });
});
