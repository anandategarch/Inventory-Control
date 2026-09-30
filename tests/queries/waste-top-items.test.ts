// Tests for src/lib/queries/waste/waste-top-items.ts (DEEP-WASTE-1 —
// "Top Item Waste" Pareto + sistematik + Item×Outlet breakdown).
//
// Covers:
//  1. isSistematikWasteItem (pure) — ≥ half the window months AND ≥ 2 outlets.
//  2. buildWasteTopItems (pure) — share + cumulative share of the population,
//     sistematik flag, per-outlet breakdown sorted + capped at 8 with
//     shareOfItem, empty input shape.
//  3. queryWasteTopItems — three query rounds (items + breakdown + window
//     months), SQL pins the SAME weekLabel + inclusive window + 12-month cap,
//     aggregates ΣABS nominalWaste + COUNT DISTINCT outlet/month, pivots
//     last/prev month inline, breakdown restricted to the top-N item ids,
//     lastMonthKey/prevMonthKey wired from the month scan.
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
  it('requires ≥ half the window months AND ≥ 2 outlets', () => {
    expect(isSistematikWasteItem(6, 2)).toBe(true);   // 6 ≥ ceil(12/2)
    expect(isSistematikWasteItem(5, 2)).toBe(false);  // 5 < 6
    expect(isSistematikWasteItem(6, 1)).toBe(false);  // single outlet
    expect(isSistematikWasteItem(12, 20)).toBe(true);
  });
});

// ------------------------------------------------------------
// 2. buildWasteTopItems
// ------------------------------------------------------------

describe('buildWasteTopItems', () => {
  it('computes share + cumulative share against the population + sistematik', () => {
    const result = buildWasteTopItems(
      [
        itemRow({ itemId: 1, totalWaste: 500 }),
        itemRow({ itemId: 2, totalWaste: 300 }),
        itemRow({ itemId: 3, totalWaste: 200, monthsActive: 2 }),
      ],
      [],
    );
    expect(result.populationTotal).toBe(1000);
    expect(result.items).toHaveLength(3);
    expect(result.items[0].share).toBeCloseTo(0.5, 10);
    expect(result.items[0].cumulativeShare).toBeCloseTo(0.5, 10);
    expect(result.items[1].cumulativeShare).toBeCloseTo(0.8, 10);
    expect(result.items[2].cumulativeShare).toBeCloseTo(1.0, 10);
    expect(result.items[0].sistematik).toBe(true);   // 7 months, 3 outlets
    expect(result.items[2].sistematik).toBe(false);  // 2 months
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
      monthsActive: 3,
    }));
    // OUT0 = 100 (top), OUT1 = 90, … OUT9 = 10 — cap keeps OUT0..OUT7.
    const result = buildWasteTopItems([itemRow({ itemId: 1, totalWaste: 1000 })], breakdown);
    expect(result.items[0].byOutlet).toHaveLength(WASTE_TOP_ITEMS_OUTLET_BREAKDOWN_LIMIT);
    expect(result.items[0].byOutlet[0].outletCode).toBe('OUT0');
    expect(result.items[0].byOutlet[0].shareOfItem).toBeCloseTo(0.1, 10);
    expect(result.items[0].byOutlet[7].outletCode).toBe('OUT7');
  });

  it('empty input → empty result', () => {
    const result = buildWasteTopItems([], []);
    expect(result.items).toEqual([]);
    expect(result.populationTotal).toBe(0);
    expect(result.lastMonthKey).toBeNull();
    expect(result.prevMonthKey).toBeNull();
  });
});

// ------------------------------------------------------------
// 3. queryWasteTopItems
// ------------------------------------------------------------

describe('queryWasteTopItems', () => {
  it('runs 3 query rounds; item SQL pins week + window + caps 12 + counts distinct outlet/month', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      itemRow({ itemId: 1, totalWaste: BigInt(500), wasteQty: BigInt(1200), outletsActive: BigInt(3), monthsActive: BigInt(7), populationTotal: BigInt(1000) }),
    ]);
    mockQueryRaw.mockResolvedValueOnce([
      { itemId: 1, outletCode: 'A', outletName: 'Outlet A', area: 'AREA', waste: BigInt(500), monthsActive: BigInt(7) },
    ]);
    mockQueryRaw.mockResolvedValueOnce([
      { monthKey: '2026-08' },
      { monthKey: '2026-07' },
    ]);

    const result = await queryWasteTopItems('WEEK 4', '2026-08', {}, 20);

    expect(mockQueryRaw).toHaveBeenCalledTimes(3);
    const itemSql = deepText(mockQueryRaw.mock.calls[0]);
    expect(itemSql).toContain('ir."weekLabel" =');
    expect(itemSql).toContain('<=');
    expect(itemSql).toContain(String(WASTE_TOP_ITEMS_WINDOW_MONTHS));
    expect(itemSql).toContain('ABS(ir."nominalWaste")');
    expect(itemSql).toContain('COUNT(DISTINCT ir."outletId")');
    expect(itemSql).toContain('COUNT(DISTINCT sf."monthKey")');
    expect(itemSql).toContain('last_month');
    expect(itemSql).toContain('prev_month');
    expect(itemSql).toContain('SUM(ia."totalWaste") OVER ()');

    const breakdownSql = deepText(mockQueryRaw.mock.calls[1]);
    expect(breakdownSql).toContain('ir."itemId" IN (');
    expect(breakdownSql).toContain('GROUP BY ir."itemId", o.code, o.name, ir.area');

    expect(result.items).toHaveLength(1);
    expect(result.items[0].totalWaste).toBe(500);
    expect(result.items[0].wasteQty).toBe(1200);
    expect(result.items[0].outletsActive).toBe(3);
    expect(result.items[0].byOutlet).toHaveLength(1);
    expect(result.items[0].byOutlet[0].waste).toBe(500);
    expect(result.lastMonthKey).toBe('2026-08');
    expect(result.prevMonthKey).toBe('2026-07');
  });

  it('short-circuits to ONE query when no items match (empty scope)', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const result = await queryWasteTopItems('WEEK 4', '2026-08', { area: 'NOWHERE' }, 20);
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    expect(result.items).toEqual([]);
    expect(result.populationTotal).toBe(0);
  });

  it('fires the merged set_config round-trip via withStatementTimeout', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await queryWasteTopItems('WEEK 4', null, {}, 20);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    expect(deepText(mockExecuteRaw.mock.calls[0])).toContain('set_config');
  });
});
