// ============================================================
//  Rule Engine — Operators
//  ----------------------------------------------------------
//  Extracted from evaluator.ts (Task 2-a). Two tightly-coupled
//  functions: evalOp (comparison ops) and resolveExpr (arithmetic
//  expression evaluation). Kept together because evalOp calls
//  resolveExpr for object operands.
// ============================================================

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
export function evalOp(value: unknown, opDef: unknown, ctx?: Record<string, unknown>): boolean {
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
export function resolveExpr(expr: unknown, ctx: Record<string, unknown>): unknown {
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
