# Technical Architecture

> **Technical Architecture** — Read when fixing bugs or optimizing performance.
>
> **Last updated:** Session AUDIT-INTENSIF-DOCS (post-PAKET A/B/C/UPLOAD/E/F: audit penuh di `AUDIT-REPORT.md`; cache hit analysis raw-JSON passthrough; 20 cached routes + invalidasi; analysis SWR 30 mnt + background-recompute; 3-pass bulk master-data import + advisory lock lintas-instance; upload chunk paralel + bucket rate-limit khusus; delete TRUNCATE atomik; tab keep-alive forceMount; Fluid Compute + maxDuration single-source; bun.lock satu-satunya; index [direction] dropped). Prior: Session DOC-2 (Trend Item Tab Phase 1+2+3).

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
| Database        | **Supabase PostgreSQL** — `ap-southeast-1` (Singapore), project `proosjqivxadwgftofry` (was `vefkgapveggbmkloaslw` — paused/deleted; migrated 626,739 rows across 10 tables via `pg` library since Prisma `db push` hangs on PgBouncer tx mode) | Free tier. Public schema. Timezone: UTC at DB layer, ISO strings everywhere in app code.                    |
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
Excel/CSV → /api/ingest-upload (chunked, paralel ×3, bucket 120/mnt) → /api/ingest-process (reassemble + parse)
  → engine/transform.ts (normalize + derive) → engine/validator.ts (DQ check)
  → insertInventoryRecords (P2002 di-skip + dihitung — BUG-4) → OutletPeriodSales (pre-compute sales MODE)
  → invalidateAnalysisCache (clear all 20 route prefixes)
```

**Stage detail:**

| Stage                | File                                        | Responsibility                                                                                     |
| -------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1. Chunked upload    | `src/app/api/ingest-upload/route.ts`        | Receives file in chunks (PAKET UPLOAD: **3 chunk paralel** — chunk terakhir tetap terakhir; bucket rate-limit khusus 120/mnt mengakhiri 429 di chunk #6 untuk file >20MB; verifikasi total-ukuran via `SUM(LENGTH(data))` — tidak re-download). Writes to `upload/`. |
| 2. Reassemble+parse  | `src/app/api/ingest-process/route.ts` (~700 LOC) | Reassembles chunks, parses rows (XLSX/CSV), runs transform pipeline. **BUG-5: `pg_advisory_xact_lock(hashtext(monthKey))` sebagai statement PERTAMA dalam semua 3 transaksi import** — serialisasi lintas-instance (serverless multi-instance), auto-release saat COMMIT/ROLLBACK. |
| 3. Normalize+derive  | `src/lib/engine/transform.ts`               | Coercion of types, unit normalization, derived fields (deviation decomposition, residual calc).   |
| 4. DQ validation     | `src/lib/engine/validator.ts`               | Data-quality checks: missing outlet, negative qty, period mismatch, etc. Reports row-level errors.  |
| 5. Bulk persist      | `insertInventoryRecords` (`src/lib/ingestion/batch-insert.ts` — BUG-4) | Bulk insert helper dipakai di 4 titik: P2002 (duplicate natural key) di-SKIP + dihitung + di-log; error lain di-rethrow → transaksi rollback (dulu: error apa pun di-skip diam-diam = kehilangan baris tanpa jejak). |
| 5b. Master-data 3-pass | `process-ingestion.ts` + `process-rows-for-import.ts` (PAKET B) | Resolusi master-data (Outlet/Item/Week/PIC) via **3-pass bulk** (SELECT all → map in-memory → createMany missing) — ±446 round-trip upsert per-baris → ±4-8 round-trip. Ported ke jalur `/api/ingest` + `import-drive`. |
| 6. Pre-compute MODE  | `OutletPeriodSales.salesMode`               | Per-outlet-per-period sales MODE precomputed at ingest time so dashboard reads are O(1).              |
| 7. Cache bust        | `invalidateAnalysisCache()`                 | Clears all 20 cached route prefixes (see §4).                                                       |

**Integrity guards (BUG-3/4/5, commit 95d58a7):**
- **BUG-3**: dedup natural-key in-memory di kedua jalur ingest (kunci `week|outlet|item|COALESCE(akun,'')` — berjalan juga di fastMode) + index unik NULL-safe `InventoryRecord_nullsafe_akun` ON `(weekId,outletId,itemId,COALESCE(akunPenyesuaian,''))` dibuat via script (`scripts/fix-null-akun-duplicates.ts` — ekspresi COALESCE tak bisa dimodelkan Prisma). Postgres NULL ≠ NULL di unique index → duplikat lolos diam-diam tanpa ini.
- **BUG-4**: lihat stage 5.
- **BUG-5**: lihat stage 2 — plus re-check `fileHash` DALAM transaksi untuk menang import file sama yang berbarengan (hasil: SKIPPED, bukan double-import).

**Delete path (PAKET UPLOAD/DELETE):** reset-semua via **TRUNCATE atomik** (dulu DELETE row-by-row + purge index 30 detik); hapus bulan/file memakai advisory lock agar tidak interleaving dengan import paralel.

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

Rules are evaluated in two stages for performance. See `src/lib/queries/rule-evaluation.ts`.

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
| Key             | `"{route}␟{month}␟{week}␟…␟{extra}"` — `\x1f` (Unit Separator) delimiter anti-collision; kelompok di-uppercased + 'all'→'ALL' dinormalisasi; `extra` membawa param route-spesifik (BUG-KELOMPOK-CACHE + BUG-EDGE-4 + PERF-CACHE-01..04) |
| Value           | JSON-serialized payload (text column; export-report menyimpan **base64** — P3-HYG-4) |
| TTL             | 5 minutes default; `/api/analysis` **30 minutes** (env `ANALYSIS_CACHE_TTL_MINUTES` — data immutabel antar mutasi; mutasi selalu invalidate eksplisit) |
| Write mode      | `awaitWrite=true` — readers wait for in-flight writers (prevents cache stampede)     |
| Invalidation    | `invalidateAnalysisCache()` clears ALL **21** route prefixes on any mutation          |

**21 cached routes** (18 pakai `withCacheAndDedup` — cache lookup + in-flight dedup + SWR; `/api/analysis` pipeline bespoke dengan raw-JSON passthrough; `/api/export-report` binary base64):

1. `/api/analysis` (bespoke 8-stage pipeline; cache check di `validate-and-resolve.ts` — **SWR 30 mnt + background-recompute + raw-JSON passthrough** P3-HYG-1)
2. `/api/pareto`
3. `/api/recommendations`
4. `/api/resto-bahan-matrix`
5. `/api/export-report` (cached per `month|week|compareWeek|compareMonth|sections`; ~8s cold, ~0.2s warm; binary docx)
6. `/api/outlet-items` (PERF-API-01)
7. `/api/item-history` (PERF-API-02)
8. `/api/drilldown` (PERF-API-03)
9. `/api/area-item-heatmap` (PERF-CACHE-08; extra: metric+itemLimit+mode)
10. `/api/item-peer-comparison` (Phase 2; auto-selects worst outlet when outletCode omitted)
11. `/api/item-trend-rank` (Phase 3; RANK() window)
12. `/api/flip-ranking` (Phase C)
13. `/api/flip-ranking/drilldown` (Phase C)
14. `/api/item-anomali-outlets` (MINORITY-direction drill-down)
15. `/api/peer-comparison` (P3-HYG-3; extra: mode+limit)
16. `/api/peer-comparison/items` (P3-HYG-3; compute di-ekstrak ke `computePeerComparisonItems`; extra: mode+topItems)
17. `/api/peer-comparison/trend` (P3-HYG-3; peer eksplisit + auto-compute dalam satu computeFn; extra: peers)
18. `/api/compliance` (PAKET E — 9 lensa dari 1 scan)
19. `/api/chronic-outlets` (PAKET E — month-grain; cache reusable antar minggu)
20. `/api/item-trend` (per-item QTY fluctuation; week filter)
21. `/api/price-effect` (Task W — AVG Price Effect Bennet decomposition; extra: compareWeek + compareMonth)

> `/api/area-item-heatmap/cell-detail` is NOT cached (direct query, LIMIT 1000, user-initiated drill-down — small payload, low latency).

**`invalidateAnalysisCache()`** deletes rows where `key LIKE '<route>\x1f%'` for each of the **21** routes (ASCII Unit Separator `\x1f` delimiter, see `src/lib/aggregation-cache.ts`). Mutations (ingest, settings change, PIC update, data delete, migrate-direction, import-drive) clear SEMUA prefix — tidak ada entry stale yang selamat dari write.

**Call sites:** 9 mutation routes — `ingest-process`, `data`, `settings`, `pic`, `pic/import`, `migrate-direction`, `ingestion.ts` (used by `ingest` + `import-drive`), `DriveImportDialog`.

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

> **`/api/status` NO_STORE fix (BUG-PIC-STALE):** `/api/status` previously used
> `CACHE_METADATA` (`s-maxage=60`). This caused stale status data for up to 60s
> after mutations (PIC update, file upload, data delete) — the edge cache wasn't
> cleared by `statusCache.clear()` or `invalidateAnalysisCache()` (those only
> clear server memory, not the CDN edge). The server-side `statusCache` (5-min TTL,
> properly invalidated by mutations via `statusCache.clear()` in `/api/pic` POST +
> similar mutation routes) is sufficient for performance; CDN caching was redundant
> and caused stale-data bugs. Both the cached response branch and the freshly-computed
> branch now return `NextResponse.json(..., { headers: NO_STORE })` where
> `NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate' }`.
> Other metadata routes (`/api/data`, `/api/pic`) still use `CACHE_METADATA` — they
> have narrower mutation triggers (only `/api/data` + `/api/pic` mutate them) and
> `statusCache.clear()` propagates immediately; `status` aggregates data from many
> sources and was the most stale-prone.

### 4.4 Client-Side (TanStack Query)

```ts
// src/hooks/useAnalysis.ts
staleTime: 120_000,        // 2 min — server is source of truth
gcTime: 10 * 60_000,       // 10 min — keep stale data for instant drilldown
keepPreviousData: true,    // drilldown navigation: no flash of empty state
```

### 4.5 Cache Coherence Guarantees

- **Write-through**: Mutations write to DB first, then invalidate cache. No write-behind.
- **No stale reads** (post-mutation): `invalidateAnalysisCache()` deletes ALL 20 cached route prefixes on any mutation, so no stale entry survives a write. (Between mutations, SWR may serve stale-but-not-yet-recomputed data — see §4.6.)
- **Stampede protection**: In-flight Promise dedup + `awaitWrite=true` ensures a single cold-miss request triggers exactly one DB query, even under 100 concurrent identical requests.
- **Cache cleanup**: `cleanupExpiredCache()` (called fire-and-forget from `/api/status`, rate-limited to once per 10 min) removes entries older than **90 min** (raised from 30 min — AUDIT-PERF-5: stale rows must survive long enough for SWR to SERVE them while the background recompute runs; at the 30-min cutoff cleanup could delete a row mid-SWR → next request pays full cold recompute).

### 4.6 Stale-While-Revalidate (SWR) — NEW (PERF-CACHE-09)

**Problem:** Pre-SWR, the first request after the 5-min TTL had to wait for a full recompute (0.3–3.9s depending on route), even though an expired entry existed in the DB.

**Implementation:** New `getCachedWithMeta<T>(cacheKey, ttlMs)` returns `{ data, stale }` WITHOUT deleting the expired row (existing `getCached()` deletes on expiry). `withCacheAndDedup` then implements SWR:

1. **In-flight check** → if a Promise exists for this key, await it (concurrent request gets FRESH data).
2. **Register in-flight** BEFORE any `await` (closes the check-then-act race).
3. **DB cache check** via `getCachedWithMeta`:
   - **Fresh hit** → resolve in-flight + return `{ data, cached: true }`.
   - **Stale hit (SWR)** → return `{ data: stale, cached: true, stale: true }` immediately + fire-and-forget background recompute. The recompute writes fresh cache via `setCached(awaitWrite=true)` + resolves the in-flight Promise so concurrent awaiters get FRESH data (not stale).
   - **No entry** → compute synchronously + write cache + resolve in-flight.
4. **On error** → reject in-flight + re-throw.

**Surface area:** 19 JSON routes surface `stale: true` on the response when serving from an expired cache entry (pareto, recommendations, resto-bahan-matrix, outlet-items, item-history, drilldown, heatmap, item-peer-comparison, item-trend-rank, flip-ranking ×2, item-anomali-outlets, peer-comparison ×3, compliance, chronic-outlets, item-trend, price-effect). `/api/export-report` uses SWR internally but the binary docx response can't surface the flag (next download gets fresh).

**`/api/analysis` — NOW on SWR (commit 72aad95, AUDIT-PERF-5):** TTL 30 mnt (env `ANALYSIS_CACHE_TTL_MINUTES`); on a stale hit, `validate-and-resolve.ts` serves the stale row immediately + flags `stale: true` + triggers `triggerBackgroundRecompute()` (guarded — max ONE recompute per key per instance, fire-and-forget, upserts fresh row via `setCached(awaitWrite=true)`). TTL panjang aman karena mutasi SELALU invalidate eksplisit. **Plus raw-JSON passthrough (P3-HYG-1, PAKET F):** cache hit menyajikan string JSON tersimpan LANGSUNG — `getCachedRawWithMeta` (nol `JSON.parse`) → flag `"cached":true`/`"stale":true` di-inject via string surgery O(1) setelah `{` pembuka (payload tersimpan tak pernah memuat key itu — aman duplicate-key) → `new NextResponse(raw, { Content-Type: application/json })`. In-flight di-resolve dengan marker `{__rawJson, stale}`; awaiter melayani marker dengan response raw yang sama. Shape guard murah: `raw[0]==='{' && raw.includes('"success":')` (substring scan µs vs full parse 10-20ms). Menghilangkan double-serialize ~1MB per hit.

**Impact:** On the first request after TTL expiry, the routes return stale data in <50ms instead of waiting 0.3–3.9s for a recompute. Background recompute refreshes the cache so the next request gets fresh data. **No stale data risk after mutations** — `invalidateAnalysisCache()` deletes entries, so there's no stale entry to serve post-mutation.

### 4.7 Cache Warming

- **`prefetchAnalysis(queryClient, params)`** — called from FilterBar hover (month/week hover) + first status load in `useDashboardEffects`. Fires a background TanStack Query `prefetchQuery` for the latest period as soon as `/api/status` returns, before the auto-select useEffect chain sets `monthLabel`/`currentWeek`. Saves ~1 render cycle on initial dashboard load.
- **`prefetchHeatmap(queryClient, { month, week })`** — called from `useDashboardEffects` alongside `prefetchAnalysis` on status load. Heatmap matrix is warm before user scrolls down to it. Uses the SAME queryKey shape as `AreaItemHeatmap`'s `useQuery` so the prefetched entry is a cache hit when the component mounts.

> Other routes (pareto, recommendations, drilldown, etc.) do NOT have explicit prefetch hooks — they're lazy-loaded tabs or user-initiated drill-downs, so prefetching would waste a cold query on a tab the user may never open.

### 4.8 Query Pattern: Single-Scan Multi-Lens (NEW — PAKET B + E)

Dua bentuk query scan-merging menopang route berat (lihat `src/lib/queries/compliance.ts` + `chronic-outlets.ts` + `dashboard.ts`):

1. **Multi-CTE single materialization**: satu CTE `base`/`wk` (per-row expr ABS/COALESCE/SUM) direferensikan oleh N agregat (outlet_agg, cat_agg, tol_item, transfer_agg, transfer_top ROW_NUMBER, totals) → PostgreSQL mematerialisasikan CTE SEKALI → semua lensa agregat berbagi 1 scan fisik. Hasil semua lensa kembali dalam **1 round-trip** via `UNION ALL (lens, to_jsonb(row))` — `to_jsonb` menormalkan COUNT bigint → angka JSON.
2. **Lensa turunan di lapisan shaping**: pairing antar-area (lensa 7) dihitung dari baris `transfer_agg` yang SAMA di JS — nol scan/round-trip tambahan; momentum outlet dihitung dari lensa 'week' (baris per outlet×minggu) yang di-UNION ke query chronic yang sama.
3. **Threshold paritas rule engine**: lensa kepatuhan memakai `getRuntimeThresholds()` (stdDevBomPct/residualWarnPct/residualHighPct) — SAMA dengan rule-evaluation — panel & mesin rule tidak mungkin berbeda versi.
4. **Agregat COUNT FILTER** (kualitas input angka bulat): 3 kolom `COUNT(*) FILTER (WHERE predikat)` di outlet_agg + totals dari scan yang sama — nol CTE baru.

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
- **Indexes**: All filterable columns indexed (outlet_id, period_week, period_month, pic_id, plus composite `(monthLabel, weekLabel, itemId)` added in PERF-DB-03 for heatmap cells query). See `prisma/schema.prisma`.
- **Export-report DB cache**: the Word export route caches the full generated payload (5-min TTL) keyed by `month|week|compareWeek|compareMonth|sections` — repeat exports of the same period+sections hit the cache in ~0.2s instead of regenerating (~8s).
- **LIMIT safety** (PERF-DB-02): All top-N queries have explicit `LIMIT` clauses; heatmap items query has `LIMIT 500` defense-in-depth cap (production Item catalog is ~153 rows); cell-detail query has `LIMIT 1000`.
- **`work_mem=32MB`** (PAKET B — PERF-TXMEM-5, diturunkan dari 64MB): All heavy query modules wrapped in `withStatementTimeout()` which also sets `work_mem` — 64MB × ~10 transaksi konkuren menekan memori server (free tier); 32MB cukup untuk hash join + sort di tabel InventoryRecord, dengan margin.
- **Scan-merge (PAKET B — PERF-DB-SCAN-1/2/3)**: 4 KPI single-row yang men-scan WHERE identik 4× → 1 scan `queryDashboardKpis` (dipakai analysis + export); 4 (8 di export) query kategori top-items → 1 scan `queryTopItemsByAllCategories` dengan `ROW_NUMBER`+`FILTER` (presisi semantik per kategori terjaga); growthDrivers 4→2 transaksi. Nested-Pareto 10 tx → 1 query ROW_NUMBER (f6a126b).

### 6.2 Code Splitting (Client)

| Lazy-loaded via `next/dynamic` | Why                                                |
| ------------------------------ | -------------------------------------------------- |
| Recharts + all chart components| Charts are below-the-fold on most routes.          |
| 5 filter dialogs               | Dialogs only mount on user action.                 |
| `export-report` client logic   | Heavy; only needed when user clicks "Export".      |
| `AreaItemHeatmapSheet`         | NEW (PERF-FE-01): drill-down Sheet (~150 lines + Sheet + ScrollArea + table primitives) loads on first cell click. `loading: () => null` because the Sheet renders its own skeleton. |
| `ItemDeepDive`, `AuditLogDialog`| Heavy components lazy-loaded at page level.         |
| 7 chart components in `DashboardTab`| `GrowthComparison`, `DeviationBreakdownChart`, `LossVsSurplusChart`, `MultiPeriodComparisonCard`, `HistoricalZScoreCard`, `BomCorrelationCard`, `AreaItemHeatmap` — keeps Recharts (5.4MB) out of main bundle. |
| `RestoAnalysis`, `PeerComparison`| Tab-level lazy-load via `RestoTab` + `PeerTab`.     |

### 6.3 React Re-render Control

- **Tab keep-alive (PAKET A — FE-INTERACT-1, P1)**: semua `TabsContent` memakai **`forceMount`** + `data-[state=inactive]:hidden` — pindah tab TIDAK lagi unmount/remount subtree (state lokal: sort direction, expand, scroll position bertahan); Radix tetap men-hide lewat CSS. Tanpa ini tiap balik tab = rebuild seluruh subtree + semua `useQuery` mount ulang.
- **`React.memo`**: 41+ components memoized (all leaf chart components, KPI cards, table rows, 6 tab components incl. `ComplianceTab`).
- **`useShallow` (Zustand)**: 13 callsites — selectors return new object refs only when shallow-equal values change.
- **`keepPreviousData` (TanStack Query)**: Drilldown navigation shows previous data while new data loads — no layout shift.
- **staleTime 5 mnt + gcTime 10 mnt pada query peer/outlet (PAKET A — FE-INTERACT-2)**: refetch storm tiap balik tab >30 dtk dihilangkan (default gcTime 5 mnt membakar cache sebelum user balik).
- **Debounce 300ms autocomplete item-search (PAKET A — FE-INTERACT-3)**: dulu 1 request per huruf.
- **Dashboard tidak terkunci saat refresh background (PAKET A — FE-INTERACT-4)**: `FetchAware` `pointer-events-none` + drill `isFetching` gate dihapus — user bisa klik card saat refresh berjalan; indikator refresh tunggal di header.
- **Custom memo comparator** on `HeatmapCellView` — only re-renders when `value`/`recordCount`/`outletCount`/`maxVal`/`metric` change (280 cells efficiently memoized).
- **`refetchOnWindowFocus: false`** (PERF-FE-04): `useAnalysis`, `useStatus`, `useDrilldown`, and `AreaItemHeatmapSheet`'s cell-detail query all explicitly disable window-focus refetch.
- **`placeholderData: keepPreviousData`** on cell-detail query (PERF-FE-02): switching cells keeps the previous cell's data visible while the new one loads.
- **Memoized props** (PERF-FE-03): `AreaItemHeatmap` memoizes `sheetFilters` via `useMemo` + `handleSheetOpenChange` via `useCallback`.
- **Memoized derived arrays** (PERF-FE-05 + **P3-HYG-7 PAKET F**): `BomCorrelationCard` wraps `rows` + `findingsNarrative` + `totalBomFlags` in `useMemo`; `TopItemsByNominal` BarList data + handler di-memo (fallback `|| []` di-pin identitasnya dengan `useMemo` juga — array kosong baru per render mengalahkan memo); `GapAnalysisCard` pipeline filter→group→avgGap→sort (dirender di 3 tab) satu `useMemo` + `sortedOutlets` pre-sorted (dulu sort inline per repaint expand); `RankingNasionalCard` filter+slice di-memo.
- **Keydown handler (P3-HYG-6)**: probe DOM `querySelector` 3-selector hanya dievaluasi SETELAH key terbukti digit tab `1..5` (dulu tiap keypress, termasuk huruf biasa di input).

### 6.4 Bundle Optimization

`next.config.ts` `experimental.optimizePackageImports` enabled for **16 packages** (was 5 — extended in PERF-FE-07 to cover all 14 Radix packages used by the 29 shadcn/ui components):
- `recharts` (tree-shakeable chart imports)
- `lucide-react` (only used icons bundled)
- `@radix-ui/react-dialog`, `@radix-ui/react-popover`, `@radix-ui/react-select`, `@radix-ui/react-tooltip`, `@radix-ui/react-tabs`, `@radix-ui/react-scroll-area`, `@radix-ui/react-checkbox`, `@radix-ui/react-switch`, `@radix-ui/react-slider`, `@radix-ui/react-label`, `@radix-ui/react-alert-dialog`, `@radix-ui/react-collapsible`, `@radix-ui/react-progress`, `@radix-ui/react-toast` (each Radix package barrel-exports 5-10 primitives — `optimizePackageImports` rewrites to per-file imports at build time, no runtime cost).

### 6.5 HTTP / Transport

- **zstd + gzip** at Caddy layer (zstd preferred, gzip fallback).
- **Static asset bypass**: Caddy serves `/static`, `/_next/static` directly — never hits Next.js.
- **Cache-Control** headers (see §4.3) enable CDN edge caching.
- **Prod-only immutable Cache-Control** (AUDIT-CACHE P1 fix): `/_next/static/*` immutable 1-year header gated on `NODE_ENV === 'production'`. In dev, the rule is OMITTED entirely so Turbopack's default `no-cache` applies — was previously `immutable` in dev too, which caused browser to cache the FIRST version of each chunk URL (Turbopack uses stable module-ID hashes, not content hashes) and never re-fetch, so source edits never reached the browser. This was the root cause of the earlier "old versions keep appearing" bug.

### 6.6 Frontend Split (NEW — SPLIT-PAGE task)

`page.tsx` was a 735-line god file bundling 5 `useEffect`s, `useCallback` handlers, keyboard shortcuts, derived state, header JSX, 4 `TabsContent`s, footer, and modals. Split into **9 modules** (page.tsx reduced to 227 lines — 69% reduction):

| Module | File | Responsibility |
|--------|------|----------------|
| `DashboardHeader` | `src/components/dashboard/DashboardHeader.tsx` (156 lines) | Sticky 2-tier header (logo + actions + FilterBar) |
| `DashboardFooter` | `src/components/dashboard/DashboardFooter.tsx` (48 lines) | Sticky bottom footer (brand + stats + last-analysis perf) |
| `DashboardTab` | `src/components/dashboard/tabs/DashboardTab.tsx` (194 lines) | Main overview tab (11 sections, 7 lazy-loaded chart components) |
| `RestoTab` | `src/components/dashboard/tabs/RestoTab.tsx` (43 lines) | Wraps lazy `RestoAnalysis` in `FetchAware` + `ErrorBoundary` |
| `PeerTab` | `src/components/dashboard/tabs/PeerTab.tsx` (37 lines) | Wraps lazy `PeerComparison` in `FetchAware` + `ErrorBoundary` |
| `ParetoTab` | `src/components/dashboard/tabs/ParetoTab.tsx` (39 lines) | Wraps static `ParetoDashboard` in `FetchAware` + `ErrorBoundary` |
| `useDashboardEffects` | `src/hooks/useDashboardEffects.ts` (158 lines) | 5 useEffects: auto-select month/week, cache warming, auto-set compare period (BUG-1 fix), week validation (BUG-8 fix). Side-effect-only, no return value. |
| `useDashboardActions` | `src/hooks/useDashboardActions.ts` (195 lines) | `handleExport` + `handleRefresh` (useCallback) + `isExporting` state + global keyboard shortcuts (`Cmd+E/R/K`, `1/2/3/4` tab switch, `Escape` close-all). |
| `shared/index.tsx` (extended) | `src/components/dashboard/shared/index.tsx` (299 lines, was 262) | Added `FetchAware` + `LoadingChart` to existing `EmptyState`/`LoadingState`/`ErrorState`/`SectionHeader`/`ScrollToTop`. |

**Behavior preserved 1:1**: all `dynamic()` imports kept, all `ErrorBoundary` + `FetchAware` wrappers in the same order, all keyboard shortcuts wired to the same setters, all 5 useEffect dependency arrays unchanged, file-naming logic for export preserved verbatim.

### 6.7 Heatmap Optimization (NEW — PERF-HEATMAP)

The `/api/area-item-heatmap` route + `AreaItemHeatmap` component received 3 optimizations beyond the DB cache (PERF-CACHE-08) + lazy-loaded Sheet (PERF-FE-01):

1. **`prefetchHeatmap()`** (see §4.7): fires a background TanStack Query `prefetchQuery` for the latest period as soon as `/api/status` returns. Heatmap is warm before user scrolls down — eliminates the 0.2-0.5s cold-fetch wait when the dashboard first renders.
2. **Parallel kelompok + PIC resolve** (PERF-HEATMAP): inside the `withCacheAndDedup` computeFn, `resolveKelompokOutletCodes(kelompok)` + `resolvePICOutletCodes(pic)` are wrapped in `Promise.all` (was sequential, saves 50-100ms on cold path).
3. **Month-before-cache-key** (PERF-HEATMAP): `resolveMonthLabel(rawMonth, resolver)` is called BEFORE `buildCacheKey(...)` so that `"Agustus 2026"` and `"agustus 2026"` share one cache entry. Previously `rawMonth` was used in the key → case mismatch = cache miss + duplicate entries.

**Heatmap query shape** (`src/lib/queries/heatmap.ts`): 3-step pipeline — (1) fetch all items with total metric value, (2) select items via Pareto 80% or top-N, (3) fetch area × item matrix for selected items with full qty + nominal aggregates. `outletCount` (from `COUNT(DISTINCT outletId)`) powers the dual display (Total + Ø per resto). Smart fallback: `pctQtyDeviasiToBom` + `recordCount` metrics auto-use "Top N" mode (Pareto not meaningful for averages/counts).

### 6.8 Component Architecture (Trend Item Tab — NEW Phase 1+2+3)

The Trend Item Tab (`src/components/dashboard/tabs/ItemTrendTab/`) was expanded from a
single 657-LOC file into a folder with 8 files via the barrel re-export pattern (see §11
File Structure). The new component tree under `ItemTrendTab/index.tsx`:

```
ItemTrendTab/                                  (folder replaces ItemTrendTab.tsx — barrel via index.tsx)
├── index.tsx                                  (~401 LOC — orchestrator + barrel; holds state, 3 TanStack Queries: trend + autocomplete + item-trend-rank; renders header + chart + table + peer comparison)
├── types.ts                                    (SortKey, SortDir, MetricOption, AutocompleteResult + METRICS constant)
├── zScoreHelpers.ts                            (zScoreColor + zScoreStatus — TODO: deduplicate with HistoricalZScoreCard)
├── periodHelpers.ts                            (periodSortKey + periodShortLabel — "Jun W4" formatter)
├── ItemTrendSearchBar.tsx                     (autocomplete search input + dropdown — uses retained /api/item-search?mode=autocomplete)
├── ItemTrendTable.tsx                          (sortable table — 8 columns incl. Phase 1 "Pola" pattern column + drillPeriod row highlight)
├── ItemTrendRankChart.tsx                     (NEW Phase 3 — compact 100px-tall inverted-axis rank chart; renders below ItemTrendLineChart)
└── ItemPeerComparison.tsx                      (NEW Phase 2 — 756 LOC drill-down panel: 4 analysis cards + peer table; fetched when selectedItem && drillPeriod are both set)
```

**Component tree** (rendering hierarchy):

```
ItemTrendTab (memo'd) — index.tsx
├── RankBadgeRow (inline) — 3-badge row in header (national rank Deviasi + BOM + outlet count)
├── ItemTrendSearchBar (memo'd) — autocomplete dropdown
├── ItemTrendLineChart (next/dynamic, parent folder) — main QTY chart, click sets drillPeriod
├── ItemTrendRankChart (NEW Phase 3 — memo'd) — compact inverted-axis rank chart, click sets drillPeriod
│   └── CustomTooltip + renderDot (per-period severity color)
├── ItemTrendTable (memo'd) — sortable table with "Pola" column + drillPeriod highlight, row click sets drillPeriod
└── ItemPeerComparison (NEW Phase 2 — memo'd, rendered when selectedItem && drillPeriod)
    ├── EfficiencyScoreCard   (composite 0-100 — see PRD §6.7 for formula)
    ├── GapAnalysisCard       (target vs peer best vs peer avg — 3 rows)
    ├── ScatterPlotCard       (Recharts ScatterChart — qtyBom × absNominalDeviasi, target highlighted)
    ├── RankingSummaryCard    (target rank #N of M + percentile)
    └── PeerTable             (9 cols + anomaly flags, target row highlighted, row click → setFocusOutlet → Resto tab)
        └── PeerTableRow (memo'd — avoids re-render on hover state changes)
```

**3 TanStack Query hooks** in `index.tsx`:
1. `useItemTrend` (existing) — main QTY trend data.
2. `useQuery` for `/api/item-search?mode=autocomplete` — search bar dropdown (5-min staleTime).
3. `useQuery` for `/api/item-trend-rank` (NEW Phase 3) — rank trend chart data (5-min staleTime, 10-min gcTime, parallel with main trend query).

**Zustand store additions** (`useDashboard.ts`):
- `trendSelectedItem: string | null` + `setTrendSelectedItem(item)` — pre-selected item (Phase 1 navigation bridge from RankingNasionalCard).
- `setFocusOutlet(code)` — peer table row click → switches to Resto tab with focused outlet.

**Cross-component state** (`drillPeriod: {month, week} | null`):
- Set by: ItemTrendTable row click, ItemTrendLineChart dot click, ItemTrendRankChart dot click.
- Auto-syncs with dashboard month/week via "adjust state during render" pattern (per React docs — avoids `set-state-in-effect` lint error).
- Triggers: ItemPeerComparison renders below table when `selectedItem && drillPeriod` are both truthy.

### 6.9 Barrel Re-Export Pattern (File Splits Batch 1-4)

13 large files (>500 LOC each) were split into ~75 smaller files via the **barrel
re-export pattern**. Each split follows the same shape:

```
# Before (single file)
src/lib/queries/items/top-items.ts  (722 LOC)

# After (folder + barrel)
src/lib/queries/items/top-items/
├── types.ts              (pure types — no 'use client', no React imports, tree-shakeable)
├── shared-cte.ts         (internal — NOT re-exported from barrel)
├── by-deviasi-rank.ts    (queries)
├── by-other-metric.ts    (queries)
└── index.ts              (barrel — re-exports public API via `export * from './X'`)
```

TypeScript `moduleResolution: "bundler"` transparently resolves
`@/lib/queries/items/top-items` to `top-items/index.ts` — **zero caller file changes**
required (backward-compatible by construction).

**Splits completed** (Tasks 1-a/1-b/1-c/1-d, 2-a/2-b, 3-a/3-b/3-c, 4-a/4-d):

| Task | Original file | LOC | Split into | Largest split file |
|------|---------------|-----|------------|---------------------|
| 1-a | `src/components/dashboard/Charts.tsx` | 584 | `Charts/` folder (5 files) | GrowthComparison.tsx (269) |
| 1-b | `src/components/dashboard/ParetoDashboard.tsx` | 604 | `ParetoDashboard/` folder (8 files) | ParetoDashboard.tsx (236) |
| 1-c | `src/lib/queries/pareto.ts` | 794 | `lib/queries/pareto/` folder (6 files) | nested.ts (419) |
| 1-d | `src/lib/queries/items/top-items.ts` | 722 | `lib/queries/items/top-items/` folder (5 files) | by-other-metric.ts (400) |
| 2-a | `src/engine/rules/evaluator.ts` | 498 | `evaluator/` folder (5 files) | (kept under 150 LOC each) |
| 2-b | `src/engine/analysis/rootCauseEngine.ts` | 469 | `rootCauseMappings.ts` + slim `rootCauseEngine.ts` | rootCauseMappings.ts (440) |
| 3-a | `src/hooks/useAnalysis.ts` | 839 | `useAnalysis/` folder (8 files) | types.ts (380) |
| 3-b | `src/app/api/analysis/services/post-process.ts` | 838 | flat siblings `post-process-*.ts` (10 files, barrel via `export *`) | post-process-bom-correlation.ts (219) |
| 3-c | `src/components/dashboard/tabs/ItemTrendTab.tsx` | 657 | `tabs/ItemTrendTab/` folder (8 files) | index.tsx (401) |
| 4-a | `src/components/dashboard/AreaItemHeatmap.tsx` | 595 | `AreaItemHeatmap/` folder (10 files) | index.tsx |
| 4-d | `src/app/api/outlet-items/route.ts` | 560 | `route.ts` slim coordinator + `services/` flat siblings (6 files) | route.ts (~156) |

**Barrel pattern details**:
- `export * from './types'` — re-exports all type + value exports.
- Named `export { X } from './file'` — preserves the original named export shape (callers using `import { X } from 'path'` keep working unchanged).
- `export type { ... } from './types'` — type-only re-export (preserves `import type`).
- `'use client'` directive added to each `.tsx` client component file (matches `shared/index.tsx` precedent).
- Pure `.ts` helper files (types, constants, pure functions) have NO `'use client'` directive (server-safe + tree-shakeable).
- Some splits expanded public API surface (e.g. `ParetoRow`, `ParetoResult`, `computePareto`, `SeverityMaps` were previously private but became shared across sub-files). Re-exported through the barrel so original import paths still resolve.

**Verification per split** (uniform across all 11 splits):
- `bun run lint` — 0 errors. Pre-existing warnings unchanged.
- `bunx tsc --noEmit` — 0 errors. Confirms barrel re-exports resolve + all internal cross-file imports are valid.
- `bun run test` — green where applicable (pareto 8/8, top-items 9/9).
- Caller files: 0 modified (zero-diff backward compatibility).

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

- **Zod schemas**: 21 of 22 API routes have a Zod schema validating `searchParams` / body.
- **Gap**: `/api/resto-bahan-matrix` still uses manual `searchParams.get()` parsing (see §9). `/api/item-search` was fixed — schema with `mode: z.literal('autocomplete')` re-uses shared `monthLabelSchema` + `weekLabelSchema`; cross-outlet + trend modes removed with `GlobalItemSearchModal` (schema hard-rejects unknown modes).

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

**21 test files**, **402 test cases**, focused on:

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
| `src/components/dashboard/tabs/ItemTrendTab/ItemPeerComparison.tsx` | ~756 | Phase 2 — single component renders 4 analysis cards + peer table. Could be split (mirrors `peer-comparison/` folder pattern). |

> **Sudah displit sejak dokumen ini ditulis terakhir:** `export-report/route.ts` (~650) → `route.ts` + `services/` (data-fetcher + docx-builder + types); `analysis/route.ts` (910) → `services/` 8-stage pipeline; `outlet-items/route.ts` (560) → slim route + `services/` 6 files. God file tersisa yang benar-benar >700 LOC hanya ingest-process + ItemPeerComparison.

> **Recently split (Tasks 1-a/1-b/1-c/1-d, 2-a/2-b, 3-a/3-b/3-c, 4-a/4-d):** 11 god
> files were split into ~75 smaller files via the barrel re-export pattern (see §6.9).
> `Charts.tsx` (584 LOC) → `Charts/` folder; `ParetoDashboard.tsx` (604 LOC) →
> `ParetoDashboard/` folder; `pareto.ts` (794 LOC) → `lib/queries/pareto/` folder;
> `top-items.ts` (722 LOC) → `lib/queries/items/top-items/` folder;
> `evaluator.ts` (498 LOC) → `evaluator/` folder;
> `rootCauseEngine.ts` (469 LOC) → `rootCauseMappings.ts` + slim `rootCauseEngine.ts`;
> `useAnalysis.ts` (839 LOC) → `useAnalysis/` folder (8 files);
> `post-process.ts` (838 LOC) → flat siblings `post-process-*.ts` (10 files);
> `ItemTrendTab.tsx` (657 LOC) → `tabs/ItemTrendTab/` folder (8 files);
> `AreaItemHeatmap.tsx` (595 LOC) → `AreaItemHeatmap/` folder (10 files);
> `outlet-items/route.ts` (560 LOC) → slim `route.ts` + `services/` flat siblings (6 files).
> All splits verified backward-compatible (0 caller files modified; `bun run lint` +
> `bunx tsc --noEmit` pass).

**Recommended refactor** (remaining god files): Extract to service modules (`ingest-process.service.ts`, etc.) with pure, testable functions. Route handler should be <100 LOC. The Trend Item Tab ItemPeerComparison.tsx could similarly follow the `peer-comparison/` folder pattern when it grows beyond ~800 LOC.

### 9.2 Test Coverage Gaps

| File                          | LOC  | Coverage | Risk                                                |
| ----------------------------- | ---- | -------- | --------------------------------------------------- |
| `src/lib/ingestion.ts`        | 758  | 0%       | Highest-risk: handles untrusted Excel input.        |
| `src/lib/engine/analysis.ts`  | 1500 | 0%       | Core business logic: deviation decomposition.       |

### 9.3 Missing Validation

| Route                        | Issue                                                        |
| ---------------------------- | ------------------------------------------------------------ |
| `/api/resto-bahan-matrix`    | No Zod schema — manual `searchParams.get()` parsing.        |
| ~~`/api/item-search`~~       | ~~No Zod schema — manual param parsing.~~ **FIXED:** Zod schema added (`itemSearchQuerySchema`) with `mode: z.literal('autocomplete').default('autocomplete')` + `monthLabelSchema` + `weekLabelSchema` re-used from shared `validation.ts`. Schema hard-rejects unknown `mode` values (was previously tolerant — `cross-outlet` + `trend` modes were removed with `GlobalItemSearchModal`). |
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

```json
// vercel.json (final — PAKET C)
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "bunx prisma generate && bun run next build",
  "framework": "nextjs",
  "fluid": true
}
```

| Step                  | Duration (approx) | Notes                                                          |
| --------------------- | ----------------- | -------------------------------------------------------------- |
| `prisma generate`     | ~5s               | Generates typed client from `schema.prisma`.                   |
| `next build --turbo`  | ~60-90s           | Turbopack build. Static + server routes compiled.              |
| Total cold build      | ~90s              | Warm cache: ~40s.                                              |

**PAKET C (DEPLOY-1..4) — penting:**
- **DEPLOY-1**: blok `functions` vercel.json LAMA adalah no-op permanen (key path tanpa `/route.ts` tidak pernah match function Vercel) — dihapus. `maxDuration` kini single-source-of-truth di route export (31 route, 10–300s) yang memang bekerja native.
- **DEPLOY-2**: `"fluid": true` top-level — tanpa Fluid, plafon duration plan Hobby (60s) memotong analysis 120s & import/reset 300s di produksi ("upload gagal setelah ~1 menit"). Bonus: instance reuse → cache in-memory + rate-limit konsisten lintas-request, cold start jarang. **Verifikasi pasca-deploy HANYA via dashboard Vercel (Settings → Functions → Fluid ON)** — project lama bisa mengabaikan config file → toggle manual.
- **DEPLOY-4**: `package-lock.json` stale dihapus (masih memuat 10+ paket radix yang sudah dihapus dari package.json — `npm ci` diam-diam memasang graph dependency LAMA). **`bun.lock` satu-satunya lockfile** (dipakai Vercel buildCommand + Railway startCommand; diverifikasi sinkron offline 50/50 dep).
- ⚠️ **`bun install --frozen-lockfile` TIDAK boleh dipakai di sandbox** (hang network); validasi sinkron dilakukan offline via dep-set compare.

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

**Supabase PgBouncer caveat**: `bun run db:push` may HANG on the Supabase transaction-mode pooler (port 6543) because PgBouncer doesn't support all the interactive prompts Prisma uses. Workarounds: (a) use `DIRECT_URL` (port 5432) for migrations, or (b) apply schema changes directly via raw SQL through Prisma's `$executeRawUnsafe` (verified present in `pg_indexes` after running).

**⚠️ AUDIT-DB-PUSH-2 — WAJIB setelah `db:push`/`migrate` APA PUN:** Prisma TIDAK bisa memodelkan index INCLUDE (covering, index-only scan — historical 8s→1.6s) maupun ekspresi COALESCE (nullsafe unique). Push akan DROP versi INCLUDE + CREATE shadow polos. SELALU jalankan setelah push:
```bash
bun run db:recreate-covering-indexes   # idempotent — pulihkan INCLUDE indexes + daftar duplikat polos yang bisa di-drop
```

**db:push checklist (audit 137ea9e + P3-HYG-2):** `model AuditLog` direstorasi ke schema (push lama sempat mau DROP tabel produksi yang masih ditulis deployment aktif); index `Week(monthKey,weekLabel)` unique + `InventoryRecord_nullsafe_akun` sudah diterapkan surgikal di produksi; **`@@index([direction])` dihapus dari schema (P3-HYG-2 — dead) → akan ter-drop saat push berikutnya** (aman: nol query mem-filter kolom itu).

### 10.5 DB Migration: vefkgapv → proosjqiv (2026-08-30)

The original Supabase project `vefkgapveggbmkloaslw` (ap-southeast-1) became unreachable (paused/deleted — free tier auto-pauses after 7d inactivity). All data was migrated to a new project `proosjqivxadwgftofry` (same region):

- **Connection string**: `postgresql://postgres.proosjqivxadwgftofry:***@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`
- **Tool**: `pg` library (v8.23.0) — Prisma `db push` hung on PgBouncer tx mode.
- **Scope**: 626,739 rows migrated across 10 tables (InventoryRecord 306K + DQIssue 315K + Outlet 342 + Item 153 + OutletPIC 341 + OutletPeriodSales 4.4K + Week 20 + SourceFile 8 + AuditLog 358 + FileChunk 6). `Setting` + `AggregationCache` SKIPPED — auto-seeded by `ensureDefaultSettings()` + lazily rebuilt on first API call.
- **Audit**: `scripts/audit/audit-migration.ts` (770 lines) verified FK integrity (0 orphans), sequence sync (all 12 `_id_seq` aligned), index integrity (28/28 present), unique constraints (0 duplicates), NULL checks (0 unexpected NULLs), performance (53ms aggregate, 0.9ms indexed point lookup). See worklog `AUDIT-MIGRATION` for full report.
- **Caveat**: Any user-customized settings from OLD DB are LOST (NEW has only hardcoded defaults from `SETTING_DEFINITIONS`). Users must re-apply customizations via `/api/settings` UI.

### 10.6 Git Hooks (NEW)

- `.githooks/pre-push` — shell script that blocks force push to `main` (non-fast-forward detection via `git merge-base --is-ancestor`). Prevents orphaning commits — the root cause of the earlier "old versions keep appearing" bug (commits were being lost during force-push recovery, never cherry-picked back).
- **Activation**: `git config core.hooksPath .githooks` (NOT wired by default — must be run once per clone).
- **Bypass**: `git push --no-verify` for legitimate force-push needs.

### 10.7 Cache-Control Dev/Prod Fix (AUDIT-CACHE P1)

`next.config.ts` `headers()` function gates the `/_next/static/*` immutable 1-year `Cache-Control` on `NODE_ENV === 'production'`:

- **Production**: `Cache-Control: public, max-age=31536000, immutable` (content-hashed filenames — safe to cache forever).
- **Dev**: rule OMITTED entirely → Turbopack's default `no-cache` applies. Previously, `immutable` was set in dev too, which caused the browser to cache the FIRST version of each chunk URL (Turbopack uses stable module-ID hashes, not content hashes) and never re-fetch — source edits never reached the browser. This was the root cause of the "old versions keep appearing" bug.

### 10.8 Caddy Configuration

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
│   │   ├── analysis/route.ts              # Main analytics endpoint (cached, bespoke 8-stage pipeline)
│   │   │   └── services/                  # Pipeline stages — flat siblings (post-process.ts orchestrator + post-process-{types,bom-correlation,flags,growth,health-ranking,historical,trend-projection,patterns,top-outlets}.ts barrel re-exports via `export *`; validate-and-resolve, fetch-records, run-queries, exec-summary, assemble-response, trend-builder, deviation-drivers)
│   │   ├── area-item-heatmap/             # NEW (heatmap drill-down)
│   │   │   ├── route.ts                   # Heatmap matrix (cached, SWR)
│   │   │   └── cell-detail/route.ts       # Per-outlet drill-down (NOT cached)
│   │   ├── item-peer-comparison/route.ts # NEW Phase 2 (item-level peer comparison; cached 5-min + SWR; auto-selects worst outlet when outletCode omitted)
│   │   ├── item-trend-rank/route.ts      # NEW Phase 3 (per-item national rank timeline; cached 5-min + SWR; RANK() OVER PARTITION BY period)
│   │   ├── item-search/route.ts          # Autocomplete only (cross-outlet + trend modes removed with GlobalItemSearchModal — Zod schema hard-rejects other modes)
│   │   ├── pareto/route.ts                # Pareto 80/20 (cached, SWR)
│   │   ├── recommendations/route.ts       # AI recommendations (cached, SWR)
│   │   ├── resto-bahan-matrix/route.ts    # Restaurant × ingredient matrix (cached, SWR)
│   │   ├── export-report/route.ts         # Word export (cached, binary docx, SWR internal)
│   │   ├── outlet-items/route.ts          # NEW cached (PERF-API-01, SWR)
│   │   ├── item-history/route.ts          # NEW cached (PERF-API-02, SWR)
│   │   ├── drilldown/route.ts             # NEW cached (PERF-API-03, slim select PERF-API-06, SWR)
│   │   ├── ingest-upload/route.ts         # Chunked upload receiver
│   │   ├── ingest-process/route.ts        # Reassemble + parse + persist
│   │   └── status/route.ts                # Health check (in-memory cached + cleanupExpiredCache; NO_STORE HTTP headers — see §4.3)
│   └── page.tsx                           # Thin orchestrator (227 lines — was 735; split in SPLIT-PAGE)
├── components/
│   ├── ui/                                # shadcn/ui primitives (29 components)
│   └── dashboard/                         # Chart + KPI components (memoized, 24 top-level + tabs/ + shared/)
│       ├── Charts/                        # NEW (split 1-a): GrowthComparison + DeviationBreakdownChart + LossVsSurplusChart + TrendChart + index.ts barrel
│       ├── ParetoDashboard/               # NEW (split 1-b): types + constants + QuadrantCard + NestedItemToOutlet + GeneralizedNested + ActionPlanFooter + ParetoDashboard + index.ts barrel
│       ├── AreaItemHeatmap/               # NEW (split 4-a): types + metricConfig + heatmapHelpers + HeatmapControls + HeatmapCellView + HeatmapGrid + HeatmapTooltip + HeatmapLegend + index.tsx barrel
│       ├── tabs/                          # NEW folder (SPLIT-PAGE): DashboardTab + RestoTab + PeerTab + ParetoTab + ItemTrendLineChart + ItemTrendTab/
│       │   └── ItemTrendTab/              # NEW (split 3-c): folder replaces ItemTrendTab.tsx — index.tsx + types + zScoreHelpers + periodHelpers + ItemTrendSearchBar + ItemTrendTable + ItemTrendRankChart (NEW Phase 3) + ItemPeerComparison (NEW Phase 2)
│       ├── AreaItemHeatmap.tsx            # (kept as backwards-compat entry — re-exports from AreaItemHeatmap/index.tsx)
│       ├── AreaItemHeatmapSheet.tsx       # NEW: drill-down Sheet (lazy-loaded via next/dynamic)
│       ├── BomCorrelationCard.tsx         # Per-record BOM findings table + count badges + aggregate alignment table + narrative
│       ├── DashboardHeader.tsx            # NEW: sticky header (extracted from page.tsx)
│       ├── DashboardFooter.tsx            # NEW: sticky footer (extracted from page.tsx)
│       ├── HistoricalZScoreCard.tsx       # Multi-metric Z-Score (Dev/BOM + Waste + Susut + Trial)
│       ├── shared/index.tsx               # EmptyState/LoadingState/ErrorState/SectionHeader/ScrollToTop/FetchAware/LoadingChart
│       └── ...                            # Other dashboard components (AreaTrendChart + CardDrillDown + GlobalItemSearchModal deleted — see §11 Removed Features)
├── hooks/
│   ├── useAnalysis/                       # NEW (split 3-a): folder replaces useAnalysis.ts — 8 files via index.ts barrel
│   │   ├── index.ts                       # Barrel: re-exports all types + 4 hooks + 2 prefetch helpers + 2 query-key builders
│   │   ├── types.ts                       # All shared AnalysisData + DrilldownData + ItemTrendData + 28 type exports (380 LOC)
│   │   ├── fetchAnalysis.ts               # fetchAnalysis(params) helper
│   │   ├── prefetchHeatmap.ts             # prefetchHeatmap(queryClient, params) helper
│   │   ├── useAnalysis.ts                 # Main useAnalysis hook + buildAnalysisQueryKey + ANALYSIS_STALE_TIME/GC_TIME + prefetchAnalysis + usePrefetchAnalysis (140 LOC)
│   │   ├── useStatus.ts                   # useStatus hook + SourceFileInfo/StatusData types
│   │   ├── useDrilldown.ts                # useDrilldown hook + DrilldownRecord/DrilldownData types
│   │   └── useItemTrend.ts                # useItemTrend hook + ItemTrend* types
│   ├── useDashboard.ts                    # Zustand filter store (+ trendSelectedItem + setFocusOutlet — Phase 1+2 additions)
│   ├── useDashboardEffects.ts             # NEW: 5 useEffects (auto-select + cache warm + validate)
│   ├── useDashboardActions.ts             # NEW: export/refresh handlers + keyboard shortcuts
│   ├── use-mobile.ts                      # shadcn responsive viewport hook
│   └── use-toast.ts                       # shadcn toast hook
├── lib/
│   ├── db.ts                              # PrismaClient singleton + withStatementTimeout (log OFF, work_mem=64MB)
│   ├── aggregation-cache.ts               # DB-level cache: getCached/setCached/getCachedWithMeta/withCacheAndDedup (SWR)/invalidateAnalysisCache — setCached MUST be awaited
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
│   │   ├── heatmap.ts                     # NEW: queryAreaItemHeatmap + queryHeatmapCellDetail (Pareto 80/20 + dual display)
│   │   ├── z-score.ts                     # Z-score query
│   │   ├── month.ts                       # resolveMonthLabel()
│   │   ├── pareto/                        # NEW (split 1-c): folder replaces pareto.ts — types + compute + by-dimension + nested + historical + index.ts barrel
│   │   └── items/
│   │       ├── top-items/                 # NEW (split 1-d): folder replaces top-items.ts — types + shared-cte (buildDeviasiRankBaseCte) + by-deviasi-rank + by-other-metric + index.ts barrel
│   │       ├── item-peer-comparison.ts    # NEW Phase 2: queryItemPeerComparison — single SQL with CTEs (item_full → combined → target → final SELECT)
│   │       ├── item-trend-rank.ts         # NEW Phase 3: queryItemTrendRank — 2-CTE SQL (item_per_period → ranked → final WHERE itemName = exact match)
│   │       ├── item-trend.ts             # Per-item multi-period QTY trend (existing — powers main ItemTrendLineChart)
│   │       └── global-search.ts          # queryItemAutocomplete (cross-outlet + trend functions removed with GlobalItemSearchModal)
│   └── format.ts                          # fmtNum / fmtIDR / fmtPctAbs / fmtHeatmapCompact
├── config/
│   └── rules.yaml                         # 19 anomaly rules — SPEC deklaratif (eksekusi = lib/queries/rule-evaluation.ts; rules.ts + legacy JS evaluator deleted as dead code)
├── middleware.ts                          # Auth gate (Edge runtime) — ADMIN_TOKEN middleware (fixed in DOC-UPDATE)
└── next.config.ts                         # CSP, optimizePackageImports (16 packages — was 5), prod-only immutable Cache-Control

.githooks/
└── pre-push                               # NEW: blocks force push to main (activate via `git config core.hooksPath .githooks`)

prisma/
├── schema.prisma                          # Models + indexes (incl. composite (monthLabel, weekLabel, itemId) index added in PERF-DB-03)
└── migrations/                            # Versioned SQL migrations

scripts/
└── audit/audit-migration.ts               # NEW: DB migration audit (OLD vs NEW row counts, FK, sequences, indexes, NULLs)

tests/                                     # 22 files, 435 cases
```
