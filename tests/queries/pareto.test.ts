// Tests for src/lib/queries/pareto.ts — queryParetoByItem, queryParetoByOutlet, etc.
// Strategy: mock @/lib/db so $queryRaw returns canned rows; verify that
// (1) the SQL is invoked, (2) the parameters (week, month) are passed,
// (3) the result transformation (computePareto) produces the right shape.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryParetoByItem, queryParetoByOutlet, queryParetoByArea } from '@/lib/queries/pareto';
import { queryParetoNested } from '@/lib/queries/pareto/nested';

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

describe('queryParetoByItem', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
    mockExecuteRaw.mockReset();
  });

  it('returns ParetoResult with drivers + totals from DB rows', async () => {
    // Rows: 4 items with totalAbsNominal 100, 50, 30, 20 (sum=200)
    mockQueryRaw.mockResolvedValueOnce([
      { itemName: 'Item A', outletCount: 5, totalAbsNominal: 100, nominalDeviasi: -100, qtyDeviasi: -10 },
      { itemName: 'Item B', outletCount: 3, totalAbsNominal: 50, nominalDeviasi: 50, qtyDeviasi: 5 },
      { itemName: 'Item C', outletCount: 2, totalAbsNominal: 30, nominalDeviasi: -30, qtyDeviasi: -3 },
      { itemName: 'Item D', outletCount: 1, totalAbsNominal: 20, nominalDeviasi: 20, qtyDeviasi: 2 },
    ]);
    const r = await queryParetoByItem('WEEK 1', 'Agustus 2026', {});
    expect(r.totalAbsNominal).toBe(200);
    expect(r.totalCount).toBe(4);
    // Drivers: top 3 cross 80% threshold (50% + 25% + 15% = 90%)
    expect(r.drivers.length).toBe(3);
    expect(r.drivers[0].name).toBe('Item A');
    expect(r.drivers[0].sharePct).toBe(50);
    expect(r.drivers[1].name).toBe('Item B');
    expect(r.drivers[2].name).toBe('Item C');
    expect(r.remainderCount).toBe(1);
    expect(r.remainderPct).toBe(10);
  });

  it('returns empty drivers when DB returns no rows', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const r = await queryParetoByItem('WEEK 1', 'Agustus 2026', {});
    expect(r.drivers).toEqual([]);
    expect(r.totalAbsNominal).toBe(0);
    expect(r.totalCount).toBe(0);
  });

  it('passes week + month as SQL parameters', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await queryParetoByItem('WEEK 2', 'Juli 2026', {});
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    // Prisma.Sql extends Array — when vitest mock records the call, the array items
    // are the SQL text fragments (interleaved with $-placeholders where parameters go).
    // Verify the SQL text contains the expected WHERE clauses.
    const call = mockQueryRaw.mock.calls[0][0];
    const sqlText = Array.isArray(call) ? call.join('$PARAM$') : String(call);
    expect(sqlText).toContain('"monthLabel"');
    expect(sqlText).toContain('"weekLabel"');
    expect(sqlText).toContain('"InventoryRecord"');
    expect(sqlText).toContain('GROUP BY');
  });

  it('coerces BigInt/Decimal DB rows to Number (outletCount, totalAbsNominal, etc.)', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      { itemName: 'Item A', outletCount: BigInt(5), totalAbsNominal: BigInt(100), nominalDeviasi: BigInt(-100), qtyDeviasi: BigInt(-10) },
    ]);
    const r = await queryParetoByItem('WEEK 1', 'M', {});
    expect(r.drivers[0].outletCount).toBe(5);
    expect(typeof r.drivers[0].outletCount).toBe('number');
    expect(r.drivers[0].totalAbsNominal).toBe(100);
    expect(r.drivers[0].nominalDeviasi).toBe(-100);
    expect(r.drivers[0].qtyDeviasi).toBe(-10);
  });
});

describe('queryParetoByOutlet', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
  });

  it('returns drivers keyed by outlet name + code', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      { outletCode: '1010.BDG1', outletName: 'Outlet A', area: 'JAWA BARAT', totalAbsNominal: 100, nominalDeviasi: -100, qtyDeviasi: -10 },
      { outletCode: '1011.BDG2', outletName: 'Outlet B', area: 'JAWA BARAT', totalAbsNominal: 50, nominalDeviasi: 50, qtyDeviasi: 5 },
    ]);
    const r = await queryParetoByOutlet('WEEK 1', 'Agustus 2026', {});
    expect(r.drivers[0].name).toBe('Outlet A');
    expect(r.drivers[0].code).toBe('1010.BDG1');
    expect(r.drivers[1].name).toBe('Outlet B');
  });

  it('returns empty result when DB returns no rows', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const r = await queryParetoByOutlet('WEEK 1', 'M', {});
    expect(r.drivers).toEqual([]);
  });
});

describe('queryParetoByArea', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
  });

  it('groups by area (intentionally ignores area filter)', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      { area: 'JAWA BARAT', outletCount: 5, totalAbsNominal: 100, nominalDeviasi: -100, qtyDeviasi: -10 },
      { area: 'JAWA TIMUR', outletCount: 3, totalAbsNominal: 50, nominalDeviasi: 50, qtyDeviasi: 5 },
    ]);
    // Pass area filter — should be stripped (set to null) inside queryParetoByArea
    const r = await queryParetoByArea('WEEK 1', 'Agustus 2026', { area: 'JAWA BARAT' });
    expect(r.drivers[0].name).toBe('JAWA BARAT');
    expect(r.drivers[1].name).toBe('JAWA TIMUR');
    expect(r.drivers.length).toBe(2);
  });

  it('returns empty result when no area rows', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const r = await queryParetoByArea('WEEK 1', 'M', {});
    expect(r.drivers).toEqual([]);
  });
});

// ============================================================
// FIX (BUG-2-c): queryParetoNested — sharePct/cumPct vs FULL population
// --------------------------------------------------------
// The parent share/cum used to be computed from the SUBTOTAL of the top-N
// slice (grandTotal = Σ topParents), inflating item #1's share and forcing
// cumPct to a misleading 100% at row maxItems. Step-1 now carries the
// population total via `SUM(...) OVER ()` and shares are computed against
// it — same semantics as computePareto8020 on the by-dimension cards.
// ============================================================
describe('queryParetoNested — population-based sharePct/cumPct', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
    mockExecuteRaw.mockReset();
  });

  it('computes parent shares against the population total (window column), not the top-N subtotal', async () => {
    // Population: 12 parents, total = 252. maxItems=10 → the top-10 subtotal
    // is 245 (K=4 and L=3 stay outside the slice).
    const population: Array<[string, number]> = [
      ['A', 100], ['B', 50], ['C', 30], ['D', 20], ['E', 10], ['F', 9],
      ['G', 8], ['H', 7], ['I', 6], ['J', 5], ['K', 4], ['L', 3],
    ];
    const POPULATION_TOTAL = population.reduce((s, [, v]) => s + v, 0); // 252
    // Step-1 rows (top 10): each row carries the window populationTotal.
    mockQueryRaw.mockResolvedValueOnce(
      population.slice(0, 10).map(([name, v]) => ({
        name, totalAbsNominal: v, populationTotal: POPULATION_TOTAL,
        nominalDeviasi: -v, qtyDeviasi: -Math.round(v / 10), outletCount: 3,
      })),
    );
    // Step-2 rows: 3 outlet children for parent A (population of A = 100 —
    // equal to the window total so shares are checkable by hand).
    mockQueryRaw.mockResolvedValueOnce([
      { parentName: 'A', name: 'out1', label: 'Outlet 1', area: 'X', totalAbsNominal: 60, parentChildPopulationTotal: 100, nominalDeviasi: -60, qtyDeviasi: -6 },
      { parentName: 'A', name: 'out2', label: 'Outlet 2', area: 'X', totalAbsNominal: 30, parentChildPopulationTotal: 100, nominalDeviasi: -30, qtyDeviasi: -3 },
      { parentName: 'A', name: 'out3', label: 'Outlet 3', area: 'X', totalAbsNominal: 10, parentChildPopulationTotal: 100, nominalDeviasi: -10, qtyDeviasi: -1 },
    ]);
    const r = await queryParetoNested('WEEK 1', 'Agustus 2026', {}, 'item', 'outlet', 10);

    // totalAbsNominal = the POPULATION total (252), not the top-10 subtotal (245)
    expect(r.totalAbsNominal).toBe(252);
    expect(r.items).toHaveLength(10);
    // A: 100/252 = 39.7% (would be 40.8% against the 245 subtotal)
    expect(r.items[0].name).toBe('A');
    expect(r.items[0].sharePct).toBe(39.7);
    // Last top-10 row (J=5): cum = 245/252 = 97.2% — NOT the old
    // misleading 100% at the cap row.
    expect(r.items[9].name).toBe('J');
    expect(r.items[9].cumPct).toBe(97.2);
    // Child shares vs the parent's full child population (window column):
    // 60/100, 30/100 → Pareto-80 cutoff keeps the first two children only.
    const children = r.items[0].children;
    expect(children).toHaveLength(2);
    expect(children[0].sharePct).toBe(60);
    expect(children[0].cumPct).toBe(60);
    expect(children[1].sharePct).toBe(30);
    expect(children[1].cumPct).toBe(90);
  });

  it('returns empty items when no parents pass the HAVING filter', async () => {
    mockQueryRaw.mockResolvedValueOnce([]); // step-1: no rows
    const r = await queryParetoNested('WEEK 1', 'M', {}, 'item', 'outlet', 10);
    expect(r.items).toEqual([]);
    expect(r.totalAbsNominal).toBe(0);
    expect(mockQueryRaw).toHaveBeenCalledTimes(1); // step-2 never runs
  });
});
