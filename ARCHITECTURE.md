# Technical Architecture

> **Technical Architecture** — Read when fixing bugs or optimizing performance.

This document describes **HOW** the Inventory Control Intelligence application is built. It covers the runtime topology, data ingestion pipeline, query architecture, caching layers, auth model, performance optimizations, security controls, test coverage, known tech debt, and deployment pipeline.

For **WHAT** the app does (domain logic, business rules, KPI definitions), see `MASTER_CONTEXT.md`.

---

## 1. System Architecture

```
User Browser → Caddy (port 81, zstd gzip, static bypass) → Next.js (port 3000) → Supabase PostgreSQL (ap-southeast-1)
```

| Layer           | Technology                                                            | Notes                                                                                                       |
| --------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Edge / Gateway  | **Caddy** on port 81                                                  | Reverse proxy to Next.js (port 3000). zstd + gzip compression. Static asset bypass (serves `/static` directly). |
| Application     | **Next.js 16** (App Router, TypeScript 5, React 19)                   | Server Components by default; Route Handlers for API. Runs on Node.js runtime.                              |
| ORM             | **Prisma** (PostgreSQL driver)                                        | Single `PrismaClient` instance via `src/lib/db.ts`. Connection pool limit=30, pool_timeout=60s.             |
| Database        | **Supabase PostgreSQL** — `ap-southeast-1` (Singapore)                | Free tier. Public schema. Timezone: UTC at DB layer, ISO strings everywhere in app code.                    |
| Object Storage  | Google Drive (read-only, server-side fetch)                           | Optional import source; SSRF allowlist enforced.                                                            |
| Client State    | **Zustand** (UI filters) + **TanStack Query** (server cache)          | Client-only state never hits the server.                                                                    |
| Real-time       | Polling via TanStack Query (no WebSocket on hot path)                 | Mini-service WebSocket demo exists under `mini-services/` but is not on the dashboard hot path.             |

### Request Lifecycle (Single Page Load)

1. Browser issues GET `/` → Caddy forwards to Next.js.
2. Next.js renders Server Component shell, streams HTML.
3. Client hydrates; TanStack Query fires parallel GETs to `/api/analysis`, `/api/pareto`, `/api/metadata`, etc.
4. Each API route checks `AggregationCache` (DB row) → on miss, runs SQL via `withStatementTimeout`, writes payload back to cache (`await setCached(key, payload, true)`).
5. Response returns JSON; TanStack Query caches with `staleTime: 120s, gcTime: 10min`.

---

## 2. Data Flow

### Ingestion Pipeline (Excel / CSV → DB)

```
Excel/CSV → /api/ingest-upload (chunked) → /api/ingest-process (reassemble + parse)
  → engine/transform.ts (normalize + derive) → engine/validator.ts (DQ check)
  → Prisma createMany (bulk insert) → OutletPeriodSales (pre-compute sales MODE)
  → invalidateAnalysisCache (clear all 5 caches)
```

**Stage detail:**

| Stage                | File                                        | Responsibility                                                                                     |
| -------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1. Chunked upload    | `src/app/api/ingest-upload/route.ts`        | Receives file in 5MB chunks. Validates `fileHash` (hex), extension allowlist. Writes to `upload/`. |
| 2. Reassemble+parse  | `src/app/api/ingest-process/route.ts` (~700 LOC) | Reassembles chunks, parses rows (XLSX/CSV), runs transform pipeline.                             |
| 3. Normalize+derive  | `src/lib/engine/transform.ts`               | Coercion of types, unit normalization, derived fields (deviation decomposition, residual calc).   |
| 4. DQ validation     | `src/lib/engine/validator.ts`               | Data-quality checks: missing outlet, negative qty, period mismatch, etc. Reports row-level errors. |
| 5. Bulk persist      | Prisma `createMany`                         | Single round-trip insert into `OutletPeriodSales`. Skips ORM hooks for speed.                      |
| 6. Pre-compute MODE  | `OutletPeriodSales.salesMode`               | Per-outlet-per-period sales MODE precomputed at ingest time so dashboard reads are O(1).           |
| 7. Cache bust        | `invalidateAnalysisCache()`                 | Clears all 5 cached route prefixes (see §4).                                                       |

**Google Drive ingestion** follows the same pipeline after SSRF-safe fetch.

---

## 3. Query Architecture (SQL Push-Down)

Heavy analytics queries bypass Prisma's query builder and use **raw SQL** for two reasons:
1. **Performance**: Prisma's builder cannot express multi-level CTEs efficiently.
2. **Control**: We need explicit `SET LOCAL statement_timeout` per query.

### 3.1 Building Blocks

| Helper                          | File                                  | Purpose                                                                                       |
| ------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `Prisma.sql` tagged templates   | all query modules                     | Parameterized SQL — values are auto-escaped. **Zero `$queryRawUnsafe` in the codebase.**     |
| `withStatementTimeout(ms, fn)`  | `src/lib/db.ts`                       | Wraps a query in a transaction with `SET LOCAL statement_timeout = '30s'`. Default 30s.      |
| `buildSqlFilters(params)`       | `src/lib/query/buildSqlFilters.ts`    | Generates parameterized WHERE clause from filter DTOs (outlet, period, PIC, etc.).           |
| `resolveMonthLabel(monthInput)` | `src/lib/query/month.ts`              | Normalizes month strings ("Jan 2024", "2024-01", etc.) → canonical `"Januari 2024"`.         |

### 3.2 Two-Level CTE Pattern (Historical Stats)

Historical z-score and weekly deviation queries use a **two-level CTE** to avoid recomputing aggregates:

```sql
WITH weekly_dev AS (
  -- Level 1: per-outlet-per-week deviation
  SELECT outlet_id, period_week,
         SUM(nominal_loss_surplus) AS weekly_sum
  FROM "OutletPeriodSales"
  WHERE <buildSqlFilters>
  GROUP BY outlet_id, period_week
),
stats AS (
  -- Level 2: per-outlet mean/stddev across weeks
  SELECT outlet_id,
         AVG(weekly_sum)      AS mean,
         STDDEV(weekly_sum)   AS stddev
  FROM weekly_dev
  GROUP BY outlet_id
)
SELECT s.*, w.* FROM stats s
JOIN weekly_dev w USING (outlet_id);
```

This pattern appears in:
- `src/lib/query/historical-stats.ts`
- `src/lib/query/z-score.ts`
- `src/lib/query/weekly-deviation.ts`
- `src/lib/queries/historical.ts` — `queryHistoricalStatsMultiMetric` (extended for multi-metric Z-Score: computes mean/stddev for Dev/BOM, Waste, Susut, and Trial in a single CTE pass)

### 3.3 Rule Evaluation Architecture (19 Rules)

Rules are split across two evaluators for performance. See `src/lib/queries/rule-evaluation.ts`.

**Two-stage evaluation:**

| Stage | Where | Rules | Why |
|-------|-------|-------|-----|
| 1. SQL push-down | `evaluateRulesSql()` | 16 (all non-zScore rules) | Single query with `CASE WHEN` columns; runs in ~2–3s for 35K records |
| 2. JS post-process | `evaluateHistoricalRulesJs()` | 3 (zScore-based: HISTORICAL_ABNORMAL, _SURPLUS, _WARNING) | Needs `historicalByOutletItem` Map (pre-fetched in parallel) — can't be inlined cleanly into the SQL query. (BENCHMARK_ABOVE_AREA/NETWORK were removed in FIX-RULE-CONFIG CONFIG-05 as duplicates of HISTORICAL_WARNING/HISTORICAL_ABNORMAL.) |

**Stage 1 SQL shape** (simplified — see `rule-evaluation.ts:62–195` for full):

```sql
WITH curr AS ( ... current-period records ... ),
     prev AS ( ... previous-period records via LATERAL JOIN ... ),
     hist AS ( ... placeholder; actual zScore computed in JS ... )
SELECT
  c."outletId", c."itemId", c."akunPenyesuaian",
  -- One CASE WHEN column per rule; 1 = fired, 0 = not
  CASE WHEN c."tolerancePct" IS NOT NULL
        AND ABS(c."pctQtyDeviasiToBom") > 2 * ABS(c."tolerancePct")
       THEN 1 ELSE 0 END AS "f_tol_breach_high",
  -- ... 15 more rule columns ...
  -- BOM Correlation rules (4 new) — use wasteGrowth/susutGrowth/trialGrowth
  CASE WHEN g."bomGrowth" IS NOT NULL AND g."wasteGrowth" IS NOT NULL AND
    ((g."bomGrowth" < 0 AND g."wasteGrowth" > 0)
  OR (g."bomGrowth" > 0 AND g."wasteGrowth" < 0))
       THEN 1 ELSE 0 END AS "f_waste_bom_mismatch",
  -- ... susut/trial/disproportionate ...
FROM curr c
LEFT JOIN LATERAL ( ... prev period ... ) p ON true
CROSS JOIN LATERAL (
  -- Growth CTE: computes salesGrowth, bomGrowth, qtyDeviasiGrowth,
  -- nominalDeviasiGrowth, wasteGrowth, susutGrowth, trialGrowth
  -- Each guarded with `prevX IS NOT NULL AND prevX != 0`
  -- and uses ABS(...) magnitude on both sides
  SELECT
    CASE WHEN p."prevNominalSales" != 0
      THEN (c."nominalSales" - p."prevNominalSales") / ABS(p."prevNominalSales")
      ELSE NULL END AS "salesGrowth",
    -- ... bomGrowth, qtyDeviasiGrowth, nominalDeviasiGrowth ...
    CASE WHEN p."prevQtyWaste" IS NOT NULL AND p."prevQtyWaste" != 0
      THEN (ABS(c."qtyWaste") - ABS(p."prevQtyWaste")) / ABS(p."prevQtyWaste")
      ELSE NULL END AS "wasteGrowth",
    -- ... susutGrowth, trialGrowth (same shape) ...
) g
ORDER BY c."outletId", c."itemId"
```

**Stage 2 JS post-process** merges zScore rules into the same `topFlagByKey` map (keyed by `outletId|itemId|akunPenyesuaian`, keeps the highest-priority flag when multiple rules fire on the same record). See `src/app/api/analysis/services/post-process.ts:evaluateAndMergeFlags`.

**Growth CTE field conventions** (used by BOM Correlation rules):
- Naming: `<metric>Growth` (camelCase) — e.g. `wasteGrowth`, `susutGrowth`, `trialGrowth`, `bomGrowth`, `qtyDeviasiGrowth`, `nominalDeviasiGrowth`, `salesGrowth`.
- Magnitude: always `ABS(curr) - ABS(prev)` in the numerator (sign of growth = direction of magnitude change).
- Div-by-zero guard: `prevX IS NOT NULL AND prevX != 0` before division; otherwise `NULL`.
- Returns `NULL` (not 0) when prev is missing — rule conditions explicitly check `IS NOT NULL`.

**Runtime threshold operands** (from `Setting` table, surfaced as operands in `rules.yaml` conditions):
- `bomDeviationFactor` (default 2.0) — used by rule 3 (`BOM_DEVIATION_MISMATCH`).
- `bomDisproportionateFactor` (default 1.5, range 1.0–5.0; `BOM_DISPROPORTIONATE_FACTOR` setting, added in FIX-SETTINGS) — used by rule 8 (`BOM_DEVIATION_DISPROPORTIONATE`). Decoupled from `bomDeviationFactor` so lowering the latter no longer silently disables rule 8.
- `salesDeviationFactor`, `residualLossHighPct`, `residualLossWarnPct`, `historicalZscoreWarn`, `historicalZscoreHigh`, `stdDeviasiBomPct`, etc. — all read via `settings.ts:getSettings()` and passed into the SQL evaluator as bound parameters.

### 3.4 Forbidden Patterns

- ❌ `$queryRawUnsafe` — anywhere. ESLint rule blocks it.
- ❌ String concatenation into SQL — even for identifiers (use `Prisma.raw` only for validated allowlist values).
- ❌ Client-side filtering/aggregation of large result sets.

---

## 4. Cache Strategy

Caching is **multi-tiered**. Each tier addresses a different latency/cost tradeoff.

### 4.1 DB-Level Aggregation Cache

| Property        | Value                                                                                |
| --------------- | ------------------------------------------------------------------------------------ |
| Storage         | `AggregationCache` table (PostgreSQL row)                                            |
| Key             | `"{route}␟{filterHash}"` — e.g. `analysis␟outlet=5|month=Januari%202024|metric=loss` |
| Value           | JSON-serialized payload (text column, no size limit)                                 |
| TTL             | 5 minutes (`expiresAt` column)                                                       |
| Write mode      | `awaitWrite=true` — readers wait for in-flight writers (prevents cache stampede)     |
| Invalidation    | `invalidateAnalysisCache()` clears ALL 5 route prefixes on any mutation              |

**5 cached routes** (all use `getCached` / `await setCached` — note: `setCached` MUST be `await`-ed; an earlier audit found 18 routes calling `errorResponse()` without `return` and several `setCached` calls missing `await` — both fixed):

1. `/api/analysis`
2. `/api/pareto`
3. `/api/recommendations`
4. `/api/resto-bahan-matrix`
5. `/api/export-report` (added in DOC-UPDATE — cached per `month|week|compareWeek|compareMonth|sections` hash; full report build is ~8s cold, ~0.2s warm)

**`invalidateAnalysisCache()`** deletes rows where `key LIKE 'analysis␟%'` OR `'pareto␟%'` OR `'recommendations␟%'` OR `'resto-bahan-matrix␟%'` OR `'export-report␟%'`.

**Call sites:** 9 mutation routes — `ingest-process`, `data`, `settings`, `pic`, `pic/import`, `migrate-direction`, `ingestion.ts`, `DriveImportDialog`.

> **Cache key note for BOM Correlation:** the BOM Correlation rules + card do NOT introduce a new cached route or filter dimension. They run inside `/api/analysis` and read the existing `executiveSummary.qty{Bom,Deviasi,Waste,Susut,Trial}.growth` fields (aggregate alignment table) plus a new `bomCorrelationFindings[]` array (per-record findings table) populated by `buildBomCorrelationFindings()` in `src/app/api/analysis/services/post-process.ts`. The findings array is bounded to the top-50 most-severe BOM flags and adds one extra SQL fetch per cold request (~50–600ms). No changes to cache keys are required.
>
> **Dead-code cleanup (FIX-DOCS):** `/api/analysis` no longer computes `areaTrend` (1 less DB query per cold request — `AreaTrendChart.tsx` was deleted). The `cardDrillDown` Zustand state was removed from `useDashboard`; ExecutiveSummary KPI cards are static display only (no click-through drilldown).

### 4.2 In-Memory Caches

| Cache          | TTL  | Purpose                                                                |
| -------------- | ---- | ---------------------------------------------------------------------- |
| `statusCache`  | 5min | `/api/status` response (DB health, row counts). LRU, max 100 entries.  |
| `settingsCache`| 30s  | Global settings (currency, threshold config). Read-heavy, rarely mutates. |
| In-flight dedup| n/a  | Per-key Promise sharing for `/api/analysis` — prevents cache stampede under concurrent identical requests. |

### 4.3 HTTP Cache-Control Headers

| Route pattern     | Header                              | Rationale                                       |
| ----------------- | ----------------------------------- | ----------------------------------------------- |
| `/api/analysis`   | `Cache-Control: s-maxage=300`       | 5-min CDN edge cache; matches DB TTL.           |
| `/api/metadata`   | `Cache-Control: s-maxage=60`        | Outlets/PIC list changes rarely.                |
| Mutation routes   | `Cache-Control: no-store`           | Never cache writes.                             |

### 4.4 Client-Side (TanStack Query)

```ts
// src/hooks/useAnalysis.ts
staleTime: 120_000,        // 2 min — server is source of truth
gcTime: 10 * 60_000,       // 10 min — keep stale data for instant drilldown
keepPreviousData: true,    // drilldown navigation: no flash of empty state
```

### 4.5 Cache Coherence Guarantees

- **Write-through**: Mutations write to DB first, then invalidate cache. No write-behind.
- **No stale reads**: Cache reads check `expiresAt` server-side; expired rows are never returned.
- **Stampede protection**: In-flight Promise dedup + `awaitWrite=true` ensures a single cold-miss request triggers exactly one DB query, even under 100 concurrent identical requests.

---

## 5. Auth Model

The app supports **single-user mode** (default for solo operators) and **token mode** (for team deployments).

### 5.1 Token Behavior

| `ADMIN_TOKEN` env var | Behavior                                            | Use case                          |
| --------------------- | --------------------------------------------------- | --------------------------------- |
| Not set               | **Fail-open**: all mutations allowed (no auth).     | Local dev, single-user deploy.    |
| Set                   | **Fail-closed**: mutations require matching token.  | Production / shared deployment.   |

### 5.2 Middleware Enforcement

`src/middleware.ts` (Edge runtime) protects:

- **Methods**: `POST`, `PUT`, `DELETE` (mutations).
- **Routes**: 10 prefixes — `analysis`, `data`, `ingest-*`, `pic`, `pic/import`, `settings`, `migrate-direction`, `export-report`, `resto-bahan-matrix`, `recommendations`.
- **GET endpoints**: all public (no auth). Read access is unrestricted by design — dashboard is shared with non-admin viewers.

### 5.3 Token Comparison

Tokens are compared with **constant-time comparison** (timing-safe equal) to prevent side-channel attacks. Implementation is Edge-runtime safe (no `crypto.timingSafeEqual` — uses a custom byte-wise XOR).

```ts
// Simplified — actual impl in src/lib/auth.ts
function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
```

---

## 6. Performance Architecture

### 6.1 Database

- **Prisma query logging**: OFF by default. Set `PRISMA_LOG_QUERIES=true` to enable (dev only — logs every query; can flood logs and slow down hot routes in prod). Disabled in `src/lib/db.ts` constructor.
- **Connection pool**: `limit=30`, `pool_timeout=60s`, `idle_timeout=20s`. Tuned for Supabase free tier (max 60 connections).
- **`createMany`**: Used for bulk inserts (ingestion). Skips ORM lifecycle hooks — ~10x faster than per-row `create`.
- **Indexes**: All filterable columns indexed (outlet_id, period_week, period_month, pic_id). See `prisma/schema.prisma`.
- **Export-report DB cache**: the Word export route caches the full generated payload (5-min TTL) keyed by `month|week|compareWeek|compareMonth|sections` — repeat exports of the same period+sections hit the cache in ~0.2s instead of regenerating (~8s).

### 6.2 Code Splitting (Client)

| Lazy-loaded via `next/dynamic` | Why                                                |
| ------------------------------ | -------------------------------------------------- |
| Recharts + all chart components| Charts are below-the-fold on most routes.          |
| 5 filter dialogs               | Dialogs only mount on user action.                 |
| `export-report` client logic   | Heavy; only needed when user clicks "Export".      |

### 6.3 React Re-render Control

- **`React.memo`**: 41+ components memoized (all leaf chart components, KPI cards, table rows).
- **`useShallow` (Zustand)**: 13 callsites — selectors return new object refs only when shallow-equal values change.
- **`keepPreviousData` (TanStack Query)**: Drilldown navigation shows previous data while new data loads — no layout shift.

### 6.4 Bundle Optimization

`next.config.ts` `experimental.optimizePackageImports` enabled for:
- `recharts` (tree-shakeable chart imports)
- `lucide-react` (only used icons bundled)
- `@radix-ui/react-dialog`, `@radix-ui/react-popover`, `@radix-ui/react-select`

### 6.5 HTTP / Transport

- **zstd + gzip** at Caddy layer (zstd preferred, gzip fallback).
- **Static asset bypass**: Caddy serves `/static`, `/_next/static` directly — never hits Next.js.
- **Cache-Control** headers (see §4.3) enable CDN edge caching.

---

## 7. Security Architecture

### 7.1 Content Security Policy

| Environment | `script-src`                                              |
| ----------- | --------------------------------------------------------- |
| Production  | `'self'` only — **no `unsafe-eval`, no `unsafe-inline'`** |
| Development | `'self' 'unsafe-eval' 'unsafe-inline'` (Next.js HMR needs) |

CSP is set in `next.config.ts` headers, applied to all routes.

### 7.2 Error Sanitization

`errorResponse()` helper (`src/lib/api/error.ts`):

```ts
// Simplified — see src/lib/api/error.ts
function errorResponse(message: string, status: number, details?: unknown) {
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ error: message, details }, { status });
  }
  return NextResponse.json({ error: 'Internal server error' }, { status });
}
```

**Production never leaks** stack traces, SQL fragments, or internal paths.

### 7.3 Input Validation

- **Zod schemas**: 20 of 22 API routes have a Zod schema validating `searchParams` / body.
- **Gap**: `/api/resto-bahan-matrix` and `/api/item-search` use manual param parsing (see §9).

### 7.4 Rate Limiting

In-memory, per-IP, per-route. Resets every 60s.

| Route            | Limit       | Rationale                                  |
| ---------------- | ----------- | ------------------------------------------ |
| `/api/analysis`  | 60 req/min  | Heavy query; needs protection.             |
| `/api/status`    | 30 req/min  | Cheap but polled frequently by clients.    |
| All other GETs   | 120 req/min | Default.                                   |
| Mutations        | 30 req/min  | Conservative — writes are expensive.       |

Implementation: `src/lib/rate-limit.ts` — sliding window, Map-based, no external dependency.

### 7.5 File Upload Security

- **Chunked**: 5MB max per chunk; server reassembles.
- **`fileHash`**: SHA-256, hex-validated (regex `^[a-f0-9]{64}$`) before use.
- **Extension allowlist**: `.xlsx`, `.xls`, `.csv` only. MIME type cross-checked.
- **Size cap**: Total file size capped (env-configurable, default 50MB).

### 7.6 SSRF Protection (Google Drive Import)

- **Domain allowlist**: Only `drive.google.com`, `docs.google.com` allowed.
- **Confirm-URL re-validation**: After redirect resolution, the final URL is re-checked against the allowlist (prevents redirect-based SSRF).
- **No internal IPs**: Server-side fetch blocks RFC1918 ranges explicitly.

---

## 8. Testing Strategy

### 8.1 Test Stack

- **Runner**: Vitest (Jest-compatible API, ESM-native, runs in Node).
- **Location**: `tests/` directory, mirroring `src/` structure.
- **No E2E**: Playwright not configured (would require running dev server in CI).

### 8.2 Coverage

| Metric       | Value  | Target | Gap                                          |
| ------------ | ------ | ------ | -------------------------------------------- |
| Lines        | 27.2%  | 60%    | Large — ingestion.ts (758 LOC) at 0%.        |
| Functions    | 31.9%  | 60%    | engine/analysis (1500 LOC) largely untested. |
| Branches     | ~22%   | 60%    | Conditional logic in validators undertested. |
| Statements   | 27.5%  | 60%    | Aligned with lines.                          |

### 8.3 Test Distribution

**22 test files**, **418 test cases**, focused on:

| Area                          | Files | Approach                                                              |
| ----------------------------- | ----- | --------------------------------------------------------------------- |
| Query modules                 | 6     | Mocked Prisma — verify SQL shape, filter combination, edge cases.     |
| Metrics (pure functions)      | 5     | Pure unit tests — `fmtNum`, `fmtIDR`, z-score, residual decomposition.|
| Validation (Zod schemas)      | 4     | Schema parse + safeParse tests for valid/invalid inputs.              |
| Cache (aggregation-cache)     | 2     | get/set/invalidate semantics, TTL expiry, in-flight dedup.            |
| Auth / rate-limit             | 2     | Constant-time compare, sliding window behavior.                       |
| Misc (utils, formatters)      | 3     | Small utilities.                                                      |

### 8.4 Test Gaps (Acknowledge)

- **API routes (integration)**: 0 of 22 routes have end-to-end tests. Vitest doesn't boot Next.js.
- **React components**: 0 component tests. No React Testing Library setup.
- **Ingestion pipeline**: `src/lib/ingestion.ts` (758 LOC) at 0% coverage. Highest-risk untested code.

---

## 9. Known Tech Debt

Documented here so future agents don't re-discover them. **Fix priority is contextual.**

### 9.1 God Functions (>500 LOC)

| File                                    | LOC | Issue                                                                  |
| --------------------------------------- | --- | --------------------------------------------------------------------- |
| `src/app/api/ingest-process/route.ts`   | ~700| Single handler: chunk reassembly + parse + transform + validate + DB. |
| `src/app/api/export-report/route.ts`    | ~650| Single handler: query + format + sheet build + respond.               |
| `src/app/api/outlet-items/route.ts`     | ~560| Single handler: multi-dim aggregation + nested grouping.              |

**Recommended refactor**: Extract to service modules (`ingest-process.service.ts`, etc.) with pure, testable functions. Route handler should be <100 LOC.

### 9.2 Test Coverage Gaps

| File                          | LOC  | Coverage | Risk                                                |
| ----------------------------- | ---- | -------- | --------------------------------------------------- |
| `src/lib/ingestion.ts`        | 758  | 0%       | Highest-risk: handles untrusted Excel input.        |
| `src/lib/engine/analysis.ts`  | 1500 | 0%       | Core business logic: deviation decomposition.       |

### 9.3 Missing Validation

| Route                        | Issue                                                        |
| ---------------------------- | ------------------------------------------------------------ |
| `/api/resto-bahan-matrix`    | No Zod schema — manual `searchParams.get()` parsing.        |
| `/api/item-search`           | No Zod schema — manual param parsing.                        |
| `/api/status`                | No rate limiting (intentional: cheap endpoint, but inconsistent with §7.4). |

### 9.4 Cache Key Gaps (Historical — Fixed)

These were identified by the `BUG-CACHE` audit and **have been fixed**. Listed here for historical context:

- ~~CACHE-02~~: `resto-bahan-matrix` cache key omitted `priority` + `limit` → cache poisoning.
- ~~CACHE-03~~: `export-report` cache key omitted `compareWeek` + `compareMonth`.
- ~~CACHE-01~~: `invalidateAnalysisCache` only cleared `analysis␟` prefix → stale pareto/recommendations.

---

## 10. Deployment

### 10.1 Platforms

| Platform  | Role                                           | Config                                          |
| --------- | ---------------------------------------------- | ----------------------------------------------- |
| **Vercel**| Hosts Next.js app                              | Auto-deploy from `main` branch. `NODE_ENV=production`. |
| **Supabase**| PostgreSQL database                          | Free tier, `ap-southeast-1` (Singapore region). |
| **Caddy** | Reverse proxy / edge                           | Runs on sandbox box, port 81. Forwards to Next.js port 3000. |

### 10.2 Build Pipeline

```bash
# vercel.json — build command
bun run build
# = prisma generate + next build --turbo
```

| Step                  | Duration (approx) | Notes                                                          |
| --------------------- | ----------------- | -------------------------------------------------------------- |
| `prisma generate`     | ~5s               | Generates typed client from `schema.prisma`.                   |
| `next build --turbo`  | ~60-90s           | Turbopack build. Static + server routes compiled.              |
| Total cold build      | ~90s              | Warm cache: ~40s.                                              |

### 10.3 Environment Variables

| Variable                | Required | Purpose                                                       |
| ----------------------- | -------- | ------------------------------------------------------------- |
| `DATABASE_URL`          | Yes      | Supabase PostgreSQL connection string (pooled).              |
| `DIRECT_URL`            | Yes      | Supabase direct connection (for migrations).                 |
| `ADMIN_TOKEN`           | No       | If set, mutations require this token (see §5.1).             |
| `PRISMA_LOG_QUERIES`    | No       | `true` enables Prisma query logging (dev only).              |
| `NODE_ENV`              | Yes      | `production` on Vercel, `development` locally.               |
| `GOOGLE_DRIVE_API_KEY`  | No       | Required only if Google Drive import is used.                |

### 10.4 Database Migrations

```bash
bun run db:push    # Push schema.prisma → DB (dev workflow, no migration history)
bun run db:migrate # Create + apply migration (production)
```

**Workflow**: Use `db:push` during active development (fast iteration). Use `db:migrate` for production releases (creates versioned migration files in `prisma/migrations/`).

### 10.5 Caddy Configuration

```caddy
# Caddyfile (simplified)
:81 {
  encode zstd gzip
  @static path /static /_next/static/*
  handle @static {
    file_server
  }
  handle {
    reverse_proxy localhost:3000
  }
}
```

- zstd preferred over gzip (better ratio, similar CPU).
- Static assets bypass Next.js entirely — served by Caddy's `file_server`.
- No HTTPS termination at Caddy (Vercel handles TLS for the public domain).

---

## Appendix: File Map (Key Paths)

```
src/
├── app/
│   ├── api/
│   │   ├── analysis/route.ts              # Main analytics endpoint (cached)
│   │   │   └── services/                  # Pipeline stages (validate, fetch, run-queries, post-process, assemble)
│   │   ├── pareto/route.ts                # Pareto 80/20 (cached)
│   │   ├── recommendations/route.ts       # AI recommendations (cached)
│   │   ├── resto-bahan-matrix/route.ts    # Restaurant × ingredient matrix (cached)
│   │   ├── export-report/route.ts         # Word export (cached)
│   │   ├── ingest-upload/route.ts         # Chunked upload receiver
│   │   ├── ingest-process/route.ts        # Reassemble + parse + persist
│   │   ├── metadata/route.ts              # Outlets, PICs, periods list
│   │   └── status/route.ts                # Health check (in-memory cached)
│   └── page.tsx                           # Single-page dashboard (only route)
├── components/
│   ├── ui/                                # shadcn/ui primitives
│   └── dashboard/                         # Chart + KPI components (memoized)
│       ├── BomCorrelationCard.tsx         # Per-record BOM findings table + count badges + aggregate alignment table + narrative
│       ├── HistoricalZScoreCard.tsx       # Multi-metric Z-Score (Dev/BOM + Waste + Susut + Trial)
│       └── ...                            # Other dashboard components (AreaTrendChart + CardDrillDown deleted in FIX-DOCS)
├── hooks/
│   ├── useAnalysis.ts                     # TanStack Query wrapper (AnalysisData type)
│   └── useFilters.ts                      # Zustand filter store
├── lib/
│   ├── db.ts                              # PrismaClient singleton + withStatementTimeout (log OFF)
│   ├── aggregation-cache.ts               # DB-level cache (get/set/invalidate) — setCached MUST be awaited
│   ├── rate-limit.ts                      # In-memory per-IP limiter
│   ├── auth.ts                            # Constant-time token compare
│   ├── api/error.ts                       # errorResponse() helper (MUST be `return`-ed)
│   ├── engine/
│   │   ├── transform.ts                   # Ingest transform pipeline
│   │   ├── validator.ts                   # Data-quality checks
│   │   └── analysis.ts                    # Deviation decomposition (1500 LOC)
│   ├── queries/
│   │   ├── buildSqlFilters.ts             # Parameterized WHERE builder
│   │   ├── historical-stats.ts            # Two-level CTE (multi-metric)
│   │   ├── rule-evaluation.ts             # 19-rule SQL push-down + 3-rule JS post-process
│   │   ├── z-score.ts                     # Z-score query
│   │   └── month.ts                       # resolveMonthLabel()
│   └── format.ts                          # fmtNum / fmtIDR / fmtPctAbs
├── config/
│   └── rules.yaml                         # 19 anomaly rules (sole source of truth; rules.ts deleted as dead code)
├── engine/rules/evaluator.ts              # Legacy JS rule evaluator (used by item-history, outlet-items)
├── middleware.ts                          # Auth gate (Edge runtime) — ADMIN_TOKEN middleware (fixed in DOC-UPDATE)
└── next.config.ts                         # CSP, optimizePackageImports, headers

prisma/
├── schema.prisma                          # Models + indexes
└── migrations/                            # Versioned SQL migrations

tests/                                     # 22 files, 418 cases
```
