// Tests for buildInventoryWhere — Prisma WhereInput builder.
// Pure function (no DB calls) — tests filter composition + sentinel pattern.
import { describe, it, expect } from 'vitest';
import { buildInventoryWhere } from '@/lib/build-where';

describe('buildInventoryWhere — base shape', () => {
  it('always sets monthLabel + weekLabel', () => {
    const w = buildInventoryWhere({ week: 'WEEK 1', month: 'Agustus 2026' });
    expect(w.monthLabel).toBe('Agustus 2026');
    expect(w.weekLabel).toBe('WEEK 1');
  });

  it('does not set area when area is undefined or "all"', () => {
    expect(buildInventoryWhere({ week: 'WEEK 1', month: 'M' })).not.toHaveProperty('area');
    expect(buildInventoryWhere({ week: 'WEEK 1', month: 'M', area: 'all' })).not.toHaveProperty('area');
  });

  it('sets area when provided', () => {
    const w = buildInventoryWhere({ week: 'WEEK 1', month: 'M', area: 'JAWA TIMUR 1' });
    expect(w.area).toBe('JAWA TIMUR 1');
  });

  it('sets item.name with insensitive contains when itemName provided', () => {
    const w: any = buildInventoryWhere({ week: 'WEEK 1', month: 'M', itemName: 'ayam' });
    expect(w.item).toBeDefined();
    expect(w.item.name).toEqual({ contains: 'ayam', mode: 'insensitive' });
  });
});

describe('buildInventoryWhere — kelompok sentinel', () => {
  it('returns __NO_MATCH__ when kelompok selected but no matching outlets', () => {
    const w: any = buildInventoryWhere({
      week: 'WEEK 1', month: 'M',
      kelompok: 'BDG',
      kelompokOutletCodes: [], // empty → sentinel
    });
    expect(w.outlet).toEqual({ code: { in: ['__NO_MATCH__'] } });
  });

  it('filters to kelompokOutletCodes when only kelompok is set', () => {
    const w: any = buildInventoryWhere({
      week: 'WEEK 1', month: 'M',
      kelompok: 'BDG',
      kelompokOutletCodes: ['1010.BDGABC', '1011.BDGXYZ'],
    });
    expect(w.outlet).toEqual({ code: { in: ['1010.BDGABC', '1011.BDGXYZ'] } });
  });

  it('intersects kelompok + PIC when both set (with sentinel for empty PIC)', () => {
    const w: any = buildInventoryWhere({
      week: 'WEEK 1', month: 'M',
      kelompok: 'BDG',
      kelompokOutletCodes: ['A.BDG1', 'B.BDG2'],
      picOutletCodes: [], // empty PIC → sentinel
    });
    expect(w.outlet).toEqual({ code: { in: ['__NO_MATCH__'] } });
  });

  it('intersects kelompok + PIC when both set (real intersection)', () => {
    const w: any = buildInventoryWhere({
      week: 'WEEK 1', month: 'M',
      kelompok: 'BDG',
      kelompokOutletCodes: ['A.BDG1', 'B.BDG2', 'C.MLG1'],
      picOutletCodes: ['B.BDG2', 'C.MLG1', 'D.JKT1'],
    });
    // Intersection = ['B.BDG2', 'C.MLG1']
    expect(w.outlet).toEqual({ code: { in: ['B.BDG2', 'C.MLG1'] } });
  });

  it('returns sentinel when intersection is empty (kelompok + PIC)', () => {
    const w: any = buildInventoryWhere({
      week: 'WEEK 1', month: 'M',
      kelompok: 'BDG',
      kelompokOutletCodes: ['A.BDG1', 'B.BDG2'],
      picOutletCodes: ['C.MLG1', 'D.JKT1'], // no overlap
    });
    expect(w.outlet).toEqual({ code: { in: ['__NO_MATCH__'] } });
  });

  it('validates outletCode against kelompok when both set', () => {
    const w: any = buildInventoryWhere({
      week: 'WEEK 1', month: 'M',
      kelompok: 'BDG',
      kelompokOutletCodes: ['A.BDG1', 'B.BDG2'],
      outletCode: 'A.BDG1',
    });
    expect(w.outlet).toEqual({ code: 'A.BDG1' });
  });

  it('returns sentinel when outletCode NOT in kelompok set', () => {
    const w: any = buildInventoryWhere({
      week: 'WEEK 1', month: 'M',
      kelompok: 'BDG',
      kelompokOutletCodes: ['A.BDG1', 'B.BDG2'],
      outletCode: 'C.MLG1', // not in kelompok
    });
    expect(w.outlet).toEqual({ code: '__NO_MATCH__' });
  });
});

describe('buildInventoryWhere — PIC only', () => {
  it('filters to picOutletCodes when only PIC is set', () => {
    const w: any = buildInventoryWhere({
      week: 'WEEK 1', month: 'M',
      picOutletCodes: ['A.BDG1', 'B.BDG2'],
    });
    expect(w.outlet).toEqual({ code: { in: ['A.BDG1', 'B.BDG2'] } });
  });

  it('returns sentinel when PIC list is empty', () => {
    const w: any = buildInventoryWhere({
      week: 'WEEK 1', month: 'M',
      picOutletCodes: [],
    });
    expect(w.outlet).toEqual({ code: { in: ['__NO_MATCH__'] } });
  });

  it('intersects PIC + outletCode when both set (in list)', () => {
    const w: any = buildInventoryWhere({
      week: 'WEEK 1', month: 'M',
      picOutletCodes: ['A.BDG1', 'B.BDG2'],
      outletCode: 'A.BDG1',
    });
    expect(w.outlet).toEqual({ code: { in: ['A.BDG1'] } });
  });

  it('returns sentinel when outletCode NOT in PIC list', () => {
    const w: any = buildInventoryWhere({
      week: 'WEEK 1', month: 'M',
      picOutletCodes: ['A.BDG1', 'B.BDG2'],
      outletCode: 'C.MLG1',
    });
    expect(w.outlet).toEqual({ code: { in: ['__NO_MATCH__'] } });
  });
});

describe('buildInventoryWhere — outletCode only', () => {
  it('filters by single outletCode', () => {
    const w: any = buildInventoryWhere({
      week: 'WEEK 1', month: 'M',
      outletCode: 'A.BDG1',
    });
    expect(w.outlet).toEqual({ code: 'A.BDG1' });
  });

  it('ignores outletCode = "all"', () => {
    const w: any = buildInventoryWhere({
      week: 'WEEK 1', month: 'M',
      outletCode: 'all',
    });
    expect(w.outlet).toBeUndefined();
  });
});

describe('buildInventoryWhere — combined filters', () => {
  it('combines area + itemName + outlet', () => {
    const w: any = buildInventoryWhere({
      week: 'WEEK 1', month: 'M',
      area: 'JAWA TIMUR 1',
      itemName: 'ayam',
      outletCode: 'A.BDG1',
    });
    expect(w.area).toBe('JAWA TIMUR 1');
    expect(w.item.name).toEqual({ contains: 'ayam', mode: 'insensitive' });
    expect(w.outlet).toEqual({ code: 'A.BDG1' });
  });

  it('honors "all" sentinel values across multiple filters', () => {
    const w: any = buildInventoryWhere({
      week: 'WEEK 1', month: 'M',
      area: 'all',
      kelompok: 'all',
      outletCode: 'all',
    });
    expect(w.area).toBeUndefined();
    expect(w.outlet).toBeUndefined();
  });
});
