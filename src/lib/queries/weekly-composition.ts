// ============================================================
//  Weekly Composition — per-week category aggregates within ONE month
//  --------------------------------------------------------
//  REFINE-3 (user request: "Grafik komposisi Waste/Susut/Trial/
//  Loss-Surplus" + "Tren akumulasi mingguan (Week 1+2+)").
//
//  Unlike queryTrendAgg (which aggregates the SAME weekLabel ACROSS
//  months), this query spans ALL weeks of ONE month — the export slices
//  the result to the weeks up to the exported week (weeks after it
//  belong to the upcoming period; same exclusion rule the item-trend
//  matrix applies to months).
//
//  Column semantics:
//  - nominalWaste/Susut/Trial/LossSurplus = SUM(ABS(nominal*)): each
//    category's MAGNITUDE — the composition chart stacks them and their
//    sum is the week's total deviation magnitude (absTotal).
//  - nominalDeviasi = SIGNED SUM (the KPI convention — kept so callers
//    can show the net alongside the magnitude).
//
//  Implementation notes (mirrors item-trend-matrix.ts):
//  - withStatementTimeout + buildSqlFilters (area/kelompok/outletCode/
//    picOutletCodes + itemName when the caller passes it).
//  - Prisma.sql tagged templates only. BigInt coercion via Number().
// ============================================================
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from './shared';

/** One week's category composition within the month. */
export interface WeeklyCompositionRow {
  weekLabel: string;
  /** Parsed week number ("WEEK 2" → 2; 0 when unparsable). */
  weekNo: number;
  /** SUM(ABS(nominalWaste)) — magnitude. */
  nominalWaste: number;
  /** SUM(ABS(nominalSusut)) — magnitude. */
  nominalSusut: number;
  /** SUM(ABS(nominalTrial)) — magnitude. */
  nominalTrial: number;
  /** SUM(ABS(nominalLossSurplus)) — magnitude. */
  nominalLossSurplus: number;
  /** SIGNED SUM(nominalDeviasi) — net (KPI convention). */
  nominalDeviasi: number;
  /** waste + susut + trial + lossSurplus magnitudes — the stack total. */
  absTotal: number;
}

export interface WeeklyCompositionResult {
  /** Sorted by weekNo ASC. */
  rows: WeeklyCompositionRow[];
}

/**
 * Per-week category composition for ONE month (all of its weeks).
 *
 * @param opts.month    e.g. "September 2026".
 * @param opts.filters  dashboard filters (area/kelompok/outlet/pic/itemName).
 */
export async function queryWeeklyComposition(opts: {
  month: string;
  filters: SqlFilterOpts;
}): Promise<WeeklyCompositionResult> {
  const { month, filters } = opts;
  const f = buildSqlFilters(filters);

  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{
    weekLabel: string;
    nominalWaste: number | bigint;
    nominalSusut: number | bigint;
    nominalTrial: number | bigint;
    nominalLossSurplus: number | bigint;
    nominalDeviasi: number | bigint;
  }>>`
    SELECT ir."weekLabel",
      COALESCE(SUM(ABS(ir."nominalWaste")), 0) as "nominalWaste",
      COALESCE(SUM(ABS(ir."nominalSusut")), 0) as "nominalSusut",
      COALESCE(SUM(ABS(ir."nominalTrial")), 0) as "nominalTrial",
      COALESCE(SUM(ABS(ir."nominalLossSurplus")), 0) as "nominalLossSurplus",
      COALESCE(SUM(ir."nominalDeviasi"), 0) as "nominalDeviasi"
    FROM "InventoryRecord" ir
    WHERE ir."monthLabel" = ${month}
      ${f}
    GROUP BY ir."weekLabel"
    ORDER BY ir."weekLabel" ASC
  `);

  return {
    rows: rows.map((r) => {
      const waste = Number(r.nominalWaste) || 0;
      const susut = Number(r.nominalSusut) || 0;
      const trial = Number(r.nominalTrial) || 0;
      const lossSurplus = Number(r.nominalLossSurplus) || 0;
      return {
        weekLabel: r.weekLabel,
        weekNo: parseInt(r.weekLabel.replace(/\D/g, ''), 10) || 0,
        nominalWaste: waste,
        nominalSusut: susut,
        nominalTrial: trial,
        nominalLossSurplus: lossSurplus,
        nominalDeviasi: Number(r.nominalDeviasi) || 0,
        absTotal: waste + susut + trial + lossSurplus,
      };
    }).sort((a, b) => a.weekNo - b.weekNo),
  };
}
