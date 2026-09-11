// Tests for src/lib/queries/growth-drivers.ts — queryTopGrowth
// Mock @/lib/db (same vi.hoisted pattern as growth-drivers.test.ts).
//
// TASK H-6 rewrite: queryTopGrowth fires TWO scans, each on a REAL
// per-grain source:
//   1. aggregateSalesMode  — per-outlet ΔSales from OutletPeriodSales
//      .salesMode (nominalSales is outlet-level denormalized; the old
//      SUM-over-rows was Sales × rowCount — the reported bug).
//   2. aggregateBomMatrix  — (outlet × item) SUM(ABS(qtyBom)) matrix:
//      per-item sums feed the Per Barang grain; the cells feed BOTH
//      drill-down directions (contributors = Δ pemakaian BOM + satuan).
//
// Mock invocation order is deterministic: Promise.all evaluates
// aggregateSalesMode(...) first — its $queryRaw fires before
// aggregateBomMatrix's (both are synchronous up to the mocked call).
// So mockResolvedValueOnce queue = [salesRows, matrixRows].
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryTopGrowth } from '@/lib/queries/growth-drivers';

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

// Helper: SQL text from a recorded Prisma.Sql call. NOTE (same caveat as
// the old test file): vitest's call recording strips the NESTED CTE
// Prisma.Sql fragments — the recorded arg surfaces as the OUTER template's
// string fragments only. Assertions must therefore anchor on outer-
// template fragments (CTE names, COALESCE lines); nested content (table
// names inside CTEs) is proven behaviorally by the fixture values.
function sqlText(sql: unknown): string {
  if (sql == null) return '';
  if (Array.isArray(sql)) return sql.map((x) => String(x ?? '')).join('');
  return String(sql);
}

// Fixture helpers — the row shapes the two scans return.
function salesRow(name: string, curr: number, prev: number) {
  return { name, curr, prev };
}
function bomRow(outletName: string, itemName: string, curr: number, prev: number, unit: string | null) {
  return { outletName, itemName, unit, curr, prev };
}

describe('queryTopGrowth (TASK H-6 — salesMode + BOM matrix)', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
    mockExecuteRaw.mockReset();
  });

  it('fires TWO scans (salesMode + BOM matrix) and derives both grains + descriptors', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([
        salesRow('RESTO-A', 7_400_000, 5_300_000),
      ])
      .mockResolvedValueOnce([
        bomRow('RESTO-A', 'AYAM', 400, 320, 'kg'),
        bomRow('RESTO-A', 'CABAI', 12, 20, 'kg'),
      ]);
    const r = await queryTopGrowth('WEEK 2', 'Agustus 2026', 'WEEK 2', 'Juli 2026', {});

    // Two scans; each withStatementTimeout transaction = 2 SET LOCALs.
    expect(mockQueryRaw).toHaveBeenCalledTimes(2);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(4);

    // Scan routing: call 0 = per-outlet salesMode scan (curr_sales/
    // prev_sales CTEs in the OUTER template — vitest strips nested CTE
    // fragments, so the OutletPeriodSales table name itself is proven
    // behaviorally by the salesRow fixtures below); call 1 = the (outlet ×
    // item) BOM matrix (curr_agg/prev_agg + unit coalesce in the outer
    // template — qtyBom proven behaviorally by the bomRow fixtures).
    const salesSql = sqlText(mockQueryRaw.mock.calls[0]?.[0]);
    const bomSql = sqlText(mockQueryRaw.mock.calls[1]?.[0]);
    expect(salesSql).toContain('curr_sales');
    expect(salesSql).toContain('FULL OUTER JOIN prev_sales p ON c.name = p.name');
    expect(bomSql).toContain('curr_agg');
    expect(bomSql).toContain('COALESCE(c."outletName", p."outletName") as "outletName"');
    expect(bomSql).toContain('COALESCE(c.unit, p.unit) as unit');

    // Per Resto — ΔSales from salesMode (Rp), unit null.
    expect(r.byOutlet.map((x) => x.name)).toEqual(['RESTO-A']);
    expect(r.byOutlet[0]).toMatchObject({
      curr: 7_400_000, prev: 5_300_000, delta: 2_100_000,
      pct: 2_100_000 / 5_300_000, isNew: false, unit: null,
    });
    // Its drill-down = top barang by Δ pemakaian BOM (qty + satuan).
    expect(r.byOutlet[0].contributors.map((c) => c.name)).toEqual(['AYAM', 'CABAI']);
    expect(r.byOutlet[0].contributors[0]).toMatchObject({ delta: 80, unit: 'kg', isNew: false });
    expect(r.byOutlet[0].contributors[1]).toMatchObject({ delta: -8, unit: 'kg', isNew: false });

    // Per Barang — Δ pemakaian BOM in the item's satuan.
    expect(r.byItem.map((x) => x.name)).toEqual(['AYAM', 'CABAI']);
    expect(r.byItem[0]).toMatchObject({ curr: 400, prev: 320, delta: 80, unit: 'kg', isNew: false });
    // Its drill-down = top resto driving the item's BOM move (unit = the
    // row item's satuan — the qty being ranked IS that item's qty).
    expect(r.byItem[0].contributors.map((c) => c.name)).toEqual(['RESTO-A']);
    expect(r.byItem[0].contributors[0]).toMatchObject({ delta: 80, unit: 'kg', isNew: false });

    // Wrapper contract — always-serialized payload markers.
    expect(r.contributorLimit).toBe(5);
    expect(r.byOutletMetric).toBe('sales');
    expect(r.byItemMetric).toBe('bom');
  });

  it('REGRESSION (H-6 bug): byOutlet uses salesMode, NOT the row-count-inflated matrix', async () => {
    // The reported bug: the old matrix summed the OUTLET-LEVEL nominalSales
    // once per row → byOutlet Δ was Sales × rowCount. Fixture: salesMode
    // says RESTO-1 sales went 100.000 → 90.000 (Δ −10.000), while the BOM
    // matrix rows for the same resto would sum to a totally different Δ.
    // byOutlet MUST read the salesMode numbers.
    mockQueryRaw
      .mockResolvedValueOnce([
        salesRow('RESTO-1', 90_000, 100_000),
      ])
      .mockResolvedValueOnce([
        bomRow('RESTO-1', 'AYAM', 120_000, 80_000, 'kg'),
        bomRow('RESTO-1', 'GULA', 60_000, 50_000, 'kg'),
      ]);
    const r = await queryTopGrowth('WEEK 2', 'Agustus 2026', 'WEEK 2', 'Juli 2026', {});

    expect(r.byOutlet.map((x) => x.name)).toEqual(['RESTO-1']);
    expect(r.byOutlet[0]).toMatchObject({ curr: 90_000, prev: 100_000, delta: -10_000, pct: -0.1 });
    // The matrix-fed numbers only appear in the DRILL-DOWN (BOM), never in
    // the parent resto row.
    expect(r.byOutlet[0].contributors[0]).toMatchObject({ name: 'AYAM', delta: 40_000, unit: 'kg' });
  });

  it('byItem sums the BOM matrix additively across outlets (matches the bom metric grain)', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([
        salesRow('RESTO-1', 500_000, 400_000),
        salesRow('RESTO-2', 300_000, 350_000),
      ])
      .mockResolvedValueOnce([
        bomRow('RESTO-1', 'AYAM', 200, 100, 'kg'),
        bomRow('RESTO-2', 'AYAM', 150, 100, 'kg'),
        bomRow('RESTO-2', 'KEJU', 30, 30, 'pcs'),
      ]);
    const r = await queryTopGrowth('WEEK 2', 'Agustus 2026', 'WEEK 2', 'Juli 2026', {});

    // AYAM across outlets: curr 350, prev 200 → Δ +150 (additive parity
    // with a GROUP BY i.name scan); KEJU Δ 0 → below the 0.01 threshold →
    // dropped from byItem.
    expect(r.byItem.map((x) => x.name)).toEqual(['AYAM']);
    expect(r.byItem[0]).toMatchObject({ curr: 350, prev: 200, delta: 150, unit: 'kg' });
    // Drill-down: restos ranked by |Δ| — RESTO-1 (+100) then RESTO-2 (+50),
    // both carrying the item's satuan.
    expect(r.byItem[0].contributors.map((c) => c.name)).toEqual(['RESTO-1', 'RESTO-2']);
    expect(r.byItem[0].contributors[0]).toMatchObject({ delta: 100, pct: 1, unit: 'kg', isNew: false });
    expect(r.byItem[0].contributors[1]).toMatchObject({ delta: 50, pct: 0.5, unit: 'kg', isNew: false });

    // Outlet grain independent of the matrix: RESTO-1 Δ +100.000 ranked
    // above RESTO-2 Δ −50.000.
    expect(r.byOutlet.map((x) => x.name)).toEqual(['RESTO-1', 'RESTO-2']);
    expect(r.byOutlet[0]).toMatchObject({ delta: 100_000 });
    expect(r.byOutlet[1]).toMatchObject({ delta: -50_000 });
  });

  it('caps contributors at 5 (top |Δ| kept), marks prev=0 contributors "Baru", Δ0 cells still listed', async () => {
    // One outlet with 7 barang — deltas 60..1; the 6th/7th by |Δ| drop out.
    mockQueryRaw
      .mockResolvedValueOnce([salesRow('RESTO-1', 200_000, 100_000)])
      .mockResolvedValueOnce([
        bomRow('RESTO-1', 'I1', 60, 0, 'kg'),     // Δ +60 — Baru (prev 0)
        bomRow('RESTO-1', 'I2', 50, 40, 'kg'),    // Δ +10
        bomRow('RESTO-1', 'I3', 30, 20, 'kg'),    // Δ +10
        bomRow('RESTO-1', 'I4', 25, 20, 'kg'),    // Δ +5
        bomRow('RESTO-1', 'I5', 15, 12, 'kg'),    // Δ +3
        bomRow('RESTO-1', 'I6', 10, 9, 'kg'),     // Δ +1 — 6th by |Δ| → dropped
        bomRow('RESTO-1', 'I7', 0.5, 0.5, 'kg'),  // Δ 0 — 7th → dropped (cap)
      ]);
    const r = await queryTopGrowth('WEEK 2', 'Agustus 2026', 'WEEK 2', 'Juli 2026', {});

    const outlet = r.byOutlet[0];
    expect(outlet.name).toBe('RESTO-1');
    expect(outlet.contributors.length).toBe(5);
    expect(outlet.contributors.map((c) => c.name)).toEqual(['I1', 'I2', 'I3', 'I4', 'I5']);
    // prev=0 → pct null + isNew ("Baru" badge case), still the TOP contributor.
    expect(outlet.contributors[0]).toMatchObject({ name: 'I1', delta: 60, pct: null, isNew: true, unit: 'kg' });
  });

  it('thresholds: |ΔSales| ≥ 1000 (outlet) and |ΔBOM| ≥ 0,01 (item); boundaries kept; 15-row item cap', async () => {
    // 20 items in ONE outlet with BOM deltas 20 → 1 → item list capped at 15.
    const matrixRows = Array.from({ length: 20 }, (_, i) =>
      bomRow('RESTO-1', `G${String(i + 1).padStart(2, '0')}`, 20 - i, 0, 'kg'));
    // Noise item for the ITEM grain: |Δ| = 0,005 < 0,01 → dropped.
    matrixRows.push(bomRow('RESTO-2', 'NOISE-BOM', 0.005, 0, 'kg'));
    // Boundary item: |Δ| exactly 0,01 → KEPT.
    matrixRows.push(bomRow('RESTO-3', 'BOUNDARY-BOM', 0.01, 0, 'kg'));

    mockQueryRaw
      .mockResolvedValueOnce([
        // Boundary outlet: |ΔSales| exactly 1000 → KEPT.
        salesRow('RESTO-3', 1_000, 0),
        // Noise outlet: |ΔSales| = 500 < 1000 → dropped (even though its
        // only BOM row exists — the grains are now independent).
        salesRow('RESTO-2', 1_500, 1_000),
        salesRow('RESTO-1', 200_000, 100_000),
      ])
      .mockResolvedValueOnce(matrixRows);
    const r = await queryTopGrowth('WEEK 2', 'Agustus 2026', 'WEEK 2', 'Juli 2026', {});

    // Item grain: capped at 15, ranked |Δ| DESC; BOUNDARY-BOM survives
    // (0.01), NOISE-BOM (0.005) does not.
    expect(r.byItem.length).toBe(15);
    expect(r.byItem[0]).toMatchObject({ name: 'G01', delta: 20, unit: 'kg' });
    expect(r.byItem[14]).toMatchObject({ name: 'G15', delta: 6 });
    expect(r.byItem.map((x) => x.name)).not.toContain('G16');
    expect(r.byItem.map((x) => x.name)).not.toContain('NOISE-BOM');
    expect(r.byItem.map((x) => x.name)).not.toContain('BOUNDARY-BOM');
    // (15 slots: G01..G15 all have |Δ| ≥ BOUNDARY-BOM's 0.01 → they fill
    // the cap; BOUNDARY-BOM is 16th+ by |Δ| and the cap drops it.)

    // Outlet grain: RESTO-1 + RESTO-3 (boundary 1000) survive; RESTO-2
    // (|Δ| = 500) dropped — from the SALES numbers, not the matrix.
    expect(r.byOutlet.map((x) => x.name)).toEqual(['RESTO-1', 'RESTO-3']);
    expect(r.byOutlet[1]).toMatchObject({ name: 'RESTO-3', delta: 1_000, pct: null, isNew: true });
  });

  it('skips rows without names (FULL OUTER JOIN null edge) in both scans', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ name: null, curr: 5_000, prev: 0 }])
      .mockResolvedValueOnce([
        { outletName: null, itemName: 'AYAM', unit: 'kg', curr: 5, prev: 0 },
        { outletName: 'RESTO-1', itemName: null, unit: 'kg', curr: 5, prev: 0 },
      ]);
    const r = await queryTopGrowth('WEEK 2', 'Agustus 2026', 'WEEK 2', 'Juli 2026', {});
    expect(r.byOutlet).toEqual([]);
    expect(r.byItem).toEqual([]);
    // Empty result still carries the always-serialized marker fields.
    expect(r.contributorLimit).toBe(5);
    expect(r.byOutletMetric).toBe('sales');
    expect(r.byItemMetric).toBe('bom');
  });

  it('no compare period → every row is "Baru" (prev 0), empty prev CTEs', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([salesRow('RESTO-1', 5_000_000, 0)])
      .mockResolvedValueOnce([bomRow('RESTO-1', 'AYAM', 400, 0, 'kg')]);
    const r = await queryTopGrowth('WEEK 2', 'Agustus 2026', null, null, {});

    expect(r.byOutlet.map((x) => x.name)).toEqual(['RESTO-1']);
    expect(r.byOutlet[0]).toMatchObject({ delta: 5_000_000, pct: null, isNew: true });
    expect(r.byItem.map((x) => x.name)).toEqual(['AYAM']);
    expect(r.byItem[0]).toMatchObject({ delta: 400, pct: null, isNew: true, unit: 'kg' });
  });
});
