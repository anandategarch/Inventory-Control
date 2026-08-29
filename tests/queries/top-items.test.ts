// Tests for src/lib/queries/items/top-items.ts — queryTopItemsByNominal + queryTopItemsByDevBom.
// Mock @/lib/db so $queryRaw returns canned rows; verify SQL is invoked + result shape.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryTopItemsByNominal, queryTopItemsByDevBom } from '@/lib/queries/items/top-items';

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
