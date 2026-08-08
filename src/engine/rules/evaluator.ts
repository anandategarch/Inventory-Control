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
function evalOp(value: unknown, opDef: unknown): boolean {
  if (typeof opDef !== 'object' || opDef === null) {
    return value === opDef;
  }
  const opObj = opDef as Record<string, unknown>;
  for (const [op, operand] of Object.entries(opObj)) {
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

  if ('all' in c && Array.isArray(c.all)) {
    return c.all.every((sub) => evalCondition(sub, ctx));
  }
  if ('any' in c && Array.isArray(c.any)) {
    return c.any.some((sub) => evalCondition(sub, ctx));
  }
  if ('not' in c) {
    return !evalCondition(c.not, ctx);
  }

  // Field comparison: { fieldName: { op: value } } or { fieldName: value }
  for (const [field, opDef] of Object.entries(c)) {
    const value = ctx[field];
    if (!evalOp(value, opDef)) return false;
  }
  return true;
}

// Render narrative template with evidence values
function renderTemplate(template: string | undefined, evidence: RuleEvidence): string {
  if (!template) return '';
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = evidence[key];
    if (v == null) return 'N/A';
    if (typeof v === 'number') {
      if (Math.abs(v) >= 1) return (v * 100).toFixed(1) + '%';
      return v.toFixed(4);
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
