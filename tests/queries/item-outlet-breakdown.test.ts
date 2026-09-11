// Tests for src/lib/queries/items/item-outlet-breakdown.ts (H-12 drilldown
// trio merge) + the nested-Pareto twin-merge adapters (H-12).
//
// WHY THIS FILE EXISTS: the H-12 SQL-capture dry-run caught a REAL bug class
// the type system cannot see — `buildSqlFilters` fragments start with `AND`
// and carry NO leading whitespace (the legacy per-query templates supplied
// the separator via the literal `\n      ` before the `${f}` slot). Any
// composed template that interpolates fragments ADJACENTLY must carry an
// explicit separator space, or the rendered SQL is invalid (`> 0AND ir.area`
// → Postgres syntax error at runtime, 500s on every drilldown with an active
// filter).
//
// These tests capture the composed SQL text (NO DB) for the 3 refactored
// callers (queryItemAnomaliOutlets, queryFlipDrilldown, queryHeatmapCellDetail)
// and queryParetoNested, then assert:
//   1. JUNCTION SAFETY — no keyword glued to the previous token, in BOTH
//      directions of every optional fragment (no filters / with filters,
//      extraWhere present — the exact matrix that produced the bug).
//   2. STRUCTURE — the invariant parts each caller promised to keep
//      (exact `i.name = ?` match, PIC join on/off, month prefix match,
//      GROUP BY column set, ORDER BY, LIMIT).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryItemAnomaliOutlets } from '@/lib/queries/items/item-anomali-outlets';
import { queryFlipDrilldown } from '@/lib/queries/items/flip-drilldown';
import { queryHeatmapCellDetail } from '@/lib/queries/heatmap';
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

// ------------------------------------------------------------
// Capture helpers
// ------------------------------------------------------------
// $queryRaw is invoked in two styles:
//  - FUNCTION style (the item-outlet-breakdown core): single Prisma.Sql
//    argument — its `.sql` getter recursively inlines raw fragments and
//    renders parameters as '?'.
//  - TAGGED-TEMPLATE style (pareto/nested.ts): first arg is the strings
//    array, rest are the values (raw fragments appear as VALUES here, so
//    the rebuilt text shows '?' in their place — structural assertions on
//    those queries check the captured values instead).
type SqlLike = { sql?: string; strings?: unknown[]; values?: unknown[] };

function capturedSqlTexts(): string[] {
  return mockQueryRaw.mock.calls.map((args: unknown[]) => {
    const first = args[0] as SqlLike;
    if (first && typeof first === 'object' && typeof first.sql === 'string') {
      return first.sql as string;
    }
    const chunks = [...(first as unknown as string[])];
    return chunks.join('?');
  });
}

/** All values passed to tagged-template $queryRaw calls (raw fragments + params). */
function capturedValues(): unknown[] {
  return mockQueryRaw.mock.calls.flatMap((args: unknown[]) => args.slice(1));
}

const rawText = (v: unknown): string =>
  v && typeof v === 'object' && Array.isArray((v as SqlLike).strings)
    ? String((v as SqlLike).strings?.[0] ?? '')
    : '';

// ------------------------------------------------------------
// Junction-safety guard (the `> 0AND ir.area` regression)
// ------------------------------------------------------------
const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'ON',
  'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'GROUP', 'BY',
  'ORDER', 'LIMIT', 'HAVING', 'WITH', 'AS', 'CASE', 'WHEN', 'THEN', 'ELSE',
  'END', 'COALESCE', 'SUM', 'ABS', 'CAST', 'COUNT', 'MAX', 'MIN', 'AVG',
  'ROW_NUMBER', 'OVER', 'PARTITION', 'DESC', 'ASC', 'NULLS', 'LAST', 'ILIKE',
  'LIKE', 'DISTINCT', 'TRUE', 'FALSE', 'INTEGER', 'TEXT', 'EXISTS',
  'INTERSECT', 'UNION', 'EXCEPT', 'BETWEEN', 'SUBSTRING', 'UPPER', 'LOWER',
  'NEUTRAL', 'LOSS', 'SURPLUS',
]);
const KW_RE = /(?:AND|OR|NOT|WHERE|GROUP|ORDER|LIMIT|JOIN|HAVING|SELECT|FROM|WITH|CASE|WHEN|THEN|ELSE|END|IN|IS|NULL)/;

/**
 * Assert every captured SQL text keeps whitespace between tokens at the
 * fragment junctions:
 *  (a) no keyword glued directly after a value/literal boundary char
 *      (digit, quote, paren, %, ?) — catches `> 0AND`, `?AND`, `)WHERE`.
 *  (b) no paren-free all-caps unknown token containing a keyword — catches
 *      `NULLAND` (letter-glued words the char class in (a) cannot see)
 *      without flagging valid function chains like `CAST(COUNT(DISTINCT`.
 */
function expectNoGluedKeywords(): void {
  for (const text of capturedSqlTexts()) {
    const cleaned = text.replace(/--[^\n]*/g, ' ');
    const glued = /[\d"')%'?](?:AND|OR|NOT|WHERE|GROUP|ORDER|LIMIT|JOIN|HAVING|SELECT|FROM|WITH|CASE|WHEN|THEN|ELSE|END|IN|IS)[\s"(]/.test(cleaned)
      || cleaned.split(/\s+/).some((t) => {
        const word = t.replace(/[^A-Za-z_]/g, '');
        return !/[()]/.test(t) && /^[A-Z][A-Z_]+$/.test(word) && !KEYWORDS.has(word) && KW_RE.test(word);
      });
    expect(glued, `glued keyword junction in SQL:\n${cleaned}`).toBe(false);
  }
}

const NO_FILTERS = { area: null, kelompok: null, outletCode: null, itemName: null, picOutletCodes: null };
const SOME_FILTERS = { area: 'Bandung', kelompok: 'BDG', outletCode: null, itemName: null, picOutletCodes: ['X1', 'X2'] };

/** Queue DB row sets: every $queryRaw call shifts the next queued set. */
function queueResults(...sets: unknown[][]): void {
  const setsCopy = [...sets];
  mockQueryRaw.mockImplementation(async () => setsCopy.shift() ?? []);
}

beforeEach(() => {
  mockQueryRaw.mockReset();
  mockExecuteRaw.mockReset();
  mockExecuteRaw.mockResolvedValue(0);
});

// ------------------------------------------------------------
// 1) Junction safety across the optional-fragment matrix
// ------------------------------------------------------------
describe('H-12 SQL junction safety (no missing-whitespace keyword glue)', () => {
  it('anomali outlets — no filters (empty filter fragment)', async () => {
    queueResults([]);
    await queryItemAnomaliOutlets({ item: 'CABAI', month: 'Juli 2026', week: 'WEEK 4', direction: 'LOSS', filters: NO_FILTERS });
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    expectNoGluedKeywords();
  });

  it('anomali outlets — filters active (extraWhere AND filters both present)', async () => {
    // This is the exact case that produced `> 0AND ir.area` before the fix.
    queueResults([]);
    await queryItemAnomaliOutlets({ item: 'CABAI', month: 'Juli 2026', week: 'WEEK 4', direction: 'SURPLUS', filters: SOME_FILTERS });
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    expectNoGluedKeywords();
    // The separator the core template must own between extraWhere and ${f}:
    expect(capturedSqlTexts()[0]).toContain('AND ir."nominalLossSurplus" > 0 AND ir.area = ?');
  });

  it('flip drilldown — both periods, outlet filter (month prefix + filters)', async () => {
    queueResults([], []);
    await queryFlipDrilldown({
      item: 'CABAI',
      weekLabel: 'WEEK 4',
      month1Label: 'Jul',
      month2Label: 'Agu',
      filters: { ...NO_FILTERS, outletCode: '1030.BDGSET' },
    });
    expect(mockQueryRaw).toHaveBeenCalledTimes(2);
    expectNoGluedKeywords();
    // Junction between qtyDeviasi IS NOT NULL (extraWhere) and the filter:
    expect(capturedSqlTexts()[0]).toContain('IS NOT NULL AND ir."outletId" IN (SELECT id FROM "Outlet" WHERE code = ?)');
  });

  it('heatmap cell detail — no filters (extraWhere present, filter fragment empty)', async () => {
    queueResults([]);
    await queryHeatmapCellDetail('WEEK 4', 'Juli 2026', NO_FILTERS, 'Bandung', 'CABAI');
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    expectNoGluedKeywords();
  });

  it('pareto nested — item→outlet, area→outlet, outlet→item (both steps)', async () => {
    const parent = { name: 'FAKE', totalAbsNominal: 10, nominalDeviasi: 3, qtyDeviasi: 2, outletCount: 5 };
    const combos: Array<['item' | 'area' | 'outlet', 'item' | 'outlet']> = [
      ['item', 'outlet'], ['area', 'outlet'], ['outlet', 'item'],
    ];
    for (const [parentDim, childDim] of combos) {
      mockQueryRaw.mockReset();
      queueResults([parent], []);
      await queryParetoNested('WEEK 4', 'Juli 2026', NO_FILTERS, parentDim, childDim, 10);
      expect(mockQueryRaw).toHaveBeenCalledTimes(2);
      expectNoGluedKeywords();
    }
  });
});

// ------------------------------------------------------------
// 2) Structural invariants each caller kept from its pre-merge SQL
// ------------------------------------------------------------
describe('H-12 structural invariants (per caller)', () => {
  it('anomali: exact item match + PIC join + direction + group/order', async () => {
    queueResults([]);
    await queryItemAnomaliOutlets({ item: 'CABAI', month: 'Juli 2026', week: 'WEEK 4', direction: 'LOSS', filters: SOME_FILTERS });
    const sql = capturedSqlTexts()[0];
    // EXACT match — never the itemName LIKE (over-matches "CABAI FROZEN").
    expect(sql).toContain('i.name = ?');
    expect(sql).not.toContain('ILIKE');
    expect(sql).toContain('LEFT JOIN "OutletPIC" pic ON o.code = pic."outletCode"');
    expect(sql).toContain('ir."nominalLossSurplus" < 0');
    expect(sql).toContain('GROUP BY o.code, o.name, o.area, pic.pic');
    expect(sql).toContain('ORDER BY ABS(SUM(ir."nominalDeviasi")) DESC');
  });

  it('flip drilldown: month prefix match + signed aggregates + NULLS LAST', async () => {
    queueResults([], []);
    await queryFlipDrilldown({ item: 'CABAI', weekLabel: 'WEEK 4', month1Label: 'Jul', month2Label: 'Agu', filters: NO_FILTERS });
    const [p1] = capturedSqlTexts();
    expect(p1).toContain('(ir."monthLabel" = ? OR ir."monthLabel" ILIKE ?)');
    expect(p1).toContain('ir."qtyDeviasi" IS NOT NULL');
    expect(p1).toContain('COALESCE(SUM(ir."qtyDeviasi"), 0) as "qtyDeviasiSigned"');
    expect(p1).toContain('ORDER BY ABS(SUM(ir."qtyDeviasi")) DESC NULLS LAST');
  });

  it('heatmap cell detail: no PIC join + area predicate + LIMIT cap', async () => {
    queueResults([]);
    await queryHeatmapCellDetail('WEEK 4', 'Juli 2026', NO_FILTERS, 'Bandung', 'CABAI');
    const sql = capturedSqlTexts()[0];
    expect(sql).not.toContain('OutletPIC');
    expect(sql).toContain('AND ir.area = ?');
    expect(sql).toContain('GROUP BY o.code, o.name, ir.area, ir."akunPenyesuaian"');
    expect(sql).toContain('LIMIT ?');
  });

  it('pareto nested outlet child: label/area display cols + GROUP BY extension', async () => {
    const parent = { name: 'FAKE', totalAbsNominal: 10, nominalDeviasi: 3, qtyDeviasi: 2, outletCount: 5 };
    queueResults([parent], []);
    await queryParetoNested('WEEK 4', 'Juli 2026', NO_FILTERS, 'area', 'outlet', 10);
    const values = capturedValues().map(rawText).join('\n');
    // Outlet children carry display columns (H-12 twin-merge contract):
    expect(values).toContain('o.name as "label", o.area as "area",');
    // ...and the GROUP BY extension required by Postgres functional
    // dependency (Outlet PK is id, code is merely UNIQUE):
    expect(values).toContain(', o.name, o.area');
  });

  it('pareto nested non-outlet child: NULL placeholder cols, no GROUP BY extension', async () => {
    const parent = { name: 'FAKE', totalAbsNominal: 10, nominalDeviasi: 3, qtyDeviasi: 2, outletCount: 5 };
    queueResults([parent], []);
    await queryParetoNested('WEEK 4', 'Juli 2026', NO_FILTERS, 'outlet', 'item', 10);
    const values = capturedValues().map(rawText).join('\n');
    expect(values).toContain('NULL::text as "label", NULL::text as "area",');
    expect(values).not.toContain(', o.name, o.area');
  });
});
