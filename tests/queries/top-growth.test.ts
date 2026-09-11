// Tests for src/lib/queries/growth-drivers.ts — queryTopGrowth
// Mock @/lib/db (same vi.hoisted pattern as growth-drivers.test.ts);
// verify the two aggregateMetric SQL invocations (outlet + item grain)
// + the pure-JS shaping: |delta| DESC sort, signed pct, "Baru" rows,
// |Δ| >= 1000 noise threshold, and the 15-row cap.
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

// Helper: SQL text from a recorded Prisma.Sql call.
// When vitest records the call, the outer Prisma.Sql surfaces as a plain
// Array of string fragments (same helper shape as areas.test.ts /
// top-items.test.ts) — join with a sentinel so param boundaries are visible.
function callText(index: number): string {
  const call = mockQueryRaw.mock.calls[index]?.[0];
  if (Array.isArray(call)) return call.join('$PARAM$');
  const s = (call as unknown as { strings?: unknown[] } | undefined)?.strings;
  if (Array.isArray(s)) return s.join('$PARAM$');
  return String(call);
}

describe('queryTopGrowth', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
    mockExecuteRaw.mockReset();
  });

  it('fires aggregateMetric twice — outlet grain first, item grain second — via withStatementTimeout', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ name: 'OUTLET-ROW', curr: 5_000, prev: 0 }]);
    mockQueryRaw.mockResolvedValueOnce([{ name: 'ITEM-ROW', curr: 5_000, prev: 0 }]);
    const r = await queryTopGrowth('WEEK 2', 'Agustus 2026', 'WEEK 2', 'Juli 2026', {});

    expect(mockQueryRaw).toHaveBeenCalledTimes(2);
    // Both invocations carry aggregateMetric's signature outer SQL
    // (curr/prev CTEs combined through a FULL OUTER JOIN). The per-grain
    // JOIN/group fragments live in the nested CTE Prisma.Sql fragments,
    // which vitest's call recording strips — the grain routing is proven
    // behaviorally by the fixture order below instead.
    for (let i = 0; i < 2; i++) {
      const text = callText(i);
      expect(text).toContain('curr_agg');
      expect(text).toContain('prev_agg');
      expect(text).toContain('FULL OUTER JOIN prev_agg p ON c.name = p.name');
      expect(text).toContain('COALESCE(c.name, p.name) as name');
    }
    // aggregateMetric wraps every query in withStatementTimeout → one
    // $transaction per query, 2 SET LOCAL statements each
    // (statement_timeout + work_mem) → 2 queries × 2 SETs = 4 executeRaw.
    expect(mockExecuteRaw).toHaveBeenCalledTimes(4);

    // Grain routing: the 1st $queryRaw resolved byOutlet's fixture, the 2nd
    // byItem's — proving call order outlet → item.
    expect(r.byOutlet.map((x) => x.name)).toEqual(['OUTLET-ROW']);
    expect(r.byItem.map((x) => x.name)).toEqual(['ITEM-ROW']);
  });

  it('sorts by |delta| DESC in both grains and computes SIGNED pct = (curr−prev)/|prev|', async () => {
    // Outlet fixture — deliberately out of |delta| order; B has the biggest
    // |delta| even though it is a DECLINE (sorting is by magnitude, not sign).
    mockQueryRaw.mockResolvedValueOnce([
      { name: 'A', curr: 120_000, prev: 100_000 }, // Δ +20.000, pct +0,2
      { name: 'B', curr: 60_000, prev: 100_000 },  // Δ −40.000, pct −0,4
      { name: 'C', curr: 210_000, prev: 200_000 }, // Δ +10.000, pct +0,05
    ]);
    mockQueryRaw.mockResolvedValueOnce([
      { name: 'AYAM', curr: 2_000_000, prev: 1_500_000 }, // Δ +500.000, pct +1/3
      { name: 'CABAI', curr: 900_000, prev: 1_000_000 },  // Δ −100.000, pct −0,1
    ]);
    const r = await queryTopGrowth('WEEK 2', 'Agustus 2026', 'WEEK 2', 'Juli 2026', {});

    // byOutlet: ranked by |Δ| DESC → B (40k) > A (20k) > C (10k)
    expect(r.byOutlet.map((x) => x.name)).toEqual(['B', 'A', 'C']);
    // Signed delta + signed pct (denominator |prev|, sign preserved)
    expect(r.byOutlet[0]).toMatchObject({ curr: 60_000, prev: 100_000, delta: -40_000, pct: -0.4, isNew: false });
    expect(r.byOutlet[1]).toMatchObject({ delta: 20_000, pct: 0.2, isNew: false });
    expect(r.byOutlet[2]).toMatchObject({ delta: 10_000, pct: 0.05, isNew: false });

    // byItem: same rule
    expect(r.byItem.map((x) => x.name)).toEqual(['AYAM', 'CABAI']);
    expect(r.byItem[0]).toMatchObject({ delta: 500_000, pct: 500_000 / 1_500_000, isNew: false });
    expect(r.byItem[1]).toMatchObject({ delta: -100_000, pct: -0.1, isNew: false });
  });

  it('marks prev=0 rows as new (pct null → "Baru") and filters noise below |Δ| >= 1000 (boundary kept)', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      // Noise: |Δ| = 500 < 1000 → dropped.
      { name: 'NOISE', curr: 1_500, prev: 1_000 },
      // Boundary: |Δ| = exactly 1000 → KEPT (threshold is >=).
      { name: 'BOUNDARY', curr: 1_000, prev: 0 },
      // New outlet: prev = 0 → pct null + isNew true, still ranked by |Δ|.
      { name: 'RESTO BARU', curr: 50_000, prev: 0 },
      // Zero-zero group → Δ 0 → dropped as noise.
      { name: 'ZERO', curr: 0, prev: 0 },
    ]);
    mockQueryRaw.mockResolvedValueOnce([]);
    const r = await queryTopGrowth('WEEK 2', 'Agustus 2026', 'WEEK 2', 'Juli 2026', {});

    expect(r.byOutlet.map((x) => x.name)).toEqual(['RESTO BARU', 'BOUNDARY']);
    expect(r.byOutlet[0]).toMatchObject({ delta: 50_000, pct: null, isNew: true });
    expect(r.byOutlet[1]).toMatchObject({ delta: 1_000, pct: null, isNew: true });
    expect(r.byOutlet.every((x) => x.pct === null && x.isNew === true)).toBe(true);
    // Item grain empty (mock returned no rows) — not a crash.
    expect(r.byItem).toEqual([]);
  });

  it('caps each list at 15 rows (top |Δ| kept, smallest dropped)', async () => {
    // 20 groups, deltas 20.000 → 1.000 (all pass the threshold).
    const rows = Array.from({ length: 20 }, (_, i) => ({
      name: `G${String(i + 1).padStart(2, '0')}`,
      curr: (20 - i) * 1_000,
      prev: 0,
    }));
    mockQueryRaw.mockResolvedValueOnce(rows);
    mockQueryRaw.mockResolvedValueOnce(rows);
    const r = await queryTopGrowth('WEEK 2', 'Agustus 2026', 'WEEK 2', 'Juli 2026', {});

    expect(r.byOutlet.length).toBe(15);
    expect(r.byItem.length).toBe(15);
    // Largest |Δ| first; the 5 smallest (Δ 5.000 … 1.000) are dropped.
    expect(r.byOutlet[0].name).toBe('G01');
    expect(r.byOutlet[0].delta).toBe(20_000);
    expect(r.byOutlet[14].name).toBe('G15');
    expect(r.byOutlet[14].delta).toBe(6_000);
    expect(r.byOutlet.map((x) => x.name)).not.toContain('G16');
    expect(r.byOutlet.map((x) => x.name)).not.toContain('G20');
  });

  it('skips rows without a group name (FULL OUTER JOIN null edge / bad fixture shape)', async () => {
    // aggregateMetric maps r.name — rows whose group name is null are skipped
    // (mirrors the guard inside aggregateMetric; also documents why fixtures
    // keyed as {groupName,...} produce empty maps).
    mockQueryRaw.mockResolvedValueOnce([
      { groupName: 'WRONG-KEY', curr: 5_000, prev: 0 },
      { name: null, curr: 5_000, prev: 0 },
    ]);
    mockQueryRaw.mockResolvedValueOnce([]);
    const r = await queryTopGrowth('WEEK 2', 'Agustus 2026', 'WEEK 2', 'Juli 2026', {});
    expect(r.byOutlet).toEqual([]);
    expect(r.byItem).toEqual([]);
  });
});
