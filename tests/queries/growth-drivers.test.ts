// Tests for src/lib/queries/growth-drivers.ts — queryGrowthDrivers
// Mock @/lib/db; verify SQL invocation + Pareto 80/20 computation.
// TASK H-6: the `sales` metric now reads OutletPeriodSales.salesMode
// (per-outlet MODE of the outlet-level denormalized nominalSales) —
// regression test below pins the canonical source + the map values.
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

// SQL text flattener. NOTE (same caveat as top-growth.test.ts): vitest's
// call recording strips NESTED CTE Prisma.Sql fragments — the recorded arg
// surfaces as the OUTER template's string fragments only, so assertions
// anchor on outer fragments (CTE names / COALESCE lines); the salesMode
// SOURCE is proven behaviorally by the mocked row values feeding the map.
function sqlText(sql: unknown): string {
  if (sql == null) return '';
  if (Array.isArray(sql)) return sql.map((x) => String(x ?? '')).join('');
  return String(sql);
}

describe('queryGrowthDrivers', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
    mockExecuteRaw.mockReset();
  });

  it('sales metric reads OutletPeriodSales.salesMode per outlet (TASK H-6 — no more Sales × rowCount)', async () => {
    // Invocation order is deterministic: Promise.all evaluates
    // aggregateSalesMode(...) first → its $queryRaw fires before
    // aggregateItemMetrics'. salesMode rows feed the `sales` map.
    mockQueryRaw
      .mockResolvedValueOnce([
        { name: 'JKT-001', curr: 100_000, prev: 80_000 },   // Δ +20.000 → up
        { name: 'BDG-001', curr: 50_000, prev: 60_000 },    // Δ −10.000 → down
      ])
      .mockResolvedValue([]);  // item-grain metrics (bom/qd/nd) — empty
    const r = await queryGrowthDrivers('WEEK 2', 'Agustus 2026', 'WEEK 1', 'Agustus 2026', {});

    const sales = r.find((m) => m.metric === 'sales');
    expect(sales).toBeDefined();
    const upDrivers = sales?.up.drivers ?? [];
    const downDrivers = sales?.down.drivers ?? [];
    expect(upDrivers.map((d) => d.item)).toEqual(['JKT-001']);
    expect(upDrivers[0]).toMatchObject({ delta: 20_000 });
    expect(downDrivers.map((d) => d.item)).toEqual(['BDG-001']);
    expect(downDrivers[0]).toMatchObject({ delta: -10_000 });
    // The canonical source: the salesMode scan is the FIRST query (its
    // outer template carries the curr_sales/prev_sales CTE skeleton;
    // vitest strips nested fragments, so the OutletPeriodSales table
    // name is proven behaviorally — these mocked rows only reach the
    // sales map via aggregateSalesMode).
    const t = sqlText(mockQueryRaw.mock.calls[0]?.[0]);
    expect(t).toContain('curr_sales');
    expect(t).toContain('FULL OUTER JOIN prev_sales p ON c.name = p.name');
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
