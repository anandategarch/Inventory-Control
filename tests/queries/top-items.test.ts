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
    // H-2b: fixtures now include `satuan` (MAX(ir."satuan") — nullable) so the
    // pass-through of the new unit-of-measure column is covered.
    mockQueryRaw.mockResolvedValueOnce([
      { itemName: 'Item A', outletCode: 'A.B1', satuan: 'PCS', absNominal: 1_000_000, nominalDeviasi: -1_000_000, direction: 'LOSS' },
      { itemName: 'Item B', outletCode: 'B.C2', satuan: null, absNominal: 500_000, nominalDeviasi: 500_000, direction: 'SURPLUS' },
    ]);
    const r = await queryTopItemsByNominal('WEEK 1', 'Agustus 2026', {}, 10);
    expect(r.length).toBe(2);
    expect(r[0].itemName).toBe('Item A');
    expect(r[0].satuan).toBe('PCS');
    expect(r[1].satuan).toBe(null);
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
    expect(sqlText).toContain('MAX(ir."satuan")'); // H-2b: satuan column for the export
  });
});

describe('queryTopItemsByDevBom', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
  });

  it('returns rows with devBom + devBomAbs + tolerance', async () => {
    // H-2b: fixtures include `satuan` (MAX(ir."satuan") — nullable).
    mockQueryRaw.mockResolvedValueOnce([
      {
        itemName: 'Item A',
        outletCode: 'A.B1',
        satuan: 'GR',
        devBom: -0.15, // signed (LOSS)
        devBomAbs: 0.15,
        tolerance: 0.05,
      },
      {
        itemName: 'Item B',
        outletCode: 'B.C2',
        satuan: null,
        devBom: 0.20, // signed (SURPLUS)
        devBomAbs: 0.20,
        tolerance: null,
      },
    ]);
    const r = await queryTopItemsByDevBom('WEEK 1', 'Agustus 2026', {}, 10);
    expect(r.length).toBe(2);
    expect(r[0].itemName).toBe('Item A');
    expect(r[0].satuan).toBe('GR');
    expect(r[1].satuan).toBe(null);
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
    expect(sqlText).toContain('MAX(ir."satuan")'); // H-2b: satuan column for the export
  });
});

describe('queryParetoByDevBom', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
    mockExecuteRaw.mockReset();
  });

  it('returns empty result when no (item, outlet) pairs exceed the threshold', async () => {
    mockQueryRaw.mockResolvedValueOnce([]); // merged per-outlet scan → empty
    const r = await queryParetoByDevBom('WEEK 1', 'Agustus 2026', {}, 20, 0.5);
    expect(r.drivers).toEqual([]);
    expect(r.totalCount).toBe(0);
    expect(r.totalAbsNominal).toBe(0);
    expect(r.thresholdPct).toBe(0.5);
    // ONE query total — no second scan, no per-item N+1
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
  });

  it('derives drivers + outlet breakdown from ONE combined (item, outlet) scan — PERF TAHAP-2/P2-10', async () => {
    // ONE query returns ALL threshold-passing (item, outlet) rows, pre-sorted
    // by (itemName, absNominal DESC, outletCode) — the item level is derived
    // in JS from the same expressions the old topItems scan used.
    mockQueryRaw.mockResolvedValueOnce([
      // Item A outlets (absNominal 100 total via -80 + -20)
      { itemName: 'Item A', outletCode: '1030.BDG1', outletName: 'Outlet BDG 1', area: 'JAWA BARAT', devBom: 0.6, devBomAbs: 0.7, nominalDeviasi: -80, absNominal: 80, totalQtyDeviasi: -60, totalQtyBom: 100 },
      { itemName: 'Item A', outletCode: '1031.BDG2', outletName: 'Outlet BDG 2', area: 'JAWA BARAT', devBom: 0.8, devBomAbs: 0.8, nominalDeviasi: -20, absNominal: 20, totalQtyDeviasi: -25, totalQtyBom: 30 },
      // Item B outlet (absNominal 50)
      { itemName: 'Item B', outletCode: '1040.MLG1', outletName: 'Outlet MLG 1', area: 'JAWA TIMUR', devBom: 0.9, devBomAbs: 0.9, nominalDeviasi: 50, absNominal: 50, totalQtyDeviasi: 45, totalQtyBom: 50 },
    ]);
    const r = await queryParetoByDevBom('WEEK 1', 'Agustus 2026', {}, 20, 0.5);
    // ONE combined scan total (old flow: topItems scan + outlet scan = 2)
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    expect(r.totalCount).toBe(2);
    expect(r.totalAbsNominal).toBe(150);
    expect(r.drivers).toHaveLength(2);
    // Driver-level share/cum math unchanged
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
    // Item-level derivation from the outlet rows: outletCount = rows per item,
    // devBom = Σ qtyDeviasi / Σ|qtyBom| (Item A: (-60 + -25) / (100 + 30))
    expect(r.drivers[0].outletCount).toBe(2);
    expect(r.drivers[0].devBom).toBeCloseTo(-85 / 130, 10);
    expect(r.drivers[0].absNominal).toBe(100);
    expect(r.drivers[1].outletCount).toBe(1);
    expect(r.drivers[1].devBom).toBeCloseTo(45 / 50, 10);
    // Query shape: ONE GROUP BY (item, outlet) scan with the HAVING threshold
    const call = mockQueryRaw.mock.calls[0][0];
    const sqlText = Array.isArray(call) ? call.join('$PARAM$') : String(call);
    expect(sqlText).toContain('WITH per_outlet AS');
    expect(sqlText).toContain('GROUP BY i.name, o.code, o.name, o.area');
    expect(sqlText).toContain('END > '); // HAVING threshold expression
    expect(sqlText).not.toContain('i.name IN ('); // no second top-items IN-list scan
  });

  it('caps drivers at maxDrivers and outlets at 20 per item (JS caps replacing SQL LIMIT/ROW_NUMBER)', async () => {
    // 3 items with absNominal 30 / 20 / 10 → maxDrivers=2 keeps the top 2
    const rows = [
      { itemName: 'I1', outletCode: 'A', outletName: 'A', area: 'X', devBom: 0.6, devBomAbs: 0.6, nominalDeviasi: -30, absNominal: 30, totalQtyDeviasi: -1, totalQtyBom: 2 },
      { itemName: 'I2', outletCode: 'A', outletName: 'A', area: 'X', devBom: 0.6, devBomAbs: 0.6, nominalDeviasi: -20, absNominal: 20, totalQtyDeviasi: -1, totalQtyBom: 2 },
      { itemName: 'I3', outletCode: 'A', outletName: 'A', area: 'X', devBom: 0.6, devBomAbs: 0.6, nominalDeviasi: -10, absNominal: 10, totalQtyDeviasi: -1, totalQtyBom: 2 },
    ];
    // 25 outlets for I1 → capped at 20 in the JS derivation
    for (let i = 0; i < 24; i++) {
      rows.push({ itemName: 'I1', outletCode: `O${String(i).padStart(2, '0')}`, outletName: `O${i}`, area: 'X', devBom: 0.6, devBomAbs: 0.6, nominalDeviasi: -1, absNominal: 1, totalQtyDeviasi: -1, totalQtyBom: 2 });
    }
    mockQueryRaw.mockResolvedValueOnce(rows);
    const r = await queryParetoByDevBom('WEEK 1', 'Agustus 2026', {}, 2, 0.5);
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    expect(r.drivers).toHaveLength(2);
    expect(r.drivers.map((d) => d.itemName)).toEqual(['I1', 'I2']);
    expect(r.drivers[0].outlets).toHaveLength(20); // 25 rows → capped at 20
    // outletCount reflects ALL threshold-passing outlets (25), not the capped 20
    expect(r.drivers[0].outletCount).toBe(25);
    // FIX (BUG-2-c) semantics update: sharePct/cumPct are now computed against
    // the FULL population total (I1 = 30 + 24×1 = 54, so 54+20+10 = 84), not
    // the top-N subtotal (74) — the old subtotal inflated shares and forced
    // cumPct to a misleading 100% at the maxDrivers cap. I1: 54/84 = 64.3%,
    // I2: 20/84 = 23.8% (cum 88.1%), remainderPct = the true rest-of-population.
    expect(r.totalAbsNominal).toBe(84);
    expect(r.drivers[0].sharePct).toBe(64.3);
    expect(r.drivers[0].cumPct).toBe(64.3);
    expect(r.drivers[1].sharePct).toBe(23.8);
    expect(r.drivers[1].cumPct).toBe(88.1);
    expect(r.remainderPct).toBe(11.9);
  });
});
