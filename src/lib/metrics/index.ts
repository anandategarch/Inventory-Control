// ============================================================
//  METRICS ENGINE — Barrel Export
//  --------------------------------------------------------
//  Import dari sini untuk semua perhitungan metric.
//  Jangan hitung metric di tempat lain.
//
//  Usage:
//    import { computeDevBomAggregate, computeHealthScore, computeSalesModePerOutlet }
//    from '@/lib/metrics';
// ============================================================

// Definitions (Single Source of Truth)
export * from './definitions';

// Deviation metrics (Gross/Explained/Net/DevBOM/Residual/Health/Priority)
export {
  computeDevBomPerRow,
  computeResidual,
  computeResidualRatio,
  computeExplainedPct,
  computeDevBomAggregate,
  computeResidualPctAggregate,
  computeExplainedPctAggregate,
  computeLossToSales,
  computeHealthScore,
  computePriority,
  type AggregateInput,
  type PriorityInput,
} from './deviation';

// Sales metrics (MODE per outlet)
export {
  computeSalesModePerOutlet,
  computeTotalSales,
  SALES_MODE_SQL_CTE,
} from './sales';

// Historical metrics (Z-Score, trend, benchmark flag from historical)
export {
  computeZScore,
  computeDeterioration,
  calcZScoreFromStats,
  HISTORICAL_STATS_SQL,
  type HistoricalStats,
  type HistoricalInput,
  type HistoricalResult,
} from './historical';

// Benchmark metrics (Area/Network comparison)
export {
  computeBenchmark,
  BENCHMARK_SQL,
  type BenchmarkInput,
  type BenchmarkResult,
} from './benchmark';

// Growth metrics (signed/abs growth, price effect decomposition)
export {
  calcGrowth,
  calcGrowthAbs,
  computeGrowthResult,
  safeRatio,
  calcAvgPrice,
  computePriceEffect,
  type GrowthResult,
  type PriceEffectResult,
} from './growth';
