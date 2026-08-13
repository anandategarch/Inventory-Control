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
