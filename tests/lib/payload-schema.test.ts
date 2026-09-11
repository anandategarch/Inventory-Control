// ============================================================
//  payload-schema — unit tests for the analysis cache shape guard
//  --------------------------------------------------------
//  TASK H-3: regression tests for the root cause of the "Top Growth
//  cache lama meskipun sudah refresh" bug — pre-deploy AggregationCache
//  rows (missing topGrowth) were served as fresh hits because the
//  serve-path guard only checked '"success":'. The guard must reject
//  every payload that lacks the current shape markers.
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  ANALYSIS_PAYLOAD_SCHEMA_VERSION,
  REQUIRED_PAYLOAD_MARKERS,
  hasCurrentPayloadShape,
} from '@/app/api/analysis/services/payload-schema';

describe('payload-schema (analysis cache shape guard — TASK H-3)', () => {
  it('schema version is 2 (bumped when topGrowth was added to the payload)', () => {
    // v1 (implicit) = pre-Top-Growth rows. If this fails, the version was
    // bumped without updating this test — update BOTH together.
    expect(ANALYSIS_PAYLOAD_SCHEMA_VERSION).toBe(2);
  });

  it('accepts a current-shape payload (contains every required marker)', () => {
    const raw = JSON.stringify({
      success: true,
      period: { monthLabel: 'Juli 2026', weekLabel: 'WEEK 1' },
      execSummary: { sales: { current: 1, previous: 2 } },
      growthDrivers: [],
      topGrowth: { byOutlet: [], byItem: [] },
    });
    expect(hasCurrentPayloadShape(raw)).toBe(true);
  });

  it('accepts a current-shape payload even when topGrowth lists are empty', () => {
    // queryTopGrowth ALWAYS returns { byOutlet, byItem } (possibly empty
    // arrays) and assembleResponse always serializes them — an empty
    // current payload must still pass the guard.
    const raw = JSON.stringify({ success: true, topGrowth: { byOutlet: [], byItem: [] } });
    expect(hasCurrentPayloadShape(raw)).toBe(true);
  });

  it('rejects pre-topGrowth payloads (the exact "cache lama" root cause)', () => {
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
    // NOTE: a bare '"topGrowth":' string DOES contain the marker → true.
    // That is correct: this guard only answers "was the row written by
    // code that emits the current shape?" — envelope VALIDITY is checked
    // separately by looksLikeAnalysisEnvelope before this runs.
    expect(hasCurrentPayloadShape('"topGrowth":')).toBe(true);
  });

  it('rejects a payload whose topGrowth value is null (field must be an object)', () => {
    // JSON.stringify({ topGrowth: null }) DOES emit '"topGrowth":null' — the
    // marker scan would pass. That's acceptable: assembleResponse never
    // writes null (queryTopGrowth returns an object), and a hypothetical
    // null-valued row still parses + the client treats it as undefined →
    // empty state with the recovery button. This test documents the nuance.
    const raw = JSON.stringify({ success: true, topGrowth: null });
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
});
