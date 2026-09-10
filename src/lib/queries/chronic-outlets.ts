// ============================================================
//  Chronic-vs-Spike Outlets Query — month-grain behavioral lens
//  --------------------------------------------------------
//  ONE physical scan of the WHOLE MONTH (per outlet × week sums,
//  materialized once — `wk` is referenced by 3 CTEs), rolled up
//  per outlet, answering the auditor's pattern question:
//
//    "Apakah outlet ini menyimpang TIAP MINGGU (kronis) atau
//     hanya buruk di satu minggu (spike/sekali-timu)?"
//
//  Classification (shaping layer — heuristic constants, NOT
//  runtime settings; they define the pattern, not a parity-
//  critical threshold):
//    CHRONIC  — deviation in ≥ CHRONIC_MIN_WEEKS weeks AND
//               ≥ 75% of the weeks the outlet has data in
//               → systemic problem (process / PIC / leakage)
//    SPIKE    — worst week holds ≥ 60% of the month's |deviasi|
//               (needs ≥ 2 weeks of data) → one-off event
//    VARIABLE — everything else
//
//  Month-grain BY DESIGN (no week param): "does this outlet
//  deviate every week?" needs ALL weeks of the month. The FE
//  therefore keys this query on month only — switching weeks
//  does not refetch it.
//
//  MOMENTUM lens (v2, same single month scan): the per-outlet ×
//  per-week rows of `wk` are ALSO returned via a UNION ALL
//  (lens, to_jsonb(row)) branch — the shaping layer computes
//  each outlet's MOMENTUM = avg |deviasi| of the SECOND half of
//  its weeks vs the FIRST half (index split, gaps ignored).
//  Worsening = the outlet's deviation magnitude is growing.
//
//  PERF: same philosophy as PAKET E compliance — 1 scan + cheap
//  aggregate passes over the materialized set, 1 round
//  trip. Direct $queryRaw rows are shaped with num()/asString()
//  coercion (Prisma returns bigint for COUNT(*) — toNum handles
//  it via Number(); to_jsonb in the UNION branch also normalizes
//  bigint COUNTs to JSON numbers).
// ============================================================
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from './shared';
import { toNum } from '@/lib/format';

/** Pattern classification — see header for semantics. */
export type ChronicClass = 'CHRONIC' | 'SPIKE' | 'VARIABLE';

/** Dominant net-direction across the outlet's weeks. */
export type DominantDirection = 'LOSS' | 'SURPLUS' | 'MIXED';

/** Momentum: avg |deviasi| second half vs first half of the
 *  outlet's weeks (null when < 3 weeks or undefined baseline). */
export type Momentum = 'WORSE' | 'BETTER' | 'STABLE' | null;

export interface ChronicOutletRow {
  outletId: number;
  outletCode: string;
  outletName: string;
  area: string;
  /** Weeks of the month this outlet has records in. */
  nWeeks: number;
  /** Weeks with any |nominalDeviasi| > 0. */
  nDevWeeks: number;
  /** Weeks with unexplained residual > 0 (audit-strongest repeat signal). */
  nResidWeeks: number;
  /** Weeks whose NET deviation was negative / positive. */
  nLossWeeks: number;
  nSurplusWeeks: number;
  totalAbsNom: number;
  totalResidNom: number;
  /** totalAbsNom / nDevWeeks (0 when no deviating week). */
  avgPerDevWeek: number;
  maxWeekLabel: string | null;
  maxWeekAbs: number;
  /** maxWeekAbs / totalAbsNom * 100 — spike concentration (0-100). */
  maxWeekSharePct: number;
  dominant: DominantDirection;
  classification: ChronicClass;
  /** avg |dev| second-half vs first-half (percentage points);
 *   null when < 3 weeks or zero first-half baseline. */
  momentumPct: number | null;
  momentum: Momentum;
}

export interface ChronicOutletsResult {
  outlets: ChronicOutletRow[];
  /** Most weeks any filtered outlet has — context "dari N minggu". */
  nWeeksMax: number;
  chronicCount: number;
  spikeCount: number;
  /** Outlets whose |deviasi| magnitude is growing (momentum WORSE). */
  worseningCount: number;
}

// ------------------------------------------------------------
//  Pattern heuristics (documented constants)
// ------------------------------------------------------------
const CHRONIC_MIN_WEEKS = 3;
const CHRONIC_MIN_SHARE = 0.75;
const SPIKE_MIN_WEEKS = 2;
const SPIKE_SHARE = 0.6;

// Momentum band: |change| below this is "stable" (documented heuristic).
const MOMENTUM_BAND = 25;

// ------------------------------------------------------------
//  Raw SQL row — one per (lens, payload) pair
// ------------------------------------------------------------
interface RawChronicLensRow {
  lens: string;
  payload: unknown;
}

export async function queryChronicOutlets(
  month: string,
  filters: SqlFilterOpts,
  topN = 15,
): Promise<ChronicOutletsResult> {
  const f = buildSqlFilters(filters);

  const rows = await withStatementTimeout((tx) => tx.$queryRaw<RawChronicLensRow[]>`
    WITH wk AS (
      SELECT ir."outletId", ir."weekLabel", ir."area",
        COALESCE(SUM(ABS(ir."nominalDeviasi")), 0) AS "absNom",
        COALESCE(SUM(ir."nominalDeviasi"), 0)      AS "netNom",
        COALESCE(SUM(ABS(ir."residualNominal")), 0) AS "residNom"
      FROM "InventoryRecord" ir
      WHERE ir."monthLabel" = ${month}
        ${f}
      GROUP BY ir."outletId", ir."weekLabel", ir."area"
    ),
    ranked AS (
      SELECT "outletId", "weekLabel", "absNom",
        ROW_NUMBER() OVER (PARTITION BY "outletId"
          ORDER BY "absNom" DESC, "weekLabel") AS rn
      FROM wk
    ),
    top_week AS (
      SELECT "outletId", "weekLabel" AS "maxWeekLabel", "absNom" AS "maxWeekAbs"
      FROM ranked
      WHERE rn = 1
    ),
    outlet_agg AS (
      SELECT wk."outletId", MIN(wk."area") AS "area",
        COUNT(*) AS "nWeeks",
        COUNT(*) FILTER (WHERE wk."absNom" > 0) AS "nDevWeeks",
        COUNT(*) FILTER (WHERE wk."residNom" > 0) AS "nResidWeeks",
        COUNT(*) FILTER (WHERE wk."netNom" < 0) AS "nLossWeeks",
        COUNT(*) FILTER (WHERE wk."netNom" > 0) AS "nSurplusWeeks",
        COALESCE(SUM(wk."absNom"), 0) AS "totalAbsNom",
        COALESCE(SUM(wk."residNom"), 0) AS "totalResidNom"
      FROM wk
      GROUP BY wk."outletId"
    )
    SELECT 'outlet' AS lens, to_jsonb(j) AS payload FROM (
      SELECT o."code" AS "outletCode", o."name" AS "outletName",
        a."outletId", a."area", a."nWeeks", a."nDevWeeks", a."nResidWeeks",
        a."nLossWeeks", a."nSurplusWeeks", a."totalAbsNom", a."totalResidNom",
        tw."maxWeekLabel", tw."maxWeekAbs"
      FROM outlet_agg a
      JOIN "Outlet" o ON o."id" = a."outletId"
      LEFT JOIN top_week tw ON tw."outletId" = a."outletId"
    ) j
    UNION ALL
    SELECT 'week' AS lens, to_jsonb(j) AS payload FROM (
      SELECT wk."outletId", wk."weekLabel",
        CAST(SUBSTRING(wk."weekLabel" FROM '[0-9]+') AS int) AS "weekNo",
        wk."absNom"
      FROM wk
    ) j
  `);

  return shapeChronic(rows, topN);
}

// ------------------------------------------------------------
//  Shaping — coerce, classify, sort (chronics first), slice
// ------------------------------------------------------------
function num(v: unknown): number {
  return toNum(v) ?? 0;
}
function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function classifyChronic(nWeeks: number, nDevWeeks: number, maxWeekSharePct: number): ChronicClass {
  const chronic = nWeeks >= CHRONIC_MIN_WEEKS
    && nDevWeeks >= CHRONIC_MIN_WEEKS
    && nDevWeeks >= Math.ceil(CHRONIC_MIN_SHARE * nWeeks);
  if (chronic) return 'CHRONIC';
  const spike = nWeeks >= SPIKE_MIN_WEEKS && maxWeekSharePct >= SPIKE_SHARE * 100;
  return spike ? 'SPIKE' : 'VARIABLE';
}

const CLASS_RANK: Record<ChronicClass, number> = { CHRONIC: 0, SPIKE: 1, VARIABLE: 2 };

function shapeChronic(rows: RawChronicLensRow[], topN: number): ChronicOutletsResult {
  // Partition rows by lens (same pattern as compliance shaping).
  const byLens = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const list = byLens.get(r.lens) ?? [];
    list.push(asRecord(r.payload));
    byLens.set(r.lens, list);
  }

  // ---- 'week' lens → per-outlet momentum ----
  // Weekly |deviasi| rows sorted by weekNo; momentum compares the
  // average of the SECOND half of the outlet's weeks vs the FIRST
  // half (index split — gaps in the calendar are ignored).
  const weekly = new Map<number, { weekNo: number; absNom: number }[]>();
  for (const r of byLens.get('week') ?? []) {
    const outletId = num(r.outletId);
    const list = weekly.get(outletId) ?? [];
    list.push({ weekNo: num(r.weekNo), absNom: num(r.absNom) });
    weekly.set(outletId, list);
  }
  const momentumOf = (outletId: number, nWeeks: number): { pct: number | null; m: Momentum } => {
    const weeks = weekly.get(outletId);
    if (!weeks || nWeeks < CHRONIC_MIN_WEEKS) return { pct: null, m: null };
    weeks.sort((a, b) => a.weekNo - b.weekNo);
    const split = Math.floor(weeks.length / 2);
    const firstAvg = weeks.slice(0, split).reduce((acc, w) => acc + w.absNom, 0) / split;
    const second = weeks.slice(split);
    const secondAvg = second.reduce((acc, w) => acc + w.absNom, 0) / second.length;
    if (firstAvg <= 0) {
      // Zero first-half baseline: any second-half activity is "new".
      return { pct: null, m: secondAvg > 0 ? 'WORSE' : null };
    }
    const pct = ((secondAvg - firstAvg) / firstAvg) * 100;
    const m: Momentum = pct >= MOMENTUM_BAND ? 'WORSE'
      : pct <= -MOMENTUM_BAND ? 'BETTER' : 'STABLE';
    return { pct, m };
  };

  const shaped: ChronicOutletRow[] = (byLens.get('outlet') ?? [])
    .map((r) => {
      const nWeeks = num(r.nWeeks);
      const nDevWeeks = num(r.nDevWeeks);
      const totalAbsNom = num(r.totalAbsNom);
      const maxWeekAbs = num(r.maxWeekAbs);
      const nLossWeeks = num(r.nLossWeeks);
      const nSurplusWeeks = num(r.nSurplusWeeks);
      const maxWeekSharePct = totalAbsNom > 0 ? (maxWeekAbs / totalAbsNom) * 100 : 0;
      const { pct: momentumPct, m: momentum } = momentumOf(num(r.outletId), nWeeks);
      return {
        outletId: num(r.outletId),
        outletCode: asString(r.outletCode) ?? '?',
        outletName: asString(r.outletName) ?? '?',
        area: asString(r.area) ?? '-',
        nWeeks,
        nDevWeeks,
        nResidWeeks: num(r.nResidWeeks),
        nLossWeeks,
        nSurplusWeeks,
        totalAbsNom,
        totalResidNom: num(r.totalResidNom),
        avgPerDevWeek: nDevWeeks > 0 ? totalAbsNom / nDevWeeks : 0,
        maxWeekLabel: asString(r.maxWeekLabel),
        maxWeekAbs,
        maxWeekSharePct,
        dominant: (nLossWeeks > nSurplusWeeks ? 'LOSS'
          : nSurplusWeeks > nLossWeeks ? 'SURPLUS' : 'MIXED') as DominantDirection,
        classification: classifyChronic(nWeeks, nDevWeeks, maxWeekSharePct),
        momentumPct,
        momentum,
      };
    })
    .filter((r) => r.totalAbsNom > 0 || r.totalResidNom > 0);

  shaped.sort((a, b) =>
    CLASS_RANK[a.classification] - CLASS_RANK[b.classification]
    || b.totalAbsNom - a.totalAbsNom
    || a.outletId - b.outletId);

  return {
    outlets: shaped.slice(0, topN),
    nWeeksMax: shaped.reduce((acc, r) => Math.max(acc, r.nWeeks), 0),
    chronicCount: shaped.filter((r) => r.classification === 'CHRONIC').length,
    spikeCount: shaped.filter((r) => r.classification === 'SPIKE').length,
    worseningCount: shaped.filter((r) => r.momentum === 'WORSE').length,
  };
}
