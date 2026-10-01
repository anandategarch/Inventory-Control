// Tests for src/lib/queries/outlets/peer-band.ts — GODSPLIT-W4 shared
// ±10% peer sales-band predicate builder (5 call sites × 3 textual
// variants consolidated; per-site semantics deliberately preserved).
//
// The builder is a pure Prisma.Sql fragment factory (no DB call) —
// tested by inspecting the resulting SQL text + parameter values
// (same style as tests/queries/shared.test.ts), plus a byte-parity
// composition proof: splicing the fragment into a tagged template
// must yield the SAME strings/values arrays as the former inline
// predicate text (final SQL identical, no new bind parameters, so
// the '0.1' assertions in waste-series.test.ts /
// outlet-monthly-series.test.ts keep passing).
import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  peerBandPredicate,
  PEER_BAND_TOLERANCE,
  PEER_BAND_UNBOUNDED_FALLBACK,
} from '@/lib/queries/outlets/peer-band';

// Helper: extract SQL text from a Prisma.Sql.
// Prisma.Sql exposes .strings (array of text fragments) + .values (array of params).
function sqlText(sql: Prisma.Sql): string {
  const s = (sql as unknown as { strings?: unknown[] }).strings;
  if (Array.isArray(s)) return s.join('$PARAM$');
  return String(sql);
}

// Helper: extract parameter values from a Prisma.Sql.
function sqlValues(sql: Prisma.Sql): unknown[] {
  const v = (sql as unknown as { values?: unknown[] }).values;
  return Array.isArray(v) ? v : [];
}

describe('peerBandPredicate — Variant A (unboundedFallback, CASE WHEN)', () => {
  it('renders the exact guarded CASE text used by peer-comparison.ts + peer-top-items.ts', () => {
    const frag = peerBandPredicate('sm.sales', 't.sales', { unboundedFallback: true });
    const text = sqlText(frag);
    // Byte-for-byte the former inline predicate (leading AND included).
    expect(text).toBe(
      'AND ABS(COALESCE(sm.sales, 0) - t.sales) <= CASE WHEN t.sales > 0 THEN t.sales * 0.1 ELSE 999999999 END',
    );
    expect(text).toContain('CASE WHEN t.sales > 0 THEN t.sales * 0.1 ELSE 999999999 END');
    expect(String(PEER_BAND_UNBOUNDED_FALLBACK)).toBe('999999999');
    expect(text).toContain(String(PEER_BAND_UNBOUNDED_FALLBACK));
  });

  it('binds ZERO parameters (caller statement text + param order unchanged)', () => {
    // Every piece is a Prisma.raw literal — no $n placeholders are added,
    // so the surrounding query's parameter numbering is untouched.
    expect(sqlValues(peerBandPredicate('sm.sales', 't.sales', { unboundedFallback: true }))).toEqual([]);
  });
});

describe('peerBandPredicate — Variant B (plain, strict)', () => {
  it('renders the exact plain text used by peer-comparison-items.ts — no CASE, no fallback', () => {
    const frag = peerBandPredicate('sm.sales', 't.sales');
    expect(sqlText(frag)).toBe('AND ABS(COALESCE(sm.sales, 0) - t.sales) <= t.sales * 0.1');
    expect(String(PEER_BAND_TOLERANCE)).toBe('0.1');
  });

  it('strict band: target sales = 0 → width 0 (999999999 fallback ABSENT)', () => {
    // Semantics deliberately NOT unified with Variant A: the plain
    // variant must never match all outlets on a zero-sales target.
    const text = sqlText(peerBandPredicate('sm.sales', 't.sales'));
    expect(text).not.toContain('CASE WHEN');
    expect(text).not.toContain('999999999');
  });
});

describe('peerBandPredicate — Variant C (targetSales alias, strict)', () => {
  it('uses the per-month band aliases from peer-track-record.ts + waste/peer-zscore.ts', () => {
    const text = sqlText(peerBandPredicate('s.sales', 'ts."targetSales"'));
    expect(text).toBe('AND ABS(COALESCE(s.sales, 0) - ts."targetSales") <= ts."targetSales" * 0.1');
    expect(text).toContain('ts."targetSales"');
    expect(text).not.toContain('CASE WHEN');
  });
});

describe('peerBandPredicate — byte-parity composition (GODSPLIT-W4 contract)', () => {
  it('splices into a tagged template IDENTICALLY to the former inline text (Variant A shape)', () => {
    // Mirrors peer-comparison.ts / peer-top-items.ts: a bound param before
    // the predicate + a Prisma.empty kelompok filter slot after it.
    const month = '2026-08';
    const withFragment = Prisma.sql`WHERE o."monthLabel" = ${month}
      AND COALESCE(sm.sales, 0) > 0
      ${peerBandPredicate('sm.sales', 't.sales', { unboundedFallback: true })}
      ${Prisma.empty}
    ORDER BY ABS(COALESCE(sm.sales, 0) - t.sales)`;
    const inline = Prisma.sql`WHERE o."monthLabel" = ${month}
      AND COALESCE(sm.sales, 0) > 0
      AND ABS(COALESCE(sm.sales, 0) - t.sales) <= CASE WHEN t.sales > 0 THEN t.sales * 0.1 ELSE 999999999 END
      ${Prisma.empty}
    ORDER BY ABS(COALESCE(sm.sales, 0) - t.sales)`;
    // Prisma merges raw-only fragments into the parent's strings array →
    // both statements serialize to the SAME SQL text AND param list.
    expect(sqlText(withFragment)).toBe(sqlText(inline));
    expect(sqlValues(withFragment)).toEqual(sqlValues(inline));
    expect(sqlValues(withFragment)).toEqual([month]);
    expect(sqlText(withFragment)).toContain('CASE WHEN t.sales > 0 THEN t.sales * 0.1 ELSE 999999999 END');
  });

  it('splices into a tagged template IDENTICALLY to the former inline text (Variant C shape)', () => {
    // Mirrors the band CTE tail of peer-track-record.ts / waste/peer-zscore.ts
    // (band CTE closes right after the predicate), with a bound week param.
    const week = 'WEEK 4';
    const withFragment = Prisma.sql`WHERE ir."weekLabel" = ${week}
      WHERE COALESCE(s.sales, 0) > 0
        ${peerBandPredicate('s.sales', 'ts."targetSales"')}
    ),`;
    const inline = Prisma.sql`WHERE ir."weekLabel" = ${week}
      WHERE COALESCE(s.sales, 0) > 0
        AND ABS(COALESCE(s.sales, 0) - ts."targetSales") <= ts."targetSales" * 0.1
    ),`;
    expect(sqlText(withFragment)).toBe(sqlText(inline));
    expect(sqlValues(withFragment)).toEqual(sqlValues(inline));
    expect(sqlValues(withFragment)).toEqual([week]);
  });
});
