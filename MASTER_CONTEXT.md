# MASTER CONTEXT — Inventory Control Intelligence

> **READ THIS FIRST** — This is the master context file. Read this before any task.
>
> This document is the **single source of truth** for the project. It contains
> tech stack, architecture, database schema, API routes, components, business
> rules, performance benchmarks, security model, and current state.
>
> **Last updated:** Session FLIP-DETECT (Flip Pattern Detection A+B+C: Flip column + Flip Summary + Chart annotations + FlipMatrix + Flip Ranking API + Drill-down; SATUAN-BUG fix; BUG2-FLIP-01..06 fixes; Audit Log feature REMOVED — 2 files deleted, 11 files modified, ~565 LOC removed; File Consolidation Batch 1 (zScore/format helpers → lib/) + Batch 2 (shared peer-comparison-cards/ — 5 cards unified); UI review + fixes 35 issues; PC-focused design; 14 cached routes)
> **Maintainer:** Z.ai Code

---

## 1. Project Overview

**Inventory Control Intelligence** is an analytics dashboard for F&B restaurants
to detect and investigate stock deviations between **System (SOC/BOM)** vs
**Actual (Physical Stock)**.

### Domain Problem
Each week, every outlet submits stock opname (SO) data. The system compares:
- **QTY BOM** (Bill of Materials — expected usage based on recipes)
- **QTY COM** (Cost of Materials — actual usage)
- **QTY Deviation** (= COM − BOM)
- **QTY Waste** (controlled waste: failed frying, etc.)
- **QTY Susut** (shrinkage: evaporation, breakage, etc.)
- **QTY Trial** (new product trials)
- **QTY Loss/Surplus** (residual = Deviation − Waste − Susut − Trial)

Deviation is decomposed into 4 categories for root cause identification:
```
|QTY Deviation| = |Waste| + |Susut| + |Trial| + |Residual|
```
- **Residual > 50%** = most deviation UNEXPLAINED → indicator of fraud / input error.

### Direction Convention
- **LOSS** = `nominalLossSurplus < 0` (actual > SOC → loss)
- **SURPLUS** = `nominalLossSurplus > 0` (actual < SOC → profit)
- **NEUTRAL** = 0

---

## 2. Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | **Next.js 16.3.3** (Turbopack, App Router) |
| Language | **TypeScript 5** (strict mode) |
| Styling | **Tailwind CSS 4** + **shadcn/ui** (New York style) |
| Database | **Prisma 6.19** + **PostgreSQL** (Supabase, `ap-southeast-1`) |
| Charts | **Recharts** (lazy-loaded per chart) |
| Client State | **Zustand v5** (`useDashboard` + `useShallow`) |
| Server State | **TanStack Query v5** (staleTime 120s, gcTime 10min) |
| Runtime | **Bun** (dev server, port 3000) |
| Reverse Proxy | **Caddy** (port 81 → 3000) |

### Constraints
- Supabase free tier: 500MB storage, transaction pooler on port 6543, `connection_limit=30`.
- Single externally-exposed port (3000). Caddy handles routing.
- `z-ai-web-dev-sdk` MUST be used server-side only.

---

## 3. Database Schema

**11 Prisma models** (defined in `prisma/schema.prisma` — `AuditLog` model REMOVED in DEL-AUDIT cleanup):

| # | Model | Purpose |
|---|-------|--------|
| 1 | `SourceFile` | Uploaded file metadata (Excel/Drive) |
| 2 | `Week` | Week periods per month |
| 3 | `Outlet` | Outlet master (333 outlets, 14 areas) |
| 4 | `Item` | Item master (109 items) |
| 5 | `InventoryRecord` | Core fact table (~54K records/month) |
| 6 | `OutletPeriodSales` | Outlet sales per period (for peer comparison) |
| 7 | `DQIssue` | Data quality issues detected |
| 8 | `AggregationCache` | DB-level cache (5-min TTL) |
| 9 | `Setting` | 24 configurable thresholds |
| 10 | `OutletPIC` | PIC assignments (339 entries) |
| 11 | `FileChunk` | Resumable upload chunks |

> **REMOVED (DEL-AUDIT):** `AuditLog` model (was #8 — write audit trail, 11 write sites) — entire audit log feature deleted: model in `prisma/schema.prisma`, `/api/audit-log` route, `AuditLogDialog.tsx`, 14 write sites, dashboard button + state, middleware entry. 2 files deleted, 11 files modified, ~565 LOC removed, 0 dangling references (verified clean).

### Prisma Client
- Config: `connection_limit=30`, `pool_timeout=60s`
- All raw SQL is **parameterized** (`$queryRaw` with tagged templates, **zero** `$queryRawUnsafe`)

---

## 4. API Routes (27 routes)

| Route | Cache | Zod | Rate Limit | Auth |
|-------|-------|------|------------|------|
| `/api/analysis` | ✅ DB 5min (SWR) | ✅ | ✅ | Public GET |
| `/api/area-item-heatmap` | ✅ DB 5min (SWR) | ✅ | ✅ | Public GET |
| `/api/area-item-heatmap/cell-detail` | ❌ | ✅ | ✅ | Public GET (sub-route) |
| `/api/data` | ❌ | ✅ | ✅ | Protected mutations |
| `/api/drilldown` | ✅ DB 5min (SWR) | ✅ | ✅ | Public GET |
| `/api/export-report` | ✅ DB 5min (SWR) | ✅ | ✅ | Public GET |
| `/api/flip-ranking` | ✅ DB 5min (SWR) | ✅ | ✅ | Public GET (NEW Phase C) |
| `/api/flip-ranking/drilldown` | ✅ DB 5min (SWR) | ✅ | ✅ | Public GET (NEW Phase C — per-outlet breakdown) |
| `/api/import-drive` | ❌ | ✅ | ✅ | Protected POST |
| `/api/ingest` | ❌ | ✅ | ✅ | Protected |
| `/api/ingest-process` | ❌ | ✅ | ✅ | Protected |
| `/api/ingest-upload` | ❌ | ✅ | ✅ | Protected POST |
| `/api/item-history` | ✅ DB 5min (SWR) | ✅ | ✅ | Public GET |
| `/api/item-peer-comparison` | ✅ DB 5min (SWR) | ✅ | ✅ | Public GET (Phase 2) |
| `/api/item-search` | ❌ | ✅ | ✅ | Public GET (autocomplete-only — cross-outlet + trend modes REMOVED) |
| `/api/item-trend` | ✅ DB 5min (SWR) | ✅ | ✅ | Public GET |
| `/api/item-trend-rank` | ✅ DB 5min (SWR) | ✅ | ✅ | Public GET (Phase 3) |
| `/api/migrate-direction` | ❌ | ✅ | ✅ | Protected |
| `/api/outlet-items` | ✅ DB 5min (SWR) | ✅ | ✅ | Public GET |
| `/api/pareto` | ✅ DB 5min (SWR) | ✅ | ✅ | Public GET |
| `/api/peer-comparison` | ❌ | ✅ | ✅ | Public GET |
| `/api/pic` | ❌ | ✅ | ✅ | Protected mutations |
| `/api/recommendations` | ✅ DB 5min (SWR) | ✅ | ✅ | Public GET |
| `/api/resto-bahan-matrix` | ✅ DB 5min (SWR) | ✅ | ✅ | Public GET |
| `/api/settings` | ❌ | ✅ | ✅ | Protected |
| `/api/setup` | ❌ | ✅ | ✅ | Protected |
| `/api/status` | ❌ (in-memory) | ✅ | ❌ | Public GET |

**Totals:** 25/27 main routes use Zod validation (incl. `/api/item-search` — Zod added in AUDIT-NEWFEATURES C4; only `/api/status` skips Zod) · **14 routes use DB cache** (analysis, pareto, recommendations, resto-bahan-matrix, export-report, outlet-items, item-history, drilldown, area-item-heatmap, item-trend, item-peer-comparison, item-trend-rank, flip-ranking, flip-ranking-drilldown) · All protected routes use `ADMIN_TOKEN` middleware.

**REMOVED (DEL-AUDIT):** `/api/audit-log` route + `AuditLog` Prisma model — entire audit log feature deleted (model, route, dialog, 14 write sites, button, state, middleware entry). 0 dangling references verified.

**New route specs:**
- `GET /api/item-peer-comparison?item=&month=&week=&outletCode=&area=&kelompok=&pic=` — Target outlet + peer outlets (BOM ±50% via `ABS(c.qtyBom) BETWEEN ABS(t.qtyBom)*0.5 AND *1.5`) + peer averages. Auto-selects worst outlet (ORDER BY ABS(nominalDeviasi) DESC LIMIT 1) when `outletCode` omitted. 5-min DB cache + SWR. Phase 2.
- `GET /api/item-trend-rank?item=&week=&area=&kelompok=&outlet=&pic=` — Per-period national rank by `ABS(nominalDeviasi)` via `RANK() OVER (PARTITION BY monthLabel, weekLabel ORDER BY absNominal DESC)`. Week filter respected. 5-min DB cache + SWR. Phase 3.
- `GET /api/flip-ranking?week=&month=&area=&kelompok=&outlet=&pic=&limit=` — Cross-item flip risk ranking. Scans ALL items per (period, item) SIGNED SUM(qtyDeviasi) aggregate via GROUP BY monthLabel, weekLabel, i.name. Risk score = `sempurnaCount*100 + dominanCount*40 + parsialCount*15` (sempurna = flip pair with disparity < 10%, dominan < 40%, parsial ≥ 40%). Risk level: `sempurnaCount>0 ? high : flipCount>0 ? moderate : low` (aligned FE+BE in BUG2-FLIP-05 fix). 5-min DB cache + SWR. Phase C.
- `GET /api/flip-ranking/drilldown?item=&week=&month1=&month2=` — Per-outlet breakdown for ONE flip pair. Returns outlet × P1 QTY + P2 QTY + Δ QTY + Net + flip% (disparityPct = |net| / MAX(|P1|,|P2|) × 100). Sorted by flip% ASC (most balanced at top). Filtered to flip-only outlets. Satuan-aware (dynamic unit, not hardcoded `kg`). 5-min DB cache + SWR. Phase C.

**14 cached routes** (all use `withCacheAndDedup` SWR — including `/api/analysis` which was migrated from legacy `getCached` to `getCachedWithMeta` SWR):
1. `/api/analysis` (SWR via `getCachedWithMeta` — stale data served immediately + background refresh)
2. `/api/pareto`
3. `/api/recommendations`
4. `/api/resto-bahan-matrix`
5. `/api/export-report` (binary docx buffer)
6. `/api/outlet-items`
7. `/api/item-history`
8. `/api/drilldown`
9. `/api/area-item-heatmap`
10. `/api/item-trend` (per-item QTY fluctuation across periods)
11. `/api/item-peer-comparison` (Phase 2 — target + peers BOM ±50% + averages; auto-selects worst outlet)
12. `/api/item-trend-rank` (Phase 3 — per-period national rank by ABS(nominalDeviasi); RANK() window function)
13. `/api/flip-ranking` (NEW Phase C — cross-item flip risk ranking; sempurna/dominan/parsial categories)
14. `/api/flip-ranking/drilldown` (NEW Phase C — per-outlet flip breakdown; sorted by flip% ASC)

> `/api/area-item-heatmap/cell-detail` is NOT cached (direct query — small result set, low latency, user-initiated drill-down).
>
---

## 5. Components (35+)

### Dashboard (`src/components/dashboard/` — 24 components + `tabs/` folder + `shared/` barrel)
- `ExecutiveSummary` — KPI cards (sales, deviation, abnormal count)
- `TopItems` — Top items by deviation
- `TopOutlets` — Top outlets by deviation
- `InsightsPanel` — AI narrative insights
- `RestoRecommendationCard` — Restaurant recommendation card
- `AdvancedAnalysis` — Advanced analysis panel
- `Charts` — 5 chart types (Deviation, Waste, Susut, Trial, Residual)
- `HistoricalZScoreCard` — Z-Score with 2-metric selector: Dev/BOM (ratio) + QTY Deviasi (absolute, signed display). Z-Score is SIGNED: positive=above historical mean (worse, red), negative=below (better, green). Only positive zScore triggers anomaly rules. Waste/Susut/Trial removed from selector per user request.
- `BomCorrelationCard` — Per-record BOM correlation findings table (Outlet × Item × Rule × Growth × Ratio) + per-rule count badges + aggregate alignment table + narrative — *reads `bomCorrelationFindings` from `/api/analysis` response (added in FIX-BOM-UI rewrite)*
- `ItemDeepDive` — Item-level deep dive
- `ParetoDashboard` — Pareto 80/20 analysis
- `PeerComparison` — Outlet vs ±10% sales peers
- `RestoAnalysis` — Restaurant analysis panel
- `AreaItemHeatmap` — Area × Item heatmap with Pareto 80/20 mode + dual display (Total + Ø per resto) + drill-down Sheet (lazy-loaded)
- `AreaItemHeatmapSheet` — Drill-down Sheet (right-side) showing per-outlet detail for a clicked cell — lazy-loaded via `next/dynamic` (PERF-FE-01)
- `DashboardHeader` — Sticky 2-tier header (logo + actions + FilterBar); extracted from `page.tsx` split
- `DashboardFooter` — Sticky bottom footer (brand + stats + last-analysis perf); extracted from `page.tsx` split

#### `tabs/` folder (6 tab modules — extracted from `page.tsx` split)
- `DashboardTab.tsx` — Main overview tab (11 sections: Exec Summary, Resto Rec, Insights, Health+Growth, Multi-Period, Top Items+Outlets, Area+Ranking, Item Consistency [Massal/Regional/Lokal], Z-Score+BOM Correlation, Loss/Surplus, Heatmap). Owns 7 `next/dynamic` lazy imports for heavy chart components.
- `RestoTab.tsx` — Wraps lazy `RestoAnalysis` in `FetchAware` + `ErrorBoundary`
- `PeerTab.tsx` — Wraps lazy `PeerComparison` in `FetchAware` + `ErrorBoundary`
- `ParetoTab.tsx` — Wraps static `ParetoDashboard` in `FetchAware` + `ErrorBoundary`
- `ItemTrendTab.tsx` — Trend Item tab (5th tab) — item search autocomplete + metric selector (QTY Deviasi/Waste/Susut/Trial) + sortable table + Z-Score coloring (signed: positive=red/worse, negative=green/better) + Rank Badge header + Period drill-down + Rank Trend chart + Peer Comparison panel. See `tabs/ItemTrendTab/` folder above for the 8-module breakdown.
- `ItemTrendLineChart.tsx` — Recharts LineChart (lazy-loaded) — dual Y-axis (QTY left, Z-Score right), historical mean baseline (dashed), color-coded Z-Score dots, ReferenceLines at z=±2,±3

#### `tabs/ItemTrendTab/` folder (NEW Phase 1+2+3 + Phase A+B+C — 11 modules + barrel index, split from monolithic `ItemTrendTab.tsx`)
- `index.tsx` — Trend Item tab orchestrator (663 LOC): `RankBadgeRow` (national rank from `topDeviasiRank`) + search bar + table + LineChart + RankChart + PeerComparison; owns `drillPeriod` state synced with dashboard month/week via "adjust state during render" pattern.
- `ItemTrendSearchBar.tsx` — Debounced autocomplete (≥2 chars) backed by `/api/item-search?mode=autocomplete`.
- `ItemTrendTable.tsx` — Sortable period table (277 LOC) with Z-Score coloring (signed) + **Pattern column** (`patternBadge`: Massal ≥10 / Regional 5-9 / Lokal 2-4 / Tunggal =1) + **Flip column** (Phase A: per-period flip badge 🟢/🟡/🔴/⚪/📍).
- `ItemTrendLineChart.tsx` — Recharts LineChart (lazy-loaded) — dual Y-axis (QTY left, Z-Score right), historical mean baseline (dashed), color-coded Z-Score dots, ReferenceLines at z=±2,±3, **amber dashed ring on flip dots** (Phase A — filtered to isFlip===true after BUG2-FLIP-01 fix).
- `ItemTrendRankChart.tsx` — NEW Phase 3: Compact rank trend chart (264 LOC, 100px height) — Y-axis INVERTED via `reversed` prop (rank #1 at top), per-dot coloring (red ≤5 / amber 6-20 / muted >20), ReferenceLines at y=5 + y=20, click handler syncs with `drillPeriod`.
- `ItemPeerComparison.tsx` — NEW Phase 2: Peer comparison panel (797 LOC) — 4 analysis cards (EfficiencyScoreCard / GapAnalysisCard / ScatterPlotCard / RankingSummaryCard — now imported from `shared/peer-comparison-cards/` after Batch 2 consolidation) + peer table with anomaly flags + row click → Resto tab.
- `FlipMatrix.tsx` — NEW Phase B: Week × Month grid for the selected item — color-coded cells (red=LOSS / emerald=SURPLUS / muted=zero), amber ring on flip cells, sticky left column (item name) + sticky top header. Native `<table>` (not shadcn `<Table>`) for tight grid layout. Satuan-aware via `fmtFullSigned`.
- `FlipRanking.tsx` — NEW Phase C: Cross-item flip ranking widget — sortable 7-column table (Rank | Item | Flips | Sempurna | AvgDisparity | RiskScore | TopFlipPair) + tooltip showing P1/P2 signed QTY + net + disparity + category. Clickable row → `setTrendSelectedItem` + drill-down expandable chevron (only HIGH+MODERATE risk items — LOW items have empty topFlips). Drill-down renders **unified table** (Ide 3): 1 row per outlet with Outlet | Area | PIC | P1 QTY | P2 QTY | Δ QTY | Net | 🔀 Flip%, sorted by flip disparityPct ASC (most balanced at top), filtered to flip-only outlets, satuan-aware. Backed by `/api/flip-ranking/drilldown`.
- `flipHelpers.ts` — NEW Phase A: Flip analysis logic — `isFlip(p1, p2)` (sign(P1) !== sign(P2) && both non-zero), `disparity(p1, p2)` = `|P1+P2| / MAX(|P1|,|P2|)` (0% = perfectly balanced = suspicious), `categorizeFlip(disparity)` (sempurna <10% / dominan <40% / parsial ≥40%), `flipRiskBadge()` aggregate risk per item (🟢 low / 🟡 moderate / 🔴 high / ⚪ none).
- `types.ts` + `zScoreHelpers.ts` (re-export barrel to `@/lib/zScoreHelpers` post-Batch-1) + `periodHelpers.ts` — Shared types + Z-Score color helpers + period short-label helpers.

#### `shared/peer-comparison-cards/` folder (NEW Batch 2 — 7 files, 675 LOC, presentational only — each caller computes its own values)
- `index.ts` (31 LOC) — Barrel re-export.
- `types.ts` (99 LOC) — `AnomalyFlag`, `GapRow`, `ScatterPoint`, `RankItem`, `BasePeerRow`, `BasePeerAverages`.
- `efficiency-score-card.tsx` (78 LOC) — Accepts pre-computed `score: number` (generic — Item Tab vs Peer Tab formulas differ, caller handles).
- `gap-analysis-card.tsx` (96 LOC) — Accepts pre-computed `rows: GapRow[]` + optional `gridCols` (1 Item Tab, 2 Peer Tab).
- `scatter-plot-card.tsx` (176 LOC) — Accepts pre-computed `points` + `colorMode` (`'target-only'` Peer Tab, `'direction-based'` Item Tab).
- `ranking-summary-card.tsx` (80 LOC) — Accepts pre-computed `items: RankItem[]` + `gridCols` (2 Item, 3 Peer) + `itemLayout`.
- `anomaly-flags.tsx` (115 LOC) — `AnomalyFlags` presentational + `computeAnomalyFlags` helper (Item Trend pattern only; Peer Tab keeps its 4-metric compute inline since semantics differ).

#### `shared/index.tsx` (7 shared utilities)
`EmptyState`, `LoadingState`, `ErrorState`, `SectionHeader`, `ScrollToTop`, `FetchAware`, `LoadingChart` (last 2 added in `page.tsx` split).

> **Removed (FIX-DOCS dead-code cleanup):** `AreaTrendChart.tsx`, `CardDrillDown.tsx` files deleted. `cardDrillDown` Zustand state removed from `useDashboard`. ExecutiveSummary KPI cards are now static display (no click-through drilldown). `RestoAnalisa` priority-score drilldown is also a static card display.
>
> **Removed (Phase 1+2+3 cleanup):** `GlobalItemSearchModal.tsx` (Cmd+K cross-outlet modal) + `ItemTrendChart.tsx` (legacy chart, replaced by `ItemTrendLineChart.tsx` + `ItemTrendRankChart.tsx`) + `lib/queries/items/network-risk.ts` (unused cross-outlet analysis) — all deleted. `/api/item-search` reduced to `autocomplete` mode only (cross-outlet + trend modes removed).
>
> **Removed (Batch 2 consolidation):** 5 `peer-comparison/*.tsx` files deleted (`efficiency-score-card.tsx`, `gap-analysis-card.tsx`, `scatter-chart.tsx`, `ranking-summary-card.tsx`, `anomaly-flags.tsx` — 417 LOC total). Replaced by unified `shared/peer-comparison-cards/` module (675 LOC). Kept `peer-comparison/types.ts` + `helpers.ts` + `items-table.tsx` + `trend-chart.tsx` + `correlation-insight-card.tsx` (unique to Peer Tab). ~766 LOC duplication eliminated. `ItemPeerComparison.tsx` + `PeerComparison.tsx` import from shared barrel.
>
> **Removed (DEL-AUDIT):** `AuditLogDialog.tsx` deleted from `filters/`. Audit log button + `auditLogOpen` state removed from `DashboardHeader.tsx` + `page.tsx` respectively. `useDashboardActions.ts` audit log keyboard shortcut removed. `/api/audit-log` middleware entry removed. `AuditLog` Prisma model removed. 2 files deleted, 11 files modified, ~565 LOC removed, 0 dangling references.
>
> **`page.tsx` split (SPLIT-PAGE task):** `page.tsx` reduced from 735 → 227 lines (69% reduction). 9 new modules created: 4 tab components + 2 layout components (`DashboardHeader`/`DashboardFooter`) + 2 hooks (`useDashboardEffects`/`useDashboardActions`) + `shared/index.tsx` extension (`FetchAware` + `LoadingChart`).

### Hooks (`src/hooks/` — 6 hooks)
- `useAnalysis/` — NEW (SPLIT Batch 2): 8-file folder (barrel `index.ts` + `types.ts` + `fetchAnalysis.ts` + `prefetchHeatmap.ts` + `useAnalysis.ts` + `useStatus.ts` + `useDrilldown.ts` + `useItemTrend.ts`) — TanStack Query hooks (`useAnalysis`, `useStatus`, `useDrilldown`, `useItemTrend`) + `prefetchAnalysis` + `prefetchHeatmap`. Split from monolithic `useAnalysis.ts` (839 LOC) — barrel re-export preserves public API for all callers.
- `useDashboard.ts` — Zustand store (filters + UI state + `trendSelectedItem` + `setTrendSelectedItem` [NEW Phase 1] + `setFocusOutlet` [NEW Phase 2] — cross-tab navigation bridge from RankingNasionalCard → Trend Item Tab)
- `useDashboardEffects.ts` — NEW (SPLIT-PAGE): bundles 5 `useEffect` hooks (auto-select month, auto-select week, cache warming via `prefetchAnalysis` + `prefetchHeatmap`, auto-set compare period with BUG-1 fix, week validation BUG-8 fix). Side-effect-only — no return value.
- `useDashboardActions.ts` — NEW (SPLIT-PAGE): export/refresh handlers (`handleExport` + `handleRefresh` + `isExporting` state) + global keyboard shortcuts (`Cmd+E/R/K`, `1/2/3/4/5` tab switch [5=Trend Item], `Escape` close-all).
- `use-mobile.ts` — Responsive viewport hook (shadcn)
- `use-toast.ts` — Toast notification hook (shadcn)

### Filters (`src/components/filters/` — 9 components — `AuditLogDialog.tsx` REMOVED in DEL-AUDIT)
- `FilterBar` — Main filter bar
- `SettingsDialog` — 24 threshold settings editor
- `DataManagementDialog` — Data management UI
- `PicManagementDialog` — PIC assignment management
- `FileUploadDialog` — Excel upload
- `DriveImportDialog` — Google Drive import
- `SearchableComboBox` — Reusable searchable combo box

### Drilldown (`src/components/drilldown/` — 2 components)
- `DrillDownDrawer` — Slide-out drill-down panel
- `SourceDataModal` — Source data modal viewer

### UI (`src/components/ui/` — 29 shadcn components)
- Complete shadcn/ui (New York) component set

### Optimizations
- All dashboard components wrapped in `React.memo` + `ErrorBoundary`
- Recharts lazy-loaded per chart instance

---

## 6. Key Features

### Anomaly Engine
- **19-rule engine** (15 original + 4 BOM correlation, YAML-configured, SQL-pushed evaluator)
- Rules defined in `src/config/rules.yaml` (sole source of truth — `src/config/rules.ts` was deleted as dead code in FIX-DOCS)
- Evaluator: SQL push-down in `src/lib/queries/rule-evaluation.ts` (16 rules) + JS post-process for zScore-based rules (3 rules: HISTORICAL_ABNORMAL, HISTORICAL_ABNORMAL_SURPLUS, HISTORICAL_WARNING). The former `BENCHMARK_ABOVE_AREA` + `BENCHMARK_ABOVE_NETWORK` rules were deleted in FIX-RULE-CONFIG (CONFIG-05) as duplicates of HISTORICAL_WARNING / HISTORICAL_ABNORMAL.
- Analysis modules: `patternEngine`, `rootCauseEngine`, `ruleService`. The `ROOT_CAUSE_MAPPINGS` table in `rootCauseEngine.ts` now includes 4 BOM correlation rule mappings (WASTE_BOM_MISMATCH, SUSUT_BOM_MISMATCH, TRIAL_BOM_MISMATCH, BOM_DEVIATION_DISPROPORTIONATE); the 2 BENCHMARK mappings were removed alongside the rule deletions.

### 19 Anomaly Rules

| # | Code | Category | Severity | Priority | Trigger |
|---|------|----------|----------|----------|---------|
| 1 | `SALES_DEVIATION_MISMATCH` | SALES | ABNORMAL | 90 | Deviation growth > 2× sales growth (both positive) |
| 2 | `SALES_DEV_DECREASE` | SALES | ABNORMAL | 85 | Sales down but deviation up |
| 3 | `BOM_DEVIATION_MISMATCH` | BOM | ABNORMAL | 88 | QTY Deviation growth > 2× BOM growth |
| 4 | `BOM_DOWN_DEV_UP` | BOM | ABNORMAL | 82 | BOM down but deviation up |
| 5 | `WASTE_BOM_MISMATCH` | BOM | WARNING | 55 | Waste growth diverges from BOM growth (opposite sign) — *new* |
| 6 | `SUSUT_BOM_MISMATCH` | BOM | WARNING | 54 | Susut growth diverges from BOM growth — *new* |
| 7 | `TRIAL_BOM_MISMATCH` | BOM | WARNING | 53 | Trial growth diverges from BOM growth — *new* |
| 8 | `BOM_DEVIATION_DISPROPORTIONATE` | BOM | WARNING | 56 | Deviation growth > 1.5× BOM growth (but ≤ 2×) — *new* |
| 9 | `TOLERANCE_BREACH_HIGH` | TOLERANCE | ABNORMAL | 80 | `|Dev/BOM|` > 2× `|tolerancePct|` |
| 10 | `TOLERANCE_BREACH` | TOLERANCE | WARNING | 70 | `|Dev/BOM|` > `|tolerancePct|` |
| 11 | `TOLERANCE_NOT_SET_HIGH_DEV` | TOLERANCE | WARNING | 65 | High `|Dev/BOM|` but tolerance is NULL |
| 12 | `OVER_EXPLAINED` | RESIDUAL | ABNORMAL | 76 | Waste + Susut + Trial > total deviation (fraud red flag) |
| 13 | `RESIDUAL_LOSS_HIGH` | RESIDUAL | ABNORMAL | 75 | Residual ratio > `residualLossHighPct` AND direction = LOSS |
| 14 | `RESIDUAL_LOSS_WARN` | RESIDUAL | WARNING | 60 | Residual ratio > `residualLossWarnPct` AND ≤ high AND LOSS |
| 15 | `HIGH_LOSS_NOMINAL` | DIRECTION | ABNORMAL | 80 | `|nominalLossSurplus|` > `highLossNominalThreshold` AND LOSS |
| 16 | `DIRECTION_FLIP` | HISTORICAL | WARNING | 60 | Direction flipped LOSS ↔ SURPLUS vs previous period |
| 17 | `HISTORICAL_ABNORMAL` | HISTORICAL | ABNORMAL | 78 | zScore > `historicalZscoreHigh` AND LOSS |
| 18 | `HISTORICAL_ABNORMAL_SURPLUS` | HISTORICAL | ABNORMAL | 77 | zScore > `historicalZscoreHigh` AND SURPLUS |
| 19 | `HISTORICAL_WARNING` | HISTORICAL | WARNING | 58 | warn < zScore ≤ high |

> **Removed (FIX-RULE-CONFIG CONFIG-05):** `BENCHMARK_ABOVE_AREA` (was P50, WARNING) + `BENCHMARK_ABOVE_NETWORK` (was P72, ABNORMAL) — duplicates of `HISTORICAL_WARNING` / `HISTORICAL_ABNORMAL` (same zScore condition, different name). True area/network comparison lives in `computeBenchmark()` and surfaces as `ABOVE_AREA` / `ABOVE_NETWORK` flags on the Resto Profile, not as rules.

### BOM Correlation Analysis
- 4 rules detect when Waste/Susut/Trial growth diverges in sign from BOM growth, or when Deviation growth is disproportionate to BOM growth. The disproportionate threshold is configurable via the `BOM_DISPROPORTIONATE_FACTOR` setting (default `1.5`; range 1.0–5.0) — replaces the previously hardcoded 1.5× factor and is decoupled from `BOM_DEVIATION_FACTOR` (the 2× upper bound for rule 3).
- Growth fields `wasteGrowth` / `susutGrowth` / `trialGrowth` (alongside existing `bomGrowth` / `qtyDeviasiGrowth` / `salesGrowth` / `nominalDeviasiGrowth`) are computed in the rule-evaluation CTE using `ABS(...)` magnitude and div-by-zero guards.
- Dashboard component: `BomCorrelationCard` (`src/components/dashboard/BomCorrelationCard.tsx`) renders (1) a per-record findings table with per-rule count badges — read from the `bomCorrelationFindings` + `bomCorrelationCounts` fields on the `/api/analysis` response, and (2) an aggregate Deviasi/Waste/Susut/Trial vs BOM alignment table. The card lives on the Dashboard tab (under "Analisis Historis").

### Analytics
- **Heatmap Area × Item** (NEW — 3 capabilities):
  - **Drill-down to Resto**: Click any heatmap cell → opens right-side Sheet (`AreaItemHeatmapSheet`) with per-outlet detail. API: `/api/area-item-heatmap/cell-detail?month=&week=&area=&item=`. Query: `queryHeatmapCellDetail()` in `src/lib/queries/heatmap.ts` — JOINs `Outlet` + `Item`, returns 13 fields per row (outlet name/code, akun penyesuaian, qtyBom/Deviasi/Waste/Susut/Trial, nominalDeviasi/LossSurplus, pctQtyDeviasiToBom, recordCount). Footer has TOTAL row + Ø PER RESTO row (avg per outlet). Header has aggregate summary incl. a `Ø per Resto` column.
  - **Pareto 80/20 mode** (default): shows only items contributing to 80% of total magnitude. Mode selector: "Pareto 80%" (default) or "Top N" (legacy). `ItemSelectMode` type in `heatmap.ts`. `paretoInfo` in response: `{ totalItems, selectedItems, cumulativePct, totalMagnitude }`. Smart fallback: `pctQtyDeviasiToBom` + `recordCount` metrics auto-use "Top N" (Pareto not meaningful for averages/counts).
  - **Dual display (Total + Avg per outlet)**: Each cell shows 2 values — Total (bold, top) + Ø Avg per resto (muted, bottom). `outletCount` field in `HeatmapCell` (from `COUNT(DISTINCT outletId)`). Avg only for nominal metrics (`absNominalDeviasi`/`nominalWaste`/`nominalSusut`) — NOT for `pctQtyDeviasiToBom` or `recordCount`. Cell height `h-11` (44px) fits 2 lines. Tooltip shows Total + Avg + Outlet Count + Record Count.
  - **Raw quantities in cells**: Each cell returns `qtyBom`/`qtyDeviasi`/`qtyWaste`/`qtySusut`/`qtyTrial` + `nominalDeviasi`/`nominalLossSurplus` so the drill-down Sheet can show real quantities without an extra query on the parent heatmap.
- **BOM Correlation analysis** (per-record findings + aggregate alignment table) — surfaced as dashboard card + 4 rules
- **Historical Z-Score** analysis (SIGNED: positive=above mean=worse/red, negative=below=better/green). 2-metric selector: Dev/BOM ratio + QTY Deviasi (absolute). Only items with zScore > 0 (current above historical) shown as anomalous.
- **Pareto 80/20** analysis (5 dimensions: Item, Outlet, Area, Kelompok, PIC)
- **Peer comparison** (outlet vs ±10% sales peers)
- **Outlet health ranking** (3D: Financial + Operational + Unexplained)

### Trend Item Tab Expansion (NEW Phase 1+2+3)
6 new modules in the Trend Item Tab (`/components/dashboard/tabs/ItemTrendTab/`):
1. **Rank Badge** (Phase 1): `RankBadgeRow` in `index.tsx` — looks up national rank from `analysisData.topDeviasiRank` (filtered by `itemName`, `Math.min` across all matching outlet rows for best rank). Renders 3 badges: Deviasi rank (red ≤5 / amber 6-20 / muted >20), BOM rank (nullable for `qtyBom=0` items — BUG-1-01 fix), and outlet count. Fallback: "Rank > 50 Nasional" muted badge when item not in top-50.
2. **Pattern column** (Phase 1): `patternBadge()` in `ItemTrendTable.tsx` — classifies period by `outletCount`: Massal ≥10 (🔴) / Regional 5-9 (🟡) / Lokal 2-4 (⚪) / Tunggal =1 (⚪, with BUG-1-02/03 cosmetic fix documented).
3. **Rank Trend chart** (Phase 3): `ItemTrendRankChart.tsx` (264 LOC, 100px height) — Recharts LineChart with Y-axis INVERTED via `reversed` prop (rank #1 at top, worst rank at bottom). Per-dot coloring: red ≤5 / amber 6-20 / muted >20. ReferenceLines at y=5 (red dashed) + y=20 (amber dashed) — only rendered when `maxRank ≥ threshold`. Click handler syncs with `drillPeriod` (same pattern as `ItemTrendLineChart`). Backed by `/api/item-trend-rank`.
4. **Item Peer Comparison** (Phase 2): `ItemPeerComparison.tsx` (797 LOC) — full panel with 4 analysis cards (now imported from `shared/peer-comparison-cards/` post-Batch-2 consolidation):
   - **EfficiencyScoreCard**: `100 - (devBomPenalty + nominalPenalty)`, each penalty bounded `[0,50]`, ABS magnitude comparison (BUG-2-03 fix).
   - **GapAnalysisCard**: Target vs peerAvg vs peerBest, with `Dev/BOM` row.
   - **ScatterPlotCard**: Peer outlets plotted on (BOM, Deviasi) — target highlighted with amber ring + larger radius (BUG-2-01/02 fix: target prepended to peers array).
   - **RankingSummaryCard**: Target's rank among peers (with `p` percentile).
   Peer table with anomaly flags (Normal / Near Peer Avg / Anomali) + row click → Resto tab via `setFocusOutlet`. Backed by `/api/item-peer-comparison`.
5. **Period drill-down** (Phase 2): Row click in `ItemTrendTable` OR dot click in `ItemTrendRankChart` OR dot click in `ItemTrendLineChart` → sets `drillPeriod` → `ItemPeerComparison` re-fetches for the selected period. Auto-syncs with dashboard month/week via "adjust state during render" pattern (`prevPeriodKey` guard prevents infinite loops).
6. **Navigation Bridge** (Phase 1): `RankingNasionalCard` row click on Dashboard tab → `setTrendSelectedItem(itemName)` (Zustand) + `setActiveTab('trend')` → Trend Item Tab mounts + `useDashboard(useShallow(...))` reads `trendSelectedItem` → search bar auto-populated + analysis re-fetched for the selected item. State persists across tab switches (Zustand store survives Radix Tabs unmount).

### Flip Pattern Detection (NEW Phase A+B+C)
Detects **suspicious reversal patterns** — an item whose deviation flips sign between consecutive periods (P1=LOSS ↔ P2=SURPLUS) with magnitudes that nearly cancel each other out (disparity close to 0%). A perfectly balanced reversal is statistically improbable in normal operations and may indicate fraud, input error, or period-shifting to mask losses.

**Formula** (`flipHelpers.ts`):
- `isFlip(p1, p2)` = `sign(P1) !== sign(P2)` AND both non-zero (P1=0 or P2=0 → not a flip; same sign → not a flip)
- `disparity(p1, p2)` = `|P1+P2| / MAX(|P1|,|P2|)` — **0% = perfectly balanced (suspicious)**; 100% = one period dominates
- `categorizeFlip(disparity)`:
  - 🟢 **Sempurna** ("perfect") — disparity < 10% (strongest fraud signal)
  - 🟡 **Dominan** — disparity 10-40% (one period dominates but other still significant)
  - 🔴 **Parsial** — disparity ≥ 40% (weakest flip signal)
- Risk level (aligned FE+BE per BUG2-FLIP-05): `sempurnaCount>0 ? 'high' : flipCount>0 ? 'moderate' : 'low'`
- Risk score (BE): `sempurnaCount*100 + dominanCount*40 + parsialCount*15`

**3 implementation phases:**

#### Phase A — Flip column + Summary card + Chart annotations (per-item, in Trend Item Tab)
1. **Flip column** in `ItemTrendTable.tsx`: per-period badge — 🟢 sempurna / 🟡 dominan / 🔴 parsial / ⚪ no-flip / 📍 non-applicable (single-period). Sortable (BUG2-FLIP-02/04 fix: nulls always sort to bottom via custom comparator).
2. **Flip Summary Card** (`FlipSummaryCard`) in `index.tsx`: aggregate risk per item — moved to `CardContent` (above chart) per UI-10 fix (was in `CardHeader`, cluttered). Shows risk badge (🟢/🟡/🔴) + sempurna/dominan/parsial counts.
3. **Chart annotations** in `ItemTrendLineChart.tsx`: amber dashed ring on flip dots. Filtered to `isFlip===true` only (BUG2-FLIP-01 fix — previously drew rings on non-flip pairs too).

#### Phase B — Flip Matrix grid (per-item)
`FlipMatrix.tsx` — week × month grid for the selected item. Cells color-coded by sign (red=LOSS / emerald=SURPLUS / muted=zero), amber ring on flip cells (P1+P2 pair). Sticky left column (item name) + sticky top header (period labels). Native `<table>` (not shadcn `<Table>`) for tight grid layout. Satuan-aware via `fmtFullSigned` (full QTY, no compact abbrev).

#### Phase C — Flip Ranking (cross-item) + drill-down (unified table)
1. **Flip Ranking API** (`/api/flip-ranking?week=&month=&area=&kelompok=&outlet=&pic=&limit=`): scans ALL items per (period, item) SIGNED SUM(qtyDeviasi) aggregate via GROUP BY. Returns per-item: `flipCount` + `sempurnaCount` + `dominanCount` + `parsialCount` + `avgDisparity` + `riskScore` + `riskLevel` + `topFlips` (top 3 flip pairs with P1/P2/Δ/net/disparity/category). Sorted by `riskScore DESC, sempurnaCount DESC, flipCount DESC`. Items with 0 flip pairs filtered out (BUG2-FLIP-06 fix). 5-min DB cache + SWR. Month filter respects either full "Juli 2026" OR short "Jul" via ILIKE prefix.
2. **Flip Ranking Widget** (`FlipRanking.tsx`): sortable 7-column table (Rank | Item | Flips | Sempurna | AvgDisparity | RiskScore | TopFlipPair) + tooltip showing P1/P2 signed QTY + net + disparity + category. Clickable row → `setTrendSelectedItem` → tab switches to Trend Item tab + search auto-populated. Drill-down expandable chevron **only on HIGH+MODERATE risk items** (LOW items have empty topFlips, so chevron hidden — UI2-08 a11y note).
3. **Drill-down API** (`/api/flip-ranking/drilldown?item=&week=&month1=&month2=`): per-outlet breakdown for ONE flip pair. Returns outlet × P1 QTY + P2 QTY + Δ QTY + Net + flip% (disparityPct = `|net| / MAX(|P1|,|P2|) × 100`). Sorted by flip% ASC (most balanced at top). Filtered to flip-only outlets. Satuan-aware (dynamic unit, not hardcoded `kg` — SATUAN-BUG fix via `MAX(ir.satuan)` query + `ItemTrendPeriod.satuan` field).
4. **Unified drill-down table** (Ide 3, no nominal): 1 row per outlet with Outlet | Area | PIC | P1 QTY | P2 QTY | Δ QTY | Net | 🔀 Flip%. Footer row shows TOTALS across ALL outlets (not just flip outlets). Backed by single `useFlipDrilldown` hook.

**Bug fixes (BUG2-FLIP-01..06)** all addressed:
- BUG2-FLIP-01: amber ring on non-flip pairs → filter `isFlip===true`
- BUG2-FLIP-02: sort consistent pairs by disparity → null + custom comparator
- BUG2-FLIP-03: monthKey type `string` → `string|null` in hook
- BUG2-FLIP-04: ASC sort put non-flip at top → null comparator (always bottom)
- BUG2-FLIP-05: inconsistent riskLevel FE vs BE → aligned formula (`sempurnaCount>0 ? high : flipCount>0 ? moderate : low`)
- BUG2-FLIP-06: 0-pair items in ranking → filter `totalPairs>0` before slicing

**Satuan-aware**: dynamic unit field via `MAX(ir.satuan)` query + `ItemTrendPeriod.satuan` in hook type. Extracted via `periods[0]?.satuan` in `index.tsx`, passed to `ItemTrendTable` + `FlipMatrix` + drill-down table. No more hardcoded `"kg"` (SATUAN-BUG fix).

### Data Operations
- Export laporan Word (`.docx`)
- Import Excel + Google Drive
- Settings (configurable thresholds incl. `BOM_DISPROPORTIONATE_FACTOR`, `BOM_DEVIATION_FACTOR`, residual/tolerance/zScore thresholds; UI editable)

> **REMOVED (DEL-AUDIT):** Audit Log feature deleted entirely. Previously: `AuditLog` Prisma model + `/api/audit-log` route + `AuditLogDialog.tsx` + dashboard button + state + middleware entry + 11 write sites (auditLog.create calls scattered across ingest, settings, pic, data, migrate-direction). Now: 0 audit log references in codebase. Removed because audit-log writes added latency to every mutation (extra INSERT) + the model was never queried for actual investigation use.

### Caching
- **DB-level `AggregationCache`** (5-min TTL, `awaitWrite` pattern)
  - API: `getCached()`, `setCached()` (MUST be `await`-ed with `awaitWrite=true`), `invalidateAll()`, `getCachedWithMeta()` (NEW — returns `{ data, stale }` without deleting expired row, for SWR pattern)
  - **14 cached routes**: `analysis`, `pareto`, `recommendations`, `resto-bahan-matrix`, `export-report`, `outlet-items`, `item-history`, `drilldown`, `area-item-heatmap`, `item-trend`, `item-peer-comparison` (Phase 2), `item-trend-rank` (Phase 3), `flip-ranking` (Phase C), `flip-ranking-drilldown` (Phase C)
  - `invalidateAnalysisCache()` clears ALL 14 prefixes on any mutation (ingest, settings, pic, data delete, migrate-direction, import-drive)
- **Stale-While-Revalidate (SWR)** (PERF-CACHE-09 + CACHE-01): `withCacheAndDup()` implements SWR on top of `getCachedWithMeta`:
  - Fresh hit → return immediately
  - Stale hit → return stale data in <50ms + fire-and-forget background recompute (writes fresh cache via `setCached(awaitWrite=true)`, resolves in-flight Promise so concurrent requests get fresh data)
  - No entry → compute synchronously + write cache
  - ALL 14 cached routes use SWR (including `/api/analysis` — migrated from legacy `getCached` to `getCachedWithMeta` SWR in CACHE-01 fix). 12 JSON routes surface `stale: true` flag (incl. `item-peer-comparison` + `item-trend-rank` + `flip-ranking` + `flip-ranking-drilldown`). `/api/export-report` binary + `/api/analysis` bespoke pipeline serve stale internally.
- **Cache warming**: `prefetchAnalysis()` (FilterBar hover + first status load) + `prefetchHeatmap()` (NEW — called from `useDashboardEffects` alongside `prefetchAnalysis` on status load). Heatmap matrix is warm before user scrolls down to it.
- **HTTP Cache-Control** headers (`s-maxage=300` for analysis routes; `NO_STORE` for `/api/status` — BUG-PIC-STALE fix below)
- **BUG-PIC-STALE fix:** `/api/status` switched from `CACHE_METADATA` (s-maxage=60) → `NO_STORE` because CDN edge wasn't cleared by `statusCache.clear()` or `invalidateAnalysisCache()` — caused stale data after PIC mutation. Both cached + freshly-computed branches now return `NO_STORE` headers. Other metadata routes (`/api/data`, `/api/pic`) still use `CACHE_METADATA` (narrower mutation triggers).
- **Performance:** Prisma query log disabled by default (`PRISMA_LOG_QUERIES=true` to enable); export-report route uses DB cache (5-min TTL) to skip recomputation on repeat exports.

### UI Design Principles
- **PC-focused**: UI optimized for **PC desktop** (not mobile) per explicit user request — "ini untuk PC ya bukan mobile". Touch-target-specific accessibility issues (44px minimum per WCAG 2.5.5) intentionally skipped. Sticky header + footer for desktop viewport. Tables use `min-w` + `overflow-x-auto` for wide content but assume desktop monitor width.
- **File Consolidation (Batch 1+2)**: helpers consolidated to `lib/` to eliminate duplication.
  - **Batch 1**: `zScoreColor` + `zScoreStatus` moved to `src/lib/zScoreHelpers.ts`; `fmtGrowth` + `growthColor` + `growthColorClass` + `fmtFullSigned` moved to `src/lib/format.ts`. Old `ItemTrendTab/zScoreHelpers.ts` + `resto-analysis/helpers.tsx` + `BomCorrelationCard.tsx` + `FlipMatrix.tsx` re-export barrels for backward compat.
  - **Batch 2**: 5 shared peer-comparison cards unified into `src/components/dashboard/shared/peer-comparison-cards/` (675 LOC). 5 old `peer-comparison/*.tsx` files deleted (417 LOC). Eliminated ~766 LOC duplication. Presentational only — each caller (ItemPeerComparison + PeerComparison) computes its own pre-computed values inline.

---

## 7. Performance Benchmarks

Measured against Supabase Singapore (`ap-southeast-1`, DB host `proosjqivxadwgftofry`):

| Route | Cold | Warm (cache) | Notes |
|-------|------|-------------|-------|
| `/api/analysis` | 0.56s | 0.24s | DB cache + parallelized post-process (PERF-API-04) |
| `/api/pareto` | 4.77s | 0.22s | SWR — stale hit <50ms |
| `/api/recommendations` | 1.92s | 0.22s | Parallelized metadata fetch (PERF-API-05) |
| `/api/resto-bahan-matrix` | 0.3s | 0.2s | SWR |
| `/api/export-report` | 0.34s | 0.22s | Binary docx, SWR internal |
| `/api/outlet-items` | 2.17s | 0.006s | NEW cached (PERF-API-01) — 157× warm speedup |
| `/api/item-history` | 1.37s | 0.006s | NEW cached (PERF-API-02) — 83× warm speedup |
| `/api/drilldown` | 1.01s | 0.023s | NEW cached (PERF-API-03) + slim `select` (PERF-API-06) |
| `/api/area-item-heatmap` | 0.21s | 0.21s | NEW cached (PERF-CACHE-08); warm ≈ cold (already fast) |
| `/api/area-item-heatmap/cell-detail` | 0.05s | n/a | NOT cached (direct query, LIMIT 1000) |
| `/api/status` | 0.01s | 0.007s | In-memory LRU cache + cleanupExpiredCache (NO_STORE HTTP headers — BUG-PIC-STALE fix) |

---

## 8. Security Model

### Authentication
- **`ADMIN_TOKEN`** env var controls auth mode:
  - **Not set** → fail-open (single-user mode, all writes allowed)
  - **Set** → fail-closed (token required for protected routes)
- `PROTECTED_PATHS` defined in `src/middleware.ts`

### Content Security Policy
- **Production**: no `unsafe-eval`
- **Dev**: allows `unsafe-eval` for HMR / Turbopack

### Rate Limiting
- In-memory, per-IP, per-route
- Implementation: `src/lib/rate-limit.ts`

### Input Validation
- **Zod** validation on 25/27 routes (incl. `/api/item-search` — Zod added in AUDIT-NEWFEATURES C4 with `z.literal('autocomplete').default('autocomplete')` schema; cross-outlet + trend modes removed). Only `/api/status` (in-memory status, no Zod) + `/api/route.ts` (root hello-world stub) skip Zod.
- All raw SQL parameterized (zero `$queryRawUnsafe`)

### Error Sanitization
- `errorResponse()` helper (`src/lib/error-response.ts`)
- Dev mode: shows full error message
- Prod mode: shows generic message (no internal leak)

---

## 9. Stats

| Metric | Value |
|--------|-------|
| Lines of code in `src/` | 51,313 |
| Test files | 22 |
| Test cases | 435 |
| Git commits | 400+ |
| npm dependencies | 23 |
| API routes (main) | 27 (was 26 incl. audit-log — REMOVED -1, ADDED flip-ranking + flip-ranking/drilldown = net +1) |
| Cached routes | 14 (was 12 — added `flip-ranking` + `flip-ranking-drilldown` Phase C) |
| Dashboard components | 24 + `tabs/ItemTrendTab/` folder (11 modules + barrel — incl. 3 NEW flip modules) + `AreaItemHeatmapSheet` + `DashboardHeader` + `DashboardFooter` + `shared/peer-comparison-cards/` (7 files, NEW Batch 2) |
| Hooks | 6 (incl. `useAnalysis/` folder split into 8 files via barrel re-export) |
| DB host | `proosjqivxadwgftofry` |
| DB indexes | 14 on InventoryRecord (incl. 2 covering indexes for heatmap + trend) |
| Z-Score | SIGNED (positive=worse/red, negative=better/green) — was non-negative |
| Bug fixes (cumulative) | 64 total: 20 (Phase 1+2+3 audit — BUG-1: 3, BUG-2: 11, BUG-3: 6) + 5 (audit v2 — BUG2-RANK-01/02 + 3 others) + 4 (calc audit — CALC-01..04) + 35 (UI audit — UI2-XX responsive/a11y + UI-XX layout/visual) |
| Bug fixes (Phase A+B+C flip) | 6 (BUG2-FLIP-01..06 — flip detection edge cases) |
| File consolidation | 2 batches: Batch 1 (4 helpers → `lib/`) + Batch 2 (5 shared peer-comparison cards — ~766 LOC duplication eliminated) |
| Removed features | Audit Log (model + route + dialog + 14 write sites — ~565 LOC removed, 0 dangling refs) |

---

## 10. File Structure

```
src/
├── app/
│   ├── page.tsx                    # Thin orchestrator (227 lines — 5 tabs: Dashboard/Resto/Peer/Pareto/Trend Item)
│   ├── layout.tsx                  # Root layout (skip-to-content, Toaster, QueryProvider)
│   └── api/                        # 27 API routes + sub-routes (was 26 incl. audit-log REMOVED -1, +2 flip-ranking = net +1)
│       ├── area-item-heatmap/
│       │   ├── route.ts            # Heatmap matrix (cached, SWR)
│       │   └── cell-detail/route.ts # Per-outlet drill-down (NOT cached)
│       ├── analysis/services/      # 8-stage pipeline (validate/fetch/run-queries/post-process/exec-summary/assemble/trend-builder/deviation-drivers)
│       ├── flip-ranking/           # NEW Phase C: cross-item flip risk ranking (cached, SWR)
│       │   ├── route.ts            # Risk score + sempurna/dominan/parsial counts
│       │   └── drilldown/route.ts  # Per-outlet unified table (cached, SWR)
│       ├── item-peer-comparison/route.ts # Phase 2: target + peers BOM ±50% + averages (cached, SWR)
│       ├── item-search/route.ts    # Autocomplete-only (cross-outlet + trend modes removed; Zod added)
│       ├── item-trend/route.ts     # Per-item QTY fluctuation across periods (cached, SWR, week filter)
│       ├── item-trend-rank/route.ts # Phase 3: per-period national rank by ABS(nominalDeviasi) (cached, SWR)
│       ├── outlet-items/route.ts   # Cached
│       ├── item-history/route.ts   # Cached
│       ├── drilldown/route.ts      # Cached (slim select, respects dashboard filters)
│       ├── pareto|recommendations|resto-bahan-matrix|export-report|analysis  # Original 5 cached routes
│       ├── status/route.ts         # NO_STORE HTTP headers (BUG-PIC-STALE fix)
│       └── ...                     # 10 other routes (data, ingest-*, peer-comparison, pic, settings, setup, etc.) — /api/audit-log REMOVED
├── components/
│   ├── dashboard/
│   │   ├── tabs/ItemTrendTab/      # NEW Phase 1+2+3 + Phase A+B+C: 11 modules + barrel index (split from monolithic ItemTrendTab.tsx) — index.tsx + ItemTrendSearchBar + ItemTrendTable + ItemTrendLineChart + ItemTrendRankChart + ItemPeerComparison + FlipMatrix [P-B] + FlipRanking [P-C] + flipHelpers [P-A] + types + zScoreHelpers + periodHelpers
│   │   ├── AreaItemHeatmap.tsx     # Heatmap matrix component (549 lines)
│   │   ├── AreaItemHeatmapSheet.tsx # NEW: drill-down Sheet (lazy-loaded via next/dynamic)
│   │   ├── BomCorrelationCard.tsx  # Per-record BOM findings table
│   │   ├── DashboardHeader.tsx     # NEW: sticky header (extracted from page.tsx)
│   │   ├── DashboardFooter.tsx     # NEW: sticky footer (extracted from page.tsx)
│   │   ├── shared/peer-comparison-cards/ # NEW Batch 2: 7 files (675 LOC) — presentational peer cards (efficiency-score + gap-analysis + scatter-plot + ranking-summary + anomaly-flags + types + index)
│   │   ├── shared/index.tsx        # EmptyState/LoadingState/ErrorState/SectionHeader/ScrollToTop/FetchAware/LoadingChart
│   │   └── ...                     # 15 other dashboard components
│   ├── filters/                    # 9 components (FilterBar + 5 dialogs + SearchableComboBox — AuditLogDialog.tsx REMOVED)
│   ├── drilldown/                  # 2 components
│   └── ui/                         # 29 shadcn components
├── hooks/
│   ├── useAnalysis/               # NEW (SPLIT Batch 2): 8-file folder + barrel — index.ts + types.ts + fetchAnalysis.ts + prefetchHeatmap.ts + useAnalysis.ts + useStatus.ts + useDrilldown.ts + useItemTrend.ts
│   ├── useDashboard.ts             # Zustand store (filters + UI state + trendSelectedItem + setFocusOutlet [NEW Phase 1+2])
│   ├── useDashboardEffects.ts      # NEW (SPLIT-PAGE): 5 useEffects (auto-select + cache warm + validate)
│   ├── useDashboardActions.ts      # NEW (SPLIT-PAGE): export/refresh handlers + keyboard shortcuts
│   ├── use-mobile.ts               # shadcn responsive viewport hook
│   └── use-toast.ts                # shadcn toast hook
├── lib/
│   ├── queries/                    # 14 query modules (SQL push-down, incl. heatmap.ts + item-trend.ts + item-trend-rank.ts + item-peer-comparison.ts + flip-ranking.ts [NEW P-C] + flip-drilldown.ts [NEW P-C])
│   ├── metrics/                    # 8 metric functions (deviation, benchmark, historical, growth)
│   ├── cache-headers.ts            # HTTP Cache-Control presets
│   ├── error-response.ts           # Sanitized error helper
│   ├── aggregation-cache.ts        # DB-level cache (getCached/setCached/getCachedWithMeta/withCacheAndDedup/invalidateAnalysisCache — 14 routes invalidated)
│   ├── zScoreHelpers.ts            # NEW Batch 1: zScoreColor + zScoreStatus (moved from ItemTrendTab/zScoreHelpers.ts; old file re-exports)
│   ├── format.ts                   # NEW Batch 1: fmtGrowth + growthColor + growthColorClass + fmtFullSigned (consolidated from resto-analysis/helpers.tsx + BomCorrelationCard.tsx + FlipMatrix.tsx)
│   ├── db.ts                       # Prisma client (connection_limit=30, pool_timeout=60)
│   ├── rate-limit.ts               # In-memory rate limiter
│   └── settings.ts                 # Configurable thresholds (incl. BOM_DISPROPORTIONATE_FACTOR default 1.5)
├── engine/
│   ├── rules/evaluator.ts          # Legacy JS rule evaluator (used by item-history, outlet-items)
│   └── analysis/                   # patternEngine, rootCauseEngine, ruleService
├── lib/queries/rule-evaluation.ts  # 19-rule SQL push-down evaluator (16 SQL + 3 JS post-process)
├── config/
│   └── rules.yaml                  # 19 anomaly rules definition (sole source of truth)
└── middleware.ts                   # Auth (ADMIN_TOKEN, PROTECTED_PATHS)

.githooks/
└── pre-push                       # NEW: blocks force push to main (activate via `git config core.hooksPath .githooks`)

next.config.ts                     # CSP, optimizePackageImports (16 packages — was 5), prod-only immutable Cache-Control
```

---

## 11. Agent Collaboration

All AI agents working on this project should:
1. **Read this file first** before any task.
2. Write work records to `/agent-ctx/{task-id}-{agent-name}.md`.
3. Append to `/home/z/my-project/worklog.md` after task completion.

### Existing Agent Work Records (`/agent-ctx/`)
- `15-sql-aggregate-refactor.md`
- `19-fix-truncation-laptop-view.md`
- `26-outlet-focus-mode.md`
- `FIX-A-security-bug-fixer.md`
- `FIX-DEEP-5-security-fixer.md`
- `OPTIMIZE-ANALYSIS-Analysis Route Optimizer.md`
- `OPTIMIZE-ENGINE-engine-optimizer.md`
- `P2-2-full-stack-developer.md`
- `PEER-ENHANCE-FRONTEND-peer-frontend-enhancer.md`
- `SPLIT-COMPONENTS-component-splitter.md`
- `UI-TERMS-EXPLAIN-ui-terms-agent.md`

---

## 12. Development Commands

```bash
bun run dev          # Start dev server (port 3000) — auto-started by system
bun run lint         # Run ESLint
bun run db:push      # Push Prisma schema to database
```

### Dev Server Log
- Located at `/home/z/my-project/dev.log`
- Check most recent logs only (file grows large)

### Sandbox Preview
- Use the **Preview Panel** on the right side of the interface
- Click "Open in New Tab" for external browser view
- Never visit `http://localhost:3000` directly (internal only)
