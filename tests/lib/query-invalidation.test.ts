// Tests for src/lib/query-invalidation.ts (invalidateAllData).
// Regression-proof for BUG-3-b B1: the CHANGE-1 "lensa Perubahan"
// (OutletPriorityPanel + ChangeItemTable) queries under ['change-analysis']
// / ['change-analysis','items',...] MUST be part of the shared client-side
// invalidation list — they were the 19th key missed by the H-14/T3 sweep,
// leaving the change lens stale (up to its 5-min staleTime) after every
// mutation (upload/delete/reset/drive/ingest/settings/PIC/refresh).
// The server side already invalidates 'change-analysis'
// (src/lib/aggregation-cache/invalidate.ts) — this test pins the client side.
import { describe, it, expect, vi } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';
import { invalidateAllData } from '@/lib/query-invalidation';

/** Minimal recording stand-in for a QueryClient — invalidateAllData only
 *  calls queryClient.invalidateQueries({ queryKey }). */
function makeRecordingClient(): { queryClient: QueryClient; invalidated: unknown[][] } {
  const invalidated: unknown[][] = [];
  const queryClient = {
    invalidateQueries: vi.fn((opts: { queryKey: readonly unknown[] }) => {
      invalidated.push([...opts.queryKey]);
    }),
  } as unknown as QueryClient;
  return { queryClient, invalidated };
}

describe('invalidateAllData (BUG-3-b B1 regression)', () => {
  it("invalidates the CHANGE-1 ['change-analysis'] key — prefix-covers ['change-analysis','items',...]", () => {
    const { queryClient, invalidated } = makeRecordingClient();
    invalidateAllData(queryClient);
    // TanStack prefix-matching: invalidating ['change-analysis'] also marks
    // ['change-analysis','items',...] stale — one entry closes both queries.
    expect(invalidated.some((k) => k[0] === 'change-analysis')).toBe(true);
  });

  it('still covers the core H-14/T3 keys (no key dropped while adding the 19th)', () => {
    const { queryClient, invalidated } = makeRecordingClient();
    invalidateAllData(queryClient);
    const roots = new Set(invalidated.map((k) => k[0]));
    for (const key of [
      'analysis',
      'status',
      'outlet-items',
      'item-history',
      'peer-comparison',
      'recommendations',
      'area-item-heatmap',
      'heatmap-cell-detail',
      'item-trend',
      'item-trend-rank',
      'item-search',
      'item-peer-comparison',
      'flip-ranking',
      'flip-drilldown',
      'pareto',
      'drilldown',
      'price-effect',
      'item-anomali-outlets',
    ]) {
      expect(roots.has(key), `missing query key [${key}]`).toBe(true);
    }
  });

  it('passes every key as a non-empty array (prefix-matchable shape)', () => {
    const { queryClient, invalidated } = makeRecordingClient();
    invalidateAllData(queryClient);
    expect(invalidated.length).toBeGreaterThanOrEqual(19);
    for (const key of invalidated) {
      expect(Array.isArray(key)).toBe(true);
      expect(key.length).toBeGreaterThan(0);
      expect(typeof key[0]).toBe('string');
    }
  });
});
