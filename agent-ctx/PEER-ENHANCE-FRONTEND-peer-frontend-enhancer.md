# Task: PEER-ENHANCE-FRONTEND

**Agent:** Peer Frontend Enhancer
**Goal:** Add 8 analysis features to Peer Comparison component.

## Files Touched
- `src/app/api/peer-comparison/items/route.ts` — NEW (Feature 3 backend)
- `src/app/api/peer-comparison/trend/route.ts` — NEW (Feature 6 backend)
- `src/components/dashboard/PeerComparison.tsx` — REWRITE (8 features + existing table)

## What Was Done

### Backend (2 new API routes)
1. `/api/peer-comparison/items?outletCode=X&month=Y&week=Z&mode=week&topItems=5`
   - SQL: CTE chain that (a) finds peer outlets within ±10% sales band, (b) finds target's top-N items by `absNominalDeviasi`, (c) cross-joins items × peers to fetch per-outlet per-item metrics.
   - Returns per-item: `target`, `peerAvg`, `peerBest` (lowest = best for bad metrics), `gap`, `peerCount`, and per-peer breakdown.
   - Same week-filter logic as `queryPeerComparison` (latest week in month-mode to avoid cumulative double-count).

2. `/api/peer-comparison/trend?outletCode=X&month=Y&peers=A,B,C`
   - For each week in the month, returns `{ weekLabel, devBomTarget, devBomPeerAvg, salesTarget, peerCount }`.
   - Accepts optional `peers` param to freeze the peer set across weeks (stable trend). If omitted, peer set auto-computed per week from ±10% sales band.
   - One SQL pass per week (cleaner than one big CTE).

### Frontend (PeerComparison.tsx — full rewrite)
Layout order matches spec:
1. **Header** — outlet info + mode/limit toggles (existing, preserved)
2. **Efficiency Score** (#7) — `EfficiencyScoreCard`: 0-100 composite with formula `100 - (devBomPenalty + lossPenalty + residualPenalty + salesPenalty)`. Penalty weights: Dev/BOM 50, LOSS 25, Residual 15, Sales 10. Color: green >70, amber 50-70, red <50. Peer avg marker at ~50.
3. **Gap Analysis** (#2) — `GapAnalysisCard`: target vs peer BEST (not avg). 4 key metrics (Dev/BOM, LOSS, Residual, Sales) in grid cards. For bad metrics best=min, for good best=max. Shows absolute gap + % above best.
4. **Ranking Summary** (#1) — `RankingSummaryCard`: rank #X/N per metric. Sort ascending for bad metrics (rank 1 = lowest = best), descending for good metrics (rank 1 = highest = best). Badges colored green/amber/red by position. Shows 6 key metrics.
5. **Scatter Plot** (#4) — `ScatterPlotCard`: Recharts `ScatterChart`, X=Sales, Y=Dev/BOM %. Target dot red (`#dc2626`) r=7, peer dots zinc (`#71717a`) r=4. Custom tooltip with outlet name.
6. **Peer Table + Flags** (#5) — existing table preserved + new "Flags" column via `AnomalyFlags` subcomponent. Rules: Dev/BOM/LOSS/Residual > 1.5× avg → 🔴; Sales < 0.8× avg → 🟡; all within ±20% → 🟢 Normal.
7. **Item-Level Comparison** (#3) — `ItemLevelComparison` + `ItemComparisonBlock`: useQuery to `/api/peer-comparison/items`. Top 5 target items, each rendered as a mini-table with Target/Peer Avg/Peer Best/Gap rows for QTY Deviasi, Dev/BOM, Nominal. Scrollable list (max-h-500).
8. **Trend Chart** (#6) — `TrendChartCard`: useQuery to `/api/peer-comparison/trend`. Recharts `LineChart` with 2 lines — Target (red solid `#dc2626`) + Peer Avg (zinc dashed `#71717a`). Y-axis Dev/BOM %, X-axis week labels.
9. **Correlation Insight** (#9) — `CorrelationInsightCard`: rule-based insights (7 rules):
   - Dev/BOM > 1.5× avg → outlier warning
   - Best practice peer (lowest Dev/BOM)
   - High sales + low deviasi peers (replicable practice)
   - Residual > 2× avg → fraud red flag
   - LOSS > 1.5× avg → investigation prompt
   - Sales < 90% avg → underperformance note
   - Target best-in-class detection
   - Color-coded left-border (red warn / emerald good / amber info)

## Conventions Followed
- `useDashboard` hook preserved (`focusOutlet`, `outletCode`, `monthLabel`, `currentWeek`, `setFocusOutlet`)
- Existing `clickableRowProps` deep-dive behavior preserved
- Existing color logic (`text-emerald-600` better / `text-red-600` worse) preserved
- `fmtIDR`, `fmtNum`, `fmtPctAbs` from `@/lib/format` reused
- `useMemo` for all client-side computations (efficiency score, ranks, insights)
- Same `enabled` gate as existing: `Boolean(activeOutlet && monthLabel && (mode === 'month' || currentWeek))`
- Mobile-responsive: grid uses `sm:grid-cols-2 sm:grid-cols-3`, charts use `ResponsiveContainer` with fixed heights
- Charts: NO blue/indigo. Target = red, peers = zinc gray
- Recharts `Tooltip` imported as `RTooltip` to avoid clash with shadcn Tooltip
- Sticky table header preserved
- Added `aria-label` to mode/limit selects for a11y
- Added `role="progressbar"` + `aria-valuenow/min/max` to efficiency score

## Verification
- `bun run lint` → exit 0, clean
- `npx tsc --noEmit --skipLibCheck` → exit 0, clean (after fixing 2 type errors: added `error?: string` to `ItemComparisonResponse` and `TrendResponse` interfaces since API can return error shape)
- Dev server: pre-existing `DATABASE_URL` protocol issue in `.zscripts/dev.log` (postgres:// missing) — NOT caused by this task, environment-level.

## Notes for Future Agents
- The `queryPeerComparison` backend (outlets.ts) has known audit issues (PEER-BACKEND-5 cumulative week multi-count in month mode is FIXED via latest-week filter; PEER-BACKEND-6 LIMIT off-by-one is NOT yet fixed). My new routes avoid the LIMIT off-by-one by using `CROSS JOIN target` + `WHERE ±10%` without a top-level LIMIT.
- The `peerAvg` object passed around uses `Record<string, number>` for ergonomics; keys match `PeerRow` numeric fields.
- Efficiency score uses peer avg = 50 as visual marker, which is an approximation (true peer avg of the formula isn't exactly 50 because penalties are clamped asymmetrically). Acceptable for UX.
