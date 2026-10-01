// Tests for src/lib/queries/waste/waste-top-items/ (DEEP-WASTE-1 —
// "Top Item Waste" Pareto + sistematik + Item×Outlet breakdown;
// W3-EXEC — the 4th quadrant round trip).
//
// Covers:
//  1. isSistematikWasteItem (pure) — monthsActive ≥ ceil(ACTUAL windowMonths/2)
//     AND ≥ 2 outlets (BUGHUNT-R1 FIX 2: the window is a parameter, not the
//     12-month cap — boundary cases for window 9 → threshold 5).
//  2. buildWasteTopItems (pure) — share + cumulative share of the population,
//     sistematik flag (window-aware), per-outlet breakdown sorted + capped at
//     8 with shareOfItem, empty input shape, windowMonths passthrough + the
//     additive W3 null defaults (quadrant fields filled by the query edge).
//  3. queryWasteTopItems — month derivation runs FIRST (BUGHUNT-R1 FIX 9) and
//     yields monthKeys + windowMonths; the item + breakdown + W3 distribution
//     rounds filter on the materialized IN list (no months CTE rebuild), SQL
//     pins the SAME weekLabel + inclusive window, aggregates ΣABS nominalWaste,
//     counts DISTINCT outlet/month with waste > 0 (FIX 1 — FILTER clause),
//     pivots last/prev month inline, breakdown restricted to the top-N item
//     ids, lastMonthKey/prevMonthKey/windowMonths wired from the month round;
//     W3 round = GROUP BY (item, outlet) with NO cap + BOM>0 flag, quadrant
//     fields + summary merged additively onto the result.
//
// Mock @/lib/db (same vi.hoisted pattern as waste-series.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  WASTE_TOP_ITEMS_WINDOW_MONTHS,
  WASTE_TOP_ITEMS_OUTLET_BREAKDOWN_LIMIT,
  isSistematikWasteItem,
  buildWasteTopItems,
  queryWasteTopItems,
} from '@/lib/queries/waste/waste-top-items';

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

function deepText(x: unknown): string {
  if (x == null) return '';
  if (Array.isArray(x)) return x.map(deepText).join('');
  if (typeof x === 'object' && 'strings' in (x as Record<string, unknown>)) {
    const { strings, values } = x as { strings: unknown[]; values?: unknown[] };
    let out = '';
    strings.forEach((s, i) => {
      out += String(s ?? '');
      if (values && i < values.length) out += deepText(values[i]);
    });
    return out;
  }
  return String(x);
}

function itemRow(overrides: Partial<Record<string, number | bigint | string | null>> = {}) {
  return {
    itemId: 1,
    itemName: 'KULIT PISANG',
    satuan: 'PCS',
    totalWaste: 100,
    wasteQty: 500,
    // W11 (additive) — neutral defaults; individual tests override to
    // build fingerprint/susut/trial fixtures.
    totalSusut: 0,
    susutQty: 0,
    totalTrial: 0,
    trialQty: 0,
    bomQty: 0,
    trialMonthsActive: 0,
    susutPopulationTotal: 0,
    trialPopulationTotal: 0,
    outletsActive: 3,
    monthsActive: 7,
    lastMonthWaste: 40,
    prevMonthWaste: 60,
    populationTotal: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  mockQueryRaw.mockReset();
  mockExecuteRaw.mockReset();
});

// ------------------------------------------------------------
// 1. isSistematikWasteItem
// ------------------------------------------------------------

describe('isSistematikWasteItem', () => {
  it('requires ≥ ceil(windowMonths/2) months AND ≥ 2 outlets (explicit window)', () => {
    expect(isSistematikWasteItem(6, 2, 12)).toBe(true);   // 6 ≥ ceil(12/2)
    expect(isSistematikWasteItem(5, 2, 12)).toBe(false);  // 5 < 6
    expect(isSistematikWasteItem(6, 1, 12)).toBe(false);  // single outlet
    expect(isSistematikWasteItem(12, 20, 12)).toBe(true);
  });

  it('BUGHUNT-R1 FIX 2: live windows below the 12-month cap lower the threshold', () => {
    // Window 9 (e.g. Jan–Sep data) → ceil(9/2) = 5 — the old hardcoded 6
    // required the cap itself, unreachable on a 9-month window.
    expect(isSistematikWasteItem(5, 2, 9)).toBe(true);
    expect(isSistematikWasteItem(4, 2, 9)).toBe(false);
    // Window 8 → ceil(8/2) = 4.
    expect(isSistematikWasteItem(4, 3, 8)).toBe(true);
    expect(isSistematikWasteItem(3, 3, 8)).toBe(false);
  });

  it('defaults to the 12-month cap when no window is passed (back-compat)', () => {
    expect(isSistematikWasteItem(6, 2)).toBe(true);
    expect(isSistematikWasteItem(5, 2)).toBe(false);
  });
});

// ------------------------------------------------------------
// 2. buildWasteTopItems
// ------------------------------------------------------------

describe('buildWasteTopItems', () => {
  it('computes share + cumulative share against the population + window-aware sistematik', () => {
    const result = buildWasteTopItems(
      [
        itemRow({ itemId: 1, totalWaste: 500 }),
        itemRow({ itemId: 2, totalWaste: 300 }),
        itemRow({ itemId: 3, totalWaste: 200, monthsActive: 2 }),
      ],
      [],
      12,
    );
    expect(result.populationTotal).toBe(1000);
    expect(result.windowMonths).toBe(12);
    expect(result.items).toHaveLength(3);
    expect(result.items[0].share).toBeCloseTo(0.5, 10);
    expect(result.items[0].cumulativeShare).toBeCloseTo(0.5, 10);
    expect(result.items[1].cumulativeShare).toBeCloseTo(0.8, 10);
    expect(result.items[2].cumulativeShare).toBeCloseTo(1.0, 10);
    expect(result.items[0].sistematik).toBe(true);   // 7 months, 3 outlets
    expect(result.items[2].sistematik).toBe(false);  // 2 months
  });

  it('BUGHUNT-R1 FIX 2: an 8-month window flags 4 active months as sistematik', () => {
    // monthsActive 4 with cap 12 → NOT sistematik; with the ACTUAL window 8
    // (ceil(8/2) = 4) → sistematik. Same input rows, different window param.
    const rows = [itemRow({ monthsActive: 4, outletsActive: 5 })];
    expect(buildWasteTopItems(rows, [], 12).items[0].sistematik).toBe(false);
    expect(buildWasteTopItems(rows, [], 8).items[0].sistematik).toBe(true);
  });

  it('guards share when populationTotal is 0', () => {
    const result = buildWasteTopItems(
      [itemRow({ totalWaste: 0, populationTotal: 0 })],
      [],
    );
    expect(result.items[0].share).toBe(0);
    expect(result.items[0].cumulativeShare).toBe(0);
  });

  it('sorts + caps the per-outlet breakdown at 8 with shareOfItem', () => {
    const breakdown = Array.from({ length: 10 }, (_, i) => ({
      itemId: 1,
      outletCode: `OUT${i}`,
      outletName: `Outlet ${i}`,
      area: 'AREA',
      waste: 100 - i * 10,
      // W11 (additive): per-outlet susut/trial companions (zeros — this
      // test pins the DEFAULT waste sort + cap).
      susut: 0,
      trial: 0,
      monthsActive: 3,
    }));
    // OUT0 = 100 (top), OUT1 = 90, … OUT9 = 10 — cap keeps OUT0..OUT7.
    const result = buildWasteTopItems([itemRow({ itemId: 1, totalWaste: 1000 })], breakdown);
    expect(result.items[0].byOutlet).toHaveLength(WASTE_TOP_ITEMS_OUTLET_BREAKDOWN_LIMIT);
    expect(result.items[0].byOutlet[0].outletCode).toBe('OUT0');
    expect(result.items[0].byOutlet[0].shareOfItem).toBeCloseTo(0.1, 10);
    expect(result.items[0].byOutlet[7].outletCode).toBe('OUT7');
  });

  it('empty input → empty result carrying the window + null quadrant defaults', () => {
    const result = buildWasteTopItems([], [], 9);
    expect(result.items).toEqual([]);
    expect(result.populationTotal).toBe(0);
    expect(result.lastMonthKey).toBeNull();
    expect(result.prevMonthKey).toBeNull();
    expect(result.windowMonths).toBe(9);
    // W3 additive defaults: the pure builder leaves quadrant null — only the
    // query edge (with the distribution round) fills it.
    expect(result.quadrant).toBeNull();
    expect(result.items.every((i) => i.quadrant === null)).toBe(true);
  });
});

// ------------------------------------------------------------
// 3. queryWasteTopItems
// ------------------------------------------------------------

describe('queryWasteTopItems', () => {
  it('derives months FIRST, then item + breakdown + W3 distribution rounds filter on the IN list (FIX 9) with waste-based counts (FIX 1)', async () => {
    // Round 0 — month derivation (8-month live window, most recent first).
    mockQueryRaw.mockResolvedValueOnce([
      { monthKey: '2026-08' },
      { monthKey: '2026-07' },
      { monthKey: '2026-06' },
      { monthKey: '2026-05' },
      { monthKey: '2026-04' },
      { monthKey: '2026-03' },
      { monthKey: '2026-02' },
      { monthKey: '2026-01' },
    ]);
    mockQueryRaw.mockResolvedValueOnce([
      itemRow({ itemId: 1, totalWaste: BigInt(500), wasteQty: BigInt(1200), outletsActive: BigInt(3), monthsActive: BigInt(7), populationTotal: BigInt(1000) }),
    ]);
    mockQueryRaw.mockResolvedValueOnce([
      { itemId: 1, outletCode: 'A', outletName: 'Outlet A', area: 'AREA', waste: BigInt(500), monthsActive: BigInt(7) },
    ]);
    // Round 3 (W3) — full per-(item, outlet) distribution. 3 outlets with
    // waste (matching round 1's outletsActive=3) + 1 record-presence-only
    // outlet WITHOUT BOM (hasBom 0) that the prevalence denominator must
    // exclude (FIX 1 discipline: usage basis, not record presence).
    mockQueryRaw.mockResolvedValueOnce([
      { itemId: 1, outletId: 10, waste: BigInt(250), hasBom: 1 },
      { itemId: 1, outletId: 11, waste: BigInt(150), hasBom: 1 },
      { itemId: 1, outletId: 12, waste: BigInt(100), hasBom: 1 },
      { itemId: 1, outletId: 13, waste: BigInt(0), hasBom: 0 },
    ]);

    const result = await queryWasteTopItems('WEEK 4', '2026-08', {}, 20);

    expect(mockQueryRaw).toHaveBeenCalledTimes(4);
    // Round 0 = the month-derivation query (cheapest first — FIX 9).
    const monthSql = deepText(mockQueryRaw.mock.calls[0]);
    expect(monthSql).toContain('ir."weekLabel" =');
    expect(monthSql).toContain('<=');
    expect(monthSql).toContain(String(WASTE_TOP_ITEMS_WINDOW_MONTHS));

    const itemSql = deepText(mockQueryRaw.mock.calls[1]);
    expect(itemSql).toContain('ir."weekLabel" =');
    expect(itemSql).toContain('ABS(ir."nominalWaste")');
    // FIX 1: distinct outlet/month counts are FILTERed on waste > 0.
    expect(itemSql).toContain('COUNT(DISTINCT ir."outletId") FILTER (WHERE ABS(ir."nominalWaste") > 0)');
    expect(itemSql).toContain('COUNT(DISTINCT sf."monthKey") FILTER (WHERE ABS(ir."nominalWaste") > 0)');
    // FIX 9: the month set arrives as a parameter IN list, not a months CTE.
    expect(itemSql).toContain('sf."monthKey" IN (');
    expect(itemSql).not.toContain('WITH months');
    expect(itemSql).toContain('SUM(ia."totalWaste") OVER ()');

    const breakdownSql = deepText(mockQueryRaw.mock.calls[2]);
    expect(breakdownSql).toContain('ir."itemId" IN (');
    expect(breakdownSql).toContain('sf."monthKey" IN (');
    expect(breakdownSql).toContain('COUNT(DISTINCT sf."monthKey") FILTER (WHERE ABS(ir."nominalWaste") > 0)');
    expect(breakdownSql).toContain('GROUP BY ir."itemId", o.code, o.name, ir.area');
    expect(breakdownSql).not.toContain('WITH months');

    // W3 round: same window/week/filter pinning + NO cap + the BOM>0 flag.
    const distributionSql = deepText(mockQueryRaw.mock.calls[3]);
    expect(distributionSql).toContain('ir."weekLabel" =');
    expect(distributionSql).toContain('sf."monthKey" IN (');
    expect(distributionSql).toContain('ir."itemId" IN (');
    expect(distributionSql).toContain('SUM(ABS(ir."nominalWaste"))');
    expect(distributionSql).toContain('ABS(ir."qtyBom") > 0');
    expect(distributionSql).toContain('GROUP BY ir."itemId", ir."outletId"');
    // No cap on the distribution — HHI needs the FULL outlet tail.
    expect(distributionSql).not.toContain('LIMIT');
    expect(distributionSql).not.toContain('WITH months');

    expect(result.items).toHaveLength(1);
    expect(result.items[0].totalWaste).toBe(500);
    expect(result.items[0].wasteQty).toBe(1200);
    expect(result.items[0].outletsActive).toBe(3);
    expect(result.items[0].byOutlet).toHaveLength(1);
    expect(result.items[0].byOutlet[0].waste).toBe(500);
    expect(result.lastMonthKey).toBe('2026-08');
    expect(result.prevMonthKey).toBe('2026-07');
    // FIX 2: the ACTUAL window size rides on the result (8 here, not the 12 cap).
    expect(result.windowMonths).toBe(8);
    // monthsActive 7 ≥ ceil(8/2) = 4 → sistematik under the live window.
    expect(result.items[0].sistematik).toBe(true);

    // W3 additive fields: prevalence 3 active / 3 BOM outlets (outlet 13
    // without BOM excluded from the denominator) = 1.0 → widespread;
    // persistence 7/8 ≥ ceil(8/2)=4 months → persistent → SISTEMIK.
    // HHI null (3 active outlets < 10 guard); paretoK null (the single
    // item's cumulativeShare 0.5 never reaches 0.8).
    expect(result.items[0].quadrant).toEqual({
      quadrantClass: 'SISTEMIK',
      prevalence: 1,
      outletsWithBom: 3,
      persistence: 0.875,
      hhi: null,
    });
    expect(result.quadrant).toEqual({
      persistenceThresholdMonths: 4,
      paretoK: null,
      classCounts: { SISTEMIK: 1, MUSIMAN: 0, 'LOKAL-KRONIS': 0, INSIDEN: 0 },
      windowMonths: 8,
    });
  });

  it('short-circuits to ONE query when the window has no months (empty scope)', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const result = await queryWasteTopItems('WEEK 4', '2026-08', { area: 'NOWHERE' }, 20);
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    expect(result.items).toEqual([]);
    expect(result.populationTotal).toBe(0);
    expect(result.windowMonths).toBe(0);
    expect(result.quadrant).toBeNull();
  });

  it('stops after 2 queries when months exist but no items match', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ monthKey: '2026-08' }, { monthKey: '2026-07' }]);
    mockQueryRaw.mockResolvedValueOnce([]);
    const result = await queryWasteTopItems('WEEK 4', '2026-08', {}, 20);
    expect(mockQueryRaw).toHaveBeenCalledTimes(2);
    expect(result.items).toEqual([]);
    expect(result.lastMonthKey).toBe('2026-08');
    expect(result.prevMonthKey).toBe('2026-07');
    expect(result.windowMonths).toBe(2);
    expect(result.quadrant).toBeNull();
  });

  it('fires the merged set_config round-trip via withStatementTimeout', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await queryWasteTopItems('WEEK 4', null, {}, 20);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    expect(deepText(mockExecuteRaw.mock.calls[0])).toContain('set_config');
  });
});
