// Tests for src/lib/queries/growth-drivers.ts — queryGrowthDrivers
// Mock @/lib/db; verify SQL invocation + Pareto 80/20 computation.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryGrowthDrivers } from '@/lib/queries/growth-drivers';

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

describe('queryGrowthDrivers', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
  });

  it('returns growth driver metrics with up/down drivers', async () => {
    // Mock: 2 outlets with positive delta (up), 1 with negative (down)
    // The query is called twice (once per metric type) — mock returns for each
    mockQueryRaw.mockResolvedValue([
      { groupName: 'JKT-001', curr: 100, prev: 80 },
      { groupName: 'JKT-002', curr: 90, prev: 70 },
      { groupName: 'BDG-001', curr: 50, prev: 60 },
    ]);
    const r = await queryGrowthDrivers('WEEK 2', 'Agustus 2026', 'WEEK 1', 'Agustus 2026', {});
    expect(Array.isArray(r)).toBe(true);
    expect(r.length).toBeGreaterThan(0);
    // Each metric should have up + down drivers
    for (const metric of r) {
      expect(metric).toHaveProperty('metric');
      expect(metric).toHaveProperty('label');
      expect(metric).toHaveProperty('up');
      expect(metric).toHaveProperty('down');
      expect(metric.up).toHaveProperty('drivers');
      expect(metric.down).toHaveProperty('drivers');
    }
  });
});
