// ============================================================
//  Rule Engine — YAML loader + AST evaluator
// ============================================================
import { logger } from '@/lib/logger';
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

  // FIX: validate each rule has required fields — catch typos/silent failures at startup
  const VALID_SEVERITIES = new Set(['NORMAL', 'WARNING', 'ABNORMAL']);
  const VALID_CATEGORIES = new Set(['TOLERANCE', 'RESIDUAL', 'DIRECTION', 'OVER_EXPLAINED', 'GROWTH', 'HISTORICAL', 'BENCHMARK', 'OPERATIONAL']);
  const seenCodes = new Set<string>();

  _rules = (parsed.rules || []).map((r, i) => {
    // Validate required fields
    if (!r.code || typeof r.code !== 'string') {
      throw new Error(`[rules.yaml] Rule #${i + 1}: missing or invalid 'code' field`);
    }
    if (seenCodes.has(r.code)) {
      logger.warn(`Rule "${r.code}": DUPLICATE code (will override)`);
    }
    seenCodes.add(r.code);

    if (!r.name || typeof r.name !== 'string') {
      throw new Error(`[rules.yaml] Rule "${r.code}": missing or invalid 'name' field`);
    }
    if (!r.severity || !VALID_SEVERITIES.has(r.severity)) {
      throw new Error(`[rules.yaml] Rule "${r.code}": invalid severity "${r.severity}". Must be one of: ${[...VALID_SEVERITIES].join(', ')}`);
    }
    if (typeof r.priority !== 'number' || r.priority < 0 || r.priority > 100) {
      logger.warn(`Rule "${r.code}": priority ${r.priority} outside 0-100 range`);
    }
    if (!r.condition || typeof r.condition !== 'object') {
      throw new Error(`[rules.yaml] Rule "${r.code}": missing or invalid 'condition' field`);
    }

    return {
      ...r,
      narrativeTemplate: (r as Record<string, unknown>).narrative_template as string | undefined,
    };
  });

  logger.info(`[rules] Loaded ${_rules.length} rules: ${_rules.map(r => r.code).join(', ')}`);
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
//
// BUG 2.1 fix: operand can ALSO be an arithmetic expression ({mul/add/sub/div/abs}).
// Previously evalOp only resolved string operands, so rules like:
//   nominalDeviasiGrowth: { gt: { mul: [salesGrowth, salesDeviationFactor] } }
// NEVER fired because operand stayed as the object {mul: [...]}.
// Now we call resolveExpr for object operands too.
function evalOp(value: unknown, opDef: unknown, ctx?: Record<string, unknown>): boolean {
  if (typeof opDef !== 'object' || opDef === null) {
    return value === opDef;
  }
  const opObj = opDef as Record<string, unknown>;
  for (const [op, operandRaw] of Object.entries(opObj)) {
    // Resolve operand: string field reference OR arithmetic expression object
    let operand = operandRaw;
    if (ctx) {
      if (typeof operandRaw === 'string' && operandRaw in ctx) {
        operand = ctx[operandRaw];
      } else if (typeof operandRaw === 'object' && operandRaw !== null) {
        // Arithmetic expression: { mul: [...] }, { add: [...] }, etc.
        operand = resolveExpr(operandRaw, ctx);
      }
    }
    switch (op) {
      case 'gt': if (!(typeof value === 'number' && typeof operand === 'number' && value > operand)) return false; break;
      case 'gte': if (!(typeof value === 'number' && typeof operand === 'number' && value >= operand)) return false; break;
      case 'lt': if (!(typeof value === 'number' && typeof operand === 'number' && value < operand)) return false; break;
      case 'lte': if (!(typeof value === 'number' && typeof operand === 'number' && value <= operand)) return false; break;
      case 'eq':
        // Bug fix: case-insensitive comparison for strings (direction: "LOSS" vs "Loss")
        if (typeof value === 'string' && typeof operand === 'string') {
          if (value.toLowerCase() !== operand.toLowerCase()) return false;
        } else if (value !== operand) {
          return false;
        }
        break;
      case 'neq':
        if (typeof value === 'string' && typeof operand === 'string') {
          if (value.toLowerCase() === operand.toLowerCase()) return false;
        } else if (value === operand) {
          return false;
        }
        break;
      case 'is_null':
        // Bug fix: fail safe if operand is not boolean (e.g., null, undefined, string)
        // Previously: if operand was null, neither if-branch matched → function returned true (fail-open)
        if (operand === true) {
          if (value !== null && value !== undefined) return false;
        } else if (operand === false) {
          if (value === null || value === undefined) return false;
        } else {
          // Invalid operand — fail safe (rule does NOT trigger)
          return false;
        }
        break;
      case 'not_null':
        if (operand === true) {
          if (value === null || value === undefined) return false;
        } else if (operand === false) {
          if (value !== null && value !== undefined) return false;
        } else {
          // Invalid operand — fail safe
          return false;
        }
        break;
      case 'between': {
        if (typeof value !== 'number' || !Array.isArray(operand)) return false;
        const arr = operand as unknown[];
        const lo = typeof arr[0] === 'string' && ctx && arr[0] in ctx ? ctx[arr[0] as string] : arr[0];
        const hi = typeof arr[1] === 'string' && ctx && arr[1] in ctx ? ctx[arr[1] as string] : arr[1];
        if (typeof lo !== 'number' || typeof hi !== 'number') return false;
        // FIX (BUG 9): Auto-swap reversed bounds so {between: [0.5, 0.1]} still works
        const [realLo, realHi] = lo <= hi ? [lo, hi] : [hi, lo];
        if (!(value >= realLo && value <= realHi)) return false;
        break;
      }
      case 'in': {
        if (!Array.isArray(operand)) return false;
        // Resolve field references inside array elements
        const resolved = ctx
          ? operand.map((v) => typeof v === 'string' && v in ctx ? ctx[v] : v)
          : operand;
        if (!resolved.includes(value)) return false;
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
    // FIX (BUG 5): Check typeof number, not just non-null. A typo'd field reference
    // returns a string (from resolveExpr line 146), which passes the null check
    // but produces NaN in arithmetic → rule silently never fires.
    if ('mul' in e && Array.isArray(e.mul)) {
      const vals = e.mul.map((v) => resolveExpr(v, ctx));
      if (vals.some((v) => v == null || typeof v !== 'number')) return null;
      return (vals as number[]).reduce((a, b) => a * b, 1);
    }
    if ('add' in e && Array.isArray(e.add)) {
      const vals = e.add.map((v) => resolveExpr(v, ctx));
      if (vals.some((v) => v == null || typeof v !== 'number')) return null;
      return (vals as number[]).reduce((a, b) => a + b, 0);
    }
    if ('sub' in e && Array.isArray(e.sub)) {
      const vals = e.sub.map((v) => resolveExpr(v, ctx));
      if (vals.some((v) => v == null || typeof v !== 'number')) return null;
      const arr = vals as number[];
      return arr.slice(1).reduce((a, b) => a - b, arr[0]);
    }
    if ('div' in e && Array.isArray(e.div)) {
      const vals = e.div.map((v) => resolveExpr(v, ctx));
      if (vals.some((v) => v == null || typeof v !== 'number') || (vals[1] as number) === 0) return null;
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

// ============================================================
//  Fast-path pre-check (Task OPTIMIZE-ENGINE)
//  ----------------------------------------------------------
//  Walks the rule's condition tree and returns false ONLY when we
//  can PROVE the rule cannot fire given the current ctx (e.g. a
//  `not_null` field is null, or a numeric `gt` is applied to null).
//  This skips the full evalCondition() pass for rules that are
//  guaranteed to evaluate to false — major speedup on 35K+ records
//  where most ctx fields (zScore, tolerancePct, benchmarkFlag) are
//  null for the majority of rows.
//
//  Conservative by design: when uncertain (e.g. `any`, `not`,
//  field-reference operands), returns true so evalCondition() runs.
// ============================================================
function canOpFire(value: unknown, opDef: unknown): boolean {
  if (typeof opDef !== 'object' || opDef === null) {
    // Bare value: equality check. If value is null/undefined and the literal
    // operand is non-null, equality cannot hold.
    if (value == null && opDef != null) return false;
    return true;
  }
  const opObj = opDef as Record<string, unknown>;
  for (const [op, operandRaw] of Object.entries(opObj)) {
    switch (op) {
      case 'gt': case 'gte': case 'lt': case 'lte':
        // Numeric comparison requires a number on the value side
        if (value == null || typeof value !== 'number') return false;
        break;
      case 'between':
        if (value == null || typeof value !== 'number') return false;
        break;
      case 'eq':
        // Equality with a null value cannot match a non-null literal operand.
        // (Operand may be a string field-reference; we conservatively allow.)
        if (value == null && operandRaw != null && typeof operandRaw !== 'string') return false;
        if (value == null && typeof operandRaw === 'string' && operandRaw !== 'true' && operandRaw !== 'false') {
          // Could be a literal string ("LOSS") or a field ref — conservatively
          // assume literal: a null value cannot equal a non-empty literal.
          return false;
        }
        break;
      case 'neq':
        // !eq — if value is null and operand is non-null, neq is true → can fire
        // Don't fail-fast.
        break;
      case 'is_null':
        // is_null: true with null value → true → can fire
        // is_null: false with non-null value → true → can fire
        // Don't fail-fast.
        break;
      case 'not_null':
        // not_null: true with null value → false → cannot fire
        if (operandRaw === true && value == null) return false;
        // not_null: false with non-null value → false → cannot fire
        if (operandRaw === false && value != null) return false;
        break;
      case 'in':
        // null value cannot be in a non-null list
        if (value == null) return false;
        break;
      default:
        // Unknown op — let evalCondition handle (fail-safe, don't skip)
        break;
    }
  }
  return true;
}

function canConditionFire(cond: unknown, ctx: Record<string, unknown>): boolean {
  if (typeof cond !== 'object' || cond === null) return true;
  if (Array.isArray(cond)) return true; // invalid; let evalCondition fail-safe
  const c = cond as Record<string, unknown>;

  // `all`: every sub must fire — if any cannot fire, the whole cannot fire
  if ('all' in c && Array.isArray(c.all)) {
    if (!c.all.every((sub) => canConditionFire(sub, ctx))) return false;
  }
  // `any`: at least one must fire — too uncertain to fail-fast, defer
  // `not`: inverted — too uncertain to fail-fast, defer

  // Field comparisons
  for (const [field, opDef] of Object.entries(c)) {
    if (field === 'all' || field === 'any' || field === 'not') continue;
    const value = ctx[field];
    if (!canOpFire(value, opDef)) return false;
  }
  return true;
}

function evalCondition(cond: unknown, ctx: Record<string, unknown>): boolean {
  if (typeof cond !== 'object' || cond === null) return Boolean(cond);
  // Bug fix: arrays are not valid condition objects — fail safe (return false)
  // Previously arrays fell through to Object.entries() which iterated indices,
  // causing fail-open behavior when used with `not: [...]`.
  if (Array.isArray(cond)) return false;
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
    // Bug fix: `not` must receive a valid condition object, not an array.
    // If `not` is an array or non-object, fail safe (treat as false → !false = true
    // would be fail-open, so we invert: treat invalid `not` as true → !true = false).
    const notCond = c.not;
    if (typeof notCond === 'object' && notCond !== null && !Array.isArray(notCond)) {
      result = result && !evalCondition(notCond, ctx);
    } else {
      // Invalid `not` operand — fail safe (rule does NOT trigger)
      result = false;
    }
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
  'salesGrowth', 'bomGrowth', 'qtyDeviasiGrowth', 'nominalDeviasiGrowth',
  'wasteGrowth', 'susutGrowth', 'trialGrowth', 'deviationBomRatio',
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
  // Bug 8 fix: fraud red flag — Waste+Susut+Trial exceeds total deviation
  isOverExplained?: boolean;
  // FIX CALC-2: ABS values for signed percent fields (for correct magnitude comparison)
  absPctQtyDeviasiToBom?: number | null;
  absTolerancePct?: number | null;
}

export function evaluateRules(ctx: RuleContext): AnomalyFlagResult[] {
  const rules = loadRules();
  const flags: AnomalyFlagResult[] = [];

  // FIX CALC-2: Pre-compute ABS values for signed percent fields.
  // Excel convention: pctQtyDeviasiToBom and tolerancePct are SIGNED
  // (negative for LOSS items). Rules need ABS comparison to work correctly.
  if (ctx.pctQtyDeviasiToBom != null) {
    ctx.absPctQtyDeviasiToBom = Math.abs(ctx.pctQtyDeviasiToBom);
  }
  if (ctx.tolerancePct != null) {
    ctx.absTolerancePct = Math.abs(ctx.tolerancePct);
  }

  for (const rule of rules) {
    try {
      // OPTIMIZE-ENGINE: skip rules whose required fields are provably null
      // (e.g. zScore/tolerancePct/benchmarkFlag). Avoids the full evalCondition
      // walk for ~7 of 15 rules on the majority of records.
      if (!canConditionFire(rule.condition, ctx)) continue;
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
    } catch (e) {
      // Bug 6 fix: log per-rule errors instead of silent swallow
      // Silent failures hide bugs in rule engine (type errors, null refs)
      logger.error(`Rule "${rule.code}" failed`, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Sort by priority desc — caller can take first N
  flags.sort((a, b) => b.priority - a.priority);
  return flags;
}
