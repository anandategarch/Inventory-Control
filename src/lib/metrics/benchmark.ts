// ============================================================
//  BENCHMARK METRICS — Single Implementation
//  --------------------------------------------------------
//  Area/Network comparison: outlet Dev/BOM vs area avg vs network avg
//
//  NOTE: Benchmark flag from Z-Score (historical) adalah metric yang BERBEDA.
//  - Z-Score benchmark = outlet vs historical pattern-nya sendiri
//  - Area/Network benchmark = outlet vs outlet lain di periode yang sama
//
//  Master context #28: Historical comparison harus membandingkan
//  current period, previous period, historical, benchmark outlet,
//  benchmark area, benchmark network.
// ============================================================

export interface BenchmarkInput {
  /** Outlet's aggregate Dev/BOM (SUM(ABS(qtyDeviasi)) / SUM(ABS(qtyBom))) */
  outletDevBom: number;
  /** Area average Dev/BOM (same aggregate formula) */
  areaAvgDevBom: number;
  /** Network average Dev/BOM (same aggregate formula) */
  networkAvgDevBom: number;
  /** Best outlet Dev/BOM in network (lowest) */
  bestDevBom?: number | null;
  /** Area multiplier threshold (from Settings, default 1.5) */
  areaFactor: number;
  /** Network multiplier threshold (from Settings, default 2.0) */
  networkFactor: number;
}

export interface BenchmarkResult {
  /** Outlet Dev/BOM vs Area avg: outletDevBom / areaAvgDevBom */
  areaMultiplier: number | null;
  /** Outlet Dev/BOM vs Network avg: outletDevBom / networkAvgDevBom */
  networkMultiplier: number | null;
  /** Is outlet above area threshold? */
  isAboveArea: boolean;
  /** Is outlet above network threshold? */
  isAboveNetwork: boolean;
  /** Benchmark status */
  status: 'ABOVE_NETWORK' | 'ABOVE_AREA' | 'NORMAL';
  /** How many times worse than best outlet */
  vsBestMultiple: number | null;
}

/**
 * Compute area/network benchmark for an outlet
 *
 * Uses AGGREGATE Dev/BOM (SUM/SUM), not AVG(ABS(pctQtyDeviasiToBom))
 * Both outlet and area/network must use the SAME formula for fair comparison.
 */
export function computeBenchmark(input: BenchmarkInput): BenchmarkResult {
  const { outletDevBom, areaAvgDevBom, networkAvgDevBom, bestDevBom, areaFactor, networkFactor } = input;

  // Area multiplier
  const areaMultiplier = areaAvgDevBom > 0 ? outletDevBom / areaAvgDevBom : null;
  // Network multiplier
  const networkMultiplier = networkAvgDevBom > 0 ? outletDevBom / networkAvgDevBom : null;
  // vs Best outlet
  const vsBestMultiple = bestDevBom != null && bestDevBom > 0 ? outletDevBom / bestDevBom : null;

  // Determine status
  const isAboveNetwork = networkMultiplier != null && networkMultiplier > networkFactor;
  const isAboveArea = !isAboveNetwork && areaMultiplier != null && areaMultiplier > areaFactor;

  const status: BenchmarkResult['status'] = isAboveNetwork
    ? 'ABOVE_NETWORK'
    : isAboveArea
    ? 'ABOVE_AREA'
    : 'NORMAL';

  return {
    areaMultiplier,
    networkMultiplier,
    isAboveArea,
    isAboveNetwork,
    status,
    vsBestMultiple,
  };
}

/**
 * SQL template for area/network benchmark query
 * Uses AGGREGATE Dev/BOM (SUM/SUM), matching computeDevBomAggregate
 *
 * Area benchmark:
 *   SUM(ABS(qtyDeviasi)) / SUM(ABS(qtyBom)) WHERE area = X
 *
 * Network benchmark:
 *   SUM(ABS(qtyDeviasi)) / SUM(ABS(qtyBom)) — all outlets
 */
export const BENCHMARK_SQL = `
  -- Area aggregate Dev/BOM (SUM/SUM, not AVG)
  SELECT
    SUM(ABS(ir."qtyDeviasi")) as totalDeviasi,
    SUM(ABS(ir."qtyBom")) as totalBom,
    CASE WHEN SUM(ABS(ir."qtyBom")) > 0
      THEN SUM(ABS(ir."qtyDeviasi")) / SUM(ABS(ir."qtyBom"))
      ELSE 0 END as devBom
  FROM "InventoryRecord" ir
  WHERE ir."monthLabel" = {month} AND ir."weekLabel" = {week}
    {areaFilter}
`;
