// Tests for src/lib/queries/growth-drivers.ts — queryTopGrowth
// Mock @/lib/db (same vi.hoisted pattern as growth-drivers.test.ts);
// TASK H-5: queryTopGrowth now fires ONE (outlet × item) matrix scan
// (aggregateSalesMatrix) instead of two per-grain scans — verify the
// single SQL invocation + the pure-JS shaping: per-grain sum derivation
// from the matrix, |delta| DESC sort, signed pct, "Baru" rows,
// |Δ| >= 1000 noise threshold, 15-row cap, AND the drill-down
// `contributors` (top-5 sub-grain movers per row, both directions)
// + contributorLimit.
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

// Matrix row fixture helper — the shape aggregateSalesMatrix returns.
function row(outletName: string, itemName: string, curr: number, prev: number) {
  return { outletName, itemName, curr, prev };
}

describe('queryTopGrowth (TASK H-5 — matrix + drill-down contributors)', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
    mockExecuteRaw.mockReset();
  });

  it('fires ONE matrix query (outlet × item grain) via withStatementTimeout', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      row('OUTLET-A', 'AYAM', 5_000, 0),
    ]);
    const r = await queryTopGrowth('WEEK 2', 'Agustus 2026', 'WEEK 2', 'Juli 2026', {});

    // H-5: 2 per-grain scans collapsed into ONE (outlet × item) matrix scan.
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    const text = callText(0);
    expect(text).toContain('curr_agg');
    expect(text).toContain('prev_agg');
    expect(text).toContain('FULL OUTER JOIN prev_agg p');
    expect(text).toContain('COALESCE(c."outletName", p."outletName") as "outletName"');
    expect(text).toContain('COALESCE(c."itemName", p."itemName") as "itemName"');
    // NOTE: the GROUP BY o.name, i.name fragment lives in the nested CTE
    // Prisma.Sql fragments which vitest's call recording strips (same caveat
    // as the old per-grain test) — the matrix routing is proven behaviorally
    // by the fixtures below (byOutlet + byItem both derived from one call).
    // withStatementTimeout → one $transaction + 2 SET LOCAL statements.
    expect(mockExecuteRaw).toHaveBeenCalledTimes(2);

    expect(r.byOutlet.map((x) => x.name)).toEqual(['OUTLET-A']);
    expect(r.byItem.map((x) => x.name)).toEqual(['AYAM']);
    expect(r.contributorLimit).toBe(5);
  });

  it('derives BOTH grain sums from the matrix (additive SUM(ABS) parity)', async () => {
    // Same outlet across two items + same item across two outlets — the
    // per-grain totals must equal the sum of the matrix cells.
    mockQueryRaw.mockResolvedValueOnce([
      row('RESTO-1', 'AYAM', 120_000, 100_000),   // Δ +20.000
      row('RESTO-1', 'CABAI', 40_000, 80_000),    // Δ −40.000 → RESTO-1 total Δ −20.000
      row('RESTO-2', 'AYAM', 90_000, 100_000),    // Δ −10.000
    ]);
    const r = await queryTopGrowth('WEEK 2', 'Agustus 2026', 'WEEK 2', 'Juli 2026', {});

    // RESTO-1: curr 160.000, prev 180.000 → Δ −20.000 (magnitude 20k)
    // RESTO-2: Δ −10.000 → byOutlet ranked |Δ| DESC: RESTO-1, RESTO-2.
    expect(r.byOutlet.map((x) => x.name)).toEqual(['RESTO-1', 'RESTO-2']);
    expect(r.byOutlet[0]).toMatchObject({ curr: 160_000, prev: 180_000, delta: -20_000, pct: -20_000 / 180_000, isNew: false });
    // AYAM: curr 210.000, prev 200_000 → Δ +10.000; CABAI: Δ −40.000.
    expect(r.byItem.map((x) => x.name)).toEqual(['CABAI', 'AYAM']);
    expect(r.byItem[0]).toMatchObject({ curr: 40_000, prev: 80_000, delta: -40_000, pct: -0.5, isNew: false });
    expect(r.byItem[1]).toMatchObject({ delta: 10_000, pct: 10_000 / 200_000, isNew: false });
  });

  it('byOutlet rows drill into top ITEMS; byItem rows drill into top OUTLETS', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      row('RESTO-1', 'AYAM', 200_000, 100_000),   // item Δ +100.000
      row('RESTO-1', 'CABAI', 60_000, 100_000),   // item Δ −40.000
      row('RESTO-1', 'KEJU', 30_000, 30_000),     // item Δ 0 (still a contributor candidate)
      row('RESTO-2', 'AYAM', 150_000, 100_000),   // outlet Δ +50.000 for RESTO-2
    ]);
    const r = await queryTopGrowth('WEEK 2', 'Agustus 2026', 'WEEK 2', 'Juli 2026', {});

    // RESTO-1 total Δ = +60.000 (biggest outlet mover); RESTO-2 Δ = +50.000.
    expect(r.byOutlet.map((x) => x.name)).toEqual(['RESTO-1', 'RESTO-2']);

    // Drill-down direction 1 — outlet row → ITEMS driving it, top |Δ| first.
    expect(r.byOutlet[0].contributors.map((c) => c.name)).toEqual(['AYAM', 'CABAI', 'KEJU']);
    expect(r.byOutlet[0].contributors[0]).toMatchObject({ name: 'AYAM', curr: 200_000, prev: 100_000, delta: 100_000, pct: 1, isNew: false });
    expect(r.byOutlet[0].contributors[1]).toMatchObject({ name: 'CABAI', delta: -40_000, pct: -0.4, isNew: false });
    // Δ 0 item still listed (contributors have NO noise threshold).
    expect(r.byOutlet[0].contributors[2]).toMatchObject({ name: 'KEJU', delta: 0, pct: 0, isNew: false });
    // RESTO-2's only item:
    expect(r.byOutlet[1].contributors.map((c) => c.name)).toEqual(['AYAM']);

    // Drill-down direction 2 — item row → OUTLETS driving it.
    // AYAM total Δ = +150.000; contributors ranked RESTO-1 (+100k) then RESTO-2 (+50k).
    expect(r.byItem.map((x) => x.name)).toEqual(['AYAM', 'CABAI']);
    expect(r.byItem[0].contributors.map((c) => c.name)).toEqual(['RESTO-1', 'RESTO-2']);
    expect(r.byItem[0].contributors[0]).toMatchObject({ delta: 100_000, pct: 1, isNew: false });
    expect(r.byItem[0].contributors[1]).toMatchObject({ delta: 50_000, pct: 0.5, isNew: false });
  });

  it('caps contributors at 5 (top |Δ| kept) and marks prev=0 contributors "Baru"', async () => {
    // One outlet with 6 items — deltas 60k..10k all positive; +1 brand-new item.
    const rows = [
      row('RESTO-1', 'I1', 60_000, 0),
      row('RESTO-1', 'I2', 50_000, 40_000),   // Δ +10.000
      row('RESTO-1', 'I3', 30_000, 20_000),   // Δ +10.000
      row('RESTO-1', 'I4', 25_000, 20_000),   // Δ +5.000
      row('RESTO-1', 'I5', 15_000, 12_000),   // Δ +3.000
      row('RESTO-1', 'I6', 10_000, 9_000),    // Δ +1.000 — 6th by |Δ| → dropped from contributors
      row('RESTO-1', 'I7', 900, 0),           // Δ +900 — 7th by |Δ| → dropped
    ];
    mockQueryRaw.mockResolvedValueOnce(rows);
    const r = await queryTopGrowth('WEEK 2', 'Agustus 2026', 'WEEK 2', 'Juli 2026', {});

    const outlet = r.byOutlet[0];
    expect(outlet.name).toBe('RESTO-1');
    expect(outlet.contributors.length).toBe(5);
    expect(outlet.contributors.map((c) => c.name)).toEqual(['I1', 'I2', 'I3', 'I4', 'I5']);
    // prev=0 → pct null + isNew (the "Baru" badge case), still the TOP contributor.
    expect(outlet.contributors[0]).toMatchObject({ name: 'I1', delta: 60_000, pct: null, isNew: true });
  });

  it('sorts rows by |delta| DESC, filters noise below |Δ| >= 1000 (boundary kept), caps 15', async () => {
    // 20 items inside ONE outlet (deltas 20.000 → 1.000 all pass) → item list
    // capped at 15; the outlet row itself aggregates them all.
    const rows = Array.from({ length: 20 }, (_, i) =>
      row('RESTO-1', `G${String(i + 1).padStart(2, '0')}`, (20 - i) * 1_000, 0));
    // Noise row for the ITEM grain: |Δ| = 500 < 1000 → dropped.
    rows.push(row('RESTO-2', 'NOISE', 1_500, 1_000));
    // Boundary: |Δ| = exactly 1000 → KEPT.
    rows.push(row('RESTO-3', 'BOUNDARY', 1_000, 0));
    mockQueryRaw.mockResolvedValueOnce(rows);
    const r = await queryTopGrowth('WEEK 2', 'Agustus 2026', 'WEEK 2', 'Juli 2026', {});

    expect(r.byItem.length).toBe(15);
    expect(r.byItem[0].name).toBe('G01');
    expect(r.byItem[0].delta).toBe(20_000);
    expect(r.byItem[14].name).toBe('G15');
    expect(r.byItem[14].delta).toBe(6_000);
    expect(r.byItem.map((x) => x.name)).not.toContain('G16');
    expect(r.byItem.map((x) => x.name)).not.toContain('NOISE');
    expect(r.byItem.map((x) => x.name)).not.toContain('BOUNDARY');
    // BOUNDARY (Δ exactly 1000) survives in the OUTLET grain (outlet RESTO-3).
    expect(r.byOutlet.map((x) => x.name)).toEqual(['RESTO-1', 'RESTO-3']);
    expect(r.byOutlet[1]).toMatchObject({ name: 'RESTO-3', delta: 1_000, pct: null, isNew: true });
    // RESTO-2's only item is NOISE (|Δ| = 500) → outlet total also 500 → dropped.
    expect(r.byOutlet.map((x) => x.name)).not.toContain('RESTO-2');
  });

  it('skips matrix rows without outlet/item names (FULL OUTER JOIN null edge)', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      { outletName: null, itemName: 'AYAM', curr: 5_000, prev: 0 },
      { outletName: 'RESTO-1', itemName: null, curr: 5_000, prev: 0 },
      { groupName: 'WRONG-KEY', curr: 5_000, prev: 0 },
    ]);
    const r = await queryTopGrowth('WEEK 2', 'Agustus 2026', 'WEEK 2', 'Juli 2026', {});
    expect(r.byOutlet).toEqual([]);
    expect(r.byItem).toEqual([]);
    // Empty result still carries the always-serialized marker field.
    expect(r.contributorLimit).toBe(5);
  });

  it('empty matrix → both lists empty, contributorLimit still present', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const r = await queryTopGrowth('WEEK 2', 'Agustus 2026', null, null, {});
    expect(r.byOutlet).toEqual([]);
    expect(r.byItem).toEqual([]);
    // Every row shape includes contributors: [] — vacuously true here, but
    // the wrapper contract (contributorLimit always serialized) is what the
    // payload-shape guard anchors on.
    expect(r.contributorLimit).toBe(5);
  });
});
