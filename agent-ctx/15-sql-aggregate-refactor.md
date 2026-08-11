# Task 15 — Refactor /api/analysis to use SQL aggregate queries

**Agent**: Main (Z.ai Code)
**Status**: COMPLETED

## Goal
Replace raw record fetching (540K records) with SQL aggregate queries (already implemented in `src/lib/queries.ts`).
The rule evaluation loop still needs raw records (35K per week) — that stays. But aggregation queries
for top items/outlets, executive summary, trend, pareto, area analysis, cost impact, item consistency
move to SQL.

## Files modified
1. `src/engine/analysis/analysis.ts` — `buildRuleContext` (historical array → precomputed stats), `computeHistoricalAnalysis`, `buildWorklist`, `computePriorities`, `computeItemConsistencyAnalysis` (signatures)
2. `src/lib/queries.ts` — fixed 11 pre-existing $queryRaw syntax errors, added ::int casts to 6 COUNT fields for JSON serialization, fixed buildSqlFilters empty parts case, added classACountFull/classAPctFull to queryPareto via SQL CTE
3. `src/app/api/analysis/route.ts` — full refactor of aggregation section, added buildExecSummaryFromSql helper

## Verification
- `bun run lint`: 0 errors
- `npx tsc --noEmit --skipLibCheck`: 0 errors in edited files (pre-existing errors in next.config.ts, drilldown/route.ts, SettingsDialog.tsx, db.ts are unrelated)
- Runtime test against Supabase production DB (MEI 2026 WEEK 4, 35K records): all 14 SQL queries pass, full GET handler returns success=true with all 30 expected response keys, JSON serialization works
- SQL query time: ~5 seconds (was minutes for 540K raw fetch)
- Total API time: 22 seconds (dominated by LLM narrative generation)

## Key design decisions
- Kept `currentRecs`/`prevRecs` findMany as-is (rule engine needs raw records, 35K per week)
- Replaced 540K historical record fetch with `queryHistoricalStats` (~10K aggregated rows)
- Replaced 540K trend record fetch with `queryTrendAgg` (~3 rows for MEI 2026)
- Built `areaAvg` for topOutlets from `queryAreaAnalysis` results (no extra query)
- Built `devToSalesRatio` for topOutletsBySales in JS (sales already dedup'd in SQL)
- Built `netCostTrend` from same `queryTrendAgg` result (no extra query)
- Used `classACountFull`/`classAPctFull` from SQL CTE (computes across ALL items, not capped by LIMIT 50)
- Frontend requires no changes — all response shapes preserved
