// ============================================================
//  ANOMALY RULES — TypeScript module (replaces rules.yaml)
//  Edit/add rules here WITHOUT touching engine code.
//  Using TS instead of YAML for Vercel serverless compatibility.
// ============================================================
import type { Rule } from '@/engine/rules/evaluator';

export const RULES: Rule[] = [
  // ===== SALES-RELATED =====
  {
    code: 'SALES_DEVIATION_MISMATCH',
    name: 'Deviation growth far exceeds sales growth',
    category: 'SALES',
    severity: 'ABNORMAL',
    priority: 90,
    condition: {
      all: [
        { salesGrowth: { gt: 0 } },
        { nominalDeviasiGrowth: { gt: { mul: ['salesGrowth', 2] } } },
      ],
    },
    narrativeTemplate: 'Deviasi meningkat {{nominalDeviasiGrowth}} jauh melebihi pertumbuhan Sales {{salesGrowth}}.',
  },
  {
    code: 'SALES_DEV_DECREASE',
    name: 'Sales down but deviation up',
    category: 'SALES',
    severity: 'ABNORMAL',
    priority: 85,
    condition: {
      all: [
        { salesGrowth: { lt: 0 } },
        { nominalDeviasiGrowth: { gt: 0 } },
      ],
    },
    narrativeTemplate: 'Sales turun {{salesGrowth}} namun deviasi naik {{nominalDeviasiGrowth}}.',
  },
  // ===== BOM-RELATED =====
  {
    code: 'BOM_DEVIATION_MISMATCH',
    name: 'Deviation growth far exceeds BOM growth',
    category: 'BOM',
    severity: 'ABNORMAL',
    priority: 88,
    condition: {
      all: [
        { bomGrowth: { gt: 0 } },
        { qtyDeviasiGrowth: { gt: { mul: ['bomGrowth', 2] } } },
      ],
    },
    narrativeTemplate: 'QTY BOM meningkat {{bomGrowth}}, namun QTY deviation meningkat {{qtyDeviasiGrowth}}.',
  },
  {
    code: 'BOM_DOWN_DEV_UP',
    name: 'BOM down but deviation up',
    category: 'BOM',
    severity: 'ABNORMAL',
    priority: 82,
    condition: {
      all: [
        { bomGrowth: { lt: 0 } },
        { qtyDeviasiGrowth: { gt: 0 } },
      ],
    },
    narrativeTemplate: 'QTY BOM turun {{bomGrowth}} namun QTY deviation naik {{qtyDeviasiGrowth}}.',
  },
  // ===== BOM CORRELATION (Waste/Susut/Trial vs BOM) =====
  {
    code: 'WASTE_BOM_MISMATCH',
    name: 'Waste tidak sejalan dengan BOM',
    category: 'BOM',
    severity: 'WARNING',
    priority: 55,
    condition: {
      any: [
        { all: [{ bomGrowth: { lt: 0 } }, { wasteGrowth: { gt: 0 } }] },
        { all: [{ bomGrowth: { gt: 0 } }, { wasteGrowth: { lt: 0 } }] },
      ],
    },
    narrativeTemplate: 'QTY Waste {{wasteGrowth}} tidak sejalan dengan QTY BOM {{bomGrowth}}.',
  },
  {
    code: 'SUSUT_BOM_MISMATCH',
    name: 'Susut tidak sejalan dengan BOM',
    category: 'BOM',
    severity: 'WARNING',
    priority: 54,
    condition: {
      any: [
        { all: [{ bomGrowth: { lt: 0 } }, { susutGrowth: { gt: 0 } }] },
        { all: [{ bomGrowth: { gt: 0 } }, { susutGrowth: { lt: 0 } }] },
      ],
    },
    narrativeTemplate: 'QTY Susut {{susutGrowth}} tidak sejalan dengan QTY BOM {{bomGrowth}}.',
  },
  {
    code: 'TRIAL_BOM_MISMATCH',
    name: 'Trial tidak sejalan dengan BOM',
    category: 'BOM',
    severity: 'WARNING',
    priority: 53,
    condition: {
      any: [
        { all: [{ bomGrowth: { lt: 0 } }, { trialGrowth: { gt: 0 } }] },
        { all: [{ bomGrowth: { gt: 0 } }, { trialGrowth: { lt: 0 } }] },
      ],
    },
    narrativeTemplate: 'QTY Trial {{trialGrowth}} tidak sejalan dengan QTY BOM {{bomGrowth}}.',
  },
  {
    code: 'BOM_DEVIATION_DISPROPORTIONATE',
    name: 'Deviasi naik tidak proporsional dengan BOM',
    category: 'BOM',
    severity: 'WARNING',
    priority: 56,
    condition: {
      all: [
        { bomGrowth: { gt: 0 } },
        { qtyDeviasiGrowth: { gt: 0 } },
        { deviationBomRatio: { gt: 1.5 } },
      ],
    },
    narrativeTemplate: 'QTY Deviasi naik {{qtyDeviasiGrowth}} tidak proporsional dengan BOM {{bomGrowth}} (rasio {{deviationBomRatio}}×).',
  },
  // ===== TOLERANCE =====
  {
    code: 'TOLERANCE_BREACH_HIGH',
    name: 'Deviation/BOM exceeds tolerance significantly',
    category: 'TOLERANCE',
    severity: 'ABNORMAL',
    priority: 80,
    condition: {
      all: [
        { tolerancePct: { not_null: true } },
        { pctQtyDeviasiToBom: { gt: { mul: ['tolerancePct', 2] } } },
      ],
    },
    narrativeTemplate: 'Deviation/BOM {{pctQtyDeviasiToBom}} melebihi tolerance {{tolerancePct}} lebih dari 2x.',
  },
  {
    code: 'TOLERANCE_BREACH',
    name: 'Deviation/BOM exceeds tolerance',
    category: 'TOLERANCE',
    severity: 'WARNING',
    priority: 70,
    condition: {
      all: [
        { tolerancePct: { not_null: true } },
        { pctQtyDeviasiToBom: { gt: 'tolerancePct' } },
      ],
    },
    narrativeTemplate: 'Deviation/BOM {{pctQtyDeviasiToBom}} melebihi tolerance {{tolerancePct}}.',
  },
  {
    code: 'TOLERANCE_NOT_SET_HIGH_DEV',
    name: 'High deviation but no tolerance set',
    category: 'TOLERANCE',
    severity: 'WARNING',
    priority: 65,
    condition: {
      all: [
        { tolerancePct: { is_null: true } },
        { pctQtyDeviasiToBom: { gt: 0.10 } },
      ],
    },
    narrativeTemplate: 'Deviation/BOM {{pctQtyDeviasiToBom}} tinggi namun tolerance belum diset (analytical flag).',
  },
  // ===== RESIDUAL =====
  {
    code: 'RESIDUAL_LOSS_HIGH',
    name: 'High residual loss after Waste/Susut/Trial',
    category: 'RESIDUAL',
    severity: 'ABNORMAL',
    priority: 75,
    condition: {
      all: [
        { direction: { eq: 'LOSS' } },
        { residualRatio: { gt: 0.70 } },
      ],
    },
    narrativeTemplate: 'Residual Loss {{residualRatio}} ({{residualQty}}) tinggi setelah dikurangi Waste/Susut/Trial.',
  },
  {
    code: 'RESIDUAL_LOSS_WARN',
    name: 'Moderate residual loss',
    category: 'RESIDUAL',
    severity: 'WARNING',
    priority: 60,
    condition: {
      all: [
        { direction: { eq: 'LOSS' } },
        { residualRatio: { gt: 0.50 } },
        { residualRatio: { lte: 0.70 } },
      ],
    },
    narrativeTemplate: 'Residual Loss {{residualRatio}} moderat.',
  },
  // ===== DIRECTION =====
  {
    code: 'HIGH_LOSS_NOMINAL',
    name: 'High nominal loss',
    category: 'DIRECTION',
    severity: 'WARNING',
    priority: 55,
    condition: {
      all: [
        { direction: { eq: 'LOSS' } },
        { absNominalDeviasi: { gt: 1000000 } },
      ],
    },
    narrativeTemplate: 'Nominal loss {{absNominalDeviasi}} tinggi.',
  },
  // ===== BENCHMARK =====
  {
    code: 'BENCHMARK_ABOVE_AREA',
    name: 'Outlet dev/bom above area average',
    category: 'BENCHMARK',
    severity: 'WARNING',
    priority: 50,
    condition: { benchmarkFlag: { eq: 'ABOVE_AREA_AVG' } },
    narrativeTemplate: 'Deviation/BOM outlet di atas rata-rata area.',
  },
  {
    code: 'BENCHMARK_ABOVE_NETWORK',
    name: 'Outlet dev/bom above network average',
    category: 'BENCHMARK',
    severity: 'ABNORMAL',
    priority: 72,
    condition: { benchmarkFlag: { eq: 'ABOVE_NETWORK_AVG' } },
    narrativeTemplate: 'Deviation/BOM outlet jauh di atas rata-rata network.',
  },
  // ===== HISTORICAL =====
  {
    code: 'HISTORICAL_ABNORMAL',
    name: 'Deviation abnormal vs historical behavior',
    category: 'HISTORICAL',
    severity: 'ABNORMAL',
    priority: 78,
    condition: { zScore: { gt: 2.0 } },
    narrativeTemplate: 'Deviation/BOM {{zScore}} std-dev di atas historical average.',
  },
  {
    code: 'HISTORICAL_WARNING',
    name: 'Deviation above historical average',
    category: 'HISTORICAL',
    severity: 'WARNING',
    priority: 58,
    condition: {
      all: [
        { zScore: { gt: 1.5 } },
        { zScore: { lte: 2.0 } },
      ],
    },
    narrativeTemplate: 'Deviation/BOM {{zScore}} std-dev di atas historical average.',
  },
];
