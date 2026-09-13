// Tests for src/lib/queries/price-effect.ts — Bennet decomposition bridge.
// FIX (BUG-2-c): two layers are tested:
//   1. decomposePriceEffectRows — the PURE per-row decomposition extracted
//      from queryPriceEffect (no DB): (a) regular matched rows are exact
//      (qtyEffect + priceEffect === netDelta, anomalyNominal = 0), (b) ghost
//      rows (Q=0 with N>0 on ONE side — qtyDeviasi & nominalDeviasi are
//      parsed from two INDEPENDENT Excel columns) produce a nonzero
//      anomalyNominal residual, (c) new/gone classification, (d) ghost on
//      both sides (Q=0 both periods, N differs).
//   2. queryPriceEffect — full query with a mocked DB (same pattern as
//      tests/queries/pareto.test.ts): the residual flows into
//      summary.anomalyNominal and the waterfall bridge identity
//        curr − prev === qtyEffect + priceEffect + new − gone + anomaly
//      closes EXACTLY.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  decomposePriceEffectRows,
  queryPriceEffect,
  type PriceEffectRawRow,
} from '@/lib/queries/price-effect';

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

/** Bridge identity helper: legs must sum back to the anchor delta EXACTLY. */
function bridgeGap(d: {
  currTotalNominal: number;
  prevTotalNominal: number;
  qtyEffect: number;
  priceEffect: number;
  newNominal: number;
  goneNominal: number;
  anomalyNominal: number;
}): number {
  return (d.currTotalNominal - d.prevTotalNominal)
    - (d.qtyEffect + d.priceEffect + d.newNominal - d.goneNominal + d.anomalyNominal);
}

describe('decomposePriceEffectRows — pure Bennet decomposition', () => {
  it('(a) regular matched rows: qtyEffect + priceEffect === netDelta per item and total; anomalyNominal = 0', () => {
    // 3 clean items, both prices observable:
    //   A: Pc=10, Pp=9  → qty=(10−8)×9.5=19,  price=(10−9)×9=9,   net=28
    //   B: Pc=12, Pp=10 → qty=(5−5)×11=0,     price=(12−10)×5=10,  net=10
    //   C: Pc=12, Pp=5  → qty=(4−10)×8.5=−51, price=(12−5)×7=49,  net=−2
    const rows: PriceEffectRawRow[] = [
      { name: 'A', qCurr: 10, qPrev: 8, nCurr: 100, nPrev: 72 },
      { name: 'B', qCurr: 5, qPrev: 5, nCurr: 60, nPrev: 50 },
      { name: 'C', qCurr: 4, qPrev: 10, nCurr: 48, nPrev: 50 },
    ];
    const d = decomposePriceEffectRows(rows);

    expect(d.matched).toHaveLength(3);
    expect(d.newItems).toBe(0);
    expect(d.goneItems).toBe(0);
    expect(d.newNominal).toBe(0);
    expect(d.goneNominal).toBe(0);
    // Per-item Bennet exactness
    for (const m of d.matched) {
      expect(m.qtyEffect + m.priceEffect).toBeCloseTo(m.netDelta, 10);
    }
    expect(d.matched[0].qtyEffect).toBeCloseTo(19, 10);
    expect(d.matched[0].priceEffect).toBeCloseTo(9, 10);
    expect(d.matched[1].qtyEffect).toBeCloseTo(0, 10);
    expect(d.matched[1].priceEffect).toBeCloseTo(10, 10);
    expect(d.matched[2].qtyEffect).toBeCloseTo(-51, 10);
    expect(d.matched[2].priceEffect).toBeCloseTo(49, 10);
    // Aggregate exactness + anchors + no anomaly
    const qtyTotal = d.matched.reduce((s, m) => s + m.qtyEffect, 0);
    const priceTotal = d.matched.reduce((s, m) => s + m.priceEffect, 0);
    const netTotal = d.matched.reduce((s, m) => s + m.netDelta, 0);
    expect(qtyTotal + priceTotal).toBeCloseTo(netTotal, 10);
    expect(d.anomalyNominal).toBe(0);
    expect(d.currTotalNominal).toBe(208); // 100 + 60 + 48
    expect(d.prevTotalNominal).toBe(172); // 72 + 50 + 50
    expect(bridgeGap({
      ...d, qtyEffect: qtyTotal, priceEffect: priceTotal,
      newNominal: d.newNominal, goneNominal: d.goneNominal,
    })).toBeCloseTo(0, 10);
  });

  it('(b) ghost row (qPrev=0, nPrev=400, qCurr=50, nCurr=500): anomalyNominal = −400, bridge identity exact', () => {
    // qPrev=0 with nPrev=400 → NOT "new" (nPrev ≠ 0) and NOT decomposable:
    // pricePrev=null → pAvg=priceCurr=10 → qtyEffect=(50−0)×10=500,
    // priceEffect=0, netDelta=100 → residual = 100 − 500 = −400.
    // Before BUG-2-c this residual silently broke the bridge (gap −400).
    const d = decomposePriceEffectRows([
      { name: 'Ghost', qCurr: 50, qPrev: 0, nCurr: 500, nPrev: 400 },
    ]);
    expect(d.matched).toHaveLength(1); // stays in matched — attribution unchanged
    expect(d.newItems).toBe(0);
    expect(d.goneItems).toBe(0);
    expect(d.anomalyNominal).toBeCloseTo(-400, 10);
    expect(d.matched[0].qtyEffect).toBeCloseTo(500, 10);
    expect(d.matched[0].priceEffect).toBe(0);
    expect(d.matched[0].netDelta).toBe(100);
    expect(d.currTotalNominal).toBe(500);
    expect(d.prevTotalNominal).toBe(400);
    // Bridge identity WITH the anomaly leg — exact 0
    expect(bridgeGap({
      ...d,
      qtyEffect: d.matched[0].qtyEffect,
      priceEffect: d.matched[0].priceEffect,
    })).toBeCloseTo(0, 10);
  });

  it('(b-sym) ghost on the CURRENT side (qCurr=0, nCurr=400, qPrev=50, nPrev=500): anomalyNominal = +400', () => {
    // priceCurr=null → pAvg=pricePrev=10 → qtyEffect=(0−50)×10=−500,
    // netDelta=−100 → residual = −100 − (−500) = +400.
    const d = decomposePriceEffectRows([
      { name: 'GhostCurr', qCurr: 0, qPrev: 50, nCurr: 400, nPrev: 500 },
    ]);
    expect(d.matched).toHaveLength(1);
    expect(d.anomalyNominal).toBeCloseTo(400, 10);
    expect(bridgeGap({
      ...d,
      qtyEffect: d.matched[0].qtyEffect,
      priceEffect: d.matched[0].priceEffect,
    })).toBeCloseTo(0, 10);
  });

  it('(c) pure new/gone rows: classified outside the decomposition, nominal carried by their own legs', () => {
    const d = decomposePriceEffectRows([
      // new: prev side fully empty (q AND n both 0)
      { name: 'New', qCurr: 12, qPrev: 0, nCurr: 240, nPrev: 0 },
      // gone: curr side fully empty
      { name: 'Gone', qCurr: 0, qPrev: 7, nCurr: 0, nPrev: 91 },
      // q=0 AND n=0 on BOTH sides → the new branch's inner guard
      // (qCurr > 0 || nCurr > 0) rejects it → row ignored entirely
      // (contributes nothing to anchors either)
      { name: 'Empty', qCurr: 0, qPrev: 0, nCurr: 0, nPrev: 0 },
    ]);
    expect(d.matched).toHaveLength(0);
    expect(d.newItems).toBe(1); // New only — the all-zero row is skipped
    expect(d.goneItems).toBe(1);
    expect(d.newNominal).toBe(240);
    expect(d.goneNominal).toBe(91);
    expect(d.anomalyNominal).toBe(0);
    expect(d.currTotalNominal).toBe(240);
    expect(d.prevTotalNominal).toBe(91);
    // Bridge: 240 − 91 === 0 + 0 + 240 − 91 + 0
    expect(bridgeGap({
      ...d, qtyEffect: 0, priceEffect: 0,
      newNominal: d.newNominal, goneNominal: d.goneNominal,
    })).toBeCloseTo(0, 10);
  });

  it('(d) ghost on BOTH sides (q=0 both periods, N differs): whole delta is the anomaly', () => {
    // Neither new (nPrev=100 ≠ 0) nor gone (nCurr=300 ≠ 0) → matched with
    // BOTH prices null → qtyEffect = priceEffect = 0, netDelta = 200 →
    // residual = 200.
    const d = decomposePriceEffectRows([
      { name: 'GhostBoth', qCurr: 0, qPrev: 0, nCurr: 300, nPrev: 100 },
    ]);
    expect(d.matched).toHaveLength(1);
    expect(d.matched[0].qtyEffect).toBe(0);
    expect(d.matched[0].priceEffect).toBe(0);
    expect(d.matched[0].netDelta).toBe(200);
    expect(d.anomalyNominal).toBe(200);
    expect(bridgeGap({
      ...d,
      qtyEffect: d.matched[0].qtyEffect,
      priceEffect: d.matched[0].priceEffect,
    })).toBeCloseTo(0, 10);
  });

  it('mixed population: identity holds across matched + ghost + new + gone simultaneously', () => {
    const d = decomposePriceEffectRows([
      { name: 'A', qCurr: 10, qPrev: 8, nCurr: 100, nPrev: 72 },   // matched clean
      { name: 'G1', qCurr: 50, qPrev: 0, nCurr: 500, nPrev: 400 }, // ghost (prev side)
      { name: 'G2', qCurr: 0, qPrev: 50, nCurr: 400, nPrev: 500 }, // ghost (curr side)
      { name: 'N1', qCurr: 12, qPrev: 0, nCurr: 240, nPrev: 0 },  // new
      { name: 'X1', qCurr: 0, qPrev: 7, nCurr: 0, nPrev: 91 },    // gone
    ]);
    expect(d.matched).toHaveLength(3);
    expect(d.newItems).toBe(1);
    expect(d.goneItems).toBe(1);
    // −400 (G1) + +400 (G2) cancel, but per-row residuals are what matter:
    expect(d.anomalyNominal).toBeCloseTo(-400 + 400, 10);
    const qtyEffect = d.matched.reduce((s, m) => s + m.qtyEffect, 0);
    const priceEffect = d.matched.reduce((s, m) => s + m.priceEffect, 0);
    expect(bridgeGap({
      ...d, qtyEffect, priceEffect,
      newNominal: d.newNominal, goneNominal: d.goneNominal,
    })).toBeCloseTo(0, 10);
  });
});

describe('queryPriceEffect — full query with mocked DB', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
    mockExecuteRaw.mockReset();
  });

  it('summary carries anomalyNominal and the bridge identity closes exactly (matched + ghost + new + gone)', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      { name: 'A', qCurr: 10, qPrev: 8, nCurr: 100, nPrev: 72 },   // matched clean (net 28)
      { name: 'G1', qCurr: 50, qPrev: 0, nCurr: 500, nPrev: 400 }, // ghost (prev side) → −400
      { name: 'G2', qCurr: 0, qPrev: 50, nCurr: 400, nPrev: 500 }, // ghost (curr side) → +400
      { name: 'N1', qCurr: 12, qPrev: 0, nCurr: 240, nPrev: 0 },   // new
      { name: 'X1', qCurr: 0, qPrev: 7, nCurr: 0, nPrev: 91 },     // gone
    ]);
    const r = await queryPriceEffect('WEEK 2', 'Agustus 2026', 'WEEK 2', 'Juli 2026', {});
    const s = r.summary;
    expect(s.hasCompare).toBe(true);
    expect(s.matchedItems).toBe(3);
    expect(s.newItems).toBe(1);
    expect(s.goneItems).toBe(1);
    expect(s.newNominal).toBe(240);
    expect(s.goneNominal).toBe(91);
    expect(s.currTotalNominal).toBe(100 + 500 + 400 + 240);
    expect(s.prevTotalNominal).toBe(72 + 400 + 500 + 91);
    // Contract field: plain number (never null), exact ghost residual sum.
    expect(typeof s.anomalyNominal).toBe('number');
    expect(s.anomalyNominal).toBeCloseTo(0, 10); // −400 + 400 cancel in this fixture
    // Bridge identity incl. the anomaly leg — EXACT.
    expect(
      (s.currTotalNominal - s.prevTotalNominal)
        - (s.qtyEffect + s.priceEffect + s.newNominal - s.goneNominal + s.anomalyNominal),
    ).toBeCloseTo(0, 10);
    // Items: sorted by |netDelta| desc, ghost rows included (attribution unchanged)
    expect(r.items.map((i) => i.item)).toEqual(['G1', 'G2', 'A']);
  });

  it('single ghost row (no cancellation): summary.anomalyNominal === −400, bridge exact', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      { name: 'A', qCurr: 10, qPrev: 8, nCurr: 100, nPrev: 72 },
      { name: 'Ghost', qCurr: 50, qPrev: 0, nCurr: 500, nPrev: 400 },
    ]);
    const r = await queryPriceEffect('WEEK 2', 'Agustus 2026', 'WEEK 2', 'Juli 2026', {});
    const s = r.summary;
    expect(s.anomalyNominal).toBeCloseTo(-400, 10);
    expect(
      (s.currTotalNominal - s.prevTotalNominal)
        - (s.qtyEffect + s.priceEffect + s.newNominal - s.goneNominal + s.anomalyNominal),
    ).toBeCloseTo(0, 10);
  });

  it('no compare / empty rows: anomalyNominal defaults to 0', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const r = await queryPriceEffect('WEEK 2', 'Agustus 2026', null, null, {});
    expect(r.summary.hasCompare).toBe(false);
    expect(r.summary.anomalyNominal).toBe(0);
    expect(r.items).toEqual([]);
  });
});
