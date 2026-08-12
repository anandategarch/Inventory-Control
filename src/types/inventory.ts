// ============================================================
//  TYPES — Inventory Control Intelligence Platform
// ============================================================

export type Direction = 'LOSS' | 'SURPLUS' | 'NEUTRAL';
export type Severity = 'NORMAL' | 'WARNING' | 'ABNORMAL';
export type DQSeverity = 'ERROR' | 'WARNING' | 'INFO';

export interface RawInventoryRow {
  [key: string]: unknown;
}

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

export interface GrowthMetrics {
  salesGrowth: number | null;
  bomGrowth: number | null;
  qtyDeviasiGrowth: number | null;
  nominalDeviasiGrowth: number | null;
  priceGrowth: number | null;
  deviationToSalesRatio: number | null;
  deviationToBomRatio: number | null;
}

export interface HistoricalStats {
  avgDevBom: number | null;
  stdDev: number | null;
  zScore: number | null;
  sampleSize: number;
}

export interface BenchmarkResult {
  outletDevBom: number | null;
  areaAvgDevBom: number | null;
  networkAvgDevBom: number | null;
  benchmarkFlag: 'ABOVE_AREA_AVG' | 'ABOVE_NETWORK_AVG' | 'NORMAL' | null;
  ratioVsArea: number | null;
  ratioVsNetwork: number | null;
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

export interface PriorityScore {
  itemId: number;
  itemName: string;
  outletId: number;
  outletCode: string;
  outletName: string;
  area: string;
  financialScore: number;
  operationalScore: number;
  financialRank: number | null;
  operationalRank: number | null;
  topAnomaly: AnomalyFlagResult | null;
}

export interface InvestigationItem {
  priority: 'P1' | 'P2' | 'P3';
  outletCode: string;
  outletName: string;
  area: string;
  itemName: string;
  issue: string;
  evidence: string;
  recommendedAction: string;
  ruleCodes: string[];
  absNominalDeviasi: number;
  deviationToBom: number | null;
  direction: Direction;
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

export interface DashboardData {
  executiveSummary: ExecutiveSummary;
  healthStatus: { normal: number; warning: number; abnormal: number };
  dqStatus: { ok: number; warnings: number; errors: number; issues: DQIssueSummary[] };
  growthComparison: GrowthMetrics;
  topItemsByNominal: Array<{ itemName: string; outletCode: string; absNominal: number; direction: Direction }>;
  topItemsByDevBom: Array<{ itemName: string; outletCode: string; devBom: number; tolerance: number | null }>;
  topOutlets: Array<{ outletCode: string; outletName: string; area: string; absNominal: number; devBom: number; areaAvg: number }>;
  deviationBreakdown: { waste: number; susut: number; trial: number; residual: number; total: number };
  lossVsSurplus: { loss: number; surplus: number; lossNominal: number; surplusNominal: number };
  investigationWorklist: InvestigationItem[];
  narrative: string;
  recommendation: Array<{ why: string; what: string[]; priority: 'P1' | 'P2' | 'P3' }>;
  trend: Array<{ weekLabel: string; devBom: number; sales: number; nominal: number }>;
  drilldownPath: string[];
}

export interface DQIssueSummary {
  code: string;
  severity: DQSeverity;
  message: string;
  count: number;
}

export interface FilterState {
  monthLabel: string | null;
  currentWeek: string | null;
  comparisonWeek: string | null;
  comparisonMonth: string | null;
  area: string | null;
  outletCode: string | null;
  itemName: string | null;
  comparisonMode: 'previous_week' | 'historical_average';
}
