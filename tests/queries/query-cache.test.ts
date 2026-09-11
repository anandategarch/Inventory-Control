// Tests for src/lib/queries/query-cache.ts — cachedSharedQuery.
// Verifies the key contract: the cache key captures ALL response-affecting
// inputs (period + compare pair + every filter + extras + resolved PIC codes,
// order-insensitive) and the wrapper delegates to / returns from
// withCacheAndDedup.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockWithCacheAndDedup } = vi.hoisted(() => ({
  mockWithCacheAndDedup: vi.fn(),
}));

vi.mock('@/lib/aggregation-cache', () => ({
  buildCacheKey: (parts: { route: string; [k: string]: unknown }) =>
    // Minimal stand-in mirroring the real format closely enough for assertions
    `${parts.route}\x1f${JSON.stringify(parts)}`,
  withCacheAndDedup: mockWithCacheAndDedup,
}));

import { cachedSharedQuery, cachedSharedQueryMap, histPeriodsKeyParts, histCriticalKeysHash } from '@/lib/queries/query-cache';

describe('cachedSharedQuery', () => {
  beforeEach(() => {
    mockWithCacheAndDedup.mockReset();
  });

  it('passes the built key + TTL to withCacheAndDedup and returns its data', async () => {
    mockWithCacheAndDedup.mockResolvedValueOnce({ data: { rows: [1, 2, 3] }, cached: false });
    const compute = vi.fn().mockResolvedValue({ rows: [1, 2, 3] });
    const out = await cachedSharedQuery('q-test', { month: 'Agustus 2026', week: 'WEEK 1', filters: {} }, compute);
    expect(out).toEqual({ rows: [1, 2, 3] });
    expect(mockWithCacheAndDedup).toHaveBeenCalledTimes(1);
    const [key, ttl, fn, awaitWrite] = mockWithCacheAndDedup.mock.calls[0];
    expect(key).toContain('q-test\x1f');
    expect(ttl).toBe(30 * 60 * 1000); // 30 min — matches the analysis payload TTL
    expect(awaitWrite).toBe(false); // non-blocking write (analysis cold path must not stall)
    expect(await fn()).toEqual({ rows: [1, 2, 3] }); // computeFn forwarded verbatim
  });

  it('key includes filters + compare pair + extras + sorted picCodes', async () => {
    mockWithCacheAndDedup.mockResolvedValueOnce({ data: null, cached: false });
    await cachedSharedQuery(
      'q-rules',
      {
        month: 'Agustus 2026',
        week: 'WEEK 2',
        compareWeek: 'WEEK 2',
        compareMonth: 'Juli 2026',
        filters: { area: 'JAWA BARAT 1', kelompok: 'BDG', outletCode: '1030.BDG1', itemName: 'Ayam' },
        extra: { limit: 10 },
      },
      vi.fn().mockResolvedValue(null),
    );
    const key = mockWithCacheAndDedup.mock.calls[0][0] as string;
    expect(key).toContain('q-rules');
    expect(key).toContain('Agustus 2026');
    expect(key).toContain('WEEK 2');
    expect(key).toContain('Juli 2026');
    expect(key).toContain('JAWA BARAT 1');
    expect(key).toContain('BDG');
    expect(key).toContain('1030.BDG1');
    expect(key).toContain('Ayam');
    expect(key).toContain('"limit":10');
  });

  it('picOutletCodes are sorted into the key — identical sets in different orders share one key', async () => {
    mockWithCacheAndDedup.mockResolvedValue({ data: null, cached: false });
    const mk = async (codes: string[]) => {
      mockWithCacheAndDedup.mockClear();
      await cachedSharedQuery('q-x', { month: 'M', week: 'W', filters: { picOutletCodes: codes } }, vi.fn().mockResolvedValue(null));
      return mockWithCacheAndDedup.mock.calls[0][0] as string;
    };
    const keyA = await mk(['B.1001.MLGPAR', '1030.BDGSET']);
    const keyB = await mk(['1030.BDGSET', 'B.1001.MLGPAR']);
    expect(keyA).toBe(keyB);
  });

  it('falls back to withCacheAndDedup errors (rejects) — no swallowing', async () => {
    mockWithCacheAndDedup.mockRejectedValueOnce(new Error('db down'));
    await expect(
      cachedSharedQuery('q-y', { month: 'M', week: 'W', filters: {} }, vi.fn().mockResolvedValue(null)),
    ).rejects.toThrow('db down');
  });
});

describe('histPeriodsKeyParts (H-11 #3 — historical-period key fingerprint)', () => {
  it('derives month from the sorted distinct monthLabels and week from distinct weekLabels', () => {
    // NOTE: the sort is ALPHABETICAL (localeCompare), not chronological —
    // "Juni" < "Mei" alphabetically. Only determinism + set-uniqueness
    // matter for the fingerprint (both pipelines call the same helper),
    // so alphabetical is fine.
    const a = histPeriodsKeyParts([
      { monthLabel: 'Juni 2026', weekLabel: 'WEEK 4' },
      { monthLabel: 'April 2026', weekLabel: 'WEEK 4' },
      { monthLabel: 'Mei 2026', weekLabel: 'WEEK 4' },
    ]);
    expect(a).toEqual({ month: 'April 2026|Juni 2026|Mei 2026', week: 'WEEK 4' });
  });

  it('is order-insensitive — the two pipelines get ONE key for the same period set', () => {
    const a = histPeriodsKeyParts([
      { monthLabel: 'Juni 2026', weekLabel: 'WEEK 4' },
      { monthLabel: 'April 2026', weekLabel: 'WEEK 4' },
    ]);
    const b = histPeriodsKeyParts([
      { monthLabel: 'April 2026', weekLabel: 'WEEK 4' },
      { monthLabel: 'Juni 2026', weekLabel: 'WEEK 4' },
      // duplicate entries must not change the fingerprint
      { monthLabel: 'Juni 2026', weekLabel: 'WEEK 4' },
    ]);
    expect(a).toEqual(b);
  });

  it('empty list → empty parts (callers guard length > 0 before caching)', () => {
    expect(histPeriodsKeyParts([])).toEqual({ month: '', week: '' });
  });
});

describe('histCriticalKeysHash (H-11 #3 — histCriticalKeys fingerprint)', () => {
  it('is order-insensitive — identical key SETS hash identically', () => {
    const a = histCriticalKeysHash([
      { outletId: 7, itemId: 3, akunPenyesuaian: 'WASTE' },
      { outletId: 1, itemId: 9, akunPenyesuaian: null },
    ]);
    const b = histCriticalKeysHash([
      { outletId: 1, itemId: 9, akunPenyesuaian: null },
      { outletId: 7, itemId: 3, akunPenyesuaian: 'WASTE' },
    ]);
    expect(a).toBe(b);
  });

  it('different key sets (or sizes) hash differently', () => {
    const base = { outletId: 1, itemId: 9, akunPenyesuaian: null };
    const a = histCriticalKeysHash([base]);
    const b = histCriticalKeysHash([base, base]);
    const c = histCriticalKeysHash([{ ...base, itemId: 10 }]);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('null vs empty-string akunPenyesuaian are distinct inputs', () => {
    const a = histCriticalKeysHash([{ outletId: 1, itemId: 1, akunPenyesuaian: null }]);
    const b = histCriticalKeysHash([{ outletId: 1, itemId: 1, akunPenyesuaian: '' }]);
    expect(a).not.toBe(b);
  });
});

describe('cachedSharedQueryMap (H-11 #3 — Map-safe cache wrapper)', () => {
  beforeEach(() => {
    mockWithCacheAndDedup.mockReset();
  });

  it('caches the Map as a JSON-safe entry array and rebuilds a Map on read', async () => {
    // First call — MISS: computeFn runs, withCacheAndDedup stores the entries.
    mockWithCacheAndDedup.mockResolvedValueOnce({
      data: [['a|b', { avgQty: 1 }], ['c|d', { avgQty: 2 }]],
      cached: false,
    });
    const out = await cachedSharedQueryMap('q-hist-stats', { month: 'A|B', week: 'W', filters: {} }, async () => {
      throw new Error('should not recompute on hit path');
    });
    expect(out).toBeInstanceOf(Map);
    expect(out.get('a|b')).toEqual({ avgQty: 1 });
    expect(out.get('c|d')).toEqual({ avgQty: 2 });
    expect(out.size).toBe(2);
  });

  it('serializes the computed Map into entries before it reaches the cache layer', async () => {
    let storedPayload: unknown;
    mockWithCacheAndDedup.mockImplementationOnce(async (_key, _ttl, computeFn) => {
      storedPayload = await computeFn();
      return { data: storedPayload, cached: false };
    });
    const out = await cachedSharedQueryMap('q-hist-catavg', { month: 'X', week: 'W', filters: {} }, async () => {
      const m = new Map<string, number>();
      m.set('k1', 42);
      return m;
    });
    // The payload stored in the (JSON-stringifying) cache layer must NOT be
    // a Map — JSON.stringify(Map) would silently produce "{}" and corrupt
    // every subsequent read.
    expect(storedPayload).toEqual([['k1', 42]]);
    expect(out.get('k1')).toBe(42);
  });
});
