// ============================================================
//  custom-compare-shape.test.ts — CUSTOM-COMPARE comparator semantics
//  --------------------------------------------------------
//  buildCustomComparison is the PURE shaper of section 13's entity set
//  (focus resto + direct picks + area expansions, out of the UNSCOPED
//  q-outlet-agg scan rows). These tests pin the comparison semantics
//  WITHOUT a DB:
//    - area pick = the area's WHOLE outlet population;
//    - focus dedupe (a focus that was also picked / sits in a picked
//      area stays ONE row, isFocus only);
//    - missing picks are DETECTED (no silent drop masquerading as zero);
//    - ranking |nominal deviasi| DESC;
//    - zero-deviation outlets are KEPT (unlike the section 11 league —
//      a clean comparator is information, not noise).
// ============================================================
import { describe, it, expect } from 'vitest';
import { buildCustomComparison } from '@/app/api/export-report/services/data-fetcher/custom-compare';
import type { OutletAggScanRow } from '@/lib/queries/outlets/outlet-agg-scan';

/** Minimal OutletAggScanRow factory — only the fields the shaper reads. */
function row(
  code: string,
  area: string,
  nominal: number,
): OutletAggScanRow {
  return {
    outletId: 0,
    outletCode: code,
    outletName: code.split('.').pop() ?? code,
    area,
    sales: 10_000_000,
    fNominalDeviasi: nominal,
    fTotalQtyDeviasi: Math.abs(nominal) / 1000,
    fTotalQtyBom: 100,
    fTotalQtyWaste: 0,
    fTotalQtySusut: 0,
    fTotalQtyTrial: 0,
    fTotalResidualQty: 0,
    fLossNominal: Math.abs(nominal),
    zeroDevCount: nominal === 0 ? 5 : 0,
    nonZeroDevCount: nominal === 0 ? 0 : 5,
    nominalDeviasi: nominal,
    devBom: 0,
    totalLoss: 0,
    totalSurplus: 0,
    residualQty: 0,
    qtyLossSurplus: 0,
    itemCount: 5,
    deviatingItems: 5,
    totalQtyDeviasi: 0,
    totalQtyBom: 100,
    grossAbsNominal: Math.abs(nominal),
    qtyDeviasiLoss: 0,
    residualNominal: 0,
    toleranceBreachCount: 0,
    toleranceBreachHighCount: 0,
    highDevBomCount: 0,
    benchmarkHighCount: 0,
    benchmarkWarningCount: 0,
    overExplainedCount: 0,
    hasNoTolerance: 0,
    highLossItem: 0,
    direction: 'LOSS',
    topItem: null,
    topItemNominal: 0,
  } as OutletAggScanRow;
}

// mlgpar (JATIM, focus) vs bdgsek (JABAR, pick) + JAKARTA area (3 resto).
const SCAN = [
  row('B.1001.MLGPAR', 'JATIM', -380_000),
  row('1042.BDGSEK', 'JABAR', 62_840),
  row('1101.JKTAAA', 'JAKARTA', -900_000),
  row('1102.JKTBBB', 'JAKARTA', 5_000),
  row('1103.JKTCCC', 'JAKARTA', 0), // zero-deviation outlet — still a row
  row('1203.CBICIL', 'JAWA TENGAH 2', 62_840_000), // outside every pick
];

describe('buildCustomComparison (CUSTOM-COMPARE section 13)', () => {
  it('focus + direct picks + area expansion, ranked |nominal| DESC', () => {
    const r = buildCustomComparison(
      SCAN,
      'B.1001.MLGPAR',
      ['1042.BDGSEK'],
      ['JAKARTA'],
    );
    expect(r.entities.map((e) => e.outletCode)).toEqual([
      '1101.JKTAAA',
      'B.1001.MLGPAR',
      '1042.BDGSEK',
      '1102.JKTBBB',
      '1103.JKTCCC',
    ]);
    expect(r.missingOutlets).toEqual([]);
    expect(r.missingAreas).toEqual([]);
  });

  it('an area pick brings the area’s WHOLE population, zero-deviation outlets included', () => {
    const r = buildCustomComparison(SCAN, null, [], ['JAKARTA']);
    const codes = r.entities.map((e) => e.outletCode);
    expect(codes).toContain('1103.JKTCCC'); // zero-dev comparator kept
    expect(codes).not.toContain('1203.CBICIL'); // outside the picked area
    expect(r.entities.every((e) => e.fromArea && !e.isFocus)).toBe(true);
  });

  it('the focus is deduped when it is ALSO picked or sits in a picked area', () => {
    // mlgpar picked directly AND JATIM would be its area — one row, focus only.
    const r = buildCustomComparison(
      SCAN,
      'B.1001.MLGPAR',
      ['B.1001.MLGPAR'],
      [],
    );
    const focusRows = r.entities.filter((e) => e.isFocus);
    expect(focusRows).toHaveLength(1);
    expect(focusRows[0]?.fromPick).toBe(false);
    expect(focusRows[0]?.fromArea).toBe(false);
    // picked-but-is-focus is NOT "missing" — it IS in the set.
    expect(r.missingOutlets).toEqual([]);
  });

  it('direct picks absent from the scan are reported as missing, not dropped silently', () => {
    const r = buildCustomComparison(
      SCAN,
      'B.1001.MLGPAR',
      ['1042.BDGSEK', '9999.NOSUCH'],
      ['JAKARTA', 'BALI'],
    );
    expect(r.missingOutlets).toEqual(['9999.NOSUCH']);
    expect(r.missingAreas).toEqual(['BALI']);
  });

  it('no picks at all → just the focus row (the section itself renders its guidance note)', () => {
    const r = buildCustomComparison(SCAN, 'B.1001.MLGPAR', [], []);
    expect(r.entities).toHaveLength(1);
    expect(r.entities[0]?.isFocus).toBe(true);
  });

  it('without a focus the set is the comparators alone (multi-resto compare)', () => {
    const r = buildCustomComparison(SCAN, null, ['1042.BDGSEK'], ['JAKARTA']);
    expect(r.focusCode).toBeNull();
    expect(r.focusName).toBeNull();
    expect(r.entities.every((e) => !e.isFocus)).toBe(true);
  });

  it('carries the raw picks for the provenance subhead', () => {
    const r = buildCustomComparison(SCAN, 'B.1001.MLGPAR', ['1042.BDGSEK'], ['JAKARTA']);
    expect(r.compareOutletCodes).toEqual(['1042.BDGSEK']);
    expect(r.compareAreas).toEqual(['JAKARTA']);
    expect(r.focusCode).toBe('B.1001.MLGPAR');
    expect(r.focusName).toBe('MLGPAR');
  });

  it('a focus with NO records this period lands in missingOutlets (no silent focus drop)', () => {
    const r = buildCustomComparison(SCAN, '9999.GHOST', ['1042.BDGSEK'], []);
    expect(r.entities.map((e) => e.outletCode)).toEqual(['1042.BDGSEK']);
    expect(r.entities.some((e) => e.isFocus)).toBe(false);
    expect(r.missingOutlets).toContain('9999.GHOST');
    expect(r.focusName).toBeNull();
    // focusCode stays set (the renderer explains "tanpa data di periode
    // ini" instead of pretending a focus row exists).
    expect(r.focusCode).toBe('9999.GHOST');
  });
});
