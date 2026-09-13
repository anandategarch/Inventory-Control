// Tests for aggregation-cache — buildCacheKey sentinel-collision regression
// (BUG-2-b fix [1]) + withCacheAndDedup generation-guard race regression
// (BUG-2-b fix [2], BUG-1-c #1/#2).
//
// buildCacheKey is pure (no DB). withCacheAndDedup / invalidateAnalysisCache
// touch db.aggregationCache (findUnique / upsert / deleteMany) — mocked here
// following the same vi.hoisted pattern as tests/lib/period-resolver.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildCacheKey,
  withCacheAndDedup,
  invalidateAnalysisCache,
  getCacheGeneration,
} from '@/lib/aggregation-cache';

const { mockFindUnique, mockUpsert, mockDeleteMany, mockDelete } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockUpsert: vi.fn(),
  mockDeleteMany: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    aggregationCache: {
      findUnique: mockFindUnique,
      upsert: mockUpsert,
      deleteMany: mockDeleteMany,
      delete: mockDelete,
    },
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Flush pending microtasks/promises so background IIFEs + awaited writes settle.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

describe('buildCacheKey — sentinel collision regression (BUG-2-b / BUG-1-c #1)', () => {
  it('a literal area="ALL" must NOT share the no-filter key', () => {
    // Old bug: the plain 'ALL' sentinel collided with user input area=ALL →
    // an empty filtered payload was cached under the no-filter view's key.
    expect(buildCacheKey({ route: 'x', area: 'ALL' }))
      .not.toBe(buildCacheKey({ route: 'x', area: undefined }));
    expect(buildCacheKey({ route: 'x', area: 'All' }))
      .not.toBe(buildCacheKey({ route: 'x', area: undefined }));
  });

  it('a literal kelompok="All" (→ uppercased "ALL") must NOT share the no-filter key', () => {
    expect(buildCacheKey({ route: 'x', kelompok: 'All' }))
      .not.toBe(buildCacheKey({ route: 'x', kelompok: undefined }));
    expect(buildCacheKey({ route: 'x', kelompok: 'ALL' }))
      .not.toBe(buildCacheKey({ route: 'x', kelompok: undefined }));
  });

  it('literal outletCode/itemName/pic "ALL" must NOT share the no-filter key', () => {
    expect(buildCacheKey({ route: 'x', outletCode: 'ALL' }))
      .not.toBe(buildCacheKey({ route: 'x', outletCode: undefined }));
    expect(buildCacheKey({ route: 'x', itemName: 'ALL' }))
      .not.toBe(buildCacheKey({ route: 'x', itemName: undefined }));
    expect(buildCacheKey({ route: 'x', pic: 'ALL' }))
      .not.toBe(buildCacheKey({ route: 'x', pic: undefined }));
  });

  it('lowercase "all" is still the no-filter marker for area/kelompok/outlet', () => {
    // Mirrors the query layer (build-where.ts / shared.ts drop only the
    // lowercase 'all') — key and SQL filter must stay in agreement.
    expect(buildCacheKey({ route: 'x', area: 'all' }))
      .toBe(buildCacheKey({ route: 'x', area: undefined }));
    expect(buildCacheKey({ route: 'x', kelompok: 'all' }))
      .toBe(buildCacheKey({ route: 'x', kelompok: undefined }));
    expect(buildCacheKey({ route: 'x', outletCode: 'all' }))
      .toBe(buildCacheKey({ route: 'x', outletCode: undefined }));
  });

  it('a real filter value produces its own unique key', () => {
    const jakarta = buildCacheKey({ route: 'x', area: 'JAKARTA' });
    expect(jakarta).not.toBe(buildCacheKey({ route: 'x', area: undefined }));
    expect(jakarta).not.toBe(buildCacheKey({ route: 'x', area: 'ALL' }));
    expect(jakarta).not.toBe(buildCacheKey({ route: 'x', area: 'BANTEN' }));
    // kelompok stays case-folded (mirrors UPPER() in the SQL filter)
    expect(buildCacheKey({ route: 'x', kelompok: 'mlg' }))
      .toBe(buildCacheKey({ route: 'x', kelompok: 'MLG' }));
  });

  it('absent month/week/compare sentinels cannot be forged by input', () => {
    // month/week are regex-validated upstream, but the sentinels must be
    // unforgeable regardless of what a route passes through.
    expect(buildCacheKey({ route: 'x', month: 'NONE' }))
      .not.toBe(buildCacheKey({ route: 'x', month: undefined, compareWeek: undefined }));
    expect(buildCacheKey({ route: 'x', compareMonth: 'NONE' }))
      .not.toBe(buildCacheKey({ route: 'x', compareMonth: undefined }));
  });
});

describe('withCacheAndDedup — generation guard vs invalidation race (BUG-2-b / BUG-1-c #2)', () => {
  beforeEach(() => {
    mockFindUnique.mockReset().mockResolvedValue(null);
    mockUpsert.mockReset().mockResolvedValue(undefined);
    mockDeleteMany.mockReset().mockResolvedValue({ count: 0 });
    mockDelete.mockReset().mockResolvedValue(undefined);
  });

  it('miss path: skips the cache write-back when an invalidation lands mid-compute', async () => {
    const deferred = Promise.withResolvers<string>();
    const computeFn = () => deferred.promise;
    const pending = withCacheAndDedup<string>('race-miss', 60_000, computeFn, true);

    await flush(); // let the caller reach computeFn
    expect(mockUpsert).not.toHaveBeenCalled();

    // Mutation lands while the compute is still running.
    await invalidateAnalysisCache();
    deferred.resolve('pre-mutation-data');

    const res = await pending;
    // The data is still returned (already computed) but never cached.
    expect(res).toEqual({ data: 'pre-mutation-data', cached: false });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('stale-hit SWR path: the background recompute does not write pre-mutation data back', async () => {
    // Seed a stale row → the SWR path serves it + fires the background recompute.
    mockFindUnique.mockResolvedValueOnce({
      payload: JSON.stringify({ v: 'stale' }),
      computedAt: new Date(Date.now() - 999_999),
    });

    let computeCalls = 0;
    const deferred = Promise.withResolvers<string>();
    const computeFn = vi.fn().mockImplementation(() => {
      computeCalls++;
      if (computeCalls === 1) return deferred.promise; // background recompute
      return Promise.resolve('post-mutation-data');    // re-enter after invalidation
    });

    // Request 1: stale hit — served immediately, background recompute starts.
    const res = await withCacheAndDedup<string>('race-swr', 1_000, computeFn, true);
    expect(res).toEqual({ data: { v: 'stale' }, cached: true, stale: true });

    // Request 2: arrives while the background recompute runs → parks on the
    // in-flight promise. The generation guard must eventually hand it the
    // POST-mutation value (never a hang, never the pre-mutation value).
    const pendingR2 = withCacheAndDedup<string>('race-swr', 60_000, computeFn, true);

    await flush(); // background recompute is now pending inside computeFn
    expect(mockUpsert).not.toHaveBeenCalled();

    await invalidateAnalysisCache();
    deferred.resolve('pre-mutation-fresh');
    const res2 = await pendingR2;
    await flush(); // let the background IIFE run past the generation guard

    // The pre-mutation result must NOT be written back under a fresh timestamp.
    expect(mockUpsert.mock.calls.filter(
      ([args]) => args?.create?.payload === JSON.stringify('pre-mutation-fresh'),
    )).toHaveLength(0);
    // The re-entered request computed post-mutation data AND cached that.
    expect(res2.data).toBe('post-mutation-data');
    expect(computeCalls).toBe(2);
    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { cacheKey: 'race-swr' },
      create: expect.objectContaining({ payload: JSON.stringify('post-mutation-data') }),
    }));
  });

  it('in-flight awaiter: refuses a result computed before the invalidation and recomputes', async () => {
    let computeCalls = 0;
    const deferred = Promise.withResolvers<string>();
    const computeFn = vi.fn().mockImplementation(() => {
      computeCalls++;
      if (computeCalls === 1) return deferred.promise;
      return Promise.resolve('post-mutation-data');
    });

    // A starts computing (cache miss).
    const pendingA = withCacheAndDedup<string>('race-inflight', 60_000, computeFn, true);
    await flush();
    // B arrives while A is computing → awaits A's in-flight promise.
    const pendingB = withCacheAndDedup<string>('race-inflight', 60_000, computeFn, true);

    await invalidateAnalysisCache(); // mutation lands mid-compute
    deferred.resolve('pre-mutation-data');

    const [resA, resB] = await Promise.all([pendingA, pendingB]);
    // A returns what it already computed (one-off, never cached).
    expect(resA.data).toBe('pre-mutation-data');
    // B must NOT serve A's pre-mutation result as cached:true — it recomputes.
    expect(resB.data).toBe('post-mutation-data');
    expect(computeCalls).toBe(2);
    // The post-mutation result IS cached (generation stable by then).
    expect(mockUpsert).toHaveBeenCalled();
  });

  it('without an invalidation, the miss path still caches (guard is inert when generation is stable)', async () => {
    const res = await withCacheAndDedup<string>(
      'race-noinvalidation', 60_000, async () => 'clean-data', true,
    );
    expect(res).toEqual({ data: 'clean-data', cached: false });
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { cacheKey: 'race-noinvalidation' } }),
    );
  });

  it('invalidateAnalysisCache advances the generation synchronously', async () => {
    const before = getCacheGeneration();
    const promise = invalidateAnalysisCache();
    // The generation must advance BEFORE the awaited deleteMany batch settles.
    expect(getCacheGeneration()).toBeGreaterThan(before);
    await promise;
    expect(getCacheGeneration()).toBeGreaterThan(before);
    expect(mockDeleteMany).toHaveBeenCalled();
  });
});
