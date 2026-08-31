// ============================================================
//  Rule Engine — Narrative Template Renderer
//  ----------------------------------------------------------
//  Extracted from evaluator.ts (Task 2-a). Context-aware
//  Indonesian IDR/percentage formatting + {{placeholder}}
//  template substitution. Fully decoupled from the rule
//  evaluation logic — pure string-in / string-out.
// ============================================================
import type { RuleEvidence } from '@/types/inventory';

// ============================================================
//  Bug 2 fix: formatNumber — context-aware formatting
//  Percentage fields (keys ending in Pct/Ratio/Growth/Rate, or value in [-1,1])
//  vs absolute fields (nominal/qty/abs/count)
// ============================================================
export const PERCENT_KEYS = new Set([
  'pctQtyDeviasiToBom', 'residualRatio', 'tolerancePct',
  'salesGrowth', 'bomGrowth', 'qtyDeviasiGrowth', 'nominalDeviasiGrowth',
  'wasteGrowth', 'susutGrowth', 'trialGrowth', 'deviationBomRatio',
  'deviationToSalesRatio', 'deviationToBomRatio',
  'pctWasteSusut', 'pctQtyWasteToBom', 'pctQtySusutToBom', 'pctQtyTrialToBom', 'pctQtyLossToBom',
]);

export function formatEvidenceValue(key: string, v: number): string {
  // Percentage fields: format as %
  if (PERCENT_KEYS.has(key) || key.toLowerCase().includes('pct') || key.toLowerCase().includes('ratio')) {
    return `${(v * 100).toFixed(2).replace('.', ',')}%`;
  }
  // Nominal/currency fields: format as IDR
  if (key.toLowerCase().includes('nominal') || key.toLowerCase().includes('sales')) {
    const abs = Math.abs(v);
    const sign = v < 0 ? '-' : '';
    if (abs >= 1_000_000_000) return `${sign}Rp ${(abs / 1_000_000_000).toFixed(2).replace('.', ',')}M`;
    if (abs >= 1_000_000) return `${sign}Rp ${(abs / 1_000_000).toFixed(2).replace('.', ',')}Jt`;
    if (abs >= 1_000) return `${sign}Rp ${(abs / 1_000).toFixed(1).replace('.', ',')}Rb`;
    return `${sign}Rp ${abs.toFixed(0)}`;
  }
  // zScore: 2 decimal
  if (key === 'zScore') return v.toFixed(2);
  // Qty fields: integer if large, decimal if small
  if (key.toLowerCase().includes('qty') || key.toLowerCase().includes('count')) {
    return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2);
  }
  // Default: 2 decimal
  return v.toFixed(2);
}

// Render narrative template with evidence values (Bug 2 fix: context-aware formatting)
export function renderTemplate(template: string | undefined, evidence: RuleEvidence): string {
  if (!template) return '';
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = evidence[key];
    if (v == null) return 'N/A';
    if (typeof v === 'number') {
      return formatEvidenceValue(key, v);
    }
    return String(v);
  }).replace(/\s+/g, ' ').trim();
}
