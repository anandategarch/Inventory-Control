// Tests for src/lib/queries/outlets/peer-band-scan.ts (PERF-FILTER1 B) —
// the SHARED national band scan's pure helpers + the per-outlet deviasi
// rank compute (src/lib/queries/items/top-items/by-deviasi-rank.ts,
// PERF-FILTER1 B3).
//
// These pin the JS twins of the SQL semantics the refactor replaced:
//   - RANK() ties share a rank; ROW_NUMBER-style national ranks are
//     sequential with a deterministic tiebreak.
//   - Median = AVG of the middle 1-2 rows (the ROW_NUMBER/COUNT form).
//   - STDDEV_SAMP; n < 2 → 0 (the SQL COALESCE).
//   - ±10% band membership (inclusive bound, sales > 0).
//   - ±50% BOM bucket (inclusive BETWEEN bounds, other outlets only).
// Mock-free — pure functions only (the query-level wiring + scan SQL are
// covered by outlet-monthly-series.test.ts + waste-series.test.ts).
import { describe, it, expect } from 'vitest';
import {
  inPeerBand,
  medianOf,
  rankWithTies,
  selectTargetScanRows,
  stddevSamp,
  buildPeerBands,
  type PeerBandScan,
  type PeerBandScanRow,
} from '@/lib/queries/outlets/peer-band-scan';
import { computeDeviasiRankForOutlet } from '@/lib/queries/items/top-items/by-deviasi-rank';
import type { DeviasiNationalScanRow } from '@/lib/queries/items/top-items/national-scan';

// ------------------------------------------------------------
// Pure helpers
// ------------------------------------------------------------

describe('rankWithTies (SQL RANK semantics)', () => {
  it('ties SHARE a rank; the next distinct value skips', () => {
    // values: 10, 20, 20, 30 ranked ASC (smaller = better)
    const items = [10, 20, 20, 30];
    const ranks = rankWithTies(items, (a, b) => a < b);
    expect(ranks).toEqual([1, 2, 2, 4]);
  });

  it('single item → rank 1', () => {
    expect(rankWithTies([7], () => false)).toEqual([1]);
  });
});

describe('medianOf (ROW_NUMBER/COUNT median form)', () => {
  it('odd n → the middle value', () => {
    expect(medianOf([30, 40, 90])).toBe(40);
  });
  it('even n → AVG of the middle two', () => {
    expect(medianOf([30, 40, 90, 95])).toBe(65);
  });
  it('n = 1 → the value itself', () => {
    expect(medianOf([42])).toBe(42);
  });
  it('empty → 0 (COALESCE semantics)', () => {
    expect(medianOf([])).toBe(0);
  });
});

describe('stddevSamp (STDDEV_SAMP twin)', () => {
  it('n < 2 → 0 (SQL NULL → COALESCE 0)', () => {
    expect(stddevSamp([])).toBe(0);
    expect(stddevSamp([5])).toBe(0);
  });
  it('sample stddev divides by n−1', () => {
    // [0.02, 0.01, 0.01, 0.01]: mean 0.0125, ss 7.5e-5, var 2.5e-5 → 0.005.
    expect(stddevSamp([0.02, 0.01, 0.01, 0.01])).toBeCloseTo(0.005, 10);
  });
});

describe('inPeerBand (±10% sales band, variant C)', () => {
  it('inclusive bounds at exactly ±10%', () => {
    expect(inPeerBand(900, 1000)).toBe(true);   // |900−1000| = 100 ≤ 100
    expect(inPeerBand(1100, 1000)).toBe(true);  // |1100−1000| = 100 ≤ 100
    expect(inPeerBand(899, 1000)).toBe(false);
    expect(inPeerBand(1101, 1000)).toBe(false);
  });
  it('zero/absent sales never match (the COALESCE > 0 guard)', () => {
    expect(inPeerBand(0, 1000)).toBe(false);
  });
});

// ------------------------------------------------------------
// Scan row selection + band building
// ------------------------------------------------------------

function scanFixtureRow(
  outletCode: string,
  monthKey: string,
  sales: number,
  overrides: Partial<PeerBandScanRow> = {},
): PeerBandScanRow {
  return {
    monthKey,
    monthLabel: `L:${monthKey}`,
    outletCode,
    nominalDeviasi: -10,
    totalLoss: 5,
    totalSurplus: 0,
    waste: 1,
    absQtyDeviasi: 2,
    absQtyBom: 3,
    sales,
    ...overrides,
  };
}

describe('selectTargetScanRows', () => {
  it("returns the target's rows, chronological, capped to the window", () => {
    const scan: PeerBandScan = {
      rows: [
        scanFixtureRow('B', '2026-01', 100),
        scanFixtureRow('A', '2026-03', 100),
        scanFixtureRow('A', '2026-01', 100),
        scanFixtureRow('A', '2026-02', 100),
      ],
    };
    const out = selectTargetScanRows(scan, 'A', 2);
    expect(out.map((r) => r.monthKey)).toEqual(['2026-02', '2026-03']);
  });
});

describe('buildPeerBands', () => {
  it('band membership: ±10% + sales > 0; months without target sales skipped', () => {
    const scan: PeerBandScan = {
      rows: [
        // 2026-08: target 1000 + in-band 950 + out-of-band 500.
        scanFixtureRow('T', '2026-08', 1000),
        scanFixtureRow('P1', '2026-08', 950),
        scanFixtureRow('P2', '2026-08', 500),
        // 2026-07: target has NO sales → month skipped entirely.
        scanFixtureRow('T', '2026-07', 0),
      ],
    };
    const bands = buildPeerBands(scan, 'T', 12, null);
    expect(bands).toHaveLength(1);
    expect(bands[0].monthKey).toBe('2026-08');
    expect(bands[0].members.map((m) => m.outletCode).sort()).toEqual(['P1', 'T']);
    expect(bands[0].targetSales).toBe(1000);
  });

  it('kelompok scope keeps the target in-band even out-of-kelompok', () => {
    const scan: PeerBandScan = {
      rows: [
        scanFixtureRow('1357.TJPPLU', '2026-08', 1000), // kelompok TJP
        scanFixtureRow('1030.BDGSET', '2026-08', 1000), // kelompok BDG
        scanFixtureRow('1030.BDGUKU', '2026-08', 1000), // kelompok BDG
      ],
    };
    const bands = buildPeerBands(scan, '1357.TJPPLU', 12, 'BDG');
    // Target (TJP) stays; the BDG peers are in scope.
    expect(bands[0].members.map((m) => m.outletCode).sort()).toEqual(['1030.BDGSET', '1030.BDGUKU', '1357.TJPPLU']);
    // And a BDG TARGET with kelompok TJP: the target stays in scope AND
    // the TJPPLU outlet (kelompok match) is its peer — BDGUKU drops out.
    const bands2 = buildPeerBands(scan, '1030.BDGSET', 12, 'TJP');
    expect(bands2[0].members.map((m) => m.outletCode)).toEqual(['1357.TJPPLU', '1030.BDGSET']);
  });
});

// ------------------------------------------------------------
// computeDeviasiRankForOutlet (PERF-FILTER1 B3)
// ------------------------------------------------------------

describe('computeDeviasiRankForOutlet', () => {
  function natRow(outletCode: string, itemName: string, nd: number, bom: number, absDev: number): DeviasiNationalScanRow {
    return { itemName, outletCode, nominalDeviasi: nd, qtyBom: bom, absQtyDeviasi: absDev };
  }
  function dispRow(itemName: string, nd: number, bom: number, overrides: Partial<Record<string, unknown>> = {}) {
    return {
      itemName,
      outletCode: 'T',
      outletName: 'Target Outlet',
      pic: null,
      satuan: 'KG',
      qtyDeviasi: -nd,
      qtyWaste: 0,
      qtyLossSurplus: -nd,
      pctLossSurplusToBom: null,
      qtyBom: bom,
      nominalDeviasi: nd,
      ...overrides,
    };
  }

  it('sequential national ranks, BOM rank NULL for qtyBom=0, ±50% bucket average', () => {
    const scanRows = [
      // National set (ABS nominalDeviasi DESC): X1 300, T1 200, Y1 100, T2 50.
      natRow('X', 'ITEM1', -300, 100, 30),
      natRow('T', 'ITEM1', -200, 100, 20),
      natRow('Y', 'ITEM1', -100, 80, 10),
      natRow('T', 'ITEM2', -50, 0, 5),   // qtyBom 0 → rankBom NULL
    ];
    const displayRows = [
      dispRow('ITEM1', -200, 100),
      dispRow('ITEM2', -50, 0),
    ];
    const out = computeDeviasiRankForOutlet(scanRows, displayRows, 'T', 30);
    expect(out).toHaveLength(2);
    // ITEM1: rankNominal 2 (after X's 300); rankBom among qtyBom>0 rows
    // sorted DESC: X(100), T(100) — tie → deterministic tiebreak by
    // outletCode ('T' < 'X') → T ranks 1st. Bucket: other outlets with
    // ITEM1, qtyBom>0, within [100×0.5, 100×1.5] = [50, 150]:
    // X(100) ✓, Y(80) ✓ → avg(30, 10) = 20.
    expect(out[0].rankNominal).toBe(2);
    expect(out[0].rankBom).toBe(1);
    expect(out[0].avgDeviasiByBom).toBeCloseTo(20, 10);
    // ITEM2: rankNominal 4; qtyBom 0 → rankBom NULL + bucket NULL.
    expect(out[1].rankNominal).toBe(4);
    expect(out[1].rankBom).toBeNull();
    expect(out[1].avgDeviasiByBom).toBeNull();
  });

  it('bucket bounds are INCLUSIVE (±50% exactly) and exclude the target itself', () => {
    const scanRows = [
      natRow('T', 'BOMTEST', -100, 100, 999), // target — excluded from its own bucket
      natRow('LO', 'BOMTEST', -10, 50, 11),   // exactly 0.5× → included
      natRow('HI', 'BOMTEST', -10, 150, 33),  // exactly 1.5× → included
      natRow('OUT', 'BOMTEST', -10, 151, 44), // 1.51× → excluded
      natRow('ZERO', 'BOMTEST', -10, 0, 55),  // qtyBom 0 → excluded
    ];
    const out = computeDeviasiRankForOutlet(
      scanRows,
      [dispRow('BOMTEST', -100, 100)],
      'T',
      30,
    );
    expect(out[0].avgDeviasiByBom).toBeCloseTo((11 + 33) / 2, 10);
  });

  it('no other bucket members → avgDeviasiByBom NULL (otherCount = 0)', () => {
    const scanRows = [
      natRow('T', 'SOLO', -100, 100, 20),
      natRow('X', 'SOLO', -10, 1000, 30), // BOM far outside the bucket
    ];
    const out = computeDeviasiRankForOutlet(scanRows, [dispRow('SOLO', -100, 100)], 'T', 30);
    expect(out[0].avgDeviasiByBom).toBeNull();
  });

  it('caps to the outlet top-N by ABS(nominalDeviasi) and coerces bigint', () => {
    const scanRows = [1, 2, 3, 4, 5].map((i) => natRow('T', `I${i}`, -i, 10, i));
    // 5 items with ABS nd 1..5 → top 3 = I5, I4, I3.
    const displayRows = [1, 2, 3, 4, 5].map((i) => dispRow(`I${i}`, -i, 10, { qtyBom: BigInt(10), nominalDeviasi: BigInt(-i) }));
    const out = computeDeviasiRankForOutlet(scanRows, displayRows, 'T', 3);
    expect(out.map((r) => r.itemName)).toEqual(['I5', 'I4', 'I3']);
    expect(out[0].qtyBom).toBe(10);
    expect(out[0].nominalDeviasi).toBe(-5);
  });

  it('display row missing from the scan (mutation race) degrades, never throws', () => {
    const out = computeDeviasiRankForOutlet(
      [natRow('X', 'OTHER', -1, 5, 1)],
      [dispRow('GHOST', -100, 100)],
      'T',
      30,
    );
    expect(out).toHaveLength(1);
    expect(out[0].rankNominal).toBe(1); // scan tail fallback (scanRows.length)
    expect(out[0].rankBom).toBeNull();
    expect(out[0].avgDeviasiByBom).toBeNull();
  });
});
