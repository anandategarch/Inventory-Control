# MASTER CONTEXT — Inventory Control Intelligence

> **READ THIS FIRST** — This is the master context file. Read this before any task.
>
> This document is the **single source of truth** for the project. It contains
> tech stack, architecture, database schema, API routes, components, business
> rules, performance benchmarks, security model, and current state.
>
> **Last updated:** Session DOC-UPDATE (BOM correlation feature)
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

**12 Prisma models** (defined in `prisma/schema.prisma`):

| # | Model | Purpose |
|---|-------|---------|
| 1 | `SourceFile` | Uploaded file metadata (Excel/Drive) |
| 2 | `Week` | Week periods per month |
| 3 | `Outlet` | Outlet master (333 outlets, 14 areas) |
| 4 | `Item` | Item master (109 items) |
| 5 | `InventoryRecord` | Core fact table (~54K records/month) |
| 6 | `OutletPeriodSales` | Outlet sales per period (for peer comparison) |
| 7 | `DQIssue` | Data quality issues detected |
| 8 | `AuditLog` | Write audit trail (11 write sites) |
| 9 | `AggregationCache` | DB-level cache (5-min TTL) |
| 10 | `Setting` | 24 configurable thresholds |
| 11 | `OutletPIC` | PIC assignments (339 entries) |
| 12 | `FileChunk` | Resumable upload chunks |

### Prisma Client
- Config: `connection_limit=30`, `pool_timeout=60s`
- All raw SQL is **parameterized** (`$queryRaw` with tagged templates, **zero** `$queryRawUnsafe`)

---

## 4. API Routes (22 routes)

| Route | Cache | Zod | Rate Limit | Auth |
|-------|-------|------|------------|------|
| `/api/analysis` | ✅ DB 5min | ✅ | ✅ | Public GET |
| `/api/audit-log` | ❌ | ✅ | ✅ | Protected |
| `/api/data` | ❌ | ✅ | ✅ | Protected mutations |
| `/api/drilldown` | ❌ | ✅ | ✅ | Public GET |
| `/api/export-report` | ✅ DB 5min | ✅ | ✅ | Public GET |
| `/api/import-drive` | ❌ | ✅ | ✅ | Protected POST |
| `/api/ingest` | ❌ | ✅ | ✅ | Protected |
| `/api/ingest-process` | ❌ | ✅ | ✅ | Protected |
| `/api/ingest-upload` | ❌ | ✅ | ✅ | Protected POST |
| `/api/item-history` | ❌ | ✅ | ✅ | Public GET |
| `/api/item-search` | ❌ | ❌ | ✅ | Public GET |
| `/api/migrate-direction` | ❌ | ✅ | ✅ | Protected |
| `/api/outlet-items` | ❌ | ✅ | ✅ | Public GET |
| `/api/pareto` | ✅ DB 5min | ✅ | ✅ | Public GET |
| `/api/peer-comparison` | ❌ | ✅ | ✅ | Public GET |
| `/api/pic` | ❌ | ✅ | ✅ | Protected mutations |
| `/api/recommendations` | ✅ DB 5min | ✅ | ✅ | Public GET |
| `/api/resto-bahan-matrix` | ✅ DB 5min | ✅ | ✅ | Public GET |
| `/api/settings` | ❌ | ✅ | ✅ | Protected |
| `/api/setup` | ❌ | ✅ | ✅ | Protected |
| `/api/status` | ❌ (in-memory) | ✅ | ❌ | Public GET |

**Totals:** 20/22 routes use Zod validation · 5 routes use DB cache · All protected routes use `ADMIN_TOKEN` middleware.

---

## 5. Components (35+)

### Dashboard (`src/components/dashboard/` — 25 components)
- `ExecutiveSummary` — KPI cards (sales, deviation, abnormal count)
- `TopItems` — Top items by deviation
- `TopOutlets` — Top outlets by deviation
- `InsightsPanel` — AI narrative insights
- `RestoRecommendationCard` — Restaurant recommendation card
- `AdvancedAnalysis` — Advanced analysis panel
- `Charts` — 5 chart types (Deviation, Waste, Susut, Trial, Residual)
- `HistoricalZScoreCard` — Multi-metric Z-Score (Dev/BOM + Waste + Susut + Trial)
- `BomCorrelationCard` — BOM correlation analysis (Dev/Waste/Susut/Trial vs BOM growth direction) — *added in DOC-UPDATE*
- `ItemDeepDive` — Item-level deep dive
- `CardDrillDown` — Card-based drill-down
- `ParetoDashboard` — Pareto 80/20 analysis
- `PeerComparison` — Outlet vs ±10% sales peers
- `RestoAnalysis` — Restaurant analysis panel

> **Removed from dashboard (DOC-UPDATE):** `AreaTrendChart` (file retained for reference, no longer rendered on dashboard) and the "Weekly Trend" component. The `RestoAnalisa` priority-score drilldown is now a static card display (no click-through).

### Filters (`src/components/filters/` — 10 components)
- `FilterBar` — Main filter bar
- `SettingsDialog` — 24 threshold settings editor
- `DataManagementDialog` — Data management UI
- `PicManagementDialog` — PIC assignment management
- `FileUploadDialog` — Excel upload
- `DriveImportDialog` — Google Drive import
- `AuditLogDialog` — Audit log viewer (filter + pagination)
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
- **21-rule engine** (17 original + 4 BOM correlation, YAML-configured, SQL-pushed evaluator)
- Rules defined in `src/config/rules.yaml` (source of truth) and mirrored in `src/config/rules.ts`
- Evaluator: SQL push-down in `src/lib/queries/rule-evaluation.ts` (16 rules) + JS post-process for zScore-based rules (5 rules: HISTORICAL_ABNORMAL, HISTORICAL_ABNORMAL_SURPLUS, HISTORICAL_WARNING, BENCHMARK_ABOVE_AREA, BENCHMARK_ABOVE_NETWORK)
- Analysis modules: `patternEngine`, `rootCauseEngine`, `ruleService`

### 21 Anomaly Rules

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
| 16 | `BENCHMARK_ABOVE_AREA` | BENCHMARK | WARNING | 50 | `benchmarkFlag = HISTORICAL_WARNING` |
| 17 | `BENCHMARK_ABOVE_NETWORK` | BENCHMARK | ABNORMAL | 72 | `benchmarkFlag = HISTORICAL_HIGH` |
| 18 | `DIRECTION_FLIP` | HISTORICAL | WARNING | 60 | Direction flipped LOSS ↔ SURPLUS vs previous period |
| 19 | `HISTORICAL_ABNORMAL` | HISTORICAL | ABNORMAL | 78 | zScore > `historicalZscoreHigh` AND LOSS |
| 20 | `HISTORICAL_ABNORMAL_SURPLUS` | HISTORICAL | ABNORMAL | 77 | zScore > `historicalZscoreHigh` AND SURPLUS |
| 21 | `HISTORICAL_WARNING` | HISTORICAL | WARNING | 58 | warn < zScore ≤ high |

### BOM Correlation Analysis
- 4 new rules detect when Waste/Susut/Trial growth diverges in sign from BOM growth, or when Deviation growth is disproportionate (1.5–2×) to BOM growth.
- Growth fields `wasteGrowth` / `susutGrowth` / `trialGrowth` (alongside existing `bomGrowth` / `qtyDeviasiGrowth` / `salesGrowth` / `nominalDeviasiGrowth`) are computed in the rule-evaluation CTE using `ABS(...)` magnitude and div-by-zero guards.
- Dashboard component: `BomCorrelationCard` (`src/components/dashboard/BomCorrelationCard.tsx`) renders a Deviasi/Waste/Susut/Trial vs BOM alignment table on the Dashboard tab (under "Analisis Historis").

### Analytics
- **BOM Correlation analysis** (Deviasi/Waste/Susut/Trial vs BOM growth direction) — surfaced as dashboard card + 4 rules
- **Historical Z-Score** analysis (multi-metric: Dev/BOM + Waste + Susut + Trial)
- **Pareto 80/20** analysis (5 dimensions: Item, Outlet, Area, Kelompok, PIC)
- **Peer comparison** (outlet vs ±10% sales peers)
- **Outlet health ranking** (3D: Financial + Operational + Unexplained)

### Data Operations
- Export laporan Word (`.docx`)
- Import Excel + Google Drive
- Settings (24 configurable thresholds, UI editable)
- Audit Log (11 write sites, UI viewer with filter + pagination)

### Caching
- **DB-level `AggregationCache`** (5-min TTL, `awaitWrite` pattern)
  - API: `getCached()`, `setCached()` (MUST be `await`-ed with `awaitWrite=true`), `invalidateAll()`
  - 5 cached routes: `analysis`, `pareto`, `recommendations`, `resto-bahan-matrix`, `export-report`
  - `invalidateAnalysisCache()` clears all 5 prefixes on any mutation (ingest, settings, pic, data delete, migrate-direction)
- **HTTP Cache-Control** headers (`s-maxage=300` for analysis routes)
- **Performance:** Prisma query log disabled by default (`PRISMA_LOG_QUERIES=true` to enable); export-report route uses DB cache (5-min TTL) to skip recomputation on repeat exports.

---

## 7. Performance Benchmarks

Measured against Supabase Singapore (`ap-southeast-1`):

| Route | Cold | Warm (cache) |
|-------|------|-------------|
| `/api/analysis` | 0.6s | 0.2s |
| `/api/pareto` | 0.3s | 0.2s |
| `/api/recommendations` | 0.3s | 0.2s |
| `/api/resto-bahan-matrix` | 0.3s | 0.2s |
| `/api/export-report` | 8s | 0.2s |
| `/api/status` | 0.01s | 0.007s |

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
- **Zod** validation on 20/22 routes
- All raw SQL parameterized (zero `$queryRawUnsafe`)

### Error Sanitization
- `errorResponse()` helper (`src/lib/error-response.ts`)
- Dev mode: shows full error message
- Prod mode: shows generic message (no internal leak)

---

## 9. Stats

| Metric | Value |
|--------|-------|
| Lines of code in `src/` | 40,271 |
| Test files | 22 |
| Test cases | 418 |
| Git commits | 387 |
| npm dependencies | 23 (down from 40+ after cleanup) |

---

## 10. File Structure

```
src/
├── app/
│   ├── page.tsx                    # Main dashboard (4 tabs: Dashboard/Resto/Peer/Pareto)
│   ├── layout.tsx                  # Root layout (skip-to-content, Toaster, QueryProvider)
│   └── api/                        # 22 API routes (incl. pic/import)
├── components/
│   ├── dashboard/                  # 25 components (+ BomCorrelationCard; AreaTrendChart retained but not rendered)
│   ├── filters/                    # 10 components (FilterBar + 5 dialogs + SearchableComboBox)
│   ├── drilldown/                  # 2 components
│   └── ui/                         # 29 shadcn components
├── hooks/
│   ├── useAnalysis.ts              # TanStack Query hooks (analysis, status, drilldown, prefetch)
│   └── useDashboard.ts             # Zustand store (filters + UI state)
├── lib/
│   ├── queries/                    # 12 query modules (SQL push-down)
│   ├── metrics/                    # 8 metric functions (deviation, benchmark, historical, growth)
│   ├── cache-headers.ts            # HTTP Cache-Control presets
│   ├── error-response.ts           # Sanitized error helper
│   ├── aggregation-cache.ts        # DB-level cache (getCached/setCached/invalidateAll)
│   ├── db.ts                       # Prisma client (connection_limit=30, pool_timeout=60)
│   ├── rate-limit.ts               # In-memory rate limiter
│   └── settings.ts                 # 24 configurable thresholds
├── engine/
│   ├── rules/evaluator.ts          # Legacy JS rule evaluator (used by item-history, outlet-items)
│   └── analysis/                   # patternEngine, rootCauseEngine, ruleService
├── lib/queries/rule-evaluation.ts  # 21-rule SQL push-down evaluator (16 SQL + 5 JS post-process)
├── config/
│   ├── rules.yaml                  # 21 anomaly rules definition (source of truth)
│   └── rules.ts                    # TypeScript rule configs (legacy mirror)
└── middleware.ts                   # Auth (ADMIN_TOKEN, PROTECTED_PATHS)
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
