// Tests for src/lib/queries/outlets/change-analysis.ts (CHANGE-1 —
// "Rata-rata Perubahan").
//
// Covers:
//  1. computeChangeStats (pure) — baseline excludes the current pair,
//     magnitude-change deltas (audit #11), swing/ratio, flip, new, and
//     the no-current / single-point edges.
//  2. classifyChange — DATA_KURANG / BARU_BERGERAK / ANOMALI / NORMAL,
//     including the Rp noise gate.
//  3. queryOutletChangeAnalysis — ONE scan, ranking order (BARU_BERGERAK →
//     ANOMALI ratio desc → NORMAL → DATA_KURANG) + counts.
//  4. queryOutletChangeItems — outlet additivity from item rows, item
//     attribution (contribution/opposes/isAnomali), vanished-item
//     zero-snapshot closure, dormant-item skip, new-item semantics.
//
// Mock @/lib/db (same vi.hoisted pattern as top-growth.test.ts). Each
// withStatementTimeout query fires 2 SET LOCAL $executeRaw calls.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  computeChangeStats,
  classifyChange,
  queryOutletChangeAnalysis,
  queryOutletChangeItems,
  type ChangeSeriesPoint,
} from '@/lib/queries/outlets/change-analysis';

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

function sqlText(sql: unknown): string {
  if (sql == null) return '';
  if (Array.isArray(sql)) return sql.map((x) => String(x ?? '')).join('');
  return String(sql);
}

const T = { ratioThreshold: 2.0, minPairs: 4, minNominal: 100_000 };
const CUR = '2026-08';

function pt(monthKey: string, nominal: number, qty = 0): ChangeSeriesPoint {
  return { monthKey, nominal, qty };
}

// Fixture helpers — the raw scan row shapes.
function orow(code: string, monthKey: string, nd: number, qd: number) {
  return { outletCode: code, outletName: `Resto ${code}`, area: 'AREA-1', monthKey, nd, qd };
}
function irow(item: string, monthKey: string, nd: number, qd = 0, satuan: string | null = 'kg') {
  return { outletCode: 'OLT-1', outletName: 'Resto 1', itemName: item, satuan, monthKey, nd, qd };
}

const M = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];

describe('computeChangeStats (pure)', () => {
  it('baseline excludes the current pair; magnitude-change delta; ratio; pct', () => {
    // 8 same-week snapshots; the first 7 form 6 baseline pairs of ±1M each,
    // the current pair (Jul→Agu) swings 6M → ratio 6.
    const points = M.map((m, i) => pt(m, i % 2 === 0 ? -10_000_000 : -11_000_000, i % 2 === 0 ? -100 : -110));
    points[7] = pt('2026-08', -16_000_000, -160);
    const s = computeChangeStats(points, CUR);

    expect(s.hasCurrent).toBe(true);
    expect(s.pairs).toBe(6);
    expect(s.avgSwingNominal).toBe(1_000_000);
    expect(s.avgSwingQty).toBe(10);
    // |%Δ| alternates: |−11M→−10M| = 1/11, |−10M→−11M| = 0.1.
    expect(s.avgPctNominal).toBeCloseTo((0.1 + 1 / 11) / 2, 5);
    expect(s.swingNominal).toBe(6_000_000);
    expect(s.swingQty).toBe(60);
    expect(s.deltaNominal).toBe(6_000_000); // |−16M| − |−10M| — grew (memburuk)
    expect(s.deltaQty).toBe(60);
    expect(s.deltaPctNominal).toBeCloseTo(0.6, 5); // calcGrowthAbs magnitude
    expect(s.ratioNominal).toBe(6);
    expect(s.ratioQty).toBe(6);
    expect(s.isFlip).toBe(false);
    expect(s.isNew).toBe(false);
  });

  it('LOSS↔SURPLUS flip: isFlip true, full swing kept, magnitude delta reflects the reversal', () => {
    const points = M.map((m) => pt(m, -10_000_000));
    points[7] = pt('2026-08', 10_000_000);
    const s = computeChangeStats(points, CUR);

    expect(s.isFlip).toBe(true);
    expect(s.swingNominal).toBe(20_000_000); // full position swing
    expect(s.deltaNominal).toBe(0); // |+10M| − |−10M| — magnitude unchanged
    expect(s.deltaPctNominal).toBe(0); // equal magnitudes — the ↺ marker + swing carry the story
  });

  it('no current-month snapshot → hasCurrent false, everything null', () => {
    const points = M.slice(0, 7).map((m) => pt(m, -10_000_000));
    const s = computeChangeStats(points, CUR);
    expect(s.hasCurrent).toBe(false);
    expect(s.pairs).toBe(0);
    expect(s.deltaNominal).toBeNull();
    expect(s.ratioNominal).toBeNull();
  });

  it('single current point → isNew, delta = full magnitude, no ratio/pct (zero base)', () => {
    const s = computeChangeStats([pt(CUR, -3_500_000, -30)], CUR);
    expect(s.hasCurrent).toBe(true);
    expect(s.isNew).toBe(true);
    expect(s.pairs).toBe(0);
    expect(s.deltaNominal).toBe(3_500_000);
    expect(s.swingNominal).toBe(3_500_000);
    expect(s.deltaPctNominal).toBeNull(); // prev = 0 → small-base guard
    expect(s.ratioNominal).toBeNull(); // no baseline
  });

  it('unsorted input is tolerated (sorted by monthKey internally)', () => {
    const points = [pt('2026-08', -16_000_000), pt('2026-01', -10_000_000)];
    const s = computeChangeStats(points, CUR);
    expect(s.hasCurrent).toBe(true);
    expect(s.deltaNominal).toBe(6_000_000);
  });
});

describe('classifyChange', () => {
  const base = {
    hasCurrent: true, pairs: 6, avgSwingNominal: 0, avgSwingQty: 0, avgPctNominal: null,
    deltaNominal: 0, deltaQty: 0, deltaPctNominal: null,
    swingNominal: 0, swingQty: 0, ratioNominal: null, ratioQty: null,
    isFlip: false, isNew: false,
  };

  it('DATA_KURANG when pairs < minPairs or no current', () => {
    expect(classifyChange({ ...base, pairs: 3, swingNominal: 9_000_000, ratioNominal: 9 }, T)).toBe('DATA_KURANG');
    expect(classifyChange({ ...base, hasCurrent: false }, T)).toBe('DATA_KURANG');
  });

  it('BARU_BERGERAK when the baseline is flat and the current swing clears the Rp gate', () => {
    expect(classifyChange({ ...base, avgSwingNominal: 0, swingNominal: 2_000_000 }, T)).toBe('BARU_BERGERAK');
  });

  it('ANOMALI when ratio ≥ threshold AND swing clears the Rp gate', () => {
    expect(classifyChange({ ...base, avgSwingNominal: 1_000_000, swingNominal: 6_000_000, ratioNominal: 6 }, T)).toBe('ANOMALI');
  });

  it('noise gate: huge ratio on a tiny swing stays NORMAL', () => {
    // avg ±20rb → now 90rb = 4.5× but only 90rb — below the 100rb gate.
    expect(classifyChange({ ...base, avgSwingNominal: 20_000, swingNominal: 90_000, ratioNominal: 4.5 }, T)).toBe('NORMAL');
  });

  it('flat baseline + tiny swing stays NORMAL (not BARU_BERGERAK)', () => {
    expect(classifyChange({ ...base, avgSwingNominal: 0, swingNominal: 50_000 }, T)).toBe('NORMAL');
  });
});

describe('queryOutletChangeAnalysis', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
    mockExecuteRaw.mockReset();
  });

  it('ONE scan; ranking BARU_BERGERAK → ANOMALI (ratio desc) → NORMAL → DATA_KURANG; counts', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      // OUT-A — ANOMALI ratio 6 (baseline ±1M, now 6M)
      ...M.map((m, i) => orow('OUT-A', m, i === 7 ? -16_000_000 : (i % 2 === 0 ? -10_000_000 : -11_000_000), i === 7 ? -160 : (i % 2 === 0 ? -100 : -110))),
      // OUT-B — BARU_BERGERAK (flat ±0 history, now moves 2M)
      ...M.map((m, i) => orow('OUT-B', m, i === 7 ? -7_000_000 : -5_000_000, 0)),
      // OUT-C — NORMAL (big but habitual ±2M, now 1M)
      ...M.map((m, i) => orow('OUT-C', m, i === 7 ? -19_000_000 : (i % 2 === 0 ? -18_000_000 : -20_000_000), 0)),
      // OUT-D — DATA_KURANG (only Jul+Agu → 0 baseline pairs)
      orow('OUT-D', '2026-07', -3_000_000, 0),
      orow('OUT-D', '2026-08', -4_000_000, 0),
      // OUT-E — DATA_KURANG (no current-month snapshot at all)
      ...M.slice(0, 7).map((m) => orow('OUT-E', m, -1_000_000, 0)),
      // OUT-F — ANOMALI ratio 20 with a LOSS↔SURPLUS flip
      ...M.map((m, i) => orow('OUT-F', m, i === 7 ? 10_000_000 : (i % 2 === 0 ? -10_000_000 : -11_000_000), 0)),
    ].flat());

    const r = await queryOutletChangeAnalysis({
      month: 'Agustus 2026', week: 'WEEK 4', currentMonthKey: CUR, filters: {}, thresholds: T,
    });

    // ONE scan (withStatementTimeout = 2 SET LOCALs).
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(2);
    const sql = sqlText(mockQueryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain('ir."weekLabel" =');
    expect(sql).toContain('sf."monthKey" <=');
    expect(sql).toContain('SUM(ir."nominalDeviasi")');
    expect(sql).toContain('SUM(ir."qtyDeviasi")');

    // Ranking order + statuses.
    expect(r.outlets.map((o) => o.outletCode)).toEqual(['OUT-B', 'OUT-F', 'OUT-A', 'OUT-C', 'OUT-D', 'OUT-E']);
    expect(r.outlets.map((o) => o.status)).toEqual([
      'BARU_BERGERAK', 'ANOMALI', 'ANOMALI', 'NORMAL', 'DATA_KURANG', 'DATA_KURANG',
    ]);
    // BARU_BERGERAK rows carry no ratio (∞); ANOMALI rows carry theirs.
    expect(r.outlets[0].ratioNominal).toBeNull();
    expect(r.outlets[1].ratioNominal).toBe(20);
    expect(r.outlets[1].isFlip).toBe(true);
    expect(r.outlets[2].ratioNominal).toBe(6);
    expect(r.outlets[2].deltaNominal).toBe(6_000_000);
    // DATA_KURANG trailing rows still carry their (unranked) stats.
    expect(r.outlets[4].hasCurrent).toBe(true);
    expect(r.outlets[5].hasCurrent).toBe(false);

    expect(r.counts).toEqual({ ranked: 4, anomali: 2, baruBergerak: 1, dataKurang: 2 });
  });

  it('empty scan → zero counts, empty outlets', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const r = await queryOutletChangeAnalysis({
      month: 'Agustus 2026', week: 'WEEK 4', currentMonthKey: CUR, filters: {}, thresholds: T,
    });
    expect(r.outlets).toEqual([]);
    expect(r.counts).toEqual({ ranked: 0, anomali: 0, baruBergerak: 0, dataKurang: 0 });
  });
});

describe('queryOutletChangeItems', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
    mockExecuteRaw.mockReset();
  });

  it('outlet stats derive additively from item rows; attribution: contribution, opposes, anomali, vanished, dormant, new', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      // AYAM — habitual ±100k, now swings 7M → ANOMALI (Ide 2 core case).
      ...M.map((m, i) => irow('AYAM', m, i === 7 ? -9_000_000 : (i % 2 === 0 ? -2_000_000 : -2_100_000), i === 7 ? -90 : (i % 2 === 0 ? -20 : -21))),
      // BERAS — big but habitual (±1.8M, now 1M) → NORMAL, still a top mover.
      ...M.map((m, i) => irow('BERAS', m, i === 7 ? -19_000_000 : (i % 2 === 0 ? -18_000_000 : -19_800_000))),
      // MINYAK — improves −3M while the outlet worsens → opposesOutlet.
      ...M.map((m, i) => irow('MINYAK', m, i === 7 ? -1_000_000 : -4_000_000)),
      // GULA — present through Jul, gone in Agu → vanished (zero snapshot).
      ...M.slice(0, 7).map((m) => irow('GULA', m, -3_000_000)),
      // LAMA — dormant since Mar (not current, not prev month) → skipped.
      ...M.slice(0, 3).map((m) => irow('LAMA', m, -500_000)),
      // BARU — appears only in Agu.
      irow('BARU', '2026-08', 500_000),
    ]);

    const r = await queryOutletChangeItems({
      month: 'Agustus 2026', week: 'WEEK 4', currentMonthKey: CUR, outletCode: 'OLT-1', filters: {}, thresholds: T,
    });

    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    const sql = sqlText(mockQueryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain('i.name as "itemName"');
    expect(sql).toContain('sf."monthKey" <=');

    // Outlet block — additive sums across ALL item rows per month (LAMA
    // ends in Mar): Jan −27.5, Feb −29.4, Mar −27.5, Apr −28.9, May −27.0,
    // Jun −28.9, Jul −27.0, Aug −28.5 (M). Baseline swing sum = 10.9M.
    // Net delta only +1.5M (the cancellers!) — AYAM's +7M is partially
    // cancelled by GULA/MINYAK −3M each: exactly the Ide-3 story.
    expect(r.outlet).not.toBeNull();
    expect(r.outlet!.outletName).toBe('Resto 1');
    expect(r.outlet!.deltaNominal).toBe(1_500_000);
    expect(r.outlet!.avgSwingNominal).toBeCloseTo(10_900_000 / 6, 3);
    expect(r.outlet!.swingNominal).toBe(1_500_000);
    expect(r.outlet!.ratioNominal).toBeCloseTo(1_500_000 / (10_900_000 / 6), 5);
    expect(r.outlet!.status).toBe('NORMAL'); // net move is small — the items tell the story

    // Participation: dormant LAMA is skipped; the other 5 remain. MINYAK
    // precedes GULA on the 3M tie (stable sort keeps row/Map insertion order).
    expect(r.items.map((i) => i.itemName)).toEqual(['AYAM', 'MINYAK', 'GULA', 'BERAS', 'BARU']);

    const ayam = r.items[0];
    expect(ayam.swingNominal).toBe(7_000_000);
    expect(ayam.ratioNominal).toBe(70);
    expect(ayam.isAnomali).toBe(true); // ≥ 2× its own ±100k habit
    expect(ayam.opposesOutlet).toBe(false); // worsened with the outlet
    expect(ayam.deltaNominal).toBe(7_000_000);
    // Contribution = 7M / (7 + 3 + 3 + 1 + 0.5)M.
    expect(ayam.contributionPct).toBeCloseTo((7 / 14.5) * 100, 3);

    const gula = r.items[2];
    expect(gula.isNew).toBe(false);
    expect(gula.deltaNominal).toBe(-3_000_000); // deviation disappeared
    expect(gula.swingNominal).toBe(3_000_000);
    expect(gula.opposesOutlet).toBe(true); // improved while outlet worsened

    const minyak = r.items[1];
    expect(minyak.deltaNominal).toBe(-3_000_000);
    expect(minyak.opposesOutlet).toBe(true);

    const beras = r.items[3];
    expect(beras.isAnomali).toBe(false); // big but habitual — no badge
    expect(beras.opposesOutlet).toBe(false); // |−19M|−|−18M| = +1M — worsened WITH the outlet

    const baru = r.items[4];
    expect(baru.isNew).toBe(true);
    expect(baru.deltaNominal).toBe(500_000);
    expect(baru.ratioNominal).toBeNull();
    expect(baru.isAnomali).toBe(false); // 0 baseline pairs → DATA_KURANG, no badge
    expect(baru.opposesOutlet).toBe(false); // +0.5M worsened with the outlet
  });

  it('no rows → outlet null, items empty', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const r = await queryOutletChangeItems({
      month: 'Agustus 2026', week: 'WEEK 4', currentMonthKey: CUR, outletCode: 'OLT-X', filters: {}, thresholds: T,
    });
    expect(r.outlet).toBeNull();
    expect(r.items).toEqual([]);
  });
});
