// GODSPLIT-W3-B: split 566-LOC rule engine → record-rules + zscore-rules + shared; barrel menjaga import path.
// Path '@/lib/queries/rule-evaluation' tetap valid via folder index — importers
// (run-queries.ts + 4 post-process-*.ts type-only + tests/queries/
// rule-evaluation.test.ts) tidak disentuh. Permukaan export identik dengan
// file asli: SqlRuleFlag + 3 evaluator (grep '^export' pra-split = 4 nama).
//
// Layout: record-rules.ts (evaluateRulesSql + RULE_MAP 19 rule record-grain)
// · zscore-rules.ts (evaluateHistoricalRulesSql + evaluateWasteRulesSql —
// pasangan CTE hist+stats twins sengaja tidak didedupe, catatan di sana)
// · shared.ts (SqlRuleFlag + expandRuleFlags — loop flag-expansion yang
// sebelumnya terduplikasi ×3). Import `db` yang sudah lama tidak terpakai
// di file asli tidak dipindah (query semua lewat withStatementTimeout dari
// ../shared yang tetap me-load '@/lib/db').
// ============================================================
//  SQL Rule Evaluation — pushes 16 rule checks to PostgreSQL.
//  Production total: 19 SQL + 3 zScore SQL + 1 waste zScore SQL = 23
//  rules (DEEP-WASTE-1 added the 3 WASTE_* record rules to the flags
//  CTE + evaluateWasteRulesSql for WASTE_SPIKE_2SIGMA).
//
//  Returns: array of { outletId, itemId, akunPenyesuaian, ruleCode,
//    severity, category, priority } — one row per fired rule per record.
//
//  The query uses:
//  - CTE for current records (filtered by month/week/area/outlet/item/PIC)
//  - LATERAL JOIN for prev period records (same outlet+item+akun)
//  - LATERAL JOIN for historical stats (mean, stddev, n)
//  - CASE WHEN for each of 16 SQL rules
//  - UNNEST(ARRAY[...]) to produce one row per fired rule
//
//  Performance: single query, ~2-3s (was 6-8s with 35K record load + JS loop)
//
//  FIX (AUDIT-PERF-3): only flagged rows transferred to Node (~10x less
//  egress). The main SELECT is wrapped in a `flags` CTE and the outer query
//  filters to rows where at least one of the 16 f_* columns is 1. Previously
//  ALL current-period rows (~10-35K × 19 columns) were shipped to Node and
//  the JS RULE_MAP loop skipped the zero-flag rows anyway — only flagged
//  rows drive worklist/priorities/health counts (verified consumers:
//  analysis post-process-flags.ts + export-report data-fetcher.ts/docx-
//  builder.ts — the normal/warning/abnormal denominators come from
//  queryOutletHealthRanking's zeroDevCount/nonZeroDevCount, NOT from these
//  rows), so the filter is semantics-preserving.
// ============================================================
export type { SqlRuleFlag } from './shared';
export { evaluateRulesSql } from './record-rules';
export { evaluateHistoricalRulesSql, evaluateWasteRulesSql } from './zscore-rules';
