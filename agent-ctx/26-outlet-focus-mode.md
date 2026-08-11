# Task 26 — Build Outlet Focus Mode (deep anomaly analysis per outlet)

## Agent: Main (Z.ai Code)

## Summary
Built comprehensive Outlet Focus Mode — when user clicks an outlet, opens a full-screen Dialog with 6 tabs that aggregates ALL anomaly data for that outlet.

## Files Created
- `src/app/api/outlet-focus/route.ts` (~1043 lines) — API endpoint
- `src/components/dashboard/OutletFocusMode.tsx` (~1307 lines) — UI component

## Files Modified
- `src/hooks/useDashboard.ts` — added `focusOutlet` + `setFocusOutlet`
- `src/components/dashboard/OutletScorecard.tsx` — added "Focus Mode" button (with Target icon)
- `src/components/dashboard/AdvancedAnalysis.tsx` — OutletHealthRanking row click → setFocusOutlet
- `src/components/dashboard/CostAccounting.tsx` — OutletEfficiencyMatrix + CostPerThousandCard → setFocusOutlet
- `src/components/dashboard/ExtraCharts.tsx` — AreaContributionBar → setFocusOutlet when outletCode filter set
- `src/app/page.tsx` — added `<OutletFocusMode data={analysis.data} />`

## API Design (`/api/outlet-focus?outletCode=&month=&week=`)

### Data Sources
1. Resolves outlet + PIC
2. Resolves previous period chronologically (cross-month via Week + SourceFile tables)
3. Fetches current period records (raw SQL with Prisma.sql)
4. Fetches previous period records (for new/disappeared/reversal/variance)
5. Fetches historical stats per itemId (AVG/STDDEV of pctQtyDeviasiToBom)
6. Fetches area + network benchmarks (parallel Promise.all)
7. Builds timeline from trendAgg filtered by outlet

### Issue Detection (per item)
- TOLERANCE_BREACH: |devBom| > tolerance (effective = tolerancePct ?? FALLBACK_TOLERANCE_PCT)
- RESIDUAL_HIGH: residualRatio > 0.5
- HISTORICAL_ABNORMAL: zScore > 2
- OVER_EXPLAINED: |W+S+T| > |Deviasi|
- HIGH_NOMINAL: |absNominal| > 10M
- ABOVE_AREA / ABOVE_NETWORK: devBom > 1.5× area/network avg
- NEW_ITEM: no prev record
- DIRECTION_REVERSAL: prev direction != current direction

### Worklist Priority
- P1: |nominal| > 10M AND (tolerance breach OR over-explained)
- P2: tolerance breach AND |nominal| > 1M
- P3: direction reversal, new item, or general

### Response Shape
```
{ success, period, outlet, timeline, itemAnomalies, wasteAnalysis,
  menuAnalysis, dqIssues, benchmarks, newItems, disappearedItems,
  directionReversals, worklist, durationMs }
```

### Performance
- Cached with `analysisCache` (5 min TTL) keyed by outlet+period+thresholdsVersion
- Rate limited (60 req/min per IP)
- Uses raw SQL via `Prisma.$queryRaw` for efficient single-outlet queries
- No re-evaluation of all rules across network — only this outlet's records

## UI Design (6 Tabs)

### Tab 1: Overview
- Health score + rank + PIC + total item count
- 4-metric grid: Dev/BOM, Residual%, Loss/Sales, Abnormal count
- Sales + Deviasi summary (current vs prev + growth badge)
- Timeline ComposedChart (Bar sales + Bar nominal + Line devBom across ~9 periods)
- Timeline table with status badges

### Tab 2: Anomali Item
- Sortable table (by |nominal|, devBom, or z-score)
- Filter: withIssues / all / abnormal / warning
- Columns: Item, Direction, QTY Dev, Nominal, Dev/BOM, Tolerance, Z-Score, vs Area, Issues badges
- Click row → close Focus Mode + open ItemDeepDive (no stacking)
- Benchmark comparison cards (vs area + network with multiplier)

### Tab 3: Waste & Residual
- 4-card grid: WASTE/SUSUT/TRIAL/RESIDUAL (with % of BOM)
- Deviation breakdown PieChart (nominal)
- Over-explained items table (W+S+T > Deviasi)
- High residual items table (>50%)

### Tab 4: Menu & BOM
- Group by prefix (first word of item name)
- Collapsible groups with count, Σ deviation, avg devBom
- Outlier detection: devBom > avg + 2*stdDev (or 3× avg if stdDev=0)
- Outlier callout: "Item X naik 200% sementara item lain di menu sama stabil → outlier"

### Tab 5: Data Quality
- 3 summary cards (ERROR/WARNING/INFO counts)
- DQ issues grouped by code with DQ_FIXES map for action recommendations
- Expandable details for multiple instances

### Tab 6: Investigasi
- 3 summary cards (P1/P2/P3 counts)
- 3 mini-cards: New items / Disappeared / Direction reversals
- Worklist with priority badge + OPEN/INVESTIGATING/RESOLVED status tracker (local state)
- Each entry shows: issue, evidence, metric, benchmark, possible cause, recommended action

## Entry Points (triggers for opening Focus Mode)
1. OutletHealthRanking row click (was → scorecard, now → focus)
2. OutletEfficiencyMatrix bubble click
3. CostPerThousandCard row click (bonus, was → scorecard)
4. AreaContributionBar bar click (when outletCode filter set; otherwise preserves area-filter behavior)
5. "Focus Mode" button inside OutletScorecard header

## OutletScorecard still accessible
- "Scorecard" button inside Focus Mode header → closes Focus Mode + opens OutletScorecard
- This preserves backward compat for users who want the simpler view

## Design Compliance
- shadcn/ui: Dialog, Tabs, Table, Badge, Button, Card, ScrollArea, Progress, Skeleton
- Recharts: ComposedChart, Bar, Line, PieChart, Pie, Cell
- All UI text Indonesian
- Color coding: red (#dc2626) abnormal, amber (#f59e0b) warning, emerald (#10b981) normal, sky (#0284c7) info
- Format: fmtIDR, fmtNum, fmtPct, fmtPctAbs, directionColor, priorityColor from @/lib/format
- Modal: max-w-[1200px], max-h-[90vh], overflow-hidden, flex flex-col
- Header: shrink-0
- Content area: flex-1 overflow-y-auto
- showCloseButton={false} + custom close button (X) + "Scorecard" button

## Verification
- `bun run lint` → 0 errors ✓
- `npx tsc --noEmit --skipLibCheck` → 0 errors ✓
- Manual API test: `GET /api/outlet-focus?outletCode=1030.BDGSET&month=Mei 2026&week=WEEK 1` → HTTP 200
  - 9 timeline periods returned
  - 55 item anomalies sorted by |nominal| desc
  - Health score 23 (matches existing dashboard)
  - All sections populated (wasteAnalysis, menuAnalysis, dqIssues, benchmarks, newItems, worklist)
