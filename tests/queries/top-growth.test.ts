// Tests for src/lib/queries/growth-drivers.ts — queryTopGrowth
// Mock @/lib/db (same vi.hoisted pattern as growth-drivers.test.ts).
//
// TASK H-7 rewrite: queryTopGrowth fires ONE scan — the (outlet × item)
// DEVIATION matrix carrying BOTH sums per cell:
//   - nd = SUM(nominalDeviasi) SIGNED net (Rp)  → feeds BOTH grains'
//     ranking metric (Δ nominal deviasi, |Δ| ranks, signed displayed)
//     via JS additivity (per-outlet = Σ of its item cells; per-item =
//     Σ of its outlet cells).
//   - qd = SUM(qtyDeviasi) SIGNED net (qty)     → feeds the drill-down
//     contributors' RANKING (|Δ kuantiti deviasi|), each contributor
//     ALSO carrying its Δ nominal ("ada nominal juga").
//
// Mock invocation: a single $queryRaw (its withStatementTimeout
// transaction also fires 1 merged set_config $executeRaw call — FIX
// BUG-3-a P3 merged the two SET LOCALs into one round-trip).
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
// the previous test files): vitest's call recording strips the NESTED CTE
// Prisma.Sql fragments — the recorded arg surfaces as the OUTER template's
// string fragments only. Assertions anchor on outer-template fragments
// (CTE names, COALESCE lines); nested content (the FILTER aggregates,
// table names inside CTEs) is proven behaviorally by the fixture values.
function sqlText(sql: unknown): string {
  if (sql == null) return '';
  if (Array.isArray(sql)) return sql.map((x) => String(x ?? '')).join('');
  return String(sql);
}

// Fixture helper — the row shape the single deviation-matrix scan returns.
function devRow(
  outletName: string,
  itemName: string,
  ndCurr: number,
  ndPrev: number,
  qdCurr: number,
  qdPrev: number,
  unit: string | null,
) {
  return { outletName, itemName, unit, ndCurr, ndPrev, qdCurr, qdPrev };
}

describe('queryTopGrowth (TASK H-7 — nominal-deviasi ranking + qty-deviasi drill-down)', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
    mockExecuteRaw.mockReset();
  });

  it('fires ONE deviation-matrix scan and derives both grains + drill-down + descriptors', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      devRow('RESTO-A', 'AYAM', -900_000, -500_000, -90, -50, 'kg'),
      devRow('RESTO-A', 'CABAI', 300_000, 150_000, 30, 25, 'kg'),
      devRow('RESTO-B', 'GULA', 250_000, 240_000, 0, 0, 'gr'),
    ]);
    const r = await queryTopGrowth('WEEK 2', 'Agustus 2026', 'WEEK 2', 'Juli 2026', {});

    // ONE scan; its withStatementTimeout transaction = 1 merged set_config.
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);

    // Scan routing: the (outlet × item) deviation matrix (curr_agg/prev_agg
    // + the nd/qd coalesce lines in the OUTER template — vitest strips
    // nested CTE fragments, so the FILTER aggregates themselves are proven
    // behaviorally by the devRow fixtures below).
    const matrixSql = sqlText(mockQueryRaw.mock.calls[0]?.[0]);
    expect(matrixSql).toContain('curr_agg');
    expect(matrixSql).toContain('FULL OUTER JOIN prev_agg p');
    expect(matrixSql).toContain('COALESCE(c."outletName", p."outletName") as "outletName"');
    expect(matrixSql).toContain('COALESCE(c.nd, 0) as "ndCurr"');
    expect(matrixSql).toContain('COALESCE(p.nd, 0) as "ndPrev"');
    expect(matrixSql).toContain('COALESCE(c.qd, 0) as "qdCurr"');
    expect(matrixSql).toContain('COALESCE(p.qd, 0) as "qdPrev"');

    // Per Resto — Δ nominal deviasi derived ADDITIVELY from the item cells:
    // RESTO-A curr = −900k + 300k = −600k, prev = −500k + 150k = −350k →
    // Δ = −250.000 SIGNED (|250k| ranks it above RESTO-B's +10.000).
    expect(r.byOutlet.map((x) => x.name)).toEqual(['RESTO-A', 'RESTO-B']);
    expect(r.byOutlet[0]).toMatchObject({
      curr: -600_000, prev: -350_000, delta: -250_000,
      pct: -250_000 / 350_000, isNew: false,
    });
    expect(r.byOutlet[1]).toMatchObject({ curr: 250_000, prev: 240_000, delta: 10_000 });

    // Its drill-down = top barang ranked by |Δ kuantiti deviasi| (AYAM |−40|
    // > CABAI |+5|), each ALSO carrying its Δ nominal.
    expect(r.byOutlet[0].contributors.map((c) => c.name)).toEqual(['AYAM', 'CABAI']);
    expect(r.byOutlet[0].contributors[0]).toMatchObject({
      qtyCurr: -90, qtyPrev: -50, qtyDelta: -40,
      nominalCurr: -900_000, nominalPrev: -500_000, nominalDelta: -400_000,
      isNew: false, unit: 'kg',
    });
    expect(r.byOutlet[0].contributors[1]).toMatchObject({
      qtyDelta: 5, nominalDelta: 150_000, unit: 'kg',
    });

    // Per Barang — Δ nominal deviasi summed across outlets (AYAM |−400k| >
    // CABAI |+150k| > GULA |+10k|). No `unit` on rows — both grains are Rp.
    expect(r.byItem.map((x) => x.name)).toEqual(['AYAM', 'CABAI', 'GULA']);
    expect(r.byItem[0]).toMatchObject({
      curr: -900_000, prev: -500_000, delta: -400_000,
      pct: -400_000 / 500_000, isNew: false,
    });
    expect(r.byItem[0]).not.toHaveProperty('unit');

    // GULA's drill-down = resto contributors; every contributor's unit is
    // the ROW item's satuan ('gr' — GULA's), NOT the contributor's own
    // (a resto has no satuan).
    expect(r.byItem[2].contributors.map((c) => c.name)).toEqual(['RESTO-B']);
    expect(r.byItem[2].contributors[0]).toMatchObject({
      qtyDelta: 0, nominalDelta: 10_000, unit: 'gr', isNew: false,
    });

    // Wrapper contract — always-serialized payload markers.
    expect(r.contributorLimit).toBe(5);
    expect(r.byOutletMetric).toBe('nominalDeviasi');
    expect(r.byItemMetric).toBe('nominalDeviasi');
    expect(r.contributorRankMetric).toBe('qtyDeviasi');
  });

  it('REGRESSION (H-7): both grains rank |Δ nominal deviasi| and expose the SIGNED real value', async () => {
    // The requested contract: "nominal deviasi sum kemudian absolute dan
    // signed nilai asli" — ranking by |Δ|, but the row's delta keeps the
    // real sign (ABS is for ORDERING only, never for the displayed value).
    // RESTO-1's items partially cancel (I1 loss reduced +300k, I2 surplus
    // grew +150k) → outlet Δ +450k; RESTO-2 is a fresh loss −260k → ranked
    // second and displayed NEGATIVE, not as 260.000.
    mockQueryRaw.mockResolvedValueOnce([
      devRow('RESTO-1', 'I1', -100_000, -400_000, -10, -40, 'kg'),
      devRow('RESTO-1', 'I2', 200_000, 50_000, 5, 2, 'kg'),
      devRow('RESTO-2', 'I3', -260_000, 0, -26, 0, 'kg'),
    ]);
    const r = await queryTopGrowth('WEEK 2', 'Agustus 2026', 'WEEK 2', 'Juli 2026', {});

    // Additive derivation: RESTO-1 curr = −100k + 200k = +100k,
    // prev = −400k + 50k = −350k → Δ = +450k (pct = 450/350).
    expect(r.byOutlet.map((x) => x.name)).toEqual(['RESTO-1', 'RESTO-2']);
    expect(r.byOutlet[0]).toMatchObject({ curr: 100_000, prev: -350_000, delta: 450_000, pct: 450_000 / 350_000 });
    // The SIGNED real value — RESTO-2's loss deepened, delta stays negative.
    expect(r.byOutlet[1]).toMatchObject({ delta: -260_000, isNew: true, pct: null });

    // Item grain mirrors the same math per item (|Δ| ranking: I1 300k,
    // I3 260k, I2 150k — the SIGNED deltas below keep their signs).
    expect(r.byItem.map((x) => x.name)).toEqual(['I1', 'I3', 'I2']);
    expect(r.byItem[0]).toMatchObject({ delta: 300_000 });
    expect(r.byItem[1]).toMatchObject({ delta: -260_000 });
    expect(r.byItem[2]).toMatchObject({ delta: 150_000 });
  });

  it('contributors are ranked by |Δ QTY deviasi| (not nominal) and each carries Δ nominal + Baru semantics', async () => {
    // "drill down nya pakai kuantiti deviasi dan ada nominal juga": BIGNOM
    // has by far the biggest NOMINAL move (−300k) but a small qty move (+5)
    // → it must rank BELOW BIGQTY (qty Δ −100, nominal Δ 0). NEWNOM has a
    // nominal base but no qty base → NOT "Baru"; TRUENEW has neither →
    // "Baru".
    mockQueryRaw.mockResolvedValueOnce([
      devRow('RESTO-1', 'BIGQTY', 0, 0, -100, 0, 'kg'),
      devRow('RESTO-1', 'BIGNOM', -300_000, 0, 5, 0, 'kg'),
      devRow('RESTO-1', 'SMALLQTY', 10_000, 5_000, 3, 1, 'kg'),
      devRow('RESTO-1', 'NEWNOM', 0, 8_000, 0, 0, 'kg'),
      devRow('RESTO-1', 'TRUENEW', 7_000, 0, 4, 0, 'pcs'),
    ]);
    const r = await queryTopGrowth('WEEK 2', 'Agustus 2026', 'WEEK 2', 'Juli 2026', {});

    // Outlet row exists (Δ nominal −296k ≥ 1000) — the parent stays NOMINAL.
    expect(r.byOutlet.map((x) => x.name)).toEqual(['RESTO-1']);
    expect(r.byOutlet[0]).toMatchObject({
      curr: -283_000, prev: 13_000, delta: -296_000,
    });

    // Contributor order is the QTY ranking: BIGQTY(|−100|) → BIGNOM(|+5|)
    // → TRUENEW(|+4|) → SMALLQTY(|+2|) → NEWNOM(|0|).
    expect(r.byOutlet[0].contributors.map((c) => c.name)).toEqual([
      'BIGQTY', 'BIGNOM', 'TRUENEW', 'SMALLQTY', 'NEWNOM',
    ]);
    // BIGQTY ranks FIRST on qty even though its nominal Δ is 0.
    expect(r.byOutlet[0].contributors[0]).toMatchObject({ qtyDelta: -100, nominalDelta: 0, unit: 'kg' });
    // BIGNOM ranks SECOND despite the biggest nominal move — and carries it.
    expect(r.byOutlet[0].contributors[1]).toMatchObject({ qtyDelta: 5, nominalDelta: -300_000, isNew: true });
    // "Baru" = no deviation base of EITHER kind in the compare period.
    expect(r.byOutlet[0].contributors[2]).toMatchObject({ qtyDelta: 4, nominalDelta: 7_000, isNew: true, unit: 'pcs' });
    expect(r.byOutlet[0].contributors[3]).toMatchObject({ qtyDelta: 2, nominalDelta: 5_000, isNew: false });
    expect(r.byOutlet[0].contributors[4]).toMatchObject({ qtyDelta: 0, nominalDelta: -8_000, isNew: false });
  });

  it('thresholds: |Δ nominal| ≥ 1000 Rp BOTH grains; boundary kept; noise dropped; 15-row & 5-contributor caps', async () => {
    // 14 items in RESTO-1 with nominal deltas 14jt → 1jt (qd deltas 14 → 1);
    // BOUND-I has |Δ| exactly 1000 (boundary → KEPT in both grains);
    // NOISE-I has |Δ| 999 (→ dropped from BOTH grains — the grains now
    // share one metric and one threshold).
    const rows = Array.from({ length: 14 }, (_, i) =>
      devRow('RESTO-1', `G${String(i + 1).padStart(2, '0')}`, (14 - i) * 1_000_000, 0, 14 - i, 0, 'kg'));
    rows.push(devRow('RESTO-BOUND', 'BOUND-I', 1_000, 0, 1, 0, 'kg'));
    rows.push(devRow('RESTO-NOISE', 'NOISE-I', 999, 0, 1, 0, 'kg'));

    mockQueryRaw.mockResolvedValueOnce(rows);
    const r = await queryTopGrowth('WEEK 2', 'Agustus 2026', 'WEEK 2', 'Juli 2026', {});

    // Item grain: 15 slots = G01..G14 + BOUND-I (1000 boundary kept);
    // NOISE-I (999) dropped by the threshold, G16+ impossible (only 14).
    expect(r.byItem.length).toBe(15);
    expect(r.byItem.map((x) => x.name)).not.toContain('NOISE-I');
    expect(r.byItem.map((x) => x.name)).toContain('BOUND-I');
    expect(r.byItem[0]).toMatchObject({ name: 'G01', delta: 14_000_000, isNew: true, pct: null });

    // Outlet grain: RESTO-1 (Σ = 105jt) + RESTO-BOUND (1000 boundary);
    // RESTO-NOISE (999) dropped.
    expect(r.byOutlet.map((x) => x.name)).toEqual(['RESTO-1', 'RESTO-BOUND']);
    expect(r.byOutlet[0]).toMatchObject({ delta: 105_000_000 });
    expect(r.byOutlet[1]).toMatchObject({ delta: 1_000, isNew: true });

    // Contributor cap: RESTO-1's 14 barang → top 5 by |Δ qty| (G01..G05).
    expect(r.byOutlet[0].contributors.length).toBe(5);
    expect(r.byOutlet[0].contributors.map((c) => c.name)).toEqual(['G01', 'G02', 'G03', 'G04', 'G05']);
    expect(r.byOutlet[0].contributors[0]).toMatchObject({ qtyDelta: 14, nominalDelta: 14_000_000 });
  });

  it('skips rows without names (FULL OUTER JOIN null edge)', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      { outletName: null, itemName: 'AYAM', unit: 'kg', ndCurr: -500_000, ndPrev: 0, qdCurr: -5, qdPrev: 0 },
      { outletName: 'RESTO-1', itemName: null, unit: 'kg', ndCurr: -500_000, ndPrev: 0, qdCurr: -5, qdPrev: 0 },
    ]);
    const r = await queryTopGrowth('WEEK 2', 'Agustus 2026', 'WEEK 2', 'Juli 2026', {});
    expect(r.byOutlet).toEqual([]);
    expect(r.byItem).toEqual([]);
    // Empty result still carries the always-serialized marker fields.
    expect(r.contributorLimit).toBe(5);
    expect(r.byOutletMetric).toBe('nominalDeviasi');
    expect(r.byItemMetric).toBe('nominalDeviasi');
    expect(r.contributorRankMetric).toBe('qtyDeviasi');
  });

  it('no compare period → every row and contributor is "Baru" (prev 0)', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      devRow('RESTO-1', 'AYAM', -900_000, 0, -90, 0, 'kg'),
    ]);
    const r = await queryTopGrowth('WEEK 2', 'Agustus 2026', null, null, {});

    expect(r.byOutlet.map((x) => x.name)).toEqual(['RESTO-1']);
    expect(r.byOutlet[0]).toMatchObject({ delta: -900_000, pct: null, isNew: true });
    expect(r.byItem.map((x) => x.name)).toEqual(['AYAM']);
    expect(r.byItem[0]).toMatchObject({ delta: -900_000, pct: null, isNew: true });
    expect(r.byItem[0].contributors[0]).toMatchObject({
      name: 'RESTO-1', qtyDelta: -90, nominalDelta: -900_000, isNew: true,
    });
  });
});
