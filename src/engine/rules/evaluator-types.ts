// ============================================================
//  Rule Engine — Types
//  ----------------------------------------------------------
//  Extracted from evaluator.ts (Task 2-a). Pure type definitions
//  shared by the orchestrator, the test suite, and ruleService.
// ============================================================
import type { Severity } from '@/types/inventory';

export interface RuleCondition {
  [key: string]: unknown;
}

export interface Rule {
  code: string;
  name: string;
  category: string;
  severity: Severity;
  priority: number;
  condition: RuleCondition;
  narrativeTemplate?: string;
}

export interface RuleContext extends Record<string, unknown> {
  salesGrowth?: number | null;
  bomGrowth?: number | null;
  qtyDeviasiGrowth?: number | null;
  nominalDeviasiGrowth?: number | null;
  // BOM Correlation: growth of waste/susut/trial vs BOM
  wasteGrowth?: number | null;
  susutGrowth?: number | null;
  trialGrowth?: number | null;
  deviationBomRatio?: number | null; // qtyDeviasiGrowth / bomGrowth (proportionality check)
  deviationToSalesRatio?: number | null;
  deviationToBomRatio?: number | null;
  benchmarkFlag?: string | null;
  zScore?: number | null;
  qtyDeviasi?: number | null;
  nominalDeviasi?: number | null;
  qtyWaste?: number | null;
  qtySusut?: number | null;
  qtyTrial?: number | null;
  qtyLossSurplus?: number | null;
  // FIX SIGN-1: nominalLossSurplus used by 5 rules (HIGH_LOSS_NOMINAL, RESIDUAL_LOSS_*, HISTORICAL_*)
  nominalLossSurplus?: number | null;
  residualQty?: number | null;
  residualRatio?: number | null;
  tolerancePct?: number | null;
  pctQtyDeviasiToBom?: number | null;
  direction?: string | null;
  prevDirection?: string | null;
  isDirectionFlip?: boolean;
  absNominalDeviasi?: number | null;
  absQtyDeviasi?: number | null;
  // FIX: NET financial/quantity fields for NET-based rules (HIGH_LOSS_NOMINAL)
  absNominalLossSurplus?: number | null;
  absQtyLossSurplus?: number | null;
  // These allow rules.yaml to use dynamic field references instead of hardcoded values.
  stdDeviasiBomPct?: number;
  stdSusutPct?: number;
  stdWastePct?: number;
  stdTrialPct?: number;
  fallbackTolerancePct?: number;
  residualLossWarnPct?: number;
  residualLossHighPct?: number;
  highLossNominalThreshold?: number;
  historicalZscoreWarn?: number;
  historicalZscoreHigh?: number;
  salesDeviationFactor?: number;
  bomDeviationFactor?: number;
  // FIX-RULE-CONFIG (EVAL-02): separate threshold for BOM_DEVIATION_DISPROPORTIONATE
  // lower bound (decoupled from bomDeviationFactor upper-bound rule). Default 1.5.
  bomDisproportionateFactor?: number;
  // Bug 8 fix: fraud red flag — Waste+Susut+Trial exceeds total deviation
  isOverExplained?: boolean;
  // FIX CALC-2: ABS values for signed percent fields (for correct magnitude comparison)
  absPctQtyDeviasiToBom?: number | null;
  absTolerancePct?: number | null;
}
