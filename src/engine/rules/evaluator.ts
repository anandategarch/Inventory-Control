// ============================================================
//  Rule Engine — YAML loader + AST evaluator
// ============================================================
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse as yamlParse } from 'yaml';
import type { AnomalyFlagResult, Severity, RuleEvidence } from '@/types/inventory';

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

let _rules: Rule[] | null = null;
let _rulesByCode: Map<string, Rule> | null = null;

export function loadRules(): Rule[] {
  if (_rules) return _rules;
  const filePath = join(process.cwd(), 'src/config/rules.yaml');
  const raw = readFileSync(filePath, 'utf8');
  const parsed = yamlParse(raw) as { rules: Omit<Rule, 'narrativeTemplate'>[] };
  _rules = (parsed.rules || []).map((r) => ({
    ...r,
    narrativeTemplate: (r as any).narrative_template,
  }));
  _rulesByCode = new Map(_rules.map((r) => [r.code, r]));
  return _rules;
}

export function getRuleByCode(code: string): Rule | undefined {
  if (!_rulesByCode) loadRules();
  return _rulesByCode!.get(code);
}

// Evaluate a comparison op against a value
// P2 fix: operand can be a field reference (string that exists in ctx).
// This allows rules.yaml to use dynamic thresholds from settings, e.g.:
//   pctQtyDeviasiToBom: { gt: stdDeviasiBomPct }
// where "stdDeviasiBomPct" is resolved from ctx (injected from runtime thresholds).
function evalOp(value: unknown, opDef: unknown, ctx?: Record<string, unknown>): boolean {
  if (typeof opDef !== 'object' || opDef === null) {
    return value === opDef;
  }
  const opObj = opDef as Record<string, unknown>;
  for (const [op, operandRaw] of Object.entries(opObj)) {
    // Resolve operand: if it's a string that exists in ctx, use the ctx value
    let operand = operandRaw;
    if (typeof operandRaw === 'string' && ctx && operandRaw in ctx) {
      operand = ctx[operandRaw];
    }
    switch (op) {
      case 'gt': if (!(typeof value === 'number' && typeof operand === 'number' && value > operand)) return false; break;
      case 'gte': if (!(typeof value === 'number' && typeof operand === 'number' && value >= operand)) return false; break;
      case 'lt': if (!(typeof value === 'number' && typeof operand === 'number' && value < operand)) return false; break;
      case 'lte': if (!(typeof value === 'number' && typeof operand === 'number' && value <= operand)) return false; break;
      case 'eq': if (value !== operand) return false; break;
      case 'neq': if (value === operand) return false; break;
      case 'is_null': if (operand === true && value !== null && value !== undefined) return false;
                      if (operand === false && (value === null || value === undefined)) return false; break;
      case 'not_null': if (operand === true && (value === null || value === undefined)) return false;
                       if (operand === false && value !== null && value !== undefined) return false; break;
      case 'between': {
        if (typeof value !== 'number' || !Array.isArray(operand)) return false;
        const [lo, hi] = operand as number[];
        if (!(value >= lo && value <= hi)) return false;
        break;
      }
      case 'in': {
        if (!Array.isArray(operand)) return false;
        if (!operand.includes(value)) return false;
        break;
      }
      default:
        // Unknown op — fail safe
        return false;
    }
  }
  return true;
}

// Resolve arithmetic references
function resolveExpr(expr: unknown, ctx: Record<string, unknown>): unknown {
  if (expr === null || expr === undefined) return null;
  if (typeof expr === 'string') {
    // field reference
    if (expr in ctx) return ctx[expr];
    return expr;
  }
  if (typeof expr === 'number' || typeof expr === 'boolean') return expr;
  if (typeof expr === 'object') {
    const e = expr as Record<string, unknown>;
    if ('mul' in e && Array.isArray(e.mul)) {
      const vals = e.mul.map((v) => resolveExpr(v, ctx));
      if (vals.some((v) => v == null)) return null;
      return (vals as number[]).reduce((a, b) => a * (b as number), 1);
    }
    if ('add' in e && Array.isArray(e.add)) {
      const vals = e.add.map((v) => resolveExpr(v, ctx));
      if (vals.some((v) => v == null)) return null;
      return (vals as number[]).reduce((a, b) => a + (b as number), 0);
    }
    if ('sub' in e && Array.isArray(e.sub)) {
      const vals = e.sub.map((v) => resolveExpr(v, ctx));
      if (vals.some((v) => v == null)) return null;
      const arr = vals as number[];
      return arr.slice(1).reduce((a, b) => a - b, arr[0]);
    }
    if ('div' in e && Array.isArray(e.div)) {
      const vals = e.div.map((v) => resolveExpr(v, ctx));
      if (vals.some((v) => v == null) || (vals[1] as number) === 0) return null;
      return (vals[0] as number) / (vals[1] as number);
    }
    if ('abs' in e) {
      const v = resolveExpr(e.abs, ctx);
      if (v == null || typeof v !== 'number') return null;
      return Math.abs(v);
    }
  }
  return expr;
}

function evalCondition(cond: unknown, ctx: Record<string, unknown>): boolean {
  if (typeof cond !== 'object' || cond === null) return Boolean(cond);
  const c = cond as Record<string, unknown>;

  // Bug 3 fix: evaluate logic operators AND field comparisons together (no early return)
  // Collect all conditions — logic operators + field comparisons in same object
  let result = true;

  if ('all' in c && Array.isArray(c.all)) {
    result = result && c.all.every((sub) => evalCondition(sub, ctx));
  }
  if ('any' in c && Array.isArray(c.any)) {
    result = result && c.any.some((sub) => evalCondition(sub, ctx));
  }
  if ('not' in c) {
    result = result && !evalCondition(c.not, ctx);
  }

  // Field comparison: { fieldName: { op: value } } or { fieldName: value }
  // Skip logic operator keys (already handled above)
  for (const [field, opDef] of Object.entries(c)) {
    if (field === 'all' || field === 'any' || field === 'not') continue;
    const value = ctx[field];
    if (!evalOp(value, opDef, ctx)) return false;
  }
  return result;
}

// ============================================================
//  Bug 2 fix: formatNumber — context-aware formatting
//  Percentage fields (keys ending in Pct/Ratio/Growth/Rate, or value in [-1,1])
//  vs absolute fields (nominal/qty/abs/count)
// ============================================================
const PERCENT_KEYS = new Set([
  'pctQtyDeviasiToBom', 'residualRatio', 'tolerancePct',
  'salesGrowth', 'bomGrowth', 'qtyDeviasiGrowth', 'nominalDeviasiGrowth', 'priceGrowth',
  'deviationToSalesRatio', 'deviationToBomRatio',
  'pctWasteSusut', 'pctQtyWasteToBom', 'pctQtySusutToBom', 'pctQtyTrialToBom', 'pctQtyLossToBom',
]);

function formatEvidenceValue(key: string, v: number): string {
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
function renderTemplate(template: string | undefined, evidence: RuleEvidence): string {
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

export interface RuleContext extends Record<string, unknown> {
  salesGrowth?: number | null;
  bomGrowth?: number | null;
  qtyDeviasiGrowth?: number | null;
  nominalDeviasiGrowth?: number | null;
  priceGrowth?: number | null;
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
  residualQty?: number | null;
  residualRatio?: number | null;
  tolerancePct?: number | null;
  pctQtyDeviasiToBom?: number | null;
  direction?: string | null;
  absNominalDeviasi?: number | null;
  absQtyDeviasi?: number | null;
  // ===== P2 fix: runtime thresholds injected from settings (DB) =====
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
}

export function evaluateRules(ctx: RuleContext): AnomalyFlagResult[] {
  const rules = loadRules();
  const flags: AnomalyFlagResult[] = [];

  for (const rule of rules) {
    try {
      const matched = evalCondition(rule.condition, ctx);
      if (matched) {
        // Build evidence from all referenced fields
        const evidence: RuleEvidence = { ...ctx };
        flags.push({
          ruleCode: rule.code,
          ruleName: rule.name,
          category: rule.category,
          severity: rule.severity,
          priority: rule.priority,
          evidence,
          narrative: renderTemplate(rule.narrativeTemplate, evidence),
        });
      }
    } catch {
      // swallow per-rule errors to keep engine running
    }
  }

  // Sort by priority desc — caller can take first N
  flags.sort((a, b) => b.priority - a.priority);
  return flags;
}
