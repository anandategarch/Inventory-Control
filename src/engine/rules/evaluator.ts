// ============================================================
//  Rule Engine — YAML loader + AST evaluator (orchestrator)
//  ----------------------------------------------------------
//  Refactored (Task 2-a): logic split across 4 sibling modules.
//  This file remains the public entry point — barrel re-exports
//  below preserve the original '@/engine/rules/evaluator' import
//  path used by evaluator.test.ts + ruleService.ts.
//
//    types       → evaluator-types.ts        (RuleCondition, Rule, RuleContext)
//    operators   → evaluator-operators.ts    (evalOp, resolveExpr)
//    condition   → evaluator-condition.ts    (canOpFire, canConditionFire, evalCondition)
//    narrative   → evaluator-narrative.ts    (PERCENT_KEYS, formatEvidenceValue, renderTemplate)
//    orchestrator→ THIS FILE                 (loadRules, getRuleByCode, evaluateRules)
// ============================================================

// Public API: types + narrative helpers re-exported for backward compat.
export * from './evaluator-types';
export * from './evaluator-narrative';

import { logger } from '@/lib/logger';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse as yamlParse } from 'yaml';
import type { AnomalyFlagResult, RuleEvidence } from '@/types/inventory';

import type { Rule, RuleContext } from './evaluator-types';
import { canConditionFire, evalCondition } from './evaluator-condition';
import { renderTemplate } from './evaluator-narrative';

let _rules: Rule[] | null = null;
let _rulesByCode: Map<string, Rule> | null = null;

export function loadRules(): Rule[] {
  if (_rules) return _rules;
  const filePath = join(process.cwd(), 'src/config/rules.yaml');
  const raw = readFileSync(filePath, 'utf8');
  const parsed = yamlParse(raw) as { rules: Omit<Rule, 'narrativeTemplate'>[] };

  // FIX: validate each rule has required fields — catch typos/silent failures at startup
  const VALID_SEVERITIES = new Set(['NORMAL', 'WARNING', 'ABNORMAL']);
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
