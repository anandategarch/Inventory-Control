# Task ID: OPTIMIZE-ANALYSIS
## Agent: Analysis Route Optimizer

### Task
Optimize `src/app/api/analysis/route.ts` (728 lines) for performance. The 42-item
`Promise.all` was suspected to contain dead queries / dead response fields after
recent feature removals (Investigasi tab, RecommendationPanel, Cost Accounting
tab, DQ Issues export section). Verify each query's frontend usage with Grep and
remove anything dead; add `select` clauses to Prisma queries; verify the rule
eval loop's existing optimizations.

### Work Log
- Read `/home/z/my-project/worklog.md` (last 30 lines) — confirmed prior agents
  (FINAL-* + OPTIMIZE-ENGINE) already removed `recommendation` + `priorities`
  response fields, `priceGrowth` from RuleContext, dead TopDeviasiRank UI,
  dead MenuAnalysisCard, etc. Clean baseline to start from.
- Read `src/app/api/analysis/route.ts` end-to-end (728 lines). Mapped the 42-item
  `Promise.all` (Group 2) to response fields, then mapped each response field to
  its frontend consumer via Grep.
- Grep matrix on `src/components/`, `src/hooks/`, `src/app/page.tsx`:
  - `lossVsSurplus` → InsightsPanel.tsx:203 + Charts.tsx:164 → KEEP query + field.
  - `costImpact` → InsightsPanel.tsx:149 (Biaya Bocor insight). The CostAccounting
    component file still exists at `src/components/dashboard/CostAccounting.tsx`
    but is NOT imported by page.tsx (comment at page.tsx:22). So 8 of the 12
    `costImpact` sub-fields (wasteCost/susutCost/trialCost/residualCost +
    wasteToSales/susutToSales/trialToSales/residualToSales) are dead — only
    totalCost/pctOfSales/lossNominal/surplusNominal are consumed. KEEP query
    (InsightsPanel needs totalCost), TRIM response.
  - `topOutlets` → CardDrillDown.tsx:124,138 + TopItems.tsx:137 → KEEP.
  - `topOutletsBySales` → CardDrillDown.tsx:34 → KEEP.
  - `itemConsistencyAnalysis` → InsightsPanel.tsx:163 + AdvancedAnalysis.tsx:142
    → KEEP.
  - `dqStatus` → ExecutiveSummary.tsx:145, only reads `.errors` + `.warnings`.
    The `ok` count and `issues` array (up to 20 detailed DQ summary objects) are
    dead → DROP from response. Also simplify the SQL groupBy.
  - `topItemsByWaste/Susut/Trial/LossSurplus`, `topDeviasiRank`, `deviationBreakdown`,
    `trend`, `areaAnalysis`, `varianceAnalysis`, `outletHealthRanking`,
    `netCostTrend`, `investigationWorklist`, `topItemsByNominal`, `topItemsByDevBom`,
    `executiveSummary`, `healthStatus`, `growthComparison` → all consumed by ≥1
    frontend component → KEEP.
- Implemented OPT 1 (slim RecWithRels type): rewrote `src/engine/analysis/types.ts`.
  Defined `RecWithRels` as a slim type with only the 22 fields the engine reads
  (verified by grepping every `curr.*` / `prev.*` / `rec.*` access in
  `src/engine/analysis/{ruleService,rankingService}.ts` + the route's rule-eval
  loop). Kept `RecWithRelsFull` alias for callers that still `include` all
  columns (e.g. export-report route). Dropped: `id, sourceFileId, weekId,
  sourceFile, week, status, satuan, qtyCom, nominalWaste/Susut/Trial, avgPrice,
  toleranceRaw, pctWasteSusut, pctQtyWasteToBom, pctQtySusutToBom,
  pctQtyTrialToBom, pctQtyLossToBom, residualNominal, bulan, bulan2, weekLabel,
  monthLabel, createdAt` (~21 unused columns).
- Implemented OPT 2 (switch include→select): `src/app/api/analysis/route.ts:315-355`.
  Both `db.inventoryRecord.findMany` calls (current + prev) now use `select`
  with the slim field set. Dropped the now-unused
  `import type { InventoryRecord, Outlet, Item, Week } from '@prisma/client'`
  import (line 43 originally).
- Implemented OPT 3 (trim costImpact response): `src/app/api/analysis/route.ts:646-655`.
  Removed 8 dead sub-fields (wasteCost, susutCost, trialCost, residualCost,
  wasteToSales, susutToSales, trialToSales, residualToSales). `queryCostImpact`
  SQL still runs (InsightsPanel needs `totalCost`). `costImpact` response now
  matches the `CostImpact` interface in `src/hooks/useAnalysis.ts:39-44` exactly.
- Implemented OPT 4 (trim deviationBreakdown response): `src/app/api/analysis/route.ts:499-504`.
  Removed the `explained`/`explainedPct`/`netPct` enrichment computation
  (was lines 494-502 — `explainedTotal` + `breakdownEnriched` object). Response
  now passes `breakdown` (the raw SQL aggregate row) directly. Verified via Grep
  that no frontend reads `deviationBreakdown.explained|explainedPct|netPct` —
  Charts.tsx DeviationBreakdownChart + InsightsPanel.tsx insight #3 only use
  `total/waste/susut/trial/residual`. Matches the
  `{ waste, susut, trial, residual, total }` type at `useAnalysis.ts:98`.
- Implemented OPT 5 (simplify DQ groupBy + trim dqStatus):
  - `src/app/api/analysis/route.ts:480-489`: changed `db.dQIssue.groupBy`
    `by: ['code', 'severity', 'message']` → `by: ['severity']`. Returns ≤3 rows
    (ERROR/WARNING/INFO) instead of N unique (code,severity,message) tuples.
  - `src/app/api/analysis/route.ts:537-545`: replaced the 12-line `dqSummary`
    mapping+sort+slice with a 3-line severity-counts Map accumulator.
  - `src/app/api/analysis/route.ts:695-705`: dropped `ok` and `issues` from
    `dqStatus` response (only `errors` + `warnings` are read by
    ExecutiveSummary.tsx:308,312).
- Verified OPT 6 (rule eval loop): `src/app/api/analysis/route.ts:396-432`.
  - Early skip for zero-deviation records (line 401) — already done.
  - `historicalByOutletItem` is a Map (line 415) — already done.
  - `prevByOutletItem` is a Map (line 409) — already done.
  No further optimization needed.
- Fixed downstream type breakage in `src/engine/analysis/rankingService.ts`:
  - Removed unused `import type { Outlet } from '@prisma/client'` (line 8).
  - Changed `byOutlet` Map's `outlet: Outlet` → `outlet: RecWithRels['outlet']`
    (line 261) — the slim outlet shape `{ code; name; area }` instead of the
    full Prisma Outlet type with `id` + `outletCode`.
- Ran `bun run lint` → 0 errors.
- Ran `npx tsc --noEmit --skipLibCheck` → 0 errors.

### Stage Summary
- OPT 1 (slim RecWithRels type): `src/engine/analysis/types.ts:1-67` — defined
  slim type with 22 fields, kept `RecWithRelsFull` alias for include-based
  callers. Documented field-set verification methodology in file header.
- OPT 2 (include→select): `src/app/api/analysis/route.ts:315-355` — both
  findMany calls now `select` only the 22 needed columns. Drops ~21 unused
  columns × ~35K rows of DB→app transfer per request. Removed unused
  `@prisma/client` type import at line 43.
- OPT 3 (costImpact trim): `src/app/api/analysis/route.ts:646-655` — dropped
  8 dead sub-fields (wasteCost/susutCost/trialCost/residualCost + 4 *ToSales
  ratios). `queryCostImpact` SQL still runs (InsightsPanel needs totalCost).
- OPT 4 (deviationBreakdown trim): `src/app/api/analysis/route.ts:499-504,716`
  — removed `explained`/`explainedPct`/`netPct` enrichment computation; response
  passes the raw SQL `breakdown` row directly.
- OPT 5 (DQ groupBy + dqStatus trim): `src/app/api/analysis/route.ts:480-489`
  (groupBy `by: ['severity']` — was `['code','severity','message']`),
  `:537-545` (3-line severity-counts Map accumulator — was 12-line map+sort+
  slice), `:695-705` (dropped `ok` + `issues` from response — only `errors`
  + `warnings` are read by ExecutiveSummary).
- OPT 6 (rule eval loop): verified already optimized — early skip at line 401,
  Map lookups for prev + historical stats at lines 409, 415. No change.
- Downstream fix: `src/engine/analysis/rankingService.ts:8,261` — removed
  unused `Outlet` import; changed `byOutlet` Map's `outlet` field type to
  `RecWithRels['outlet']` (slim shape) to match the slim RecWithRels.
- **No queries were removed entirely** — every query in the 42-item Promise.all
  is still consumed by ≥1 frontend component. The task description's hypothesis
  that `queryLossVsSurplus` / `queryTopOutlets` / `queryTopOutletsBySales` /
  `queryItemConsistency` / `db.dQIssue.groupBy` might be dead was disproven by
  Grep — they all feed live response fields.
- lint: 0 errors. tsc: 0 errors.
