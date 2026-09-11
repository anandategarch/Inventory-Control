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

import { cachedSharedQuery } from '@/lib/queries/query-cache';

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
