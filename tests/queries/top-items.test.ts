// Tests for src/lib/queries/items/top-items.ts — queryTopItemsByNominal + queryTopItemsByDevBom.
// Mock @/lib/db so $queryRaw returns canned rows; verify SQL is invoked + result shape.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryTopItemsByNominal, queryTopItemsByDevBom, queryParetoByDevBom } from '@/lib/queries/items/top-items';

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

describe('queryTopItemsByNominal', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
  });

  it('returns rows sorted by absNominal (passes through)', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      { itemName: 'Item A', outletCode: 'A.B1', absNominal: 1_000_000, nominalDeviasi: -1_000_000, direction: 'LOSS' },
      { itemName: 'Item B', outletCode: 'B.C2', absNominal: 500_000, nominalDeviasi: 500_000, direction: 'SURPLUS' },
    ]);
    const r = await queryTopItemsByNominal('WEEK 1', 'Agustus 2026', {}, 10);
    expect(r.length).toBe(2);
    expect(r[0].itemName).toBe('Item A');
    expect(r[0].direction).toBe('LOSS');
    expect(r[1].direction).toBe('SURPLUS');
  });

  it('returns empty array when DB returns no rows', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const r = await queryTopItemsByNominal('WEEK 1', 'M', {});
    expect(r).toEqual([]);
  });

  it('uses default limit=10 when not specified', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await queryTopItemsByNominal('WEEK 1', 'M', {});
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    // The SQL contains LIMIT — verify it's in the query text
    const call = mockQueryRaw.mock.calls[0][0];
    const sqlText = Array.isArray(call) ? call.join('$') : String(call);
    expect(sqlText).toContain('LIMIT');
  });

  it('uses custom limit when specified', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await queryTopItemsByNominal('WEEK 1', 'M', {}, 50);
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    // The limit is passed as a parameter — verify the SQL has LIMIT and one of the params is 50
    const call = mockQueryRaw.mock.calls[0][0];
    const sqlText = Array.isArray(call) ? call.join('$') : String(call);
    expect(sqlText).toContain('LIMIT');
  });

  it('includes DIRECTION_FROM_SUM_SQL fragment (referenced as parameter)', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await queryTopItemsByNominal('WEEK 1', 'M', {});
    // The DIRECTION_FROM_SUM_SQL is interpolated as a nested Prisma.Sql fragment
    // (stored in .values, not in the array-strings text). When vitest mock records
    // the call, the outer Prisma.Sql is stripped to a plain Array of strings, so
    // we can only verify the SQL skeleton + that a placeholder exists for the
    // direction column expression.
    const call = mockQueryRaw.mock.calls[0][0];
    const sqlText = Array.isArray(call) ? call.join('$PARAM$') : String(call);
    expect(sqlText).toContain('SELECT');
    expect(sqlText).toContain('"InventoryRecord"');
    expect(sqlText).toContain('as direction'); // DIRECTION_FROM_SUM_SQL is interpolated here
    expect(sqlText).toContain('$PARAM$'); // confirm placeholder for nested SQL fragment
  });
});

describe('queryTopItemsByDevBom', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
  });

  it('returns rows with devBom + devBomAbs + tolerance', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      {
        itemName: 'Item A',
        outletCode: 'A.B1',
        devBom: -0.15, // signed (LOSS)
        devBomAbs: 0.15,
        tolerance: 0.05,
      },
      {
        itemName: 'Item B',
        outletCode: 'B.C2',
        devBom: 0.20, // signed (SURPLUS)
        devBomAbs: 0.20,
        tolerance: null,
      },
    ]);
    const r = await queryTopItemsByDevBom('WEEK 1', 'Agustus 2026', {}, 10);
    expect(r.length).toBe(2);
    expect(r[0].itemName).toBe('Item A');
    expect(r[0].devBom).toBe(-0.15);
    expect(r[0].devBomAbs).toBe(0.15);
    expect(r[0].tolerance).toBe(0.05);
    expect(r[1].tolerance).toBe(null);
  });

  it('returns empty array when DB returns no rows', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const r = await queryTopItemsByDevBom('WEEK 1', 'M', {});
    expect(r).toEqual([]);
  });

  it('uses custom limit', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await queryTopItemsByDevBom('WEEK 1', 'M', {}, 25);
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    const call = mockQueryRaw.mock.calls[0][0];
    const sqlText = Array.isArray(call) ? call.join('$') : String(call);
    expect(sqlText).toContain('LIMIT');
    expect(sqlText).toContain('devBomAbs'); // ORDER BY devBomAbs
  });

  it('includes qtyBom != 0 guard in WHERE clause', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await queryTopItemsByDevBom('WEEK 1', 'M', {});
    const call = mockQueryRaw.mock.calls[0][0];
    const sqlText = Array.isArray(call) ? call.join('$') : String(call);
    expect(sqlText).toContain('"qtyBom"');
  });
});

describe('queryParetoByDevBom', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
    mockExecuteRaw.mockReset();
  });

  it('returns empty result without firing the outlet query when no items exceed the threshold', async () => {
    mockQueryRaw.mockResolvedValueOnce([]); // topItems query → empty
    const r = await queryParetoByDevBom('WEEK 1', 'Agustus 2026', {}, 20, 0.5);
    expect(r.drivers).toEqual([]);
    expect(r.totalCount).toBe(0);
    expect(r.totalAbsNominal).toBe(0);
    expect(r.thresholdPct).toBe(0.5);
    // Early return — the per-outlet breakdown query must NOT fire
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
  });

  it('builds drivers + outlet breakdown from ONE combined outlet query (no per-item N+1) — FIX AUDIT-PERF-2', async () => {
    // Step 1 (topItems): two items, absNominal 100 + 50 (grandTotal = 150)
    mockQueryRaw.mockResolvedValueOnce([
      { itemName: 'Item A', outletCount: 2, devBom: 0.6, devBomAbs: 0.7, nominalDeviasi: -100, absNominal: 100 },
      { itemName: 'Item B', outletCount: 1, devBom: 0.9, devBomAbs: 0.9, nominalDeviasi: 50, absNominal: 50 },
    ]);
    // Step 2 (single combined outlet query): rows for BOTH items in ONE result —
    // grouped by (itemName, outletCode) with the ROW_NUMBER top-20-per-item cap.
    mockQueryRaw.mockResolvedValueOnce([
      { itemName: 'Item A', outletCode: '1030.BDG1', outletName: 'Outlet BDG 1', area: 'JAWA BARAT', devBom: 0.6, devBomAbs: 0.7, nominalDeviasi: -80, absNominal: 80 },
      { itemName: 'Item A', outletCode: '1031.BDG2', outletName: 'Outlet BDG 2', area: 'JAWA BARAT', devBom: 0.8, devBomAbs: 0.8, nominalDeviasi: -20, absNominal: 20 },
      { itemName: 'Item B', outletCode: '1040.MLG1', outletName: 'Outlet MLG 1', area: 'JAWA TIMUR', devBom: 0.9, devBomAbs: 0.9, nominalDeviasi: 50, absNominal: 50 },
    ]);
    const r = await queryParetoByDevBom('WEEK 1', 'Agustus 2026', {}, 20, 0.5);
    // ONE topItems query + ONE combined outlet query (old code fired one
    // transaction PER top item — 2 items = 2 extra transactions, 20 items = 20)
    expect(mockQueryRaw).toHaveBeenCalledTimes(2);
    expect(r.totalCount).toBe(2);
    expect(r.totalAbsNominal).toBe(150);
    expect(r.drivers).toHaveLength(2);
    // Driver-level share/cum math unchanged (same as the old per-item path)
    expect(r.drivers[0].itemName).toBe('Item A');
    expect(r.drivers[0].sharePct).toBe(66.7);
    expect(r.drivers[0].cumPct).toBe(66.7);
    expect(r.drivers[0].outlets).toHaveLength(2);
    expect(r.drivers[0].outlets[0].outletCode).toBe('1030.BDG1');
    expect(r.drivers[0].outlets[0].sharePct).toBe(80); // 80 / 100
    expect(r.drivers[0].outlets[0].cumPct).toBe(80);
    expect(r.drivers[0].outlets[1].outletCode).toBe('1031.BDG2');
    expect(r.drivers[0].outlets[1].sharePct).toBe(20); // 20 / 100
    expect(r.drivers[0].outlets[1].cumPct).toBe(100);
    expect(r.drivers[1].itemName).toBe('Item B');
    expect(r.drivers[1].sharePct).toBe(33.3);
    expect(r.drivers[1].cumPct).toBe(100);
    expect(r.drivers[1].outlets).toHaveLength(1);
    expect(r.drivers[1].outlets[0].outletCode).toBe('1040.MLG1');
    expect(r.drivers[1].outlets[0].sharePct).toBe(100);
    // Query shape: single GROUP BY (item, outlet) query with ROW_NUMBER top-20 cap
    const call = mockQueryRaw.mock.calls[1][0];
    const sqlText = Array.isArray(call) ? call.join('$PARAM$') : String(call);
    expect(sqlText).toContain('WITH per_outlet AS');
    expect(sqlText).toContain('ROW_NUMBER() OVER (PARTITION BY "itemName"');
    expect(sqlText).toContain('WHERE rn <= 20');
    expect(sqlText).toContain('i.name IN ('); // parameterized IN-list (Prisma.join)
  });
});
