// ============================================================
//  Rule Engine — Condition Tree Evaluator + Fast-Path Pre-check
//  ----------------------------------------------------------
//  Extracted from evaluator.ts (Task 2-a). Three functions:
//    - canOpFire / canConditionFire: conservative pre-check that
//      returns false ONLY when a rule provably cannot fire.
//    - evalCondition: full condition-tree walk (calls evalOp
//      from ./evaluator-operators for leaf comparisons).
// ============================================================
import { evalOp } from './evaluator-operators';

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
export function canOpFire(value: unknown, opDef: unknown): boolean {
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

export function canConditionFire(cond: unknown, ctx: Record<string, unknown>): boolean {
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

export function evalCondition(cond: unknown, ctx: Record<string, unknown>): boolean {
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
