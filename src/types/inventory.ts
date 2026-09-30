// ============================================================
//  TYPES — Inventory Control Intelligence Platform
//  FILTERDROP-1 dead-code audit: RawInventoryRow, GrowthMetrics,
//  HistoricalStats, BenchmarkResult, PriorityScore were REMOVED —
//  zero importers repo-wide (name-collisions with the LIVE types in
//  src/lib/metrics/* masked them in earlier audits; confirmed by grep).
// ============================================================

export type Direction = 'LOSS' | 'SURPLUS' | 'NEUTRAL';
export type Severity = 'NORMAL' | 'WARNING' | 'ABNORMAL';
export type DQSeverity = 'ERROR' | 'WARNING' | 'INFO';

export interface NormalizedRecord {
  akunPenyesuaian: string | null;
  status: string | null;
  resto: string;
  namaBahan: string;
  satuan: string | null;
  qtyBom: number | null;
  qtyCom: number | null;
  qtyDeviasi: number | null;
  qtyWaste: number | null;
  qtySusut: number | null;
  qtyTrial: number | null;
  qtyLossSurplus: number | null;
  nominalDeviasi: number | null;
  nominalWaste: number | null;
  nominalSusut: number | null;
  nominalTrial: number | null;
  nominalLossSurplus: number | null;
  qtyWasteSusut: number | null;
  pctWasteSusut: number | null;
  tolerancePct: number | null;
  toleranceRaw: string | null;
  pctQtyDeviasiToBom: number | null;
  pctQtyWasteToBom: number | null;
  pctQtySusutToBom: number | null;
  pctQtyTrialToBom: number | null;
  pctQtyLossToBom: number | null;
  area: string;
  bulan: string;
  bulan2: string | null;
  nominalSales: number | null;
  weekLabel: string;
  monthLabel: string;
  sourceFile: string;
  rowNumber: number;
}

export interface DerivedRecord extends NormalizedRecord {
  direction: Direction;
  residualQty: number | null;
  residualNominal: number | null;
  residualRatio: number | null;
  isOverExplained: boolean;
  netDeviationMismatch: boolean;
  absQtyDeviasi: number | null;
  absNominalDeviasi: number | null;
  absQtyLossSurplus: number | null;
  absNominalLossSurplus: number | null;
  outletCode: string;
  outletName: string;
  outletNumericCode: string;
  monthKey: string;
  weekKey: string;
  periodStart: number;
  periodEnd: number;
}

export interface RuleEvidence {
  [key: string]: unknown;
}

export interface AnomalyFlagResult {
  ruleCode: string;
  ruleName: string;
  category: string;
  severity: Severity;
  priority: number;
  evidence: RuleEvidence;
  narrative: string;
}

export interface ExecutiveSummary {
  period: { monthLabel: string; weekLabel: string; comparisonWeek: string | null };
  sales: { current: number; previous: number | null; growth: number | null };
  nominalDeviasi: { current: number; previous: number | null; growth: number | null };
  qtyBom: { current: number; previous: number | null; growth: number | null };
  qtyDeviasi: { current: number; previous: number | null; growth: number | null };
  qtyWaste: { current: number; previous: number | null; growth: number | null };
  qtySusut: { current: number; previous: number | null; growth: number | null };
  qtyTrial: { current: number; previous: number | null; growth: number | null };
  qtyLossSurplus: { current: number; previous: number | null; growth: number | null };
  totalLoss: number;
  totalSurplus: number;
  lossToSales: number | null;
  surplusToSales: number | null;
  deviationToBom: number | null;
  residualLossQty: number;
  residualLossPct: number | null;
}

export interface DQIssueSummary {
  code: string;
  severity: DQSeverity;
  message: string;
  count: number;
}
