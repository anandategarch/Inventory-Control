// Tests for src/lib/queries/waste/rate-league.ts (W1 — "Liga
// Waste-Rate": per-item outlet league ranked by the normalized
// waste rate Σ|qtyWaste| / Σ|qtyBom|, median + MAD + robust-z)
// + the /api/waste-rate-league route surface (schema gate +
// __NO_MATCH__ shape).
//
// Covers:
//  1. Pure helpers — medianOf (odd/even/empty), madOf, robustZ
//     (the 1.4826 consistency constant + the MAD=0 → null guard),
//     clampRateLeagueLimit (1..50 + non-finite → default).
//  2. buildRateLeague (pure, no DB) — rate arithmetic
//     (waste 10 / BOM 100 → 0.1), hand-computed median/MAD/z on a
//     7-outlet fixture (median 0.03, MAD 0.02, z(0.10) ≈ 2.3607),
//     zero-waste outlets INSIDE the median population but NOT in
//     the league (zero-inflation honesty), the min-5-outlet guard
//     (league omitted + reason, item still listed), NO_BOM_BASIS,
//     orphaned waste (BOM=0 → rate null, never ranked, counted),
//     rank ordering + outletCode tie-break, both-zero rows ignored,
//     bigint inputs, input purity, meta disclosure block, empty input
//     + FIX (AUDIT-D F1) defensive merge: an outlet split across two
//     area labels on the raw rows collapses to ONE population slot
//     (guard sees DISTINCT outlets; merged rate = Σw/Σb; no
//     duplicate league rows).
//  3. queryWasteRateLeague — month derivation runs FIRST
//     (BUGHUNT-R1 FIX 9), round 1 (item aggregate + Pareto door-in
//     + LIMIT clamp + optional exact-name item pin) and round 2
//     (per-(item, outlet) GROUP BY with the Outlet join, Σ|qtyWaste|
//     + Σ|qtyBom|, NO cap — the full outlet tail feeds the median),
//     early-return short-circuits, wiring of lastMonthKey /
//     windowMonths / meta, set_config via withStatementTimeout
//     + FIX (AUDIT-D F1) round-2 grain pins (area from the Outlet
//     MASTER — o.area — with a NEGATIVE pin on ir.area) and
//     FIX (AUDIT-D F2) population-window-before-item-pin + the
//     no-match fallback that keeps populationTotal honest.
//  4. Route /api/waste-rate-league (GET + the inline zod schema;
//     tests/app/settings-cross-key.test.ts pattern — mocked
//     rate-limit/month-resolver/pic-resolver, real zod + real
//     builder) — FIX (AUDIT-D F3): `?item=` (empty) normalizes to
//     "absent" at the schema gate (was a 400) and end-to-end;
//     FIX (AUDIT-D F4): the __NO_MATCH__ early return carries the
//     item echo + builder meta (week/limit stay off — family
//     convention).
//
// Mock @/lib/db (same vi.hoisted pattern as waste-top-items.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  WASTE_RATE_LEAGUE_WINDOW_MONTHS,
  WASTE_RATE_LEAGUE_DEFAULT_LIMIT,
  WASTE_RATE_LEAGUE_MAX_LIMIT,
  WASTE_RATE_LEAGUE_MIN_OUTLETS,
  WASTE_RATE_LEAGUE_MAD_SCALE,
  medianOf,
  madOf,
  robustZ,
  clampRateLeagueLimit,
  buildRateLeague,
  queryWasteRateLeague,
} from '@/lib/queries/waste/rate-league';
import type { WasteRateItemRawRow, WasteRateOutletRawRow } from '@/lib/queries/waste/rate-league';
import type { NextRequest } from 'next/server';
import { GET, wasteRateLeagueQuerySchema } from '@/app/api/waste-rate-league/route';
import { validateQuery } from '@/lib/validation';

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

// Route-level coverage (section 4) imports the route module. The
// @/lib/queries BARREL the route pulls is heavy (every query domain);
// re-point it at the REAL deep module this file already exercises —
// the route only imports rate-league symbols from the barrel, so the
// mock is behavior-identical and load-light.
vi.mock('@/lib/queries', async () => import('@/lib/queries/waste/rate-league'));

// Route infra mocks (tests/app/settings-cross-key.test.ts pattern).
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: vi.fn().mockReturnValue({ allowed: true }),
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
  RATE_LIMITS: { analysis: { maxRequests: 100, windowMs: 60_000 } },
}));
vi.mock('@/lib/month-resolver', () => ({
  getMonthResolver: vi.fn().mockResolvedValue({}),
  resolveMonthLabel: vi.fn((m: string) => m),
}));
vi.mock('@/lib/pic-resolver', () => ({
  // Default: the PIC matches no outlets → the __NO_MATCH__ early
  // return (the F4 shape test rides this; nothing else in this file
  // resolves PICs).
  resolvePICOutletCodes: vi.fn().mockResolvedValue(['__NO_MATCH__']),
}));

/** Render a Prisma.Sql fragment (or nested array of them) to flat text. */
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

/** Minimal NextRequest stand-in — GET only touches req.url. */
function makeReq(query: string): NextRequest {
  return { url: `http://localhost/api/waste-rate-league?${query}` } as unknown as NextRequest;
}

// ------------------------------------------------------------
// Fixture factories
// ------------------------------------------------------------

function itemRow(overrides: Partial<Record<string, number | bigint | string | null>> = {}): WasteRateItemRawRow {
  return {
    itemId: 1,
    itemName: 'KULIT PANGSIT',
    satuan: 'PCS',
    totalWaste: 1000,
    wasteQty: 29,
    bomQty: 700,
    populationTotal: 5000,
    ...overrides,
  } as WasteRateItemRawRow;
}

function outletRow(
  outletCode: string,
  wasteQty: number | bigint,
  bomQty: number | bigint,
  overrides: Partial<Record<string, string | number>> = {},
): WasteRateOutletRawRow {
  return {
    itemId: 1,
    outletCode,
    outletName: `Outlet ${outletCode}`,
    area: 'JAKARTA',
    wasteQty,
    bomQty,
    ...overrides,
  } as WasteRateOutletRawRow;
}

// ------------------------------------------------------------
// 1. Pure helpers
// ------------------------------------------------------------

describe('medianOf / madOf / robustZ', () => {
  it('medianOf: odd n takes the middle, even n averages the middle pair, empty → null', () => {
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([4, 1, 3, 2])).toBe(2.5);
    expect(medianOf([])).toBeNull();
    expect(medianOf([7])).toBe(7);
  });

  it('madOf: median of |x − median| (hand-computed), empty → null', () => {
    // rates [0.10, 0.08, 0.05, 0.03, 0.02, 0.01, 0.00] → median 0.03
    // |x − 0.03| = [0.07, 0.05, 0.02, 0.00, 0.01, 0.02, 0.03] → median 0.02
    expect(madOf([0.10, 0.08, 0.05, 0.03, 0.02, 0.01, 0.00], 0.03)).toBeCloseTo(0.02, 10);
    expect(madOf([], 0.03)).toBeNull();
  });

  it('robustZ applies the 1.4826 consistency constant (hand-computed)', () => {
    // (0.10 − 0.03) / (1.4826 × 0.02) = 0.07 / 0.029652 ≈ 2.3607176582
    expect(robustZ(0.10, 0.03, 0.02)).toBeCloseTo(0.07 / (1.4826 * 0.02), 10);
    expect(robustZ(0.03, 0.03, 0.02)).toBe(0);
    expect(robustZ(0.01, 0.03, 0.02)).toBeCloseTo(-0.02 / (1.4826 * 0.02), 10);
    // The constant is exported and pinned (Φ⁻¹(0.75)).
    expect(WASTE_RATE_LEAGUE_MAD_SCALE).toBe(1.4826);
  });

  it('MAD = 0 (or negative) → z = null — the documented degenerate-scale guard', () => {
    // Reporting z = 0 would fabricate "exactly typical"; z stays null.
    expect(robustZ(0.10, 0.03, 0)).toBeNull();
    expect(robustZ(0.10, 0.03, -1)).toBeNull();
  });
});

describe('clampRateLeagueLimit', () => {
  it('clamps into 1..50 (house limit convention)', () => {
    expect(clampRateLeagueLimit(1)).toBe(1);
    expect(clampRateLeagueLimit(20)).toBe(20);
    expect(clampRateLeagueLimit(50)).toBe(50);
    expect(clampRateLeagueLimit(0)).toBe(1);
    expect(clampRateLeagueLimit(-5)).toBe(1);
    expect(clampRateLeagueLimit(999)).toBe(50);
    expect(clampRateLeagueLimit(3.7)).toBe(3);
  });

  it('non-finite input falls back to the default (route bogus-value semantics)', () => {
    expect(clampRateLeagueLimit(Number.NaN)).toBe(WASTE_RATE_LEAGUE_DEFAULT_LIMIT);
    expect(clampRateLeagueLimit(Number.POSITIVE_INFINITY)).toBe(WASTE_RATE_LEAGUE_DEFAULT_LIMIT);
  });

  it('knobs pinned: default 20, max 50, min outlets 5, window cap 12', () => {
    expect(WASTE_RATE_LEAGUE_DEFAULT_LIMIT).toBe(20);
    expect(WASTE_RATE_LEAGUE_MAX_LIMIT).toBe(50);
    expect(WASTE_RATE_LEAGUE_MIN_OUTLETS).toBe(5);
    expect(WASTE_RATE_LEAGUE_WINDOW_MONTHS).toBe(12);
  });
});

// ------------------------------------------------------------
// 2. buildRateLeague (pure)
// ------------------------------------------------------------

describe('buildRateLeague', () => {
  // Fixture A — 7 BOM>0 outlets: 6 wasting + 1 zero-waste.
  // rates = [0.10, 0.08, 0.05, 0.03, 0.02, 0.01, 0.00]
  //   median = 0.03 · MAD = 0.02 · scaled σ = 1.4826 × 0.02 = 0.029652
  //   z(0.10) ≈ 2.3607176582 · z(0.08) ≈ 1.6862268987 ·
  //   z(0.05) ≈ 0.6744907595 · z(0.03) = 0 ·
  //   z(0.02) ≈ −0.3372453797 · z(0.01) ≈ −0.6744907595
  const fixtureAOutlets = (): WasteRateOutletRawRow[] => [
    outletRow('OUT1', 10, 100),
    outletRow('OUT2', 8, 100),
    outletRow('OUT3', 5, 100),
    outletRow('OUT4', 3, 100),
    outletRow('OUT5', 2, 100),
    outletRow('OUT7', 1, 100),
    outletRow('OUT6', 0, 100), // zero-waste: in the population, NOT in the league
  ];

  it('rate arithmetic: waste 10 / BOM 100 → 0.1, ranked DESC with deterministic ranks', () => {
    const result = buildRateLeague([itemRow()], fixtureAOutlets());
    const league = result.items[0].league!;
    expect(league).toHaveLength(6); // zero-waste OUT6 excluded from the table
    expect(league[0]).toMatchObject({ rank: 1, outletCode: 'OUT1', rate: 0.1 });
    expect(league[1]).toMatchObject({ rank: 2, outletCode: 'OUT2' });
    expect(league[5]).toMatchObject({ rank: 6, outletCode: 'OUT7' });
    // Numerator + denominator ride on the row (display context).
    expect(league[0].wasteQty).toBe(10);
    expect(league[0].bomQty).toBe(100);
    expect(league[0].area).toBe('JAKARTA');
  });

  it('median/MAD over the FULL BOM>0 population (zero-waste outlet included at rate 0) + hand-computed robust-z', () => {
    const it = buildRateLeague([itemRow()], fixtureAOutlets()).items[0];
    // Without OUT6's 0.00 inside the population the median would be
    // (0.03+0.05)/2 = 0.04 — asserting 0.03 PROVES the zero-waste
    // outlet is inside the median population (task spec: "median +
    // MAD over outlets with BOM>0").
    expect(it.medianRate).toBeCloseTo(0.03, 10);
    expect(it.madRate).toBeCloseTo(0.02, 10);
    expect(it.outletsWithBom).toBe(7);
    const z = (code: string) => it.league!.find((r) => r.outletCode === code)!.robustZ;
    expect(z('OUT1')).toBeCloseTo(2.360717658168083, 10);
    expect(z('OUT2')).toBeCloseTo(1.6862268986914877, 10);
    expect(z('OUT3')).toBeCloseTo(0.6744907594765952, 10);
    expect(z('OUT4')).toBe(0);
    expect(z('OUT5')).toBeCloseTo(-0.3372453797382975, 10);
    expect(z('OUT7')).toBeCloseTo(-0.674490759476595, 10);
  });

  it('zero-waste outlets reported SEPARATELY (count + share), never as 0% league rows', () => {
    const it = buildRateLeague([itemRow()], fixtureAOutlets()).items[0];
    expect(it.zeroWasteOutlets).toBe(1);
    expect(it.zeroWasteShare).toBeCloseTo(1 / 7, 10);
    expect(it.league!.every((r) => r.wasteQty > 0)).toBe(true);
    expect(it.league!.find((r) => r.outletCode === 'OUT6')).toBeUndefined();
  });

  it('MAD = 0 (degenerate population) → league still ranked, z null for EVERY row', () => {
    // 6 outlets: [0.1, 0.1, 0.1, 0.1, 0.2, 0.3] → median 0.1, MAD 0.
    const outlets = [
      outletRow('OUT1', 10, 100),
      outletRow('OUT2', 10, 100),
      outletRow('OUT3', 10, 100),
      outletRow('OUT4', 10, 100),
      outletRow('OUT5', 20, 100),
      outletRow('OUT6', 30, 100),
    ];
    const it = buildRateLeague([itemRow()], outlets).items[0];
    expect(it.medianRate).toBeCloseTo(0.1, 10);
    expect(it.madRate).toBe(0);
    expect(it.league).not.toBeNull();
    expect(it.league!.every((r) => r.robustZ === null)).toBe(true);
    // Rates still readable: OUT6 tops the league at 0.3.
    expect(it.league![0]).toMatchObject({ rank: 1, outletCode: 'OUT6', rate: 0.3 });
  });

  it('min-5-outlets guard: league omitted with reason, item STILL listed, stats disclosed', () => {
    // 4 BOM>0 outlets (3 wasting + 1 zero-waste) — below the guard.
    const outlets = [
      outletRow('OUT1', 10, 100),
      outletRow('OUT2', 8, 100),
      outletRow('OUT3', 5, 100),
      outletRow('OUT4', 0, 100),
    ];
    const result = buildRateLeague([itemRow()], outlets);
    expect(result.items).toHaveLength(1); // never silently dropped
    const it = result.items[0];
    expect(it.league).toBeNull();
    expect(it.leagueOmittedReason).toBe('MIN_OUTLETS');
    expect(it.outletsWithBom).toBe(4);
    expect(it.zeroWasteOutlets).toBe(1);
    expect(it.zeroWasteShare).toBeCloseTo(0.25, 10);
    // Median/MAD stay disclosed for transparency (hand: median 0.065, MAD 0.025).
    expect(it.medianRate).toBeCloseTo(0.065, 10);
    expect(it.madRate).toBeCloseTo(0.025, 10);
  });

  it('NO_BOM_BASIS: no outlet recorded BOM → league omitted with the distinct reason', () => {
    const outlets = [
      outletRow('OUT1', 5, 0),  // orphaned waste
      outletRow('OUT2', 0, 0),  // neither usage nor waste — ignored entirely
    ];
    const it = buildRateLeague([itemRow()], outlets).items[0];
    expect(it.league).toBeNull();
    expect(it.leagueOmittedReason).toBe('NO_BOM_BASIS');
    expect(it.outletsWithBom).toBe(0);
    expect(it.zeroWasteShare).toBeNull();
    expect(it.medianRate).toBeNull();
    expect(it.orphanWasteOutlets).toBe(1);
  });

  it('BOM=0 outlets: rate null (never ranked), counted as orphaned waste, NOT in the median', () => {
    // 5 BOM>0 outlets + 1 orphan (waste 50, BOM 0). The orphan's
    // large waste must not move the median: rates [0.1, 0.08,
    // 0.05, 0.03, 0.02] → median 0.05, MAD 0.03.
    const outlets = [
      outletRow('OUT1', 10, 100),
      outletRow('OUT2', 8, 100),
      outletRow('OUT3', 5, 100),
      outletRow('OUT4', 3, 100),
      outletRow('OUT5', 2, 100),
      outletRow('ORPH', 50, 0), // BOM=0 → null rate, orphan bucket
      outletRow('NULL', 0, 0),  // both zero → ignored
    ];
    const it = buildRateLeague([itemRow()], outlets).items[0];
    expect(it.medianRate).toBeCloseTo(0.05, 10);
    expect(it.madRate).toBeCloseTo(0.03, 10);
    expect(it.outletsWithBom).toBe(5);
    expect(it.orphanWasteOutlets).toBe(1);
    expect(it.league).toHaveLength(5);
    expect(it.league!.find((r) => r.outletCode === 'ORPH')).toBeUndefined();
    expect(it.league![0].robustZ).toBeCloseTo(1.1241512657943253, 10);
  });

  it('rank tie-break: equal rates order by outletCode ASC (deterministic)', () => {
    const outlets = [
      outletRow('OUTB', 5, 100),
      outletRow('OUTA', 5, 100),
      outletRow('OUTC', 5, 100),
      outletRow('OUTD', 5, 100),
      outletRow('OUTE', 5, 100),
    ];
    const league = buildRateLeague([itemRow()], outlets).items[0].league!;
    expect(league.map((r) => r.outletCode)).toEqual(['OUTA', 'OUTB', 'OUTC', 'OUTD', 'OUTE']);
    expect(league.every((r) => r.rank >= 1 && r.rate === 0.05)).toBe(true);
  });

  it('FIX (AUDIT-D F1) defensive merge: outlet split across two area labels → ONE population slot — the guard sees DISTINCT outlets', () => {
    // The pre-fix round-2 SQL produced exactly this raw shape: 3
    // DISTINCT outlets × 2 record-level area labels = 6 rows, and
    // the builder used to read outletsWithBom = 6 — bypassing the
    // MIN_OUTLETS=5 guard (the audit's synthetic repro). The merge
    // makes one physical outlet ONE population slot: 3 < 5 → the
    // guard FIRES on the true population.
    const outlets = [
      outletRow('OUT1', 10, 100, { area: 'JAWA TENGAH 1' }),
      outletRow('OUT1', 6, 100, { area: 'JAWA TENGAH 2' }),
      outletRow('OUT2', 8, 100, { area: 'JAWA TENGAH 1' }),
      outletRow('OUT2', 4, 100, { area: 'JAWA TENGAH 2' }),
      outletRow('OUT3', 5, 100, { area: 'JAWA TENGAH 1' }),
      outletRow('OUT3', 5, 100, { area: 'JAWA TENGAH 2' }),
    ];
    const it = buildRateLeague([itemRow()], outlets).items[0];
    expect(it.outletsWithBom).toBe(3); // DISTINCT outlets, never 6
    expect(it.league).toBeNull();
    expect(it.leagueOmittedReason).toBe('MIN_OUTLETS');
    // Median over the MERGED rates: OUT1 (10+6)/200 = 0.08,
    // OUT2 (8+4)/200 = 0.06, OUT3 (5+5)/200 = 0.05 → 0.06 (hand).
    expect(it.medianRate).toBeCloseTo(0.06, 10);
  });

  it('FIX (AUDIT-D F1) defensive merge: split outlet appears ONCE in the league with summed waste/BOM + merged rate', () => {
    // 5 distinct outlets (the guard passes at exactly 5); OUT1 moved
    // area mid-window (JAWA TIMUR 1 → WCR) — the live MLGSOE shape.
    const outlets = [
      outletRow('OUT1', 10, 100, { area: 'JAWA TIMUR 1' }),
      outletRow('OUT1', 6, 100, { area: 'WCR' }),
      outletRow('OUT2', 8, 100),
      outletRow('OUT3', 5, 100),
      outletRow('OUT4', 3, 100),
      outletRow('OUT5', 2, 100),
    ];
    const it = buildRateLeague([itemRow()], outlets).items[0];
    expect(it.outletsWithBom).toBe(5); // the split outlet counts ONCE
    // ONE league slot per outlet — no duplicate outletCode rows
    // (this is also what un-breaks the card's key={outletCode}).
    expect(it.league!.map((r) => r.outletCode)).toEqual(['OUT1', 'OUT2', 'OUT3', 'OUT4', 'OUT5']);
    const out1 = it.league!.find((r) => r.outletCode === 'OUT1')!;
    expect(out1.wasteQty).toBe(16); // 10 + 6 merged
    expect(out1.bomQty).toBe(200);  // 100 + 100 merged
    expect(out1.rate).toBeCloseTo(0.08, 10); // merged rate = Σw/Σb
    // Population stats over the MERGED distribution
    // [0.08, 0.08, 0.05, 0.03, 0.02]: median 0.05, MAD 0.03,
    // z(0.08) = 0.03 / (1.4826 × 0.03) ≈ 0.6744907594765952.
    expect(it.medianRate).toBeCloseTo(0.05, 10);
    expect(it.madRate).toBeCloseTo(0.03, 10);
    expect(out1.robustZ).toBeCloseTo(0.6744907594765952, 10);
    // Labels from the FIRST occurrence (Outlet-master fields are
    // constant per outletCode — any occurrence is correct).
    expect(out1.area).toBe('JAWA TIMUR 1');
    expect(out1.outletName).toBe('Outlet OUT1');
  });

  it('bigint round-trip rows (SQL aggregates arrive as bigint) coerce to numbers', () => {
    const outlets = [
      outletRow('OUT1', BigInt(10), BigInt(100)),
      outletRow('OUT2', BigInt(8), BigInt(100)),
      outletRow('OUT3', BigInt(5), BigInt(100)),
      outletRow('OUT4', BigInt(3), BigInt(100)),
      outletRow('OUT5', BigInt(2), BigInt(100)),
    ];
    const result = buildRateLeague(
      [itemRow({ totalWaste: BigInt(1000), wasteQty: BigInt(29), bomQty: BigInt(700), populationTotal: BigInt(5000) })],
      outlets,
    );
    expect(result.populationTotal).toBe(5000);
    const it = result.items[0];
    expect(it.wasteQty).toBe(29);
    expect(it.bomQty).toBe(700);
    expect(it.league![0].rate).toBeCloseTo(0.1, 10);
    expect(it.league![0].wasteQty).toBe(10);
  });

  it('does not mutate its inputs (purity)', () => {
    const items = [itemRow()];
    const outlets = fixtureAOutlets();
    const itemsSnapshot = JSON.stringify(items);
    const outletsSnapshot = JSON.stringify(outlets);
    buildRateLeague(items, outlets);
    expect(JSON.stringify(items)).toBe(itemsSnapshot);
    expect(JSON.stringify(outlets)).toBe(outletsSnapshot);
  });

  it('carries the disclosure meta block (guards + basis + epistemics, window passthrough)', () => {
    const result = buildRateLeague([itemRow()], fixtureAOutlets(), 9);
    expect(result.windowMonths).toBe(9);
    expect(result.meta).toMatchObject({
      windowMonths: 9,
      minOutlets: 5,
      madScale: 1.4826,
      epistemicLabel: 'INDIKASI',
    });
    // Satuan + BOM-basis + zero-waste policy disclosed in metadata.
    expect(result.meta.rateDefinition).toContain('qtyWaste');
    expect(result.meta.rateDefinition).toContain('qtyBom');
    expect(result.meta.bomBasis).toContain('BOM');
    expect(result.meta.zeroWastePolicy).toContain('terpisah');
    // Satuan itself rides per item.
    expect(result.items[0].satuan).toBe('PCS');
  });

  it('empty input → empty result with meta + null lastMonthKey (query edge fills it)', () => {
    const result = buildRateLeague([], [], 8);
    expect(result.items).toEqual([]);
    expect(result.populationTotal).toBe(0);
    expect(result.lastMonthKey).toBeNull();
    expect(result.windowMonths).toBe(8);
    expect(result.meta.windowMonths).toBe(8);
  });
});

// ------------------------------------------------------------
// 3. queryWasteRateLeague (db mocked)
// ------------------------------------------------------------

describe('queryWasteRateLeague', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
    mockExecuteRaw.mockReset();
  });

  it('derives months FIRST, then the item + outlet rounds; leagues wired end-to-end (BigInt rows)', async () => {
    // Round 0 — month derivation (2-month window, most recent first).
    mockQueryRaw.mockResolvedValueOnce([{ monthKey: '2026-08' }, { monthKey: '2026-07' }]);
    // Round 1 — item aggregate.
    mockQueryRaw.mockResolvedValueOnce([
      itemRow({ totalWaste: BigInt(1000), wasteQty: BigInt(29), bomQty: BigInt(700), populationTotal: BigInt(5000) }),
    ]);
    // Round 2 — per-(item, outlet) grain.
    mockQueryRaw.mockResolvedValueOnce([
      outletRow('OUT1', BigInt(10), BigInt(100)),
      outletRow('OUT2', BigInt(8), BigInt(100)),
      outletRow('OUT3', BigInt(5), BigInt(100)),
      outletRow('OUT4', BigInt(3), BigInt(100)),
      outletRow('OUT5', BigInt(2), BigInt(100)),
      outletRow('OUT6', BigInt(0), BigInt(100)),
    ]);

    const result = await queryWasteRateLeague('WEEK 4', '2026-08', {}, 20);

    expect(mockQueryRaw).toHaveBeenCalledTimes(3);
    // Round 0 = the month-derivation query (cheapest first — FIX 9).
    const monthSql = deepText(mockQueryRaw.mock.calls[0]);
    expect(monthSql).toContain('ir."weekLabel" =');
    expect(monthSql).toContain('<=');
    expect(monthSql).toContain(String(WASTE_RATE_LEAGUE_WINDOW_MONTHS));
    expect(monthSql).not.toContain('WITH months');

    // Round 1 — Pareto door-in + rate context columns.
    const itemSql = deepText(mockQueryRaw.mock.calls[1]);
    expect(itemSql).toContain('ABS(ir."nominalWaste")');
    expect(itemSql).toContain('ABS(ir."qtyWaste")');
    expect(itemSql).toContain('ABS(ir."qtyBom")');
    expect(itemSql).toContain('sf."monthKey" IN (');
    expect(itemSql).toContain('SUM(ia."totalWaste") OVER ()');
    // FIX (AUDIT-D F2): the window rides INSIDE the `populated` CTE
    // (over ALL in-scope items); the outer wrapper only orders +
    // limits.
    expect(itemSql).toContain('populated AS (');
    expect(itemSql).toContain('SELECT * FROM populated');
    expect(itemSql).toContain('ORDER BY "totalWaste" DESC, "itemName" ASC');
    expect(itemSql).toContain('LIMIT');
    // Default mode: NO single-item pin.
    expect(itemSql).not.toContain('WHERE "itemName"');

    // Round 2 — the league grain: outlet join + both aggregates,
    // NO cap (the full tail feeds the median population).
    // FIX (AUDIT-D F1): the area comes from the Outlet MASTER
    // (o.area) and the GROUP BY keys on the outlet columns — ONE
    // physical outlet = ONE row per item. The record-level ir.area
    // label must never re-enter the grain. (This call is UNFILTERED;
    // an area FILTER would legitimately reference ir.area inside
    // the WHERE — the negative pin is only meaningful here.)
    const outletSql = deepText(mockQueryRaw.mock.calls[2]);
    expect(outletSql).toContain('ir."itemId" IN (');
    expect(outletSql).toContain('sf."monthKey" IN (');
    expect(outletSql).toContain('JOIN "Outlet" o ON ir."outletId" = o.id');
    expect(outletSql).toContain('SUM(ABS(ir."qtyWaste"))');
    expect(outletSql).toContain('SUM(ABS(ir."qtyBom"))');
    expect(outletSql).toContain('o.area as "area"');
    expect(outletSql).toContain('GROUP BY ir."itemId", o.code, o.name, o.area');
    expect(outletSql).not.toContain('ir.area');
    expect(outletSql).not.toContain('LIMIT');
    expect(outletSql).not.toContain('WITH months');

    // Wiring: window + monthKeys + the built league.
    expect(result.lastMonthKey).toBe('2026-08');
    expect(result.windowMonths).toBe(2);
    expect(result.populationTotal).toBe(5000);
    expect(result.meta.windowMonths).toBe(2);
    const it = result.items[0];
    expect(it.itemName).toBe('KULIT PANGSIT');
    expect(it.outletsWithBom).toBe(6);
    expect(it.league).toHaveLength(5);
    expect(it.league![0]).toMatchObject({ rank: 1, outletCode: 'OUT1', rate: 0.1 });
    expect(it.zeroWasteOutlets).toBe(1);
    expect(it.zeroWasteShare).toBeCloseTo(1 / 6, 10);

    // set_config fires per wrapped round (withStatementTimeout).
    expect(mockExecuteRaw).toHaveBeenCalledTimes(3);
    expect(deepText(mockExecuteRaw.mock.calls[0])).toContain('set_config');
  });

  it('clamps the limit before it reaches SQL (999 → 50)', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ monthKey: '2026-08' }]);
    mockQueryRaw.mockResolvedValueOnce([]);
    await queryWasteRateLeague('WEEK 4', '2026-08', {}, 999);
    // The mock captures the TAGGED-TEMPLATE call as [strings, ...raw
    // interpolations] — round 1's LAST interpolation is the clamped
    // LIMIT parameter (deepText renders values after the static
    // text, so the contiguous 'LIMIT 50' string never forms).
    const round1Args = mockQueryRaw.mock.calls[1] as unknown[];
    expect(round1Args[round1Args.length - 1]).toBe(50);
    // And the clamp is the pure, unit-tested rule (1..50).
    expect(clampRateLeagueLimit(999)).toBe(50);
  });

  it('item param pins round 1 to ONE item by exact name (single-item league mode)', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ monthKey: '2026-08' }]);
    mockQueryRaw.mockResolvedValueOnce([itemRow({ itemId: 7, itemName: 'ADONAN PANGSIT' })]);
    mockQueryRaw.mockResolvedValueOnce([
      outletRow('OUT1', BigInt(10), BigInt(100), { itemId: 7 }),
      outletRow('OUT2', BigInt(8), BigInt(100), { itemId: 7 }),
      outletRow('OUT3', BigInt(5), BigInt(100), { itemId: 7 }),
      outletRow('OUT4', BigInt(3), BigInt(100), { itemId: 7 }),
      outletRow('OUT5', BigInt(2), BigInt(100), { itemId: 7 }),
    ]);
    const result = await queryWasteRateLeague('WEEK 4', '2026-08', {}, 20, 'ADONAN PANGSIT');
    const itemSql = deepText(mockQueryRaw.mock.calls[1]);
    // FIX (AUDIT-D F2): the pin now references the OUTPUT alias
    // "itemName" and sits in the OUTER wrapper — AFTER the
    // population window (the window is over ALL in-scope items, so
    // the pinned row carries the FULL population total).
    expect(itemSql).toContain('WHERE "itemName" =');
    expect(itemSql.indexOf('SUM(ia."totalWaste") OVER ()')).toBeLessThan(
      itemSql.indexOf('WHERE "itemName" ='),
    );
    // The pinned item's league flows regardless of its Pareto rank.
    expect(result.items).toHaveLength(1);
    expect(result.items[0].itemName).toBe('ADONAN PANGSIT');
    expect(result.items[0].league).toHaveLength(5);
    // FIX (AUDIT-D F2): populationTotal is the FULL population
    // window (5000 — the network Pareto 100%), NOT the pinned
    // item's own totalWaste (1000) — share-of-network stays
    // meaningful in single-item mode (pre-fix it read 1000).
    expect(result.populationTotal).toBe(5000);
    expect(result.items[0].totalWaste).toBe(1000);
  });

  it('FIX (AUDIT-D F2): item-pin no-match → items: [] with the FULL populationTotal (fallback reads the population row), same shape', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ monthKey: '2026-08' }, { monthKey: '2026-07' }]);
    // Pinned round 1: the item name matches nothing in scope.
    mockQueryRaw.mockResolvedValueOnce([]);
    // Fallback: the population's first row (the window value — the
    // SAME value rides on every populated row).
    mockQueryRaw.mockResolvedValueOnce([
      itemRow({ itemName: 'KULIT PANGSIT', totalWaste: 4000, populationTotal: 9000 }),
    ]);
    const result = await queryWasteRateLeague('WEEK 4', '2026-08', {}, 20, 'TIDAK ADA ITEMNYA');
    expect(mockQueryRaw).toHaveBeenCalledTimes(3);
    // The fallback is the SAME round-1 SQL WITHOUT the item pin and
    // with LIMIT 1 — reading the population total from one row.
    const fallbackSql = deepText(mockQueryRaw.mock.calls[2]);
    expect(fallbackSql).toContain('SELECT * FROM populated');
    expect(fallbackSql).not.toContain('WHERE "itemName"');
    const fallbackArgs = mockQueryRaw.mock.calls[2] as unknown[];
    expect(fallbackArgs[fallbackArgs.length - 1]).toBe(1);
    // Shape consistent with the match case: the FULL population
    // total rides (pre-fix this path collapsed it to 0).
    expect(result.items).toEqual([]);
    expect(result.populationTotal).toBe(9000);
    expect(result.lastMonthKey).toBe('2026-08');
    expect(result.windowMonths).toBe(2);
    expect(result.meta).not.toBeNull();
    expect(result.meta.windowMonths).toBe(2);
  });

  it('short-circuits to ONE query when the window has no months (empty scope)', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const result = await queryWasteRateLeague('WEEK 4', '2026-08', { area: 'NOWHERE' }, 20);
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    expect(result.items).toEqual([]);
    expect(result.populationTotal).toBe(0);
    expect(result.windowMonths).toBe(0);
    expect(result.lastMonthKey).toBeNull();
    // Even the empty path carries the disclosure meta (guards stay visible).
    expect(result.meta).not.toBeNull();
    expect(result.meta.windowMonths).toBe(0);
  });

  it('stops after 2 queries when months exist but no items match', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ monthKey: '2026-08' }, { monthKey: '2026-07' }]);
    mockQueryRaw.mockResolvedValueOnce([]);
    const result = await queryWasteRateLeague('WEEK 4', '2026-08', {}, 20);
    expect(mockQueryRaw).toHaveBeenCalledTimes(2);
    expect(result.items).toEqual([]);
    expect(result.lastMonthKey).toBe('2026-08');
    expect(result.windowMonths).toBe(2);
    // Default mode (no item pin): populationTotal stays 0 — the
    // population itself is empty, so 0 IS the honest Pareto 100%
    // (the FIX AUDIT-D F2 fallback only fires in item-pin mode).
    expect(result.populationTotal).toBe(0);
  });
});

// ------------------------------------------------------------
// 4. Route /api/waste-rate-league (GET + inline schema) —
//    FIX (AUDIT-D F3) empty-item normalization + FIX (AUDIT-D F4)
//    __NO_MATCH__ shape. Infra mocked per the tests/app/
//    settings-cross-key.test.ts pattern; the zod schema and the
//    pure builder run REAL.
// ------------------------------------------------------------

describe('wasteRateLeagueQuerySchema (route inline schema)', () => {
  it('FIX (AUDIT-D F3): ?item= (empty) normalizes to "no pin" instead of a 400', () => {
    // `?item=` used to die at itemNameSchema's .min(1) with
    // "Invalid query params: item: ..." — contradicting the route
    // comment ("null/'' means the default top-N Pareto slice").
    // Now '' is preprocessed to absent and validates exactly like a
    // param that never rode the request.
    expect(validateQuery(wasteRateLeagueQuerySchema, new URLSearchParams('item='))).toEqual({
      success: true,
      data: {},
    });
    expect(validateQuery(wasteRateLeagueQuerySchema, new URLSearchParams('')).success).toBe(true);
    // A real pin still parses through (exact name, unchanged atoms).
    const pinned = validateQuery(
      wasteRateLeagueQuerySchema,
      new URLSearchParams('item=KULIT PANGSIT'),
    );
    expect(pinned.success).toBe(true);
    // The gate keeps rejecting what it should (max 200, control chars).
    expect(
      validateQuery(wasteRateLeagueQuerySchema, new URLSearchParams('item=A\u0001B')).success,
    ).toBe(false);
    expect(
      validateQuery(wasteRateLeagueQuerySchema, new URLSearchParams(`item=${'x'.repeat(201)}`))
        .success,
    ).toBe(false);
  });
});

describe('GET /api/waste-rate-league', () => {
  it('FIX (AUDIT-D F3): ?item= (empty) passes the zod gate end-to-end (was 400) and behaves like an absent param', async () => {
    const res = await GET(makeReq('month=September%202026&week=WEEK%204&item='));
    expect(res.status).toBe(200); // NOT the "Invalid query params: item:" 400
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.item).toBeNull(); // '' → no pin (default top-N Pareto slice)
  });

  it('FIX (AUDIT-D F4): __NO_MATCH__ carries the item echo + builder meta; week/limit stay off (family convention)', async () => {
    const res = await GET(
      makeReq('month=September%202026&week=WEEK%204&pic=Hantu&item=KULIT%20PANGSIT'),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.items).toEqual([]);
    expect(json.populationTotal).toBe(0);
    expect(json.lastMonthKey).toBeNull();
    expect(json.windowMonths).toBe(0);
    // Param echo — same convention as waste-top-items echoing its
    // `metric` selector on its own __NO_MATCH__ path.
    expect(json.item).toBe('KULIT PANGSIT');
    // meta from the SAME pure builder as every other empty path
    // (used to be null — the only success path without the
    // disclosure block).
    expect(json.meta).not.toBeNull();
    expect(json.meta).toMatchObject({
      windowMonths: 0,
      minOutlets: 5,
      madScale: 1.4826,
      epistemicLabel: 'INDIKASI',
    });
    // week/limit are deliberately NOT echoed — NO waste-family
    // early-return carries them (waste-top-items / waste-series omit
    // both); documented shape decision for FIX (AUDIT-D F4).
    expect(json.week).toBeUndefined();
    expect(json.limit).toBeUndefined();
  });
});
