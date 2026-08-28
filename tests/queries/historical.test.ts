// Tests for src/lib/queries/historical.ts — queryHistoricalStats
// Mock @/lib/db; verify SQL invocation + result transformation (Map with mean/stdDev/n).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryHistoricalStats } from '@/lib/queries/historical';

const { mockQueryRaw, mockExecuteRaw } = vi.hoisted(() => ({
  mockQueryRaw: vi.fn(),
  mockExecuteRaw: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    $queryRaw: mockQueryRaw,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      $queryRaw: mockQueryRaw,
      $executeRaw: mockExecuteRaw,
    }),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe('queryHistoricalStats', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
  });

  it('returns empty Map when historicalPeriods is empty', async () => {
    const r = await queryHistoricalStats([], {});
    expect(r).toBeInstanceOf(Map);
    expect(r.size).toBe(0);
  });

  it('returns Map with mean, stdDev, n per outlet+item', async () => {
    // Mock: outlet 1, item 10 — 4 weeks of data
    // mean = 0.05, sumSq = 0.01, n = 4
    // variance = (0.01 - 4 * 0.05^2) / 3 = (0.01 - 0.01) / 3 = 0
    // stdDev = 0
    mockQueryRaw.mockResolvedValueOnce([
      { outletId: 1, itemId: 10, mean: 0.05, sumSq: 0.01, n: 4 },
    ]);
    const r = await queryHistoricalStats(
      [{ monthLabel: 'Juli 2026', weekLabel: 'WEEK 1' }],
      {},
    );
    expect(r.size).toBe(1);
    const stats = r.get('1|10');
    expect(stats).toBeDefined();
    expect(stats!.mean).toBe(0.05);
    expect(stats!.n).toBe(4);
    expect(stats!.stdDev).toBe(0); // variance = 0 when sumSq = n * mean^2
  });

  it('computes sample variance (N-1 Bessel correction) correctly', async () => {
    // 2 observations: 0.1 and 0.3
    // mean = 0.2, sumSq = 0.01 + 0.09 = 0.10
    // variance = (0.10 - 2 * 0.04) / 1 = 0.02
    // stdDev = sqrt(0.02) ≈ 0.1414
    mockQueryRaw.mockResolvedValueOnce([
      { outletId: 1, itemId: 10, mean: 0.2, sumSq: 0.10, n: 2 },
    ]);
    const r = await queryHistoricalStats(
      [{ monthLabel: 'Juli 2026', weekLabel: 'WEEK 1' }],
      {},
    );
    const stats = r.get('1|10')!;
    expect(stats.stdDev).toBeCloseTo(Math.sqrt(0.02), 5);
  });

  it('handles n=1 (variance = 0, no division by zero)', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      { outletId: 1, itemId: 10, mean: 0.15, sumSq: 0.0225, n: 1 },
    ]);
    const r = await queryHistoricalStats(
      [{ monthLabel: 'Juli 2026', weekLabel: 'WEEK 1' }],
      {},
    );
    const stats = r.get('1|10')!;
    expect(stats.n).toBe(1);
    expect(stats.stdDev).toBe(0); // n=1 → variance = 0 (no division by zero)
  });

  it('handles multiple outlet+item pairs', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      { outletId: 1, itemId: 10, mean: 0.05, sumSq: 0.01, n: 3 },
      { outletId: 1, itemId: 20, mean: 0.10, sumSq: 0.03, n: 3 },
      { outletId: 2, itemId: 10, mean: 0.15, sumSq: 0.07, n: 3 },
    ]);
    const r = await queryHistoricalStats(
      [{ monthLabel: 'Juli 2026', weekLabel: 'WEEK 1' }],
      {},
    );
    expect(r.size).toBe(3);
    expect(r.has('1|10')).toBe(true);
    expect(r.has('1|20')).toBe(true);
    expect(r.has('2|10')).toBe(true);
  });
});
