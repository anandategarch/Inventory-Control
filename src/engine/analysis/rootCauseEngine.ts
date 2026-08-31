// ============================================================
//  Root Cause Engine — runtime logic that maps each rule code
//  to possible root causes + recommended actions for executive
//  investigation.
//  --------------------------------------------------------
//  Pure lookup — no DB calls, no side effects.
//  Used by:
//    - /api/outlet-items route (per-item rootCauses field)
//    - /api/root-causes endpoint (standalone lookup)
//    - /api/analysis route (worklist rootCauses summary)
//
//  The ~400 LOC of static data (ROOT_CAUSE_MAPPINGS) now lives
//  in ./rootCauseMappings.ts (split out in Task ID 2-b for
//  readability — the data file is browsable via go-to-symbol
//  without scrolling past runtime logic). This file re-exports
//  the data + types so that callers importing from
//  '@/engine/analysis/rootCauseEngine' or '@/engine/analysis'
//  (the barrel) are unaffected.
// ============================================================

import { ROOT_CAUSE_MAPPINGS, type RootCauseMapping } from './rootCauseMappings';

// Re-export types + data so existing imports keep resolving.
// (analysis/index.ts barrel imports these from './rootCauseEngine';
//  external callers may also import them directly from this path.)
export type { RootCauseSeverity, RootCauseCategory, RootCauseMapping } from './rootCauseMappings';
export { ROOT_CAUSE_MAPPINGS } from './rootCauseMappings';

// ============================================================
//  getRootCauses — look up mappings for a list of rule codes.
//  - Deduplicates input
//  - Preserves input order (first occurrence wins)
//  - Skips unknown rule codes (returns only matched mappings)
// ============================================================
export function getRootCauses(ruleCodes: string[]): RootCauseMapping[] {
  const seen = new Set<string>();
  const results: RootCauseMapping[] = [];
  for (const code of ruleCodes) {
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const mapping = ROOT_CAUSE_MAPPINGS[code];
    if (mapping) {
      results.push(mapping);
    }
  }
  return results;
}

// ============================================================
//  Helper — get a single root cause mapping (or null if unknown)
// ============================================================
export function getRootCause(ruleCode: string): RootCauseMapping | null {
  return ROOT_CAUSE_MAPPINGS[ruleCode] ?? null;
}

// ============================================================
//  Helper — list all known rule codes (for UI dropdowns / debugging)
// ============================================================
export function listKnownRuleCodes(): string[] {
  return Object.keys(ROOT_CAUSE_MAPPINGS);
}
